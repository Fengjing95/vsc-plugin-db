import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { EXTENSION_DIR, TEST_EXTENSION_DIR, VSCODE_CACHE_DIR } from './paths';

export interface LaunchOptions {
  runDir: string;
  workspaceDir: string;
  cdpPort: number;
  bridgePort: number;
  /** VSCode --locale（zh-cn / en）——e2e 恒显式指定，不依赖宿主机系统语言 */
  locale: string;
}

/** zh 基线依赖中文语言包（P-77：无语言包时 --locale=zh-cn 被 VSCode 回落为 en）——
 * 一次性装入缓存目录（marketplace 拉取；CI 走 actions/cache），安装失败明确报错不静默跳过 */
const ZH_PACK_ID = 'ms-ceintl.vscode-language-pack-zh-hans';

/** 按 locale 准备 --extensions-dir：en = 空隔离目录（屏蔽用户已装扩展）；zh = 含语言包的缓存目录 */
export async function ensureLocaleExtensions(locale: string, executablePath: string): Promise<string> {
  const base = join(VSCODE_CACHE_DIR, 'e2e-ext');
  if (!locale.startsWith('zh')) {
    const empty = join(base, 'empty');
    mkdirSync(empty, { recursive: true });
    return empty;
  }
  const extRoot = join(base, 'extensions');
  // CLI 安装布局 = <id>-<version> 顶层目录（1.14x 实测；旧布局 <id>/<version> 同样认）
  const packInstalled = existsSync(extRoot) && readdirSync(extRoot).some((d) => d === ZH_PACK_ID || d.startsWith(`${ZH_PACK_ID}-`));
  if (!packInstalled) {    mkdirSync(extRoot, { recursive: true });
    console.log(`[e2e] 安装中文语言包（首次，marketplace 拉取）: ${ZH_PACK_ID}`);
    const tmpUserData = join(base, 'cli-user-data');
    mkdirSync(tmpUserData, { recursive: true });
    // CLI 入口 = ELECTRON_RUN_AS_NODE + out/cli.js（bin/code 包装脚本同款直启 Electron 主进程不处理
    // --install-extension，实测 spawn error/无输出）
    const cliJs = join(executablePath, '..', '..', 'Resources', 'app', 'out', 'cli.js');
    const exitCode = await new Promise<number>((resolve) => {
      const cli = spawn(
        executablePath,
        [cliJs, `--extensions-dir=${extRoot}`, `--user-data-dir=${tmpUserData}`, '--install-extension', ZH_PACK_ID],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let out = '';
      cli.stdout?.on('data', (c: Buffer) => (out += c.toString()));
      cli.stderr?.on('data', (c: Buffer) => (out += c.toString()));
      const timer = setTimeout(() => {
        cli.kill('SIGKILL');
        resolve(-1);
      }, 180_000);
      const finish = (code: number): void => {
        clearTimeout(timer);
        resolve(code);
      };
      cli.once('exit', (code) => finish(code ?? -1));
      cli.on('error', (err) => {
        out += `\nspawn error: ${String(err)}`;
        finish(-1);
      });
      cli.once('close', () => {
        if (!readdirSync(extRoot).some((d) => d === ZH_PACK_ID || d.startsWith(`${ZH_PACK_ID}-`))) {
          console.error(`[e2e] 语言包安装输出: ${out.slice(-1500)}`);
        }
      });
    });
    const installedAfter = readdirSync(extRoot).some((d) => d === ZH_PACK_ID || d.startsWith(`${ZH_PACK_ID}-`));
    if (!installedAfter) {
      throw new Error(`中文语言包安装失败（exit=${exitCode}）——marketplace 不可达或引擎不兼容，zh 旅程无法运行`);
    }
  }
  normalizePackLayout(extRoot);
  await bootstrapLanguagePackSeed(executablePath, extRoot);
  return extRoot;
}

/** 语言包缓存种子过期检测：translations 路径内嵌 pack 版本目录，与已装 pack 版本不一致即重建 */
function seedVersionMatches(extRoot: string): boolean {
  if (!existsSync(LANGUAGE_PACK_SEED)) return false;
  try {
    const seed = JSON.parse(readFileSync(LANGUAGE_PACK_SEED, 'utf8')) as {
      'zh-cn'?: { translations?: { vscode?: string } };
    };
    const seedPath = seed['zh-cn']?.translations?.vscode;
    if (!seedPath) return false;
    const versionDir = seedPath.split(`${ZH_PACK_ID}/`)[1]?.split('/')[0];
    const installed = readdirSync(join(extRoot, ZH_PACK_ID));
    return versionDir !== undefined && installed.includes(versionDir);
  } catch {
    return false;
  }
}

/** 无头自举：语言包缓存（user-data/languagepacks.json）由主进程启动时生成，但 NLS 解析先于缓存
 *  写入（首轮恒 en）。seed 缺失/过期时拉起一次性 VSCode（无 CDP/桥），轮询缓存文件出现即收割。 */
async function bootstrapLanguagePackSeed(executablePath: string, extRoot: string): Promise<void> {
  if (seedVersionMatches(extRoot)) return;
  const base = join(VSCODE_CACHE_DIR, 'e2e-ext');
  const bootUserData = join(base, 'seed-user-data');
  rmSync(bootUserData, { recursive: true, force: true });
  mkdirSync(join(bootUserData, 'User'), { recursive: true });
  console.log('[e2e] 引导语言包缓存（一次性无头启动）…');
  const child = spawn(
    executablePath,
    [
      `--user-data-dir=${bootUserData}`,
      `--extensions-dir=${extRoot}`,
      '--locale=zh-cn',
      '--disable-workspace-trust',
      '--disable-updates',
      '--disable-crash-reporter',
      '--skip-release-notes',
    ],
    { env: { ...process.env, VSCODE_EXTENSIONS: extRoot }, stdio: ['ignore', 'ignore', 'ignore'] },
  );
  const cacheFile = join(bootUserData, LANGUAGE_PACK_CACHE);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (existsSync(cacheFile)) break;
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  // 轮询退出码防僵尸 await（同 launchVSCode kill 口径）
  child.kill('SIGTERM');
  for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!child.killed && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (existsSync(cacheFile)) {
    mkdirSync(join(LANGUAGE_PACK_SEED, '..'), { recursive: true });
    copyFileSync(cacheFile, LANGUAGE_PACK_SEED);
    console.log('[e2e] 语言包缓存种子就绪');
  } else {
    throw new Error('语言包缓存引导失败（90s 内未生成 languagepacks.json）——zh 基线无法运行');
  }
}

const LANGUAGE_PACK_CACHE = 'languagepacks.json';
const LANGUAGE_PACK_SEED = join(VSCODE_CACHE_DIR, 'e2e-ext', 'seed', LANGUAGE_PACK_CACHE);

/** 启动前播种语言包缓存：主进程 NLS 解析先于语言包缓存重建（实测慢一拍——首启恒 en、次启才 zh）。
 *  缓存内容只依赖 extRoot 绝对路径（跨 run 稳定），首轮由 harvestLanguagePackCache 收割为种子后，
 *  每轮启动前拷入 profile 即首轮即 zh。 */
export function seedLanguagePackCache(userDataDir: string, locale: string): void {
  if (!locale.startsWith('zh') || !existsSync(LANGUAGE_PACK_SEED)) return;
  copyFileSync(LANGUAGE_PACK_SEED, join(userDataDir, LANGUAGE_PACK_CACHE));
}

/** 运行后收割主进程生成的语言包缓存为种子（首轮 zh run 的产物；存在才覆盖） */
export function harvestLanguagePackCache(userDataDir: string, locale: string): void {
  if (!locale.startsWith('zh')) return;
  const generated = join(userDataDir, LANGUAGE_PACK_CACHE);
  if (!existsSync(generated)) return;
  mkdirSync(join(LANGUAGE_PACK_SEED, '..'), { recursive: true });
  copyFileSync(generated, LANGUAGE_PACK_SEED);
}

/** CLI 装出的是平铺 `<id>-<version>` 目录；归一化为经典嵌套 `<id>/<version>/` 布局，
 * 并同步改写 extensions.json 的 location/relativeLocation——manifest 是扫描的权威索引，
 * 只挪目录不改索引实测语言包不生效（env.language 恒 en） */
function normalizePackLayout(extRoot: string): void {
  const flatDirs = readdirSync(extRoot).filter((d) => d.startsWith(`${ZH_PACK_ID}-`));
  if (flatDirs.length === 0) return;
  const manifestPath = join(extRoot, 'extensions.json');
  let manifest = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null;
  for (const flat of flatDirs) {
    const version = flat.slice(ZH_PACK_ID.length + 1);
    const src = join(extRoot, flat);
    const dst = join(extRoot, ZH_PACK_ID, version);
    mkdirSync(join(dst, '..'), { recursive: true });
    if (!existsSync(dst)) {
      cpSync(src, dst, { recursive: true });
    }
    rmSync(src, { recursive: true, force: true });
    if (manifest !== null) manifest = manifest.split(flat).join(`${ZH_PACK_ID}/${version}`);
  }
  if (manifest !== null) writeFileSync(manifestPath, manifest);
}

export interface VscodeApp {
  child: ChildProcess;
  outputTail(): string;
  kill(): Promise<void>;
}

/**
 * 下载（带缓存）并拉起真实 VSCode 桌面二进制：
 * - 两个 --extensionDevelopmentPath：db-kit 本体 + e2e bridge（测试专用控制面扩展）
 * - --user-data-dir 隔离 profile（不碰用户环境；日志同在 runDir 下 = 失败工件天然就位）
 * - --remote-debugging-port 开 CDP，runner 用 playwright-core connectOverCDP 驱动 DOM
 * - --locale 显式指定显示语言（J3 双语冒烟的根基；P-72 场景 = en）
 */
export async function launchVSCode(opts: LaunchOptions): Promise<VscodeApp> {
  let executablePath = await downloadAndUnzipVSCode({ cachePath: VSCODE_CACHE_DIR, version: 'stable' });
  // @vscode/test-electron 对 macOS stable 返回 Contents/MacOS/Electron，实际二进制是 Code（1.143 实测）——
  // 存在性校验后回退，避免 spawn ENOENT
  if (!existsSync(executablePath)) {
    const fallback = join(executablePath, '..', '..', 'MacOS', 'Code');
    if (existsSync(fallback)) {
      executablePath = fallback;
    } else {
      throw new Error(`VSCode 可执行文件不存在: ${executablePath}（回退 ${fallback} 亦缺失）`);
    }
  }
  const userDataDir = join(opts.runDir, 'user-data');
  mkdirSync(join(userDataDir, 'User'), { recursive: true });
  seedLanguagePackCache(userDataDir, opts.locale);
  // locale 必须写进 profile 的 argv.json：--locale CLI 旗标不驱动语言包 NLS 解析（实测 1.143
  // zh 包已装载仍回落 en）；日常 VSCode 的生效路径同样是 argv.json（用户实机对照确认）
  if (opts.locale.startsWith('zh')) {
    writeFileSync(join(userDataDir, 'argv.json'), JSON.stringify({ locale: opts.locale }));
  }
  // 首启 onboarding/welcome 模态会拦截一切点击（onboarding-a-overlay aria-modal）——profile 预置关闭；
  // notifications.showToast=false 同理：通知气泡（如 shell 环境解析超时提示）会遮挡右下角控件（实测 flake 源）
  writeFileSync(
    join(userDataDir, 'User', 'settings.json'),
    JSON.stringify({
      'workbench.startupEditor': 'none',
      'extensions.ignoreRecommendations': true,
      'update.mode': 'none',
      'notifications.showToast': false,
    }),
  );

  const extensionsDir = await ensureLocaleExtensions(opts.locale, executablePath);
  const args = [
    `--extensionDevelopmentPath=${EXTENSION_DIR}`,
    `--extensionDevelopmentPath=${TEST_EXTENSION_DIR}`,
    `--user-data-dir=${join(opts.runDir, 'user-data')}`,
    // 用户已装扩展隔离 + locale 依赖（P-77）：en=空目录屏蔽用户扩展；zh=缓存的语言包目录
    `--extensions-dir=${extensionsDir}`,
    `--locale=${opts.locale}`,
    '--disable-workspace-trust',
    '--disable-updates',
    '--disable-crash-reporter',
    '--skip-release-notes',
    `--remote-debugging-port=${opts.cdpPort}`,
    opts.workspaceDir,
  ];
  if (process.platform === 'linux') {
    // CI headless（xvfb-run 之外仍需要的 chromium 旗标）
    args.push('--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
  }

  // ELECTRON_RUN_AS_NODE 若从 VSCode 终端继承会让 VSCode 以纯 node 启动（@vscode/test-electron 同款防御）。
  // VSCODE_EXTENSIONS 与 --extensions-dir 双通道：主进程的 NLS/语言包解析不认 --extensions-dir 旗标
  //（实测 zh 包在位仍回落 en），环境变量是主进程扩展扫描的另一入口
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    E2E_BRIDGE_PORT: String(opts.bridgePort),
    VSCODE_EXTENSIONS: extensionsDir,
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(executablePath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  const capture = (chunk: Buffer): void => {
    tail = (tail + chunk.toString('utf8')).slice(-8000);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  return {
    child,
    outputTail: () => tail,
    kill: async () => {
      // 轮询 exitCode 而非 await 'exit' 事件：子进程可能已在注册监听前退出，
      // 永不触发的事件 + 空事件循环 = node 静默 exit 0（实测踩，runOnce 后半段凭空消失）
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      const dead = (): boolean => child.exitCode !== null || child.signalCode !== null;
      if (dead()) return;
      child.kill('SIGTERM');
      for (let i = 0; i < 50 && !dead(); i++) await sleep(100);
      if (!dead()) child.kill('SIGKILL');
      for (let i = 0; i < 30 && !dead(); i++) await sleep(100);
    },
  };
}

/** 等待 CDP 就绪并以 DevToolsActivePort 文件为准返回实际端口（Chromium 撞端口时会静默换端口） */
export async function waitForCdpPort(userDataDir: string, requested: number, timeoutMs = 60_000): Promise<number> {
  const portFile = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      try {
        const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
        if (port > 0) return port;
      } catch {
        // 文件写入中，重试
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return requested; // 文件未出现则按请求端口兜底（connectOverCDP 会给出明确错误）
}

/** 端口候选：向 OS 要一个空闲端口（listen(0) 立即关闭；存在极小 TOCTOU 窗口，可接受）。
 * 固定随机数会撞本机占用端口——Chromium 撞端口后静默绑到别的端口并写 DevToolsActivePort，
 * runner 侧按请求端口连接就永远失败（实测踩）。 */
export function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('未取到空闲端口'))));
    });
    srv.on('error', reject);
  });
}
