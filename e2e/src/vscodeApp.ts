import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  // 首启 onboarding/welcome 模态会拦截一切点击（onboarding-a-overlay aria-modal）——profile 预置关闭
  writeFileSync(
    join(userDataDir, 'User', 'settings.json'),
    JSON.stringify({ 'workbench.startupEditor': 'none', 'extensions.ignoreRecommendations': true, 'update.mode': 'none' }),
  );

  const args = [
    `--extensionDevelopmentPath=${EXTENSION_DIR}`,
    `--extensionDevelopmentPath=${TEST_EXTENSION_DIR}`,
    `--user-data-dir=${join(opts.runDir, 'user-data')}`,
    // 用户已装扩展隔离：extensions-dir 指向空目录（--user-data-dir 不隔离 ~/.vscode/extensions），
    // 开发扩展（--extensionDevelopmentPath）不受影响——确定性与启动时长都可控
    `--extensions-dir=${join(opts.runDir, 'extensions')}`,
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

  // ELECTRON_RUN_AS_NODE 若从 VSCode 终端继承会让 VSCode 以纯 node 启动（@vscode/test-electron 同款防御）
  const env: NodeJS.ProcessEnv = { ...process.env, E2E_BRIDGE_PORT: String(opts.bridgePort) };
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
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      if (!exited) child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
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
