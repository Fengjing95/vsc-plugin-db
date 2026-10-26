/**
 * e2e bridge 扩展（仅测试，不入发布物）：随 VSCode 以第二个 --extensionDevelopmentPath 装载，
 * 在 extension host 内起 HTTP 桥（127.0.0.1，端口经 E2E_BRIDGE_PORT 注入）。
 *
 * 为什么需要桥：runner 在 VSCode 进程外，CDP 只能驱动 DOM——命令执行（打开视图、打开文档等）
 * 与扩展宿主状态（vscode.env.language / 工作区）没有外部通道，桥补上这条控制面。
 * 零产品代码依赖：本扩展独立于 db-kit，不污染扩展本身。
 */
import * as http from 'node:http';
import * as vscode from 'vscode';

/** JSON 安全化：命令结果可能含 Uri/Range/bigint/undefined，统一可序列化 */
function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value ?? null, (_k, v) => (typeof v === 'bigint' ? String(v) : v === undefined ? null : v)),
    );
  } catch {
    return String(value);
  }
}

/** 参数变换：{$uri: "..."} → vscode.Uri（workbench.action.files.openFolder / vscode.open 等命令需要） */
function reviveArgs(args: unknown[]): unknown[] {
  return args.map((a) => {
    if (a !== null && typeof a === 'object' && '$uri' in (a as Record<string, unknown>)) {
      return vscode.Uri.parse(String((a as Record<string, unknown>)['$uri']));
    }
    return a;
  });
}

export function activate(_context: vscode.ExtensionContext): void {
  const port = Number(process.env.E2E_BRIDGE_PORT ?? 0);
  if (!port) {
    return; // 非 e2e 环境装载时静默空转（无 env 即无服务）
  }
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/state') {
      send(200, {
        language: vscode.env.language,
        version: vscode.version,
        workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
        extensions: vscode.extensions.all
          .filter((e) => e.packageJSON?.name)
          .map((e) => `${e.packageJSON.publisher}.${e.packageJSON.name}`),
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/execute') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        void (async () => {
          try {
            const body = JSON.parse(raw || '{}') as { command?: string; args?: unknown[] };
            if (!body.command) {
              send(400, { ok: false, error: 'command required' });
              return;
            }
            const result = await vscode.commands.executeCommand(body.command, ...reviveArgs(body.args ?? []));
            send(200, { ok: true, result: jsonSafe(result) });
          } catch (err) {
            send(200, { ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        })();
      });
      return;
    }
    send(404, { ok: false, error: 'not found' });
  });
  server.listen(port, '127.0.0.1');
}

export function deactivate(): void {
  // 生命周期随 extension host；runner 侧直接终止 VSCode 进程
}
