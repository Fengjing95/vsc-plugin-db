export {};

type WebviewPage =
  | 'table'
  | 'connectionForm'
  | 'console'
  | 'tableDesign'
  | 'databaseDesign'
  | 'erDiagram'
  | 'schemaCompare'
  | 'settings';

declare global {
  interface BootstrapData {
    page: WebviewPage;
    viewId: string;
    params: Record<string, string>;
    /** UI 语言与词典（extension buildWebviewHtml 注入；stub 场景可缺省 → 回落 zh） */
    lang?: string;
    messages?: Record<string, string>;
  }

  interface Window {
    __BOOTSTRAP__?: BootstrapData;
    acquireVsCodeApi?: () => {
      postMessage(msg: unknown): void;
      getState(): unknown;
      setState(state: unknown): void;
    };
  }
}
