import { randomUUID } from 'node:crypto';
import type { ConnExportConfigsResult, ConnImportConfigsResult } from '@db-explorer/protocol';
import {
  ConnExportConfigsParamsSchema,
  ConnImportConfigsParamsSchema,
} from '@db-explorer/protocol';
import type { ConnectionConfig, DriverRegistry } from '@db-explorer/core';
import type { ConnectionStore } from './connectionStore';
import { t } from './i18n';

/**
 * 连接配置导入/导出（概要设计 §5.2 P2 关账 / §5.13 / ADR D-32）。
 *
 * C-10 红线：密码与 SSH 密码绝不落文件——导出只含 hasSecret 形态的 `${secret}` 占位
 * （标记「导入后首连需补录」），密钥本体只存 SecretStorage；connId/secretRef 不导出
 * （导入侧 randomUUID 重生成 + secretRefOf 重写）。
 * 纯函数（buildExportFile / parseImportJson / auditNoSecrets / importPlan）与 vscode
 * 解耦，可单测；审计单测断言导出 JSON 深层无密码本体字段。
 */

/** 密码占位标记：§5.2 口径「导出不含密码（`${secret}` 占位）」 */
export const SECRET_PLACEHOLDER = '${secret}';

/** 导出文件格式版本 */
export const EXPORT_FORMAT_VERSION = 1;

export interface ExportedConnection {
  name: string;
  driverId: string;
  env?: 'dev' | 'test' | 'prod';
  group?: string;
  color?: string;
  readOnly?: boolean;
  /** @since D-33：树库列表筛选（undefined = 显示全部）；仅随导出顺带迁移，键名非密码形态零消毒冲突 */
  visibleDatabases?: string[];
  options: Record<string, unknown>;
  ssl?: Record<string, unknown>;
  ssh?: Record<string, unknown>;
  /** `${secret}` 占位 = 源连接存有密码，首连需补录；缺省 = 源无密码 */
  password?: string;
  /** SSH 密码同口径（仅 ssh.enabled 时可能出现） */
  sshPassword?: string;
}

export interface ExportFile {
  dbkit: number;
  exportedAt: string;
  connections: ExportedConnection[];
}

/** 密码形态键（导出深度消毒 + 审计共用；不区分大小写） */
const SECRET_KEY_PATTERN = /^(password|passwd|pwd|secret|passphrase|credentials?)$/i;

/** 深度消毒：剔除对象树中密码形态键（防御性——options/ssl/ssh 由驱动定义，永不 trust） */
export function sanitizeForExport(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(k)) {
      continue;
    }
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = sanitizeForExport(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function buildExportConnection(
  cfg: ConnectionConfig,
  hasSecret: boolean,
  hasSshSecret: boolean,
): ExportedConnection {
  const ssh = cfg.ssh && typeof cfg.ssh === 'object' ? sanitizeForExport(cfg.ssh) : undefined;
  const exported: ExportedConnection = {
    name: cfg.name,
    driverId: cfg.driverId,
    env: cfg.env,
    group: cfg.group,
    color: cfg.color,
    readOnly: cfg.readOnly === true ? true : undefined,
    visibleDatabases:
      Array.isArray(cfg.visibleDatabases) && cfg.visibleDatabases.length > 0 ? [...cfg.visibleDatabases] : undefined,
    options: sanitizeForExport(cfg.options ?? {}),
    ssl: cfg.ssl && typeof cfg.ssl === 'object' ? sanitizeForExport(cfg.ssl) : undefined,
    ssh,
  };
  if (hasSecret) {
    exported.password = SECRET_PLACEHOLDER;
  }
  if (hasSshSecret && ssh && ssh.enabled === true) {
    exported.sshPassword = SECRET_PLACEHOLDER;
  }
  return exported;
}

export function buildExportFile(connections: ExportedConnection[]): ExportFile {
  return { dbkit: EXPORT_FORMAT_VERSION, exportedAt: new Date().toISOString(), connections };
}

/**
 * C-10 审计：递归收集「密码形态键携带了非占位值」的路径——非空数组即违规
 * （占位符 `${secret}` 是唯一允许的字符串值）。
 */
export function auditNoSecrets(value: unknown, prefix = ''): string[] {
  const offenders: string[] = [];
  if (value === null || typeof value !== 'object') {
    return offenders;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (SECRET_KEY_PATTERN.test(k)) {
      if (typeof v === 'string' && v !== '' && v !== SECRET_PLACEHOLDER) {
        offenders.push(path);
      } else if (v !== undefined && v !== null && v !== '' && typeof v !== 'string') {
        offenders.push(path);
      }
      continue;
    }
    if (v !== null && typeof v === 'object') {
      offenders.push(...auditNoSecrets(v, path));
    }
  }
  return offenders;
}

/** 导入解析：ExportFile 形状或裸数组（宽容）；整体非法抛错，条目级问题走 skip 报告 */
export function parseImportJson(text: string): ExportFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(t('文件不是合法 JSON'));
  }
  if (Array.isArray(data)) {
    return { dbkit: EXPORT_FORMAT_VERSION, exportedAt: '', connections: data as ExportedConnection[] };
  }
  if (data !== null && typeof data === 'object' && Array.isArray((data as ExportFile).connections)) {
    return data as ExportFile;
  }
  throw new Error(t('文件形状不符：期望 {dbkit, connections: [...]} 或连接数组'));
}

