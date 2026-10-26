import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dumpArtifacts } from './artifacts';
import { BridgeClient } from './bridgeClient';
import { connectWorkbench } from './cdp';
import { createFixture } from './fixture';
import { uiLabels } from './labels';
import { ARTIFACTS_ROOT, EXTENSION_DIR } from './paths';
import { launchVSCode, harvestLanguagePackCache, pickPort, waitForCdpPort } from './vscodeApp';
import { journey1 } from './journeys/j1';
import { journey2 } from './journeys/j2';
import { journey3 } from './journeys/j3';

// 旅程有状态依赖（J1 建连接、J2 建绑定），必须按序全跑；--journey 过滤仅用于调试
const journeys: Record<string, (ctx: import('./journeys/j1').JourneyCtx) => Promise<void>> = {
  j1: journey1,
  j2: journey2,
  j3: journey3,
};

function parseArgs(): { locales: string[]; keep: boolean; only: string[] } {
  const locales: string[] = [];
  let keep = false;
  let only: string[] = [];
  for (const a of process.argv.slice(2)) {
    if (a === '--keep') keep = true;
    else if (a.startsWith('--locale=')) locales.push(a.split('=')[1]);
    else if (a.startsWith('--journey=')) only = a.split('=')[1].split(',');
  }
  return { locales: locales.length > 0 ? locales : ['en', 'zh-cn'], keep, only: only.length > 0 ? only : Object.keys(journeys) };
}

/** 清理历史工件目录，保留最近 keep 个 */
/** e2e 临时 run 根：unix domain socket（VSCode 单实例 IPC `<user-data>/1.14-main.sock`）的
 * sun_path 上限 103 字符——macOS os.tmpdir()（/var/folders/…/T/）前缀就 54 字符，必超；
 * 用字面 /tmp 短路径（Linux CI 同样适用；Windows 无此问题，走 os.tmpdir()） */
const TMP_RUN_ROOT = process.platform === 'win32' ? join(tmpdir(), 'dbkit-e2e') : '/tmp/dbkit-e2e';

function cleanupOldRuns(keep: number): void {
  try {
    const runs = readdirSync(ARTIFACTS_ROOT)
      .filter((d) => !d.startsWith('run-'))
      .sort()
      .reverse();
    for (const d of runs.slice(keep)) rmSync(join(ARTIFACTS_ROOT, d), { recursive: true, force: true });
  } catch {
    // 首次运行目录不存在
  }
  try {
    const tmpRuns = readdirSync(TMP_RUN_ROOT);
    for (const d of tmpRuns) rmSync(join(TMP_RUN_ROOT, d), { recursive: true, force: true });
  } catch {
    // 首次运行目录不存在
  }
}

/** P-55 精神：跑之前断言扩展构建产物在位，缺了直接报清楚（而非 VSCode 里莫名空白） */
function preflight(): void {
  const need = [
    join(EXTENSION_DIR, 'dist', 'extension.js'),
    join(EXTENSION_DIR, 'media', 'sql-wasm.wasm'),
    join(EXTENSION_DIR, 'dist', 'webview', 'index.html'),
    join(EXTENSION_DIR, 'l10n', 'bundle.l10n.en.json'),
  ];
  const missing = need.filter((p) => !existsSync(p));
  if (missing.length > 0) {
    throw new Error(`扩展构建产物缺失（先跑根目录 pnpm build）:\n${missing.join('\n')}`);
  }
}

interface RunResult {
  locale: string;
  passed: string[];
  failed: string[];
}

