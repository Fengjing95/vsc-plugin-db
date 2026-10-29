import * as vscode from 'vscode';
import { DriverError } from '@db-explorer/core';
import {
  SETTINGS_KEY_TYPES,
  SettingsGetResultSchema,
  type SettingsAllowedKey,
} from '@db-explorer/protocol';
import { t } from './i18n';

/**
 * 设置中心（交互稿 §16）：代理编辑 VSCode settings——读 getConfiguration、写 update
 * （User 作用域），与 VSCode 设置双向同步、不另立存储。
 * key 白名单 fail-closed（SETTINGS_ALLOWED_KEYS，protocol 定义）：webview 传任意其他键
 * 直接拒绝，防写非插件配置；值按键分型校验（number > 0 / enum / boolean / string）。
 * AI 密钥不在此（只进 SecretStorage，走 ai.* RPC）。
 */

const EXPORT_FORMATS = ['csv', 'json', 'xlsx', 'ndjson', 'markdown', 'insert'] as const;

export class SettingsHub {
  constructor(private readonly extensionVersion: string) {}

  getValues(): Record<SettingsAllowedKey, unknown> {
    const conf = vscode.workspace.getConfiguration('dbExplorer');
    const get = <T>(section: string, fallback: T): T => conf.get<T>(section, fallback);
    return {
      'dbExplorer.query.maxRows': get('query.maxRows', 1000),
      'dbExplorer.query.timeoutMs': get('query.timeoutMs', 15_000),
      'dbExplorer.connection.connectTimeoutMs': get('connection.connectTimeoutMs', 10_000),
      'dbExplorer.queries.directory': get('queries.directory', ''),
      'dbExplorer.export.defaultFormat': get('export.defaultFormat', 'csv'),
      'dbExplorer.export.chunkRows': get('export.chunkRows', 1000),
      'dbExplorer.transaction.idleTimeoutMs': get('transaction.idleTimeoutMs', 300_000),
      'dbExplorer.edit.allowNoPrimaryKey': get('edit.allowNoPrimaryKey', false),
      'dbExplorer.edit.cellMaxChars': get('edit.cellMaxChars', 262_144),
      'dbExplorer.tree.databaseTtlSeconds': get('tree.databaseTtlSeconds', 60),
      'dbExplorer.tree.columnTtlSeconds': get('tree.columnTtlSeconds', 300),
      'dbExplorer.ai.temperature': vscode.workspace.getConfiguration('dbExplorer.ai').get<number>('temperature', 0.7),
      'dbExplorer.ai.maxTokens': vscode.workspace.getConfiguration('dbExplorer.ai').get<number>('maxTokens', 2048),
    };
  }

  getSettings(): Record<string, unknown> {
    return SettingsGetResultSchema.parse({ version: this.extensionVersion, values: this.getValues() });
  }

  async update(key: SettingsAllowedKey, raw: unknown): Promise<void> {
    const value = this.coerce(key, raw);
    const section = key.replace('dbExplorer.', '');
    await vscode.workspace
      .getConfiguration('dbExplorer')
      .update(section, value, vscode.ConfigurationTarget.Global);
  }

  /** 值按键分型校验（number > 0 / number0 ≥ 0——temperature=0 是合法确定性采样；enum 限定导出格式）；非法即拒（E_VALIDATION） */
  private coerce(key: SettingsAllowedKey, raw: unknown): unknown {
    const type = SETTINGS_KEY_TYPES[key];
    if (type === 'boolean') {
      if (typeof raw !== 'boolean') {
        throw new DriverError('E_VALIDATION', t('{0} 需要布尔值', [key]));
      }
      return raw;
    }
    if (type === 'number' || type === 'number0') {
      const n = typeof raw === 'number' ? raw : Number(raw);
      const invalid = type === 'number0' ? !Number.isFinite(n) || n < 0 : !Number.isFinite(n) || n <= 0;
      if (invalid) {
        throw new DriverError('E_VALIDATION', t(type === 'number0' ? '{0} 需要不小于 0 的数值' : '{0} 需要正数', [key]));
      }
      return n;
    }
    if (type === 'enum') {
      if (typeof raw !== 'string' || !EXPORT_FORMATS.includes(raw as (typeof EXPORT_FORMATS)[number])) {
        throw new DriverError('E_VALIDATION', t('{0} 仅支持 csv / json / xlsx / ndjson / markdown / insert', [key]));
      }
      return raw;
    }
    if (typeof raw !== 'string') {
      throw new DriverError('E_VALIDATION', t('{0} 需要字符串', [key]));
    }
    return raw;
  }

  /** 定位到 VSCode 设置页：缺省打开本扩展的设置区域（@ext），提供 key 时定位到具体配置项（@id） */
  async openInVscodeSettings(key?: SettingsAllowedKey): Promise<void> {
    const query = key ? `@id:${key}` : '@ext:db-explorer-dev.db-kit';
    await vscode.commands.executeCommand('workbench.action.openSettings', query);
  }

  /** 关于页动作（枚举分发，不接收任意 uri/command） */
  async hubAction(action: 'openLog' | 'openGitHub' | 'openIssues' | 'openWebsite'): Promise<void> {
    const repo = 'https://github.com/Fengjing95/vsc-plugin-db';
    switch (action) {
      case 'openLog':
        await vscode.commands.executeCommand('dbExplorer.showLog');
        return;
      case 'openGitHub':
        await vscode.env.openExternal(vscode.Uri.parse(repo));
        return;
      case 'openIssues':
        await vscode.env.openExternal(vscode.Uri.parse(`${repo}/issues`));
        return;
      case 'openWebsite':
        await vscode.env.openExternal(vscode.Uri.parse('https://dbkit.easyremember.cn'));
        return;
    }
  }
}
