import { describe, expect, it } from 'vitest';
import { DriverRegistry, type ConnectionConfig, type IDatabaseDriver } from '@db-explorer/core';
import { type ConnectionStore } from './connectionStore';
import {
  SECRET_PLACEHOLDER,
  auditNoSecrets,
  buildExportConnection,
  buildExportFile,
  ConfigTransferService,
  importPlan,
  parseImportJson,
  resolveNameConflict,
  sanitizeForExport,
} from './configTransfer';

/**
 * 连接配置导入/导出单测（§5.2 P2 / D-32）：往返形状、驱动缺失跳过、重名后缀、
 * C-10 审计红线（导出 JSON 深层无密码本体——`${secret}` 占位是唯一合法密码形态值）。
 */

function fakeDriver(id: string): IDatabaseDriver {
  return {
    id,
    displayName: id,
    apiVersion: 1,
    capabilities: {
      supportsSQL: true,
      supportsTransaction: true,
      supportsInteractiveTransaction: false,
      supportsMultipleDatabases: true,
      supportsMultiStatement: true,
      supportsCancel: false,
      supportsDdl: false,
      hierarchy: [],
      editable: true,
      pagination: 'offset',
    },
    getConnectionFormSchema: () => ({ fields: [] }),
    testConnection: async () => ({ ok: true }),
    connect: async () => {
      throw new Error('not implemented');
    },
  } as unknown as IDatabaseDriver;
}

const baseCfg: ConnectionConfig = {
  id: 'conn-1',
  name: '生产 MySQL',
  driverId: 'mysql',
  group: '生产环境',
  color: '#ff0000',
  readOnly: false,
  env: 'prod',
  options: { host: 'db.example.com', port: 3306, database: 'app' },
  secretRef: 'dbExplorer.secrets.conn-1',
};

describe('buildExportConnection / buildExportFile', () => {
  it('导出形状：不含 connId/secretRef；hasSecret → `${secret}` 占位', () => {
    const ec = buildExportConnection(baseCfg, true, false);
    expect(ec).toMatchObject({
      name: '生产 MySQL',
      driverId: 'mysql',
      env: 'prod',
      group: '生产环境',
      color: '#ff0000',
      options: { host: 'db.example.com', port: 3306, database: 'app' },
      password: SECRET_PLACEHOLDER,
    });
    expect(Object.keys(ec)).not.toContain('connId');
    expect(JSON.stringify(ec)).not.toContain('conn-1');
    expect(ec.sshPassword).toBeUndefined();
  });

  it('无密码连接不出现占位；SSH 密码占位仅在 ssh.enabled 时出现', () => {
    const noSecret = buildExportConnection({ ...baseCfg, ssh: { enabled: true, host: 'jump', port: 22 } }, false, true);
    expect(noSecret.password).toBeUndefined();
    expect(noSecret.sshPassword).toBe(SECRET_PLACEHOLDER);
    const sshOff = buildExportConnection({ ...baseCfg, ssh: { enabled: false } }, true, true);
    expect(sshOff.password).toBe(SECRET_PLACEHOLDER);
    expect(sshOff.sshPassword).toBeUndefined();
  });

  it('options 深度消毒：密码形态键剔除（防御——正常配置本就不含）', () => {
    const dirty = { host: 'h', password: 'leak', nested: { secret: 'x', ok: 1 } };
    expect(sanitizeForExport(dirty)).toEqual({ host: 'h', nested: { ok: 1 } });
  });

  it('文件形状：dbkit 版本 + exportedAt + connections 数组', () => {
    const f = buildExportFile([buildExportConnection(baseCfg, true, false)]);
    expect(f.dbkit).toBe(1);
    expect(f.exportedAt).not.toBe('');
    expect(f.connections).toHaveLength(1);
  });

  it('D-33：visibleDatabases 随导出迁移（未设置不出现字段；空数组同 undefined）', () => {
    expect(buildExportConnection(baseCfg, true, false).visibleDatabases).toBeUndefined();
    expect(
      buildExportConnection({ ...baseCfg, visibleDatabases: [] }, true, false).visibleDatabases,
    ).toBeUndefined();
    const filtered = buildExportConnection({ ...baseCfg, visibleDatabases: ['app', 'report'] }, true, false);
    expect(filtered.visibleDatabases).toEqual(['app', 'report']);
    // 键名非密码形态：消毒/审计零误伤（该字段在顶层，sanitizeForExport 只递归对象值不触及数组）
    expect(auditNoSecrets(buildExportFile([filtered]))).toEqual([]);
  });
});

