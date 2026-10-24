import * as vscode from 'vscode';
import { DriverError } from '@db-explorer/core';
import {
  SETTINGS_KEY_TYPES,
  SettingsGetResultSchema,
  type SettingsAllowedKey,
} from '@db-explorer/protocol';

/**
 * 设置中心（交互稿 §16）：代理编辑 VSCode settings——读 getConfiguration、写 update
 * （User 作用域），与 VSCode 设置双向同步、不另立存储。
 * key 白名单 fail-closed（SETTINGS_ALLOWED_KEYS，protocol 定义）：webview 传任意其他键
 * 直接拒绝，防写非插件配置；值按键分型校验（number > 0 / enum / boolean / string）。
 * AI 密钥不在此（只进 SecretStorage，走 ai.* RPC）。
 */

const EXPORT_FORMATS = ['csv', 'json', 'xlsx'] as const;

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

  /** 值按键分型校验（number > 0；enum 限定导出格式）；非法即拒（E_VALIDATION） */
  private coerce(key: SettingsAllowedKey, raw: unknown): unknown {
    const type = SETTINGS_KEY_TYPES[key];
    if (type === 'boolean') {
      if (typeof raw !== 'boolean') {
        throw new DriverError('E_VALIDATION', `${key} 需要布尔值`);
      }
      return raw;
    }
    if (type === 'number') {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        throw new DriverError('E_VALIDATION', `${key} 需要正数`);
      }
      return n;
    }
    if (type === 'enum') {
      if (typeof raw !== 'string' || !EXPORT_FORMATS.includes(raw as (typeof EXPORT_FORMATS)[number])) {
        throw new DriverError('E_VALIDATION', `${key} 仅支持 csv / json / xlsx`);
      }
      return raw;
    }
    if (typeof raw !== 'string') {
      throw new DriverError('E_VALIDATION', `${key} 需要字符串`);
    }
    return raw;
  }

  /** 定位到 VSCode 设置页的指定配置项（@id 过滤） */
  async openInVscodeSettings(key: SettingsAllowedKey): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openSettings', `@id:${key}`);
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
