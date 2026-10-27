import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** CLI 入口路径跨平台解析：macOS exe 在 .app/Contents/MacOS/ → Contents/Resources/app/out/cli.js；
 * Linux exe 在 VSCode-linux-x64/ 根 → resources/app/out/cli.js（CI 首跑踩：mac 布局硬编码 Linux 必挂） */
function resolveCliJs(executablePath: string): string {
  const candidates = [
    join(executablePath, '..', '..', 'Resources', 'app', 'out', 'cli.js'),
    join(executablePath, '..', 'resources', 'app', 'out', 'cli.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`cli.js 未找到（候选: ${candidates.join(', ')}）`);
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
  // CLI 安装布局 = 平铺 <id>-<version> 顶层目录（1.14x）——**保持原样**：这版扩展扫描器就按平铺扫，
  // 挪成嵌套 <id>/<version>/ 会让扫描器把 <id>/ 当扩展目录读 package.json 报错、语言包静默失效
  // （sharedprocess.log「Unable to read file …/<id>/package.json」实测定因）
  const packInstalled = existsSync(extRoot) && readdirSync(extRoot).some((d) => d.startsWith(`${ZH_PACK_ID}-`));
  if (!packInstalled) {
    mkdirSync(extRoot, { recursive: true });
    console.log(`[e2e] 安装中文语言包（首次，marketplace 拉取）: ${ZH_PACK_ID}`);
    const tmpUserData = join(base, 'cli-user-data');
    mkdirSync(tmpUserData, { recursive: true });
    // CLI 入口 = ELECTRON_RUN_AS_NODE + out/cli.js（bin/code 包装脚本同款直启 Electron 主进程不处理
    // --install-extension，实测 spawn error/无输出）
    const cliJs = resolveCliJs(executablePath);
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
        if (!readdirSync(extRoot).some((d) => d.startsWith(`${ZH_PACK_ID}-`))) {
          console.error(`[e2e] 语言包安装输出: ${out.slice(-1500)}`);
        }
      });
    });
    const installedAfter = readdirSync(extRoot).some((d) => d.startsWith(`${ZH_PACK_ID}-`));
    if (!installedAfter) {
      throw new Error(`中文语言包安装失败（exit=${exitCode}）——marketplace 不可达或引擎不兼容，zh 旅程无法运行`);
    }
  }
  await bootstrapLanguagePackSeed(executablePath, extRoot);
  return extRoot;
}

/** 语言包缓存种子过期检测：translations 路径内嵌 pack 目录名（平铺 <id>-<version>），与已装目录不一致即重建 */
function seedVersionMatches(extRoot: string): boolean {
  if (!existsSync(LANGUAGE_PACK_SEED)) return false;
  try {
    const seed = JSON.parse(readFileSync(LANGUAGE_PACK_SEED, 'utf8')) as {
      'zh-cn'?: { translations?: { vscode?: string } };
    };
    const seedPath = seed['zh-cn']?.translations?.vscode;
    if (!seedPath) return false;
    const installed = readdirSync(extRoot).filter((d) => d.startsWith(`${ZH_PACK_ID}-`));
    return installed.some((dir) => seedPath.includes(`/${dir}/`));
  } catch {
    return false;
  }
}

/** Linux headless（xvfb-run 之外仍需要的 chromium 旗标）——主启动与无头引导两处同用 */
const LINUX_FLAGS = process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] : [];

/** 无头自举：语言包缓存（user-data/languagepacks.json）由主进程启动时生成，但 NLS 解析先于缓存
 *  写入（首轮恒 en）。seed 缺失/过期时拉起一次性 VSCode（无 CDP/桥），轮询缓存文件出现即收割。
 *  失败不抛错：runner 侧有自愈重试兜底（首轮 zh 回落 en 失败 → finally 收割缓存为种子 → 重跑即绿），
 *  失败时附带现场诊断（Linux CI 首跑实测引导不可用，注记里必须能看到为什么）。 */
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
      `--shared-data-dir=${join(bootUserData, 'shared-data')}`,
      '--locale=zh-cn',
      '--disable-workspace-trust',
      '--disable-updates',
      '--disable-crash-reporter',
      '--skip-release-notes',
      // CI 首跑踩：引导缺 Linux 旗标 → Chromium sandbox 起不来 → 120s 无任何产物（profile 只剩我建的 User/）
      ...LINUX_FLAGS,
    ],
    {
      env: { ...process.env, VSCODE_EXTENSIONS: extRoot },
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  );
  const cacheFile = join(bootUserData, LANGUAGE_PACK_CACHE);
  const deadline = Date.now() + 120_000;
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
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (existsSync(cacheFile)) {
    mkdirSync(join(LANGUAGE_PACK_SEED, '..'), { recursive: true });
    copyFileSync(cacheFile, LANGUAGE_PACK_SEED);
    console.log('[e2e] 语言包缓存种子就绪');
    return;
  }
  // 诊断现场：主进程日志尾部 + profile 根文件列表（CI 注记可见）
  const mainLog = join(bootUserData, 'logs');
  let logTail = '';
  try {
    for (const stamp of readdirSync(mainLog)) {
      const f = join(mainLog, stamp, 'main.log');
      if (existsSync(f)) logTail = readFileSync(f, 'utf8').slice(-1200);
    }
  } catch {
    // 目录不存在
  }
  console.warn(`[e2e] 语言包缓存引导失败（120s 未生成 languagepacks.json）——降级为首轮回落 en + 自愈重试；`);
  console.warn(`[e2e] 引导 profile 根: ${(() => { try { return readdirSync(bootUserData).join(', '); } catch { return '不存在'; } })()}`);
  if (logTail) console.warn(`[e2e] 引导 main.log 尾部: ${logTail}`);
}