describe('auditNoSecrets（C-10 红线）', () => {
  it('导出文件审计通过（占位符是唯一合法密码形态值）', () => {
    const file = buildExportFile([
      buildExportConnection({ ...baseCfg, ssh: { enabled: true, host: 'jump' } }, true, true),
      buildExportConnection(baseCfg, false, false),
    ]);
    expect(auditNoSecrets(file)).toEqual([]);
  });

  it('深层密码本体被检出（含嵌套 options/ssh）', () => {
    expect(auditNoSecrets({ password: 'hunter2' })).toEqual(['password']);
    expect(auditNoSecrets({ options: { dbPassword: 'x' } })).toEqual([]);
    expect(auditNoSecrets({ ssh: { password: 'leak' } })).toEqual(['ssh.password']);
    expect(auditNoSecrets({ credential: { token: 42 } })).toEqual(['credential']);
    expect(auditNoSecrets({ secret: SECRET_PLACEHOLDER })).toEqual([]);
    expect(auditNoSecrets({ secret: '' })).toEqual([]);
  });
});

describe('parseImportJson / importPlan', () => {
  it('ExportFile 形状与裸数组均可解析', () => {
    const f = buildExportFile([buildExportConnection(baseCfg, true, false)]);
    expect(parseImportJson(JSON.stringify(f)).connections).toHaveLength(1);
    expect(parseImportJson(JSON.stringify(f.connections)).connections).toHaveLength(1);
    expect(() => parseImportJson('{"a":1}')).toThrow();
    expect(() => parseImportJson('not json')).toThrow();
  });

  it('driverId 未注册 → 跳过并报告；条目形状不合法 → 跳过', () => {
    const registry = new DriverRegistry();
    registry.register(fakeDriver('mysql'));
    const file = {
      connections: [
        buildExportConnection(baseCfg, true, false),
        { name: '未知驱动', driverId: 'oracle-x', options: {} },
        { name: '', driverId: 'mysql', options: {} },
        { driverId: 'mysql' },
      ],
    };
    const plan = importPlan(parseImportJson(JSON.stringify(file)), registry);
    expect(plan.usable).toHaveLength(1);
    expect(plan.skipped).toEqual([
      { name: '未知驱动', reason: expect.stringContaining('oracle-x') },
      { name: '?', reason: expect.any(String) },
      { name: '?', reason: expect.any(String) },
    ]);
  });

  it('导入条目消毒：密码形态键剔除、env 非法值丢弃', () => {
    const registry = new DriverRegistry();
    registry.register(fakeDriver('mysql'));
    const plan = importPlan(
      parseImportJson(
        JSON.stringify({
          connections: [{ name: 'x', driverId: 'mysql', env: 'staging', options: { host: 'h', password: 'leak' } }],
        }),
      ),
      registry,
    );
    expect(plan.usable).toHaveLength(1);
    expect(plan.usable[0].cfg.options).toEqual({ host: 'h' });
    expect(plan.usable[0].cfg.env).toBeUndefined();
  });

  it('D-33：visibleDatabases 合法数组随导入保留；非法形态回落 undefined', () => {
    const registry = new DriverRegistry();
    registry.register(fakeDriver('mysql'));
    const plan = importPlan(
      parseImportJson(
        JSON.stringify({
          connections: [
            { name: 'a', driverId: 'mysql', visibleDatabases: ['app'], options: {} },
            { name: 'b', driverId: 'mysql', visibleDatabases: 'app', options: {} },
            { name: 'c', driverId: 'mysql', visibleDatabases: ['app', 3], options: {} },
          ],
        }),
      ),
      registry,
    );
    expect(plan.usable).toHaveLength(3);
    expect(plan.usable[0].cfg.visibleDatabases).toEqual(['app']);
    expect(plan.usable[1].cfg.visibleDatabases).toBeUndefined();
    expect(plan.usable[2].cfg.visibleDatabases).toBeUndefined();
  });
});

