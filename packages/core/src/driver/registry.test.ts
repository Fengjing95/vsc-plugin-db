import { describe, expect, it, vi } from 'vitest';
import { DriverError } from './errors';
import { DRIVER_API_VERSION, DriverRegistry } from './registry';
import { Emitter } from './emitter';
import type { IDatabaseDriver } from './types';

function fakeDriver(id: string, apiVersion = DRIVER_API_VERSION): IDatabaseDriver {
  return {
    id,
    displayName: id,
    apiVersion,
    capabilities: {
      supportsSQL: false,
      supportsTransaction: false,
      supportsInteractiveTransaction: false,
      supportsMultipleDatabases: false,
      supportsMultiStatement: false,
      supportsCancel: false,
      supportsDdl: false,
      hierarchy: ['connection'],
      editable: false,
      pagination: 'none',
    },
    getConnectionFormSchema: () => ({ fields: [] }),
    testConnection: async () => ({ ok: true }),
    connect: vi.fn(),
  };
}

describe('DriverRegistry', () => {
  it('注册后可通过 id 获取并列出', () => {
    const registry = new DriverRegistry();
    registry.register(fakeDriver('mysql'));
    registry.register(fakeDriver('redis'));

    expect(registry.get('mysql')?.id).toBe('mysql');
    expect(registry.list().map((d) => d.id).sort()).toEqual(['mysql', 'redis']);
    expect(registry.get('missing')).toBeUndefined();
  });

  it('重复 id：拒绝后注册者（E_VALIDATION）', () => {
    const registry = new DriverRegistry();
    registry.register(fakeDriver('mysql'));

    expect(() => registry.register(fakeDriver('mysql'))).toThrowError(DriverError);
    try {
      registry.register(fakeDriver('mysql'));
    } catch (err) {
      expect(DriverError.is(err) && err.code).toBe('E_VALIDATION');
    }
    expect(registry.list()).toHaveLength(1);
  });

  it('apiVersion 不匹配：拒绝注册（E_UNSUPPORTED）', () => {
    const registry = new DriverRegistry();
    expect(() => registry.register(fakeDriver('future', DRIVER_API_VERSION + 1))).toThrowError(
      DriverError,
    );
    try {
      registry.register(fakeDriver('future', DRIVER_API_VERSION + 1));
    } catch (err) {
      expect(DriverError.is(err) && err.code).toBe('E_UNSUPPORTED');
    }
  });

  it('onDidRegister 事件随注册触发，dispose 可注销', () => {
    const registry = new DriverRegistry();
    const seen: string[] = [];
    const sub = registry.onDidRegister((d) => seen.push(d.id));

    registry.register(fakeDriver('a'));
    expect(seen).toEqual(['a']);

    sub.dispose();
    registry.register(fakeDriver('b'));
    expect(seen).toEqual(['a']);
  });

  it('Emitter：监听器抛错不阻断其他监听器', () => {
    const emitter = new Emitter<string>();
    const calls: string[] = [];
    emitter.event(() => {
      throw new Error('boom');
    });
    emitter.event((e) => calls.push(e));

    emitter.fire('x');
    expect(calls).toEqual(['x']);
  });
});
