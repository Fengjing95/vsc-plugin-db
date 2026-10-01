export {};

type WebviewPage = 'table' | 'connectionForm' | 'console';

declare global {
  interface BootstrapData {
    page: WebviewPage;
    viewId: string;
    params: Record<string, string>;
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
