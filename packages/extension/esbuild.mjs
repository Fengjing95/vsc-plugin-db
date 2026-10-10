import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const scriptDir = dirname(fileURLToPath(import.meta.url)); // packages/extension

const watch = process.argv.includes('--watch');
// --minify：release 打包专用（VSIX 体积）；日常 F5 保持可读产物（P-36 排查习惯：符号名 grep dist）
const minify = process.argv.includes('--minify');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // ssh2 / exceljs：external 从 node_modules 运行时加载——ssh2 含可选 native 加速
  // （cpu-features，try/catch 降级），exceljs 体积大且含动态 require，打包无收益。
  // pg 与 mysql2/node-redis 同口径整体打包（纯 JS）；pg-native 是 pg 的可选 native 客户端
  // （未安装），静态打包会被 esbuild 解析报错 → 标 external（运行时仅在 native 路径才 require）
  external: ['vscode', 'ssh2', 'cpu-features', 'exceljs', 'pg-native'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify,
  logLevel: 'info',
};

// ── 驱动品牌 logo：从 webview-ui 素材源拷贝到 media/logos（树连接节点 iconPath 引用；
// .vscodeignore 不排除 media → 随扩展打包）。素材单一事实源在 webview-ui/src/assets/logos；
// 仅拷 .svg（避开 .DS_Store 等杂物），文件名归一化小写——素材源大小写混合（MySQL.svg 等），
// 而树侧 DRIVER_LOGO_FILES 映射为小写（与 webview DRIVER_LOGO_KEYS 同源），iconPath 在
// Linux 等大小写敏感文件系统上必须与磁盘文件名精确一致；逐文件拷贝可改名，幂等可重复执行
const logosSrc = join(scriptDir, '..', 'webview-ui', 'src', 'assets', 'logos');
const logosDst = join(scriptDir, 'media', 'logos');
mkdirSync(logosDst, { recursive: true });
for (const file of readdirSync(logosSrc)) {
  if (file.endsWith('.svg')) {
    copyFileSync(join(logosSrc, file), join(logosDst, file.toLowerCase()));
  }
}

// sql.js 的 wasm 引擎（M8-SQLite，D-16）：构建期拷到 media/（.vscodeignore 不排除 media → 随扩展
// 打包；.gitignore 忽略产物）。sql.js 本体纯 JS 随 esbuild 整体打包（同 pg/mysql2 口径），
// wasm 二进制不可打包——运行时驱动经 initSqlJs({ locateFile }) 定位 media/sql-wasm.wasm
// （extension.ts 传入 extensionPath 路径）。源经 createRequire 从 driver-sqlite 的依赖解析
// （pnpm 隔离目录不在本包依赖图内）。
const sqliteWasm = createRequire(join(scriptDir, '..', 'driver-sqlite', 'package.json')).resolve(
  'sql.js/dist/sql-wasm.wasm',
);
copyFileSync(sqliteWasm, join(scriptDir, 'media', 'sql-wasm.wasm'));

// ── Webview 产物入包（发布准备批次）：VSIX 安装后不存在仓库兄弟目录
// （../webview-ui/dist），webviewHtml.ts 优先读包内 dist/webview、monorepo 兄弟目录兜底。
// 先清空再拷：Vite 产物带内容哈希，残留旧哈希文件会随包膨胀
const webviewSrc = join(scriptDir, '..', 'webview-ui', 'dist');
const webviewDst = join(scriptDir, 'dist', 'webview');
if (existsSync(webviewSrc)) {
  rmSync(webviewDst, { recursive: true, force: true });
  cpSync(webviewSrc, webviewDst, { recursive: true, dereference: true });
} else {
  console.warn('[warn] webview-ui/dist 不存在——先跑 `pnpm --filter @db-explorer/webview-ui build`（根 pnpm build 已按此序）');
}

