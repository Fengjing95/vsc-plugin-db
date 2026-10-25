/**
 * SQL 行内执行结果注记（M8 优化）：执行完成后在语句行尾内联显示耗时（绿）/错误消息（红），
 * 行号左侧 gutter 显示 ✓/✗ 图标——纯装饰器渲染（TextEditorDecorationType，GitLens 行内 blame
 * 同款机制），不写入文档内容。文档一经编辑即清除（语句偏移失义）；新一轮执行以最新结果为准。
 * 含 vscode 依赖，不进单测。
 */
import * as vscode from 'vscode';
import { t } from './i18n';

/** 单条语句的执行结果（runStatements 逐语句上报） */
export interface StatementOutcome {
  /** 语句在文档中的起止偏移（执行时快照） */
  start: number;
  end: number;
  ok: boolean;
  durationMs: number;
  /** 失败时的错误码（DriverError code，hover 展示） */
  code?: string;
  /** 失败消息 / 取消说明（内联展示，截断） */
  message?: string;
}

export interface ExecutionAnnotations {
  /** 清空该文档的注记（新一轮执行开始时调用） */
  clear(uri: vscode.Uri): void;
  /** 追加一条语句结果并渲染（文档在执行期间被编辑过 → 版本不符丢弃） */
  report(uri: vscode.Uri, docVersion: number, outcome: StatementOutcome): void;
  /** M9-AI：该文档当前一轮的失败语句结果（编辑器内「✨ 修复建议」CodeLens 数据源） */
  failedOutcomes(uri: vscode.Uri): StatementOutcome[];
  /** 注记变化（report/clear）——CodeLens 据此重渲染（P-34：箭头包装保 this） */
  readonly onDidChange: vscode.Event<void>;
}

const GREEN = '#3fb950';
const RED = '#f85149';
const GRAY = '#8b949e';
/** 行尾内联错误消息截断长度（完整内容走 hover） */
const MAX_INLINE_MESSAGE = 60;

function svgUri(svg: string): vscode.Uri {
  return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
}

const CHECK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill="#3fb950" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>';
const CROSS_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill="#f85149" d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>';

export function createExecutionAnnotations(): ExecutionAnnotations & vscode.Disposable {
  // 类型持色彩/边距等固定样式；每条语句的动态文本经 DecorationOptions.renderOptions.after 覆盖
  const successInline = vscode.window.createTextEditorDecorationType({
    after: { color: GREEN, margin: '0 0 0 1ch' },
  });
  const successGutter = vscode.window.createTextEditorDecorationType({
    gutterIconPath: svgUri(CHECK_SVG),
    overviewRulerColor: GREEN,
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  const errorInline = vscode.window.createTextEditorDecorationType({
    after: { color: RED, margin: '0 0 0 1ch', fontStyle: 'italic' },
  });
  const errorGutter = vscode.window.createTextEditorDecorationType({
    gutterIconPath: svgUri(CROSS_SVG),
    overviewRulerColor: RED,
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  const canceledInline = vscode.window.createTextEditorDecorationType({
    after: { color: GRAY, margin: '0 0 0 1ch' },
  });

  /** uri → 当前一轮各语句的结果（新一轮 clear 后重建；文档编辑即丢弃） */
  const entries = new Map<string, StatementOutcome[]>();
  const changeEmitter = new vscode.EventEmitter<void>();

  const findDoc = (uri: vscode.Uri): vscode.TextDocument | undefined =>
    vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());

  const apply = (uri: vscode.Uri): void => {
    const list = entries.get(uri.toString()) ?? [];
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== uri.toString()) {
        continue;
      }
      const doc = editor.document;
      const success: vscode.DecorationOptions[] = [];
      const errors: vscode.DecorationOptions[] = [];
      const canceled: vscode.DecorationOptions[] = [];
      for (const o of list) {
        const range = new vscode.Range(doc.positionAt(o.start), doc.positionAt(o.end));
        if (o.ok) {
          success.push({
            range,
            hoverMessage: t('执行成功 · {0}ms', [o.durationMs]),
            renderOptions: { after: { contentText: `  ${o.durationMs}ms` } },
          });
        } else if (o.message === '已取消') {
          // core 消息原文比对，非 UI 文案，勿 t()
          canceled.push({
            range,
            hoverMessage: t('执行已取消'),
            renderOptions: { after: { contentText: `  ${t('已取消')}` } },
          });
        } else {
          const text = o.message ?? t('未知错误');
          errors.push({
            range,
            hoverMessage: `${o.code ? `${o.code}: ` : ''}${text}`,
            renderOptions: {
              after: { contentText: `  ${text.length > MAX_INLINE_MESSAGE ? `${text.slice(0, MAX_INLINE_MESSAGE)}…` : text}` },
            },
          });
        }
      }
      editor.setDecorations(successInline, success);
      editor.setDecorations(successGutter, success.map((o) => o.range));
      editor.setDecorations(errorInline, errors);
      editor.setDecorations(errorGutter, errors.map((o) => o.range));
      editor.setDecorations(canceledInline, canceled);
    }
  };

  const clear = (uri: vscode.Uri): void => {
    if (!entries.delete(uri.toString())) {
      return;
    }
    apply(uri); // entries 已空 → 全部装饰清零
    changeEmitter.fire();
  };

  const report = (uri: vscode.Uri, docVersion: number, outcome: StatementOutcome): void => {
    const doc = findDoc(uri);
    // 执行期间文档被编辑 → 偏移失义（编辑监听已清空），丢弃本次上报
    if (!doc || doc.version !== docVersion) {
      return;
    }
    const list = entries.get(uri.toString()) ?? [];
    list.push(outcome);
    entries.set(uri.toString(), list);
    apply(uri);
    changeEmitter.fire();
  };

  const disposables = [
    successInline,
    successGutter,
    errorInline,
    errorGutter,
    canceledInline,
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length > 0) {
        clear(e.document.uri);
      }
    }),
    // 注记挂在文档而非编辑器：切回该编辑器时重放（visibleTextEditors 集合变化）
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && entries.has(editor.document.uri.toString())) {
        apply(editor.document.uri);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => entries.delete(doc.uri.toString())),
  ];

  return {
    clear,
    report,
    failedOutcomes: (uri: vscode.Uri): StatementOutcome[] =>
      // core 消息原文比对，非 UI 文案，勿 t()
      (entries.get(uri.toString()) ?? []).filter((o) => !o.ok && o.message !== '已取消'),
    onDidChange: (fn) => changeEmitter.event(fn),
    dispose: () => {
      for (const d of disposables) {
        d.dispose();
      }
      changeEmitter.dispose();
      entries.clear();
    },
  };
}
