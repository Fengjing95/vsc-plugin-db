import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { DriverError, type ConnectionConfig, type DriverRegistry } from '@db-explorer/core';
import {
  ConnDbOptionsParamsSchema,
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
import {
  SSH_FORM_FIELDS,
  optionsFromSshConfig,
  resolveSshTarget,
  sshConfigFromOptions,
  type FingerprintStore,
} from '../services/sshTunnel';
import { buildWebviewHtml, webviewDistRoot } from './webviewHtml';

const panels = new Map<string, vscode.WebviewPanel>();

export interface FormPanelDeps {
  store: ConnectionStore;
  registry: DriverRegistry;
  output: vscode.OutputChannel;
  /** SSH 主机指纹库（TOFU 持久化，与 ConnectionManager 共享同一 globalState） */
  sshFingerprints: FingerprintStore;
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
      const driverSchema = driverId
        ? deps.registry.require(driverId).getConnectionFormSchema()
        : { fields: [] };
      // SSH 隧道为驱动无关的标准字段组（扩展层统一注入，驱动不感知）
      const schema = { fields: [...driverSchema.fields, ...SSH_FORM_FIELDS] };
      const meta = config
        ? {
            connId: config.id,
            name: config.name,
            driverId: config.driverId,
            env: config.env ?? null,
            group: config.group ?? null,
            color: config.color ?? null,
            readOnly: config.readOnly ?? false,
            options: { ...config.options, ...optionsFromSshConfig(config.ssh) },
            hasSecret: await deps.store.hasSecret(config.id),
          }
        : null;
      return { drivers, config: meta, schema };
    },

    [RpcMethods.connSchema]: async (raw) => {
      const p = ConnSchemaParamsSchema.parse(raw);
      const schema = deps.registry.require(p.driverId).getConnectionFormSchema();
      return { schema: { fields: [...schema.fields, ...SSH_FORM_FIELDS] } };
    },

    [RpcMethods.connTest]: async (raw) => {
      const p = ConnTestParamsSchema.parse(raw);
      const driver = deps.registry.require(p.driverId);
      // 密码解析优先级：表单明文 > 已存密钥；测试用临时配置，不产生任何持久化
      const secret =
        p.password ?? (p.connId ? ((await deps.store.getSecret(p.connId)) ?? '') : '');
      // SSH 密码同理（表单明文优先，回退已存）
      const sshSecret =
        (typeof p.options.sshPassword === 'string' && p.options.sshPassword
          ? p.options.sshPassword
          : undefined) ??
        (p.connId ? ((await deps.store.getSshPassword(p.connId)) ?? '') : '');
      let cfg: ConnectionConfig = {
        id: p.connId ?? 'test',
        name: 'test',
        driverId: p.driverId,
        options: p.options,
        secretRef: secretRefOf(p.connId ?? 'test'),
      };
      let tunnel: Awaited<ReturnType<typeof resolveSshTarget>>['tunnel'];
      try {
        // SSH 隧道测试路径与真实建连同源（resolveSshTarget）；draft 指纹键避免污染正式连接记录
        const resolved = await resolveSshTarget(cfg, sshSecret, deps.sshFingerprints, 10_000);
        cfg = resolved.cfg;
        tunnel = resolved.tunnel;
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
      } finally {
        tunnel?.dispose();
      }
    },

    [RpcMethods.connDbOptions]: async (raw) => {
      const p = ConnDbOptionsParamsSchema.parse(raw);
      const driver = deps.registry.require(p.driverId);
      // 无感降级契约（驱动规范 §3 @since v0.1.4）：驱动未实现/解析失败/拉取失败一律回空数组，
      // Webview 静默降级为自由手输，绝不显示错误
      if (typeof driver.listDatabaseOptions !== 'function') {
        return { databases: [] };
      }
      // 密码解析与 conn.test 同源：表单明文 > 已存密钥；SSH 隧道同走 resolveSshTarget
      const secret =
        p.password ?? (p.connId ? ((await deps.store.getSecret(p.connId)) ?? '') : '');
      const sshSecret =
        (typeof p.options.sshPassword === 'string' && p.options.sshPassword
          ? p.options.sshPassword
          : undefined) ??
        (p.connId ? ((await deps.store.getSshPassword(p.connId)) ?? '') : '');
      let cfg: ConnectionConfig = {
        id: p.connId ?? 'test',
        name: 'test',
        driverId: p.driverId,
        options: p.options,
        secretRef: secretRefOf(p.connId ?? 'test'),
      };
      let tunnel: Awaited<ReturnType<typeof resolveSshTarget>>['tunnel'];
      try {
        const resolved = await resolveSshTarget(cfg, sshSecret, deps.sshFingerprints, 10_000);
        cfg = resolved.cfg;
        tunnel = resolved.tunnel;
        const databases = await driver.listDatabaseOptions(cfg, secret);
        return { databases };
      } catch (err) {
        deps.output.appendLine(
          `[form] 列库建议失败（无感降级）: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { databases: [] };
      } finally {
        tunnel?.dispose();
      }
    },

    [RpcMethods.connSave]: async (raw) => {
      const p = ConnSaveParamsSchema.parse(raw);
      const driver = deps.registry.require(p.driverId);
      // 驱动规范 §3.1 + SSH 标准组：type=password 字段不入 options，密码走 SecretStorage
      const secretKeys = new Set(
        [...driver.getConnectionFormSchema().fields, ...SSH_FORM_FIELDS]
          .filter((f) => f.type === 'password')
          .map((f) => f.key),
      );
      const options: Record<string, unknown> = {};
      let sshPassword = '';
      for (const [k, v] of Object.entries(p.options)) {
        if (k === 'sshPassword') {
          sshPassword = typeof v === 'string' ? v : '';
          continue;
        }
        if (!secretKeys.has(k)) {
          options[k] = v;
        }
      }
      // ssh* 字段归位 cfg.ssh 槽位（core ConnectionConfig 预留），options 只留驱动自有参数
      const SSH_KEYS = ['sshEnabled', 'sshHost', 'sshPort', 'sshUsername', 'sshPrivateKeyPath', 'sshInsecureHostKey'];
      const sshOptions: Record<string, unknown> = {};
      for (const k of SSH_KEYS) {
        if (options[k] !== undefined) {
          sshOptions[k] = options[k];
          delete options[k];
        }
      }
      const ssh = sshConfigFromOptions(sshOptions);

      const connId = p.connId ?? randomUUID();
      if (p.password) {
        await deps.store.setPassword(connId, p.password);
      }
      if (sshPassword) {
        await deps.store.setSshPassword(connId, sshPassword);
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
        ssh,
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
