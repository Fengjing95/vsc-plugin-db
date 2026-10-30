import { execSync } from 'node:child_process';
import { cpSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 官网双构建编排（D-25 P2 落地）：zh（根路径）→ en（/en/ 前缀）→ en 产物拷入 dist/en/。
 * 单一入口供本地与 CI 使用；产出后断言两份 index.html 存在（P-55 防空转假绿）。
 * EdgeOne 托管口径：/en/ 是静态子目录（自带 index.html 直接命中），无 SPA 回退需求，
 * 部署侧零配置改动。
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const distEn = join(root, 'dist-en');

function sh(cmd, env = {}) {
  execSync(cmd, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
}

// 1. Playground 产物 + 素材拷贝（原 build 前置步骤，两轮构建共用）
sh('node scripts/build-playground.mjs');
sh('node scripts/copy-assets.mjs');

// 2. zh 构建（base=/，zh 静态 SEO——现状行为）
sh('npx vite build', { SITE_LANG: 'zh' });
if (!existsSync(join(dist, 'index.html'))) {
  console.error('[build-all] zh 产物缺失：dist/index.html 不存在');
  process.exit(1);
}

// 3. en 构建（base=/en/，SEO 落死英文——vite.config.ts enSeoPlugin）
sh('npx vite build', { SITE_LANG: 'en' });
const enIndex = join(distEn, 'index.html');
if (!existsSync(enIndex) || statSync(enIndex).size < 500) {
  console.error('[build-all] en 产物缺失或为空：dist-en/index.html');
  process.exit(1);
}

// 4. en 产物并入 dist/en/（playground 的 withBase 引用随 base=/en/ 自洽，整目录拷贝）
rmSync(join(dist, 'en'), { recursive: true, force: true });
cpSync(distEn, join(dist, 'en'), { recursive: true });
rmSync(distEn, { recursive: true, force: true });

if (!existsSync(join(dist, 'en', 'index.html'))) {
  console.error('[build-all] 合并产物缺失：dist/en/index.html');
  process.exit(1);
}
console.log('[build-all] 双构建完成：dist/index.html（zh）+ dist/en/index.html（en）');