describe('resolveNameConflict（重名后缀）', () => {
  it('无冲突原样；冲突加「（导入）」；再冲突追加序号', () => {
    expect(resolveNameConflict('a', new Set(['b']))).toBe('a');
    expect(resolveNameConflict('a', new Set(['a']))).toBe('a（导入）');
    expect(resolveNameConflict('a', new Set(['a', 'a（导入）']))).toBe('a（导入） 2');
    expect(resolveNameConflict('a', new Set(['a', 'a（导入）', 'a（导入） 2']))).toBe('a（导入） 3');
  });
});

describe('ConfigTransferService', () => {
  const saved: ConnectionConfig[] = [];
  const secrets = new Map<string, string | undefined>([['conn-1', 'real-secret']]);
  const store = {
    list: () => [...saved],
    save: async (cfg: ConnectionConfig) => {
      saved.push(cfg);
    },
    hasSecret: async (id: string) => secrets.get(id) !== undefined,
    getSshPassword: async () => undefined,
  } as unknown as ConnectionStore;

  it('exportConfigs：往返 JSON → importConfigs 重生成 connId + secretRef 重写', async () => {
    saved.length = 0;
    const registry = new DriverRegistry();
    registry.register(fakeDriver('mysql'));
    saved.push(baseCfg);
    const svc = new ConfigTransferService(store, registry);
    const exported = await svc.exportConfigs({ connId: 'conn-1' });
    expect(exported.count).toBe(1);
    expect(exported.json).toContain(SECRET_PLACEHOLDER);
    expect(exported.json).not.toContain('real-secret');

    const imported = await svc.importConfigs({ json: exported.json });
    expect(imported.imported).toBe(1);
    expect(imported.skipped).toEqual([]);
    const cfg = saved[1];
    expect(cfg.id).not.toBe('conn-1');
    expect(cfg.secretRef).toBe(`dbExplorer.secrets.${cfg.id}`);
    expect(cfg.name).toBe('生产 MySQL（导入）');
    expect(cfg.options).toEqual(baseCfg.options);
  });

  it('importConfigs：未知驱动跳过且汇总', async () => {
    saved.length = 0;
    const registry = new DriverRegistry();
    const svc = new ConfigTransferService(store, registry);
    const r = await svc.importConfigs({
      json: JSON.stringify({ connections: [{ name: 'x', driverId: 'nope', options: {} }] }),
    });
    expect(r.imported).toBe(0);
    expect(r.skipped).toEqual([{ name: 'x', reason: expect.stringContaining('nope') }]);
  });

  it('配置本体藏密码：消毒剔除后导出成功且不落本体（双层防线：sanitize → audit 兜底）', async () => {
    saved.length = 0;
    const registry = new DriverRegistry();
    registry.register(fakeDriver('mysql'));
    saved.push({ ...baseCfg, options: { host: 'h', password: 'inline-leak' } });
    const svc = new ConfigTransferService(store, registry);
    const r = await svc.exportConfigs({});
    expect(r.json).not.toContain('inline-leak');
    // 密码形态键的唯一合法值 = `${secret}` 占位（本体永不落盘）
    expect(r.json).toContain(`"password": "${SECRET_PLACEHOLDER}"`);
  });
});