// ── external 运行时依赖闭包物化（发布准备批次）：.vscodeignore 排除 node_modules/**，
// VSIX 用 --no-dependencies 打包，external 的 ssh2/exceljs 若不随包则 SSH 隧道与 XLSX 导出
// 运行时必崩（AGENTS P-32/P-35 的 external 口径不变——esbuild 仍不打它们，这里在构建期把
// 真实依赖闭包按链接解引用拷到 dist/node_modules，require('ssh2') 从 dist/extension.js
// 就近解析）。布局用经典嵌套（依赖拷到消费者自身的 node_modules/ 下）：闭包内存在多版本
// （实测 readable-stream@2/3 并存），扁平布局会静默发错版本；嵌套解析天然按消费者就近命中。
// 可选 native 依赖（cpu-features/nan/pg-native）不物化：缺省 try/catch 降级（P-32）/永不
// 触达（P-43）。exceljs 剪掉 dist/（21MB 浏览器 UMD 构建，入口只 require lib/）。
const stageExternals = ['ssh2', 'exceljs'];
const stageDstRoot = join(scriptDir, 'dist', 'node_modules');
const stageReq = createRequire(join(scriptDir, 'package.json'));
const STAGE_MAX_DEPTH = 12;
const copyPkgTree = (pkgDir, dstDir, visited, depth) => {
  if (depth > STAGE_MAX_DEPTH) {
    throw new Error(`[stage] 依赖嵌套超过 ${STAGE_MAX_DEPTH} 层（疑似循环依赖）：${dstDir}`);
  }
  const pkgJsonPath = join(pkgDir, 'package.json');
  if (visited.get(dstDir) === pkgDir) return; // 同一落位已由同一真实包拷过（环/共享依赖去重）
  const prev = visited.get(dstDir);
  if (prev !== undefined && prev !== pkgDir) {
    throw new Error(`[stage] 落位冲突：${dstDir} 已由 ${prev} 占用（${pkgDir} 无法落位）`);
  }
  visited.set(dstDir, pkgDir);
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  rmSync(dstDir, { recursive: true, force: true });
  cpSync(pkgDir, dstDir, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const base = basename(src);
      if (base === '.bin') return false;
      if (/\.(md|markdown|map)$/i.test(base)) return false;
      if (pkg.name === 'exceljs' && src === join(pkgDir, 'dist')) return false;
      return true;
    },
  });
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    let depDir;
    try {
      depDir = dirname(createRequire(pkgJsonPath).resolve(`${dep}/package.json`));
    } catch {
      console.warn(`[warn] ${pkg.name} 的依赖 ${dep} 无法解析（跳过物化）`);
      continue;
    }
    copyPkgTree(depDir, join(dstDir, 'node_modules', dep), visited, depth + 1);
  }
};
rmSync(stageDstRoot, { recursive: true, force: true });
mkdirSync(stageDstRoot, { recursive: true });
let stagedCount = 0;
for (const name of stageExternals) {
  const visited = new Map();
  copyPkgTree(dirname(stageReq.resolve(`${name}/package.json`)), join(stageDstRoot, name), visited, 0);
  stagedCount += visited.size;
}
console.log(`[stage] dist/webview + dist/node_modules（${stageExternals.join(', ')} 闭包，共 ${stagedCount} 个落位）`);

// ── 发布物随包文档：vsce 只认打包目录内的 LICENSE/CHANGELOG/README（扩展详情页与许可展示），
// 权威文件在仓库根 → 构建期拷入本包目录（副本已 gitignore，防双源漂移）；README 由
// packages/extension/README.md 提供（扩展专属介绍，区别于仓库根的开发者向 README）
for (const f of ['LICENSE', 'CHANGELOG.md']) {
  const root = join(scriptDir, '..', '..', f);
  if (existsSync(root)) copyFileSync(root, join(scriptDir, f));
}

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[watch] extension 构建中…');
} else {
  await esbuild.build(options);
}