const LANGUAGE_PACK_CACHE = 'languagepacks.json';
export const LANGUAGE_PACK_SEED = join(VSCODE_CACHE_DIR, 'e2e-ext', 'seed', LANGUAGE_PACK_CACHE);

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
  // 存在性校验后按平台候选回退，避免 spawn ENOENT
  if (!existsSync(executablePath)) {
    const platformRoot = join(executablePath, '..', '..');
    const candidates =
      process.platform === 'darwin'
        ? [join(platformRoot, 'MacOS', 'Code'), join(platformRoot, 'MacOS', 'Electron')]
        : [join(platformRoot, 'code'), join(platformRoot, 'vscode'), join(platformRoot, 'bin', 'code')];
    const fallback = candidates.find((c) => existsSync(c));
    if (fallback) {
      executablePath = fallback;
    } else {
      throw new Error(`VSCode 可执行文件不存在: ${executablePath}（候选 ${candidates.join(', ')} 均缺失）`);
    }
  }
  const userDataDir = join(opts.runDir, 'user-data');
  mkdirSync(join(userDataDir, 'User'), { recursive: true });
  // 顺序关键：先确保语言包 + 引导出 languagepacks.json 种子，再播种进 profile——
  // 冷态下种子由本步骤的无头引导产出，颠倒顺序会让播种空跳、首轮恒回落 en（实测定因：
  // argv.json 20:56:07 写入时种子不存在，VSCode 20:56:17 启动后 20:56:19 才自建缓存，晚于 NLS 解析）
  const extensionsDir = await ensureLocaleExtensions(opts.locale, executablePath);
  seedLanguagePackCache(userDataDir, opts.locale);
  // locale 必须写进 profile 的 argv.json：--locale CLI 旗标不驱动语言包 NLS 解析（实测 1.143
  // zh 包已装载仍回落 en）；日常 VSCode 的生效路径同样是 argv.json（用户实机对照确认）
  if (opts.locale.startsWith('zh')) {
    writeFileSync(join(userDataDir, 'argv.json'), JSON.stringify({ locale: opts.locale }));
  }
  // 首启 onboarding/welcome 模态会拦截一切点击（onboarding-a-overlay aria-modal）——profile 预置关闭
  // （startupEditor none + walkthrough 不自动开 + 实验关：Linux zh 轮实测模态仍可能晚于旅程开头出现，
  // 旅程侧另有 dismissOverlays 兜底）；notifications.showToast=false 同理：通知气泡（如 shell 环境
  // 解析超时提示）会遮挡右下角控件（实测 flake 源）
  writeFileSync(
    join(userDataDir, 'User', 'settings.json'),
    JSON.stringify({
      'workbench.startupEditor': 'none',
      'workbench.welcomePage.walkthroughs.openOnInstall': false,
      'workbench.enableExperiments': false,
      'workbench.tips.enabled': false,
      'extensions.ignoreRecommendations': true,
      'update.mode': 'none',
      'notifications.showToast': false,
    }),
  );

  const args = [
    `--extensionDevelopmentPath=${EXTENSION_DIR}`,
    `--extensionDevelopmentPath=${TEST_EXTENSION_DIR}`,
    `--user-data-dir=${join(opts.runDir, 'user-data')}`,
    // 用户已装扩展隔离 + locale 依赖（P-77）：en=空目录屏蔽用户扩展；zh=缓存的语言包目录
    `--extensions-dir=${extensionsDir}`,
    // 1.14x 新增 HOME 级全局共享存储（~/.vscode-shared/sharedStorage/state.vscdb，product.json
    // sharedDataFolderName）——跨 run 跨 profile 共享，不隔离会让 e2e 结果依赖本机历史状态；
    // 指进 runDir 保证每轮零历史
    `--shared-data-dir=${join(opts.runDir, 'shared-data')}`,
    `--locale=${opts.locale}`,
    '--disable-workspace-trust',
    '--disable-updates',
    '--disable-crash-reporter',
    '--skip-release-notes',
    `--remote-debugging-port=${opts.cdpPort}`,
    ...LINUX_FLAGS,
    opts.workspaceDir,
  ];

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
