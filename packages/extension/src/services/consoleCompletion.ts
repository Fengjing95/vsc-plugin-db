import * as vscode from 'vscode';
import {
  BASE_KEYWORDS,
  buildCompletionDescriptors,
  resolveCompletionContext,
  type CompletionItemDescriptor,
} from '@db-explorer/core';
import type { ConsoleService } from './consoleService';

/**
 * Console 补全（概要设计 §5.5.3 / 评审 P1-1）：
 * - 注册范围隔离：untitled sql 文档 + **已绑定连接**的文件（动态注册）；
 *   用户的普通 .sql 文件不注册（禁止污染），未绑定的 untitled 文档只给关键字级补全
 * - 数据源：metadataCache 的补全缓存（Console 打开时预热；DoD 缓存命中 <100ms）
 * - 上下文：resolveCompletionContext（单库 + 别名，D-04）
 */
const UNTITLED_SELECTOR: vscode.DocumentSelector = { language: 'sql', scheme: 'untitled' };

function kindOf(kind: CompletionItemDescriptor['kind']): vscode.CompletionItemKind {
  switch (kind) {
    case 'function':
      return vscode.CompletionItemKind.Function;
    case 'database':
      return vscode.CompletionItemKind.Module;
    case 'table':
      return vscode.CompletionItemKind.Struct;
    case 'column':
      return vscode.CompletionItemKind.Field;
    case 'snippet':
      return vscode.CompletionItemKind.Snippet;
    default:
      return vscode.CompletionItemKind.Keyword;
  }
}

export function registerConsoleCompletion(
  context: vscode.ExtensionContext,
  service: ConsoleService,
): vscode.Disposable {
  const provider: vscode.CompletionItemProvider<vscode.CompletionItem> = {
    async provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position) {
      const state = service.bindingForDocument(doc);
      if (!state) {
        // P1-1：未绑定 → 仅关键字级（VSCode 状态栏可看到“未绑定连接”提示）
        return BASE_KEYWORDS.map((k) => new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword));
      }
      const source = await service.completionFor(state.consoleId);
      if (!source) {
        return [];
      }
      const ctx = resolveCompletionContext(doc.getText(), doc.offsetAt(position));
      return buildCompletionDescriptors(source, ctx).map((d) => {
        const item = new vscode.CompletionItem(d.label, kindOf(d.kind));
        if (d.detail) {
          item.detail = d.detail;
        }
        return item;
      });
    },
  };

  const fileProviders = new Map<string, vscode.Disposable>();
  const syncFileProviders = (): void => {
    const bound = new Set(service.boundFilePaths());
    for (const [path, d] of [...fileProviders]) {
      if (!bound.has(path)) {
        d.dispose();
        fileProviders.delete(path);
      }
    }
    for (const path of bound) {
      if (!fileProviders.has(path)) {
        const selector: vscode.DocumentSelector = { language: 'sql', scheme: 'file', pattern: path };
        fileProviders.set(path, vscode.languages.registerCompletionItemProvider(selector, provider, '.'));
      }
    }
  };

  const untitled = vscode.languages.registerCompletionItemProvider(UNTITLED_SELECTOR, provider, '.');
  syncFileProviders();
  return vscode.Disposable.from(untitled, service.onBindingsChanged(syncFileProviders), {
    dispose: () => {
      for (const d of fileProviders.values()) {
        d.dispose();
      }
      fileProviders.clear();
    },
  });
}
