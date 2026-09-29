import { DriverError } from './errors';
import { Emitter } from './emitter';
import type { Disposable, IDatabaseDriver } from './types';

/** 驱动 API 版本：破坏性接口变更必须升主版本（驱动开发规范 §2） */
export const DRIVER_API_VERSION = 1;

export class DriverRegistry {
  private readonly drivers = new Map<string, IDatabaseDriver>();
  private readonly didRegister = new Emitter<IDatabaseDriver>();

  /**
   * 注册驱动。校验 apiVersion 兼容性与 id 全局唯一（ADR D-12 / 概要设计 5.1.2：
   * 冲突时拒绝后注册者并指明来源，由上层提示内置驱动/扩展撞名）。
   */
  register(driver: IDatabaseDriver): Disposable {
    if (driver.apiVersion !== DRIVER_API_VERSION) {
      throw new DriverError(
        'E_UNSUPPORTED',
        `驱动 "${driver.id}" 要求驱动 API v${driver.apiVersion}，当前核心提供 v${DRIVER_API_VERSION}，请升级插件或驱动`,
      );
    }
    if (this.drivers.has(driver.id)) {
      throw new DriverError(
        'E_VALIDATION',
        `驱动 id "${driver.id}" 已注册，拒绝后注册者（内置驱动与扩展可能撞名）`,
      );
    }
    this.drivers.set(driver.id, driver);
    this.didRegister.fire(driver);
    return {
      dispose: () => {
        this.drivers.delete(driver.id);
      },
    };
  }

  get(id: string): IDatabaseDriver | undefined {
    return this.drivers.get(id);
  }

  require(id: string): IDatabaseDriver {
    const driver = this.drivers.get(id);
    if (!driver) {
      throw new DriverError('E_NOT_FOUND', `驱动 "${id}" 未注册`);
    }
    return driver;
  }

  list(): IDatabaseDriver[] {
    return [...this.drivers.values()];
  }

  onDidRegister(fn: (driver: IDatabaseDriver) => void): Disposable {
    return this.didRegister.event(fn);
  }

  dispose(): void {
    this.drivers.clear();
  }
}
