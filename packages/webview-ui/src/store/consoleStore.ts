import type {
  ConsoleAi,
  ConsoleBanner,
  ConsoleRun,
  ConsoleStateResult,
} from '@db-explorer/protocol';
import {
  ConsoleActivatedEventSchema,
  ConsoleAiEventSchema,
  ConsoleBannerEventSchema,
  ConsoleRunningEventSchema,
  ConsoleStateResultSchema,
  ConsoleUpdatedEventSchema,
  RpcEvents,
  type RpcEvent,
} from '@db-explorer/protocol';
import { create } from 'zustand';
import { request, RpcError } from '../rpc/client';
import { deriveTabs } from '../lib/consoleView';
import { rpcErrorText } from '../lib/errors';

/**
 * Console 结果面板状态（交互稿 §7.3/§7.4）：
 * Host 执行逐语句推送 evt:console.updated（全量运行快照），面板渲染 Tab/状态行/横幅。
 * Webview 重载经 console.getState 恢复（最近运行 + 悬挂横幅 + 执行中）。
 * 底部面板为共享单例视图：consoleId 以空串引导（Host 解析为最近执行的 Console），
 * 经 evt:console.activated 在多 Console 间跟随切换（重新拉取全量状态）。
 */

interface ToastState {
  text: string;
  kind: 'info' | 'error';
}

interface ConsoleStoreState {
  consoleId: string;
  phase: 'loading' | 'ready' | 'error';
  errorMsg: string;

  bound: boolean;
  connLabel?: string;
  db: string | null;
  run: ConsoleRun | null;
  banner: ConsoleBanner | null;
  running: { runId: string; total: number } | null;
  /** M9-AI：最近一次 AI 解释（交互稿 §15.3） */
  ai: ConsoleAi | null;

  activeTab: string;
  /** 用户在运行期间手动点过 Tab → 停止自动跟随 */
  manualTab: boolean;
  exporting: boolean;
  toast: ToastState | null;

