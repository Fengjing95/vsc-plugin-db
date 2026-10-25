import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { IconPlay } from '../../components/ui/icons';
import { t } from '../../lib/i18n';
import { useTableStore } from '../../store/tableStore';
import { SqlInput } from './SqlInput';

/**
 * 自由条件栏（交互稿 §4.4 v0.1.3）：WHERE 与 ORDER BY 两个手写输入框，
 * 语法高亮 + 列名/关键字补全；应用 → 服务端拼接进最终语句并回到第 1 页；
 * 未应用的改动在 [应用] 上以蓝点提示。清空同时移除全局搜索（回到全量数据）。
 */
export function FilterBar() {
  const allColumns = useTableStore((s) => (s.allColumns.length > 0 ? s.allColumns : s.columns));
  const appliedWhere = useTableStore((s) => s.appliedWhere);
  const appliedOrderBy = useTableStore((s) => s.appliedOrderBy);
  const applyQuery = useTableStore((s) => s.applyQuery);

  const [where, setWhere] = useState(appliedWhere);
  const [orderBy, setOrderBy] = useState(appliedOrderBy);
  const dirty = where !== appliedWhere || orderBy !== appliedOrderBy;

  // 应用/清空后同步本地草稿
  useEffect(() => {
    setWhere(appliedWhere);
    setOrderBy(appliedOrderBy);
  }, [appliedWhere, appliedOrderBy]);

  const apply = (): void => {
    void applyQuery(where.trim(), orderBy.trim());
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-2 py-1.5">
      <span className="shrink-0 font-mono text-[11px] font-medium text-muted-foreground" title={t('table.filter.whereTitle')}>
        WHERE
      </span>
      <SqlInput
        value={where}
        onChange={setWhere}
        onApply={apply}
        columns={allColumns}
        context="where"
        ariaLabel={t('table.filter.whereAria')}
        widthClass="min-w-56 flex-1"
      />
      <span className="ml-1 shrink-0 font-mono text-[11px] font-medium text-muted-foreground" title={t('table.filter.orderTitle')}>
        ORDER BY
      </span>
      <SqlInput
        value={orderBy}
        onChange={setOrderBy}
        onApply={apply}
        columns={allColumns}
        context="order"
        ariaLabel={t('table.filter.orderAria')}
        widthClass="w-64"
      />
      <Button
        variant="primary"
        size="sm"
        className="w-7 px-0"
        disabled={!dirty}
        onClick={apply}
        aria-label={t('table.filter.apply')}
        title={dirty ? t('table.filter.applyTitle') : t('table.filter.unchanged')}
      >
        <IconPlay size={13} />
      </Button>
    </div>
  );
}
