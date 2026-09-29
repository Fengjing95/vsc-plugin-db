export {};

declare global {
  interface BootstrapData {
    viewId: string;
    params: { connId: string; db: string; obj: string };
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
