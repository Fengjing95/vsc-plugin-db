import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { DriverError, type ConnectionConfig, type DriverRegistry } from '@db-explorer/core';
import {
  ConnMetaParamsSchema,
  ConnSaveParamsSchema,
  ConnSchemaParamsSchema,
  ConnTestParamsSchema,
  RPC_PROTOCOL_VERSION,
  RpcMethods,
  type HandshakeResult,
} from '@db-explorer/protocol';
import { secretRefOf, type ConnectionStore } from '../services/connectionStore';
import { attachRpcHost } from '../rpc/rpcHost';
import { buildWebviewHtml, webviewDistRoot } from './webviewHtml';

const panels = new Map<string, vscode.WebviewPanel>();

export interface FormPanelDeps {
  store: ConnectionStore;
  registry: DriverRegistry;
  output: vscode.OutputChannel;
}

export function openConnectionForm(
  context: vscode.ExtensionContext,
  deps: FormPanelDeps,
  connId?: string,
): void {
  const viewId = `form:${connId ?? 'new'}`;
  const existing = panels.get(viewId);
  if (existing) {
    void existing.reveal();
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'dbExplorer.connectionForm',
    connId ? '编辑连接' : '新建连接',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(webviewDistRoot(context.extensionUri))],
    },
  );
  panels.set(viewId, panel);
  panel.onDidDispose(
    () => {
      panels.delete(viewId);
    },
    null,
    context.subscriptions,
  );

  panel.webview.html = buildWebviewHtml(panel.webview, context.extensionUri, {
    page: 'connectionForm',
    viewId,
    params: { connId: connId ?? '' },
  });

  attachRpcHost(panel.webview, {
    viewId,
    params: {},
    output: deps.output,
    handlers: formHandlers(deps, () => panel.dispose()),
  });
}

function formHandlers(
  deps: FormPanelDeps,
  closeSelf: () => void,
): Record<string, (params: unknown) => Promise<unknown>> {
  return {
    [RpcMethods.connMeta]: async (raw) => {
      const p = ConnMetaParamsSchema.parse(raw ?? {});
      const drivers = deps.registry.list().map((d) => ({ id: d.id, displayName: d.displayName }));
      const config = p.connId ? deps.store.get(p.connId) : undefined;
      const driverId = config?.driverId ?? drivers[0]?.id ?? '';
      const schema = driverId
        ? deps.registry.require(driverId).getConnectionFormSchema()
        : { fields: [] };
      const meta = config
        ? {
            connId: config.id,
            name: config.name,
            driverId: config.driverId,
            env: config.env ?? null,
            group: config.group ?? null,
            color: config.color ?? null,
            readOnly: config.readOnly ?? false,
            options: config.options,
            hasSecret: await deps.store.hasSecret(config.id),
          }
        : null;
      return { drivers, config: meta, schema };
    },

    [RpcMethods.connSchema]: async (raw) => {
      const p = ConnSchemaParamsSchema.parse(raw);
      return { schema: deps.registry.require(p.driverId).getConnectionFormSchema() };
    },

    [RpcMethods.connTest]: async (raw) => {
      const p = ConnTestParamsSchema.parse(raw);
      const driver = deps.registry.require(p.driverId);
      // 密码解析优先级：表单明文 > 已存密钥；测试用临时配置，不产生任何持久化
      const secret =
        p.password ?? (p.connId ? ((await deps.store.getSecret(p.connId)) ?? '') : '');
      const cfg: ConnectionConfig = {
        id: p.connId ?? 'test',
        name: 'test',
        driverId: p.driverId,
        options: p.options,
        secretRef: secretRefOf(p.connId ?? 'test'),
      };
      try {
        const result = await driver.testConnection(cfg, secret);
        return result.ok
          ? { ok: true, latencyMs: result.latencyMs, serverVersion: result.serverVersion }
          : {
              ok: false,
              errorCode: result.error?.code ?? 'E_INTERNAL',
              errorMessage: result.error?.message ?? '连接失败',
            };
      } catch (err) {
        const e = DriverError.is(err) ? err : new DriverError('E_INTERNAL', String(err));
        return { ok: false, errorCode: e.code, errorMessage: e.message };
      }
    },

    [RpcMethods.connSave]: async (raw) => {
      const p = ConnSaveParamsSchema.parse(raw);
      const driver = deps.registry.require(p.driverId);
      // 驱动规范 §3.1：type=password 字段不入 options，密码走 SecretStorage
      const secretKeys = new Set(
        driver
          .getConnectionFormSchema()
          .fields.filter((f) => f.type === 'password')
          .map((f) => f.key),
      );
      const options: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p.options)) {
        if (!secretKeys.has(k)) {
          options[k] = v;
        }
      }

      const connId = p.connId ?? randomUUID();
      if (p.password) {
        await deps.store.setPassword(connId, p.password);
      }
      await deps.store.save({
        id: connId,
        name: p.name.trim(),
        driverId: p.driverId,
        env: p.env ?? undefined,
        group: p.group ?? undefined,
        color: p.color ?? undefined,
        readOnly: p.readOnly ?? false,
        options,
        secretRef: secretRefOf(connId),
      });
      closeSelf();
      return { connId };
    },

    // 占位：握手在表单页同样可用（协议一致性），返回最小快照
    [RpcMethods.handshake]: async () => {
      const result: HandshakeResult = {
        protocolVersion: RPC_PROTOCOL_VERSION,
        viewId: 'form',
        params: {},
        changeSet: { inserts: [], updates: [], deletes: [] },
        edit: { enabled: false, reason: '连接表单视图' },
        capabilities: { supportsSQL: false, supportsDdl: false },
      };
      return result;
    },
  };
}
