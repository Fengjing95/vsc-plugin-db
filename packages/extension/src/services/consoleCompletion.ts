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
 * - 注册范围：全部 sql 文档（untitled Console + 普通 .sql 文件——落实 §5.5.3「普通 .sql 只给关键字级」，
 *   M8 起不再仅限已绑定文件动态注册）
 * - provider 内部按文档绑定过滤：已绑定 → metadataCache 的补全缓存（Console 打开时预热；
 *   DoD 缓存命中 <100ms）；未绑定 → 仅关键字级（VSCode 状态栏可看到「未绑定连接」提示）
 * - 上下文：resolveCompletionContext（单库 + 别名，D-04）
 */
const SELECTOR: vscode.DocumentSelector = { language: 'sql' };

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

export function registerConsoleCompletion(service: ConsoleService): vscode.Disposable {
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

  return vscode.languages.registerCompletionItemProvider(SELECTOR, provider, '.');
}
