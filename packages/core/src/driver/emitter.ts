import type { Disposable } from './types';

/** 轻量事件发射器：避免 core 运行时依赖 vscode.EventEmitter */
export class Emitter<T> {
  private readonly listeners = new Set<(e: T) => void>();

  event(fn: (e: T) => void): Disposable {
    this.listeners.add(fn);
    return {
      dispose: () => {
        this.listeners.delete(fn);
      },
    };
  }

  fire(e: T): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch {
        // 监听器异常不阻断事件分发
      }
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