async function runOnce(locale: string, only: string[], keep: boolean): Promise<RunResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // user-data 必须短路径：VSCode 单实例 IPC 用 <user-data>/1.14-main.sock，unix domain socket
  // sun_path 上限 103 字符，超长 → listen EINVAL → ext host 起不来（实测踩；repo 深路径 + 时间戳必超）
  const runDir = join(TMP_RUN_ROOT, `run-${stamp}`);
  // 失败工件（截图/webview 摘要）落仓库 artifacts，便于直接查看
  const artifactDir = join(ARTIFACTS_ROOT, `${locale}-${stamp}`);
  mkdirSync(runDir, { recursive: true });
  console.log(`[e2e] locale=${locale} runDir=${runDir}`);

  const fixture = await createFixture(runDir);
  const cdpPort = await pickPort();
  const bridgePort = await pickPort();
  const app = await launchVSCode({ runDir, workspaceDir: fixture.workspaceDir, cdpPort, bridgePort, locale });

  const result: RunResult = { locale, passed: [], failed: [] };
  let workbench: Awaited<ReturnType<typeof connectWorkbench>> | undefined;
  try {
    const bridge = new BridgeClient(`http://127.0.0.1:${bridgePort}`);
    const state = await bridge.waitReady();
    // 定位词表按「生效语言」取（bridge 上报的 vscode.env.language），而非请求的 --locale——
    // 无语言包时 VSCode 会把请求 locale 回落为 en（实测 1.143：--locale=zh-cn → env.language='en'）
    const effectiveLocale = state.language;
    console.log(`[e2e] bridge 就绪：vscode=${state.version} language=${effectiveLocale}（请求 ${locale}） ext=${state.extensions.includes('db-explorer-dev.db-kit')}`);

    const actualCdpPort = await waitForCdpPort(join(runDir, 'user-data'), cdpPort);
    workbench = await connectWorkbench(actualCdpPort);
    console.log('[e2e] workbench 就绪');

    const ctxBase = {
      page: workbench.page,
      bridge,
      fixture,
      requestedLocale: locale,
      locale: effectiveLocale,
      runDir,
      labels: uiLabels(effectiveLocale),
    };
    for (const name of only) {
      const fn = journeys[name];
      if (!fn) throw new Error(`未知旅程: ${name}`);
      try {
        await fn(ctxBase);
        result.passed.push(name);
        console.log(`[e2e] ✅ ${name} 通过`);
      } catch (err) {
        result.failed.push(name);
        await dumpArtifacts(artifactDir, workbench.page, name);
        console.error(`[e2e] ❌ ${name} 失败:`, err instanceof Error ? err.message : err);
        break; // 首个失败即停（旅程之间有状态依赖）
      }
    }
  } catch (err) {
    console.error('[e2e] VSCode 输出尾部:', app.outputTail().slice(-2000));
    throw err;
  } finally {
    console.log('[e2e] 收尾：关闭浏览器与 VSCode…');
    await workbench?.close().catch(() => undefined);
    await app.kill();
    console.log('[e2e] 收尾完成');
    if (locale.startsWith('zh')) harvestLanguagePackCache(join(runDir, 'user-data'), locale);
    const allPassed = result.failed.length === 0 && result.passed.length === only.length;
    if (!keep && allPassed) {
      rmSync(runDir, { recursive: true, force: true });
      console.log('[e2e] 全部通过，临时目录已清理（--keep 可保留）');
    } else if (result.failed.length > 0) {
      console.error(`[e2e] 失败工件：截图 ${artifactDir}/，workbench 日志 ${join(runDir, 'user-data', 'logs')}/`);
    } else {
      console.error(`[e2e] 未完成，现场保留：runDir=${runDir}（workbench 日志 user-data/logs/）`);
    }
  }
  return result;
}

async function main(): Promise<void> {
  const { locales, keep, only } = parseArgs();
  cleanupOldRuns(5);
  preflight();

  const results: RunResult[] = [];
  for (const locale of locales) {
    results.push(await runOnce(locale, only, keep));
    console.log(`[e2e] locale=${locale} 轮次结束`);
  }

  const totalFailed = results.reduce((n, r) => n + r.failed.length, 0);
  for (const r of results) {
    console.log(`[e2e] ${r.locale}: pass=${r.passed.join(',') || '-'} fail=${r.failed.join(',') || '-'}`);
  }
  if (totalFailed > 0) process.exit(1);
}

void main().catch((err) => {
  console.error('[e2e] 致命错误:', err);
  process.exit(1);
});