  bootstrap(consoleId: string): Promise<void>;
  applyState(state: ConsoleStateResult): void;
  handleEvent(evt: RpcEvent): void;
  setActiveTab(id: string): void;
  resolveBanner(action: 'proceed' | 'cancel'): Promise<void>;
  cancelRun(): Promise<void>;
  rerun(sql: string): Promise<void>;
  exportItem(seq: number, format: 'csv' | 'json' | 'xlsx' | 'ndjson' | 'markdown'): Promise<void>;
  openFix(seq: number): Promise<void>;
  retryExplain(): Promise<void>;
  openAiSettings(): Promise<void>;
  closePanel(): Promise<void>;
  showToast(t: ToastState, autoDismissMs?: number): void;
  dismissToast(): void;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useConsoleStore = create<ConsoleStoreState>((set, get) => ({
  consoleId: '',
  phase: 'loading',
  errorMsg: '',

  bound: false,
  connLabel: undefined,
  db: null,
  run: null,
  banner: null,
  running: null,
  ai: null,

  activeTab: 'msg',
  manualTab: false,
  exporting: false,
  toast: null,

  async bootstrap(consoleId) {
    set({ consoleId });
    try {
      const raw = await request<unknown>('console.getState', { consoleId }, 15_000);
      const parsed = ConsoleStateResultSchema.safeParse(raw);
      if (!parsed.success) {
        set({ phase: 'error', errorMsg: '插件与视图版本不一致，请重载窗口' });
        return;
      }
      get().applyState(parsed.data);
      set({ phase: 'ready' });
    } catch (err) {
      set({ phase: 'error', errorMsg: err instanceof Error ? err.message : String(err) });
    }
  },

  applyState(state: ConsoleStateResult): void {
    const run = state.run ?? null;
    const ai = state.ai ?? null;
    const tabs = deriveTabs(run, ai);
    const lastResult = [...tabs].reverse().find((t) => t.kind === 'result');
    // AI 解释进行中（bootstrap 恢复/引导路径）跟随 AI Tab
    const followAi = ai?.status === 'running';
    set({
      // 底部面板单例视图：consoleId 以 Host 解析结果为准（引导传空串时在此回填）
      consoleId: state.consoleId || get().consoleId,
      bound: state.bound,
      connLabel: state.connLabel,
      db: state.db ?? null,
      banner: state.banner ?? null,
      run,
      running: state.running ?? null,
      ai,
          activeTab: followAi ? 'ai' : run ? (lastResult ? lastResult.id : 'msg') : get().activeTab,
      manualTab: false,
    });
  },

  handleEvent(evt: RpcEvent): void {
    if (evt.event === RpcEvents.consoleUpdated) {
      const parsed = ConsoleUpdatedEventSchema.safeParse(evt.payload);
      if (!parsed.success) {
        return;
      }
      const { run } = parsed.data;
      if (run.consoleId !== get().consoleId) {
        return; // 其它 Console 的推送
      }
      const tabs = deriveTabs(run);
      const lastResult = [...tabs].reverse().find((t) => t.kind === 'result');
      const manual = get().manualTab;
      let activeTab = get().activeTab;
      if (!manual) {
        // 运行中跟随最新结果；结束后停在最前的结果 Tab（无则消息）
        activeTab =
          run.status === 'running'
            ? (lastResult?.id ?? 'msg')
            : (tabs.find((t) => t.kind === 'result')?.id ?? 'msg');
      }
      set({ run, running: run.status === 'running' ? get().running : null, activeTab });
      return;
    }
    if (evt.event === RpcEvents.consoleActivated) {
      const parsed = ConsoleActivatedEventSchema.safeParse(evt.payload);
      if (parsed.success && parsed.data.consoleId !== get().consoleId) {
        // 切换跟随的 Console：重新拉全量状态（运行/横幅/Tab 一并恢复）
        void get().bootstrap(parsed.data.consoleId);
      }
      return;
    }
    if (evt.event === RpcEvents.consoleBanner) {
      const parsed = ConsoleBannerEventSchema.safeParse(evt.payload);
      if (parsed.success && parsed.data.consoleId === get().consoleId) {
        set({ banner: parsed.data.banner });
      }
      return;
    }
    if (evt.event === RpcEvents.consoleAi) {
      const parsed = ConsoleAiEventSchema.safeParse(evt.payload);
      if (!parsed.success || parsed.data.consoleId !== get().consoleId) {
        return; // 其它 Console 的推送
      }
      const ai = parsed.data.ai;
      // 解释开始/进行中自动跟随 AI Tab（用户手动切 Tab 后不抢）
      const followAi = ai !== null && ai.status === 'running' && !get().manualTab;
      set({ ai, activeTab: followAi ? 'ai' : get().activeTab });
      return;
    }
    if (evt.event === RpcEvents.consoleRunning) {
      const parsed = ConsoleRunningEventSchema.safeParse(evt.payload);
      if (parsed.success && parsed.data.consoleId === get().consoleId) {
        set({ running: { runId: parsed.data.runId, total: parsed.data.total }, manualTab: false });
      }
    }
  },

  setActiveTab(id: string): void {
    set({ activeTab: id, manualTab: true });
  },

  async resolveBanner(action) {
    const { consoleId, banner } = get();
    if (!banner) {
      return;
    }
    set({ banner: null }); // 乐观关闭（Host 侧同步清理）
    try {
      await request('console.resolveBanner', { consoleId, bannerId: banner.bannerId, action });
    } catch {
      // 横幅确认失败不阻塞（执行流 Host 侧持有）
    }
  },

  async cancelRun() {
    const { consoleId } = get();
    try {
      await request('console.cancel', { consoleId });
    } catch {
      // 取消失败静默（执行有超时兜底）
    }
  },

  async rerun(sql) {
    const { consoleId } = get();
    try {
      // 执行时长不设限（进度与结果经 evt 推送）
      await request('console.execute', { consoleId, sql }, 0);
    } catch (err) {
      get().showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  },

  async exportItem(seq, format) {
    if (get().exporting) {
      return;
    }
    set({ exporting: true });
    try {
      const result = await request<{ filePath: string; rows: number; canceled?: boolean }>(
        'console.export',
        { consoleId: get().consoleId, itemSeq: seq, format },
        120_000,
      );
      if (result.canceled) {
        get().showToast({ kind: 'info', text: '已取消导出' });
      } else {
        get().showToast({ kind: 'info', text: `已导出 ${result.rows} 行 → ${result.filePath}` }, 6000);
      }
    } catch (err) {
      get().showToast({ kind: 'error', text: `导出失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      set({ exporting: false });
    }
  },

  /** M9-AI（C 方案）：消息 Tab「✨ 修复建议」——触发 Host 生成并进入编辑器内联预览；
   *  保留/放弃确认在编辑器 CodeLens 与通知上，webview 不渲染 Modal */
  async openFix(seq: number): Promise<void> {
    try {
      const { consoleId } = get();
      await request('ai.fixError', { consoleId, seq }, 120_000);
      get().showToast({ kind: 'info', text: '已生成修复建议，请在编辑器中选择保留或放弃' }, 6000);
    } catch (err) {
      get().showToast({
        kind: 'error',
        text: `修复建议失败：${rpcErrorText(
          err instanceof RpcError ? err : { message: err instanceof Error ? err.message : String(err) },
        )}`,
      });
    }
  },

  /** M9-AI：解释 Tab 错误态「重试」——复跑该 Console 最近一次 AI 解释（流式经 evt 推送） */
  async retryExplain() {
    try {
      await request('ai.retryExplain', { consoleId: get().consoleId }, 0);
    } catch (err) {
      // 失败由 evt:console.ai 的 error 态呈现（Host 侧推送）；此处仅兜底 Toast
      get().showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  },

  /** M9-AI：webview 侧「去配置」引导 → 打开 AI 设置页 */
  async openAiSettings() {
    try {
      await request('ai.openSettings', {});
    } catch {
      // 引导失败静默（面板可能尚未就绪）
    }
  },

  async closePanel() {
    try {
      await request('console.close', { consoleId: get().consoleId });
    } catch {
      // 面板已关闭等场景静默
    }
  },

  showToast(t, autoDismissMs) {
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    set({ toast: t });
    if (autoDismissMs) {
      toastTimer = setTimeout(() => {
        useConsoleStore.getState().dismissToast();
      }, autoDismissMs);
    }
  },

  dismissToast() {
    set({ toast: null });
  },
}));
