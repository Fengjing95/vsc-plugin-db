import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { Dialog } from '../../components/ui/dialog';
import { Select } from '../../components/ui/select';
import { t } from '../../lib/i18n';
import { useTableStore } from '../../store/tableStore';

/**
 * 数据导入映射 Dialog（概要设计 §5.13 / ADR D-32）：文件信息 + 列映射（文件列 → 表列
 * 下拉/忽略，parse 按名对齐建议）+ 错行报告 + 前 N 行原值预览 + 空字段语义开关。
 * 预览为文件原值（CSV 全字符串）；类型转换在写入侧按列 normalizedType 执行（C-7）。
 * 纯展示组件，状态在 tableStore.importDialog（解析/启动生命周期由 store 管）。
 */
export function ImportDialog() {
  const dialog = useTableStore((s) => s.importDialog);
  const setImportMapping = useTableStore((s) => s.setImportMapping);
  const setImportEmptyAsNull = useTableStore((s) => s.setImportEmptyAsNull);
  const confirmImport = useTableStore((s) => s.confirmImport);
  const closeImportDialog = useTableStore((s) => s.closeImportDialog);

  const close = () => closeImportDialog();

  if (dialog.parsing) {
    return (
      <Dialog open onOpenChange={(o) => !o && close()} title={t('table.import.title', [''])} footer={null}>
        <div className="flex h-32 items-center justify-center text-[13px] text-muted-foreground">
          {t('table.import.parsing')}
        </div>
      </Dialog>
    );
  }
  const parse = dialog.parse;
  if (!parse) {
    return null;
  }

  const mappedTargets = new Set(
    dialog.mapping.filter((m) => m.tableColumn !== null).map((m) => m.tableColumn as string),
  );
  const tableColumnOptions = parse.tableColumns.map((c) => ({
    value: c.name,
    label: `${c.name} · ${c.type}${c.autoIncrement ? ' · AI' : ''}${c.isPrimaryKey ? ' · PK' : ''}`,
  }));
  const formatLabel = parse.format === 'xlsx' ? 'Excel (xlsx)' : parse.format.toUpperCase();

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title={t('table.import.title', [parse.fileName])}
      contentClassName="w-[min(880px,94vw)]"
      footer={
        <>
          <span className="mr-auto text-muted-foreground">
            <Checkbox
              checked={dialog.emptyAsNull}
              onCheckedChange={(v) => setImportEmptyAsNull(v)}
              label={dialog.emptyAsNull ? t('table.import.emptyAsNull') : t('table.import.emptyAsNullOff')}
            />
          </span>
          <Button variant="secondary" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={dialog.starting} onClick={() => void confirmImport()}>
            {t('table.import.start', [parse.validRows])}
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="shrink-0 border-b border-border px-4 py-2 text-[12px] text-muted-foreground">
          {t('table.import.meta', [
            parse.fileName,
            formatLabel,
            parse.rowsTotal,
            parse.validRows,
            parse.skippedRows,
          ])}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          <div className="mb-1 text-[12px] font-medium">{t('table.import.columnMapping')}</div>
          <div className="mb-3 flex flex-col gap-1">
            {dialog.mapping.map((m) => (
              <div key={m.fileColumn} className="flex items-center gap-2">
                <span className="w-44 shrink-0 truncate text-[13px]" title={m.fileColumn}>
                  {m.fileColumn}
                </span>
                <span aria-hidden className="shrink-0 text-muted-foreground">→</span>
                <Select
                  className="w-64"
                  aria-label={`${m.fileColumn} ${t('table.import.selectColumn')}`}
                  value={m.tableColumn ?? ''}
                  onValueChange={(v) => setImportMapping(m.fileColumn, v === '' ? null : v)}
                  options={[
                    { value: '', label: t('table.import.ignore') },
                    ...tableColumnOptions.map((o) => ({
                      value: o.value,
                      label: mappedTargets.has(o.value) && o.value !== m.tableColumn ? `⚠ ${o.label}` : o.label,
                    })),
                  ]}
                />
                {m.tableColumn !== null && (
                  <span className="text-[11px] text-muted-foreground">{m.type}</span>
                )}
              </div>
            ))}
          </div>

          {parse.errors.length > 0 && (
            <div className="mb-3 rounded-sm border border-destructive/40 px-3 py-2">
              <div className="text-[12px] font-medium text-destructive">
                {t('table.import.errors', [parse.errorsTotal])}
              </div>
              <div className="mt-1 flex max-h-24 flex-col gap-0.5 overflow-y-auto text-[11px] text-muted-foreground">
                {parse.errors.map((e) => (
                  <div key={`${e.row}-${e.message}`}>{t('table.import.errorRow', [e.row, e.message])}</div>
                ))}
                {parse.errorsTotal > parse.errors.length && (
                  <div>… +{parse.errorsTotal - parse.errors.length}</div>
                )}
              </div>
            </div>
          )}

          <div className="mb-1 text-[12px] font-medium">{t('table.import.preview', [parse.preview.length])}</div>
          <div className="overflow-x-auto rounded-sm border border-border">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr>
                  {parse.fileColumns.map((c) => (
                    <th key={c} className="max-w-40 truncate border-b border-border px-2 py-1 text-left font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {parse.preview.map((row, i) => (
                  <tr key={i} className="border-b border-border last:border-b-0">
                    {row.map((v, j) => (
                      <td key={j} className="max-w-40 truncate px-2 py-1 align-top">
                        {v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
