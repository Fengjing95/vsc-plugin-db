import * as vscode from 'vscode';
import {
  BASE_FUNCTIONS,
  BASE_KEYWORDS,
  GENERIC_SNIPPETS,
  buildCompletionDescriptors,
  resolveCompletionContext,
  type CompletionItemDescriptor,
} from '@db-explorer/core';
import type { ConsoleService } from './consoleService';

/**
 * Console 补全（概要设计 §5.5.3 / 评审 P1-1）：
 * - 注册范围：全部 sql 文档（untitled Console + 普通 .sql 文件——落实 §5.5.3「普通 .sql 只给
 *   关键字级」，M8 起不再仅限已绑定文件动态注册）
 * - provider 内部按文档绑定过滤：已绑定 → metadataCache 的补全缓存（Console 打开时预热；
 *   DoD 缓存命中 <100ms；词表为方言全量：关键字/函数/片段）；未绑定 → 关键字 + 常用标准函数
 *   + 通用片段（不含库/表等连接元数据）
 * - 上下文：resolveCompletionContext（单库 + 别名，D-04）
 * - 排序：buildCompletionDescriptors 关键字置顶（v0.2.12 用户口径），其后按上下文优先级出序
 *   （列位：列→函数；任意位：表/列→片段→函数→库；表位保持表/库优先），extension 按序号生成
 *   sortText，VSCode 不再按字母重排
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

function toItem(d: CompletionItemDescriptor, index: number): vscode.CompletionItem {
  const item = new vscode.CompletionItem(d.label, kindOf(d.kind));
  if (d.detail) {
    item.detail = d.detail;
  }
  // 保序：纯层已按上下文优先级出序，序号即 sortText（字典序稳定且不受 VSCode 字母重排影响）
  item.sortText = index.toString(36).padStart(4, '0');
  if (d.kind === 'snippet' && d.insert) {
    item.insertText = new vscode.SnippetString(d.insert);
  }
  return item;
}

export function registerConsoleCompletion(service: ConsoleService): vscode.Disposable {
  const provider: vscode.CompletionItemProvider<vscode.CompletionItem> = {
    async provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position) {
      const state = service.bindingForDocument(doc);
      if (!state) {
        // P1-1：未绑定 → 关键字 + 常用标准函数 + 通用片段（无连接元数据）
        return [
          ...BASE_KEYWORDS.map((k, i) => toItem({ label: k, kind: 'keyword' }, i)),
          ...BASE_FUNCTIONS.map((f, i) => toItem({ label: f, kind: 'function', detail: '函数' }, i)),
          ...GENERIC_SNIPPETS.map((s, i) =>
            toItem({ label: s.label, kind: 'snippet', detail: s.description ?? s.body, insert: s.body }, i),
          ),
        ];
      }
      const source = await service.completionFor(state.consoleId);
      if (!source) {
        return [];
      }
      const ctx = resolveCompletionContext(doc.getText(), doc.offsetAt(position));
      return buildCompletionDescriptors(source, ctx).map(toItem);
    },
  };

  return vscode.languages.registerCompletionItemProvider(SELECTOR, provider, '.');
}
