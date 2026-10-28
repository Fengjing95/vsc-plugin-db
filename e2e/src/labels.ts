/** e2e 定位器用的短键文案（zh/en 双份，取自权威词表：package.nls*.json 与 protocol src/i18n/*）。
 * 断言尽量绑结构化 role 与本表短键，禁止断言长句；新增定位文案时两侧成对补（键名注明词表键）。 */
export interface UiLabels {
  /** 树标题栏「新建连接」按钮（manifest command.dbExplorer.newConnection.title） */
  newConnection: string;
  /** 连接表单保存按钮（webview form.save） */
  save: string;
  /** 连接表单测试按钮（webview form.test.button） */
  testConnection: string;
  /** 树上「表」目录节点（extension KIND_FOLDERS label） */
  tables: string;
  /** 树 inline 图标「打开表格视图」（manifest openTable title） */
  openTableView: string;
  /** 表格工具栏预览按钮 aria-label（webview table.toolbar.previewSql） */
  previewSql: string;
  /** 预览 Modal 确认按钮（webview table.preview.confirm） */
  previewConfirm: string;
  /** Console 危险横幅文本前缀（webview console.bannerDetected） */
  bannerDetected: string;
  /** Console 横幅「仍要执行」按钮（webview console.runAnyway） */
  runAnyway: string;
  /** 通用取消按钮（webview common.cancel） */
  cancel: string;
  /** 结果面板「图表」Tab（webview console.chartTab，D-29） */
  chartTab: string;
  /** 结果面板「结果 1」Tab（webview console.resultTab） */
  resultTab1: string;
}

export function uiLabels(locale: string): UiLabels {
  if (locale.startsWith('zh')) {
    return {
      newConnection: '新建连接',
      save: '保存',
      testConnection: '测试连接',
      tables: '表',
      openTableView: '打开表格视图',
      previewSql: '预览提交 SQL',
      previewConfirm: '确认提交',
      bannerDetected: '检测到可能影响全表的语句',
      runAnyway: '仍要执行',
      cancel: '取消',
      chartTab: '图表',
      resultTab1: '结果 1',
    };
  }
  return {
    newConnection: 'New Connection',
    save: 'Save',
    testConnection: 'Test Connection',
    tables: 'Tables',
    openTableView: 'Open Table View',
    previewSql: 'Preview SQL',
    previewConfirm: 'Commit',
    bannerDetected: 'A statement that may affect the whole table was detected',
    runAnyway: 'Run Anyway',
    cancel: 'Cancel',
    chartTab: 'Chart',
    resultTab1: 'Result 1',
  };
}

/** 表格工具栏提交按钮 aria-label（webview table.toolbar.commitCount：提交变更（{0}）/ Commit Changes ({0})） */
export function commitCountLabel(locale: string, n: number): string {
  return locale.startsWith('zh') ? `提交变更（${n}）` : `Commit Changes (${n})`;
}
