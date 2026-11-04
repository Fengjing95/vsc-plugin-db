import * as vscode from 'vscode';
import type { ConnectionConfig } from '@db-explorer/core';
import type { ConnectionStore } from './connectionStore';
import { t } from './i18n';

/**
 * 首连补录（概要设计 §5.2 既有设计落地，ADR D-32 批次 C）：
 * 导入的连接配置取不到密码时弹一次性输入框（不暴露错误堆栈——干净的 DriverError 由
 * ConnectionManager 抛出）；输入即存 SecretStorage（后续连接不再提示）；
 * 留空回车 = 无密码跳过（密码可选的连接一次摩擦后永久静默）；Esc = 本次连接中止。
 * ConnectionManager 不 import vscode 的边界延续：提示器经此注入（可桩单测）。
 */
export interface SecretPrompter {
  /** 数据库密码补录；undefined = 用户取消（中止本次连接） */
  ensurePassword(cfg: ConnectionConfig): Promise<string | undefined>;
  /** SSH 密码补录；undefined = 用户取消 */
  ensureSshPassword(cfg: ConnectionConfig): Promise<string | undefined>;
}

export function createSecretPrompter(store: ConnectionStore): SecretPrompter {
  const prompt = async (cfg: ConnectionConfig, title: string, promptText: string): Promise<string | undefined> => {
    const entered = await vscode.window.showInputBox({
      title,
      prompt: promptText,
      password: true,
      ignoreFocusOut: true,
      placeHolder: t('留空并回车 = 无密码；Esc = 取消连接'),
    });
    if (entered === undefined) {
      return undefined;
    }
    return entered;
  };
  return {
    ensurePassword: async (cfg) => {
      const entered = await prompt(
        cfg,
        t('连接 "{0}" 需要密码', [cfg.name]),
        t('导入的连接配置不含密码（安全口径：密码不随配置文件流转）。输入密码将存入本机 SecretStorage'),
      );
      if (entered === undefined) {
        return undefined;
      }
      await store.setPassword(cfg.id, entered);
      return entered;
    },
    ensureSshPassword: async (cfg) => {
      const entered = await prompt(
        cfg,
        t('连接 "{0}" 的 SSH 跳板机需要密码', [cfg.name]),
        t('导入的连接配置不含 SSH 密码。输入密码将存入本机 SecretStorage'),
      );
      if (entered === undefined) {
        return undefined;
      }
      await store.setSshPassword(cfg.id, entered);
      return entered;
    },
  };
}