export interface ImportEntry {
  cfg: Omit<ConnectionConfig, 'id' | 'secretRef'>;
}

export interface ImportPlan {
  usable: ImportEntry[];
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * 导入规划：条目形状校验（name/driverId 非空字符串、options 为对象）+ driverId 经
 * registry 校验（未注册跳过并报告）；options/ssl/ssh 深度消毒（导入文件不可信）。
 */
export function importPlan(file: ExportFile, registry: DriverRegistry): ImportPlan {
  const usable: ImportEntry[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const entry of file.connections) {
    const name = entry && typeof entry.name === 'string' ? entry.name : '';
    if (!name || typeof entry.driverId !== 'string' || !entry.driverId) {
      skipped.push({ name: name || '?', reason: t('条目形状不合法（缺 name/driverId）') });
      continue;
    }
    if (!registry.get(entry.driverId)) {
      skipped.push({ name, reason: t('驱动 "{0}" 未安装或未注册', [entry.driverId]) });
      continue;
    }
    usable.push({
      cfg: {
        name,
        driverId: entry.driverId,
        env: entry.env === 'dev' || entry.env === 'test' || entry.env === 'prod' ? entry.env : undefined,
        group: typeof entry.group === 'string' ? entry.group : undefined,
        color: typeof entry.color === 'string' ? entry.color : undefined,
        readOnly: entry.readOnly === true ? true : undefined,
        // D-33：筛选集合按字符串数组校验（非数组/含非字符串项 = 忽略回落显示全部）
        visibleDatabases:
          Array.isArray(entry.visibleDatabases) && entry.visibleDatabases.every((n) => typeof n === 'string')
            ? entry.visibleDatabases
            : undefined,
        options: sanitizeForExport(entry.options && typeof entry.options === 'object' ? entry.options : {}),
        ssl: entry.ssl && typeof entry.ssl === 'object' ? sanitizeForExport(entry.ssl) : undefined,
        ssh: entry.ssh && typeof entry.ssh === 'object' ? sanitizeForExport(entry.ssh) : undefined,
      },
    });
  }
  return { usable, skipped };
}

/** 重名加「（导入）」后缀提示（仍冲突则追加序号） */
export function resolveNameConflict(name: string, existing: Set<string>): string {
  if (!existing.has(name)) {
    return name;
  }
  const base = t('{0}（导入）', [name]);
  if (!existing.has(base)) {
    return base;
  }
  let n = 2;
  while (existing.has(`${base} ${n}`)) {
    n++;
  }
  return `${base} ${n}`;
}

/** 服务：RPC（conn.exportConfigs / conn.importConfigs）与树/视图命令共用的单一来源 */
export class ConfigTransferService {
  constructor(
    private readonly store: ConnectionStore,
    private readonly registry: DriverRegistry,
    private readonly log: (line: string, level?: 'info' | 'warn' | 'error') => void = () => undefined,
  ) {}

  async exportConfigs(raw: unknown): Promise<ConnExportConfigsResult> {
    const p = ConnExportConfigsParamsSchema.parse(raw);
    const all = this.store.list();
    const list = p.connId ? all.filter((c) => c.id === p.connId) : all;
    const connections: ExportedConnection[] = [];
    for (const cfg of list) {
      const hasSecret = await this.store.hasSecret(cfg.id);
      const sshEnabled = (cfg.ssh as { enabled?: unknown } | undefined)?.enabled === true;
      const hasSshSecret = sshEnabled && (await this.store.getSshPassword(cfg.id)) !== undefined;
      connections.push(buildExportConnection(cfg, hasSecret, hasSshSecret));
    }
    const offenders = auditNoSecrets(connections);
    if (offenders.length > 0) {
      // 防御红线：消毒后仍检出密码形态值 → 拒绝导出（不得落盘）
      this.log(`[configTransfer] 导出审计拦截：${offenders.join(', ')}`, 'error');
      throw new Error(t('导出审计未通过：配置中检出密码形态字段，已中止导出'));
    }
    this.log(`[configTransfer] 导出 ${connections.length} 个连接配置（不含密码，C-10）`);
    return { json: JSON.stringify(buildExportFile(connections), null, 2), count: connections.length };
  }

  async importConfigs(raw: unknown): Promise<ConnImportConfigsResult> {
    const p = ConnImportConfigsParamsSchema.parse(raw);
    const file = parseImportJson(p.json);
    const plan = importPlan(file, this.registry);
    const connIds: string[] = [];
    const existingNames = new Set(this.store.list().map((c) => c.name));
    for (const entry of plan.usable) {
      const name = resolveNameConflict(entry.cfg.name, existingNames);
      existingNames.add(name);
      const id = randomUUID();
      await this.store.save({ ...entry.cfg, name, id, secretRef: `dbExplorer.secrets.${id}` });
      connIds.push(id);
      this.log(`[configTransfer] 已导入连接：${name}（${entry.cfg.driverId}，新 connId=${id}；密码未迁移，首连补录）`);
    }
    return { imported: connIds.length, connIds, skipped: plan.skipped };
  }
}
