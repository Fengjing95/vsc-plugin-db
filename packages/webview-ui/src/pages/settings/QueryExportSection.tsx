import { useEffect, useState } from 'react';
import type { SettingsGetResult } from '@db-explorer/protocol';
import { SETTINGS_ALLOWED_KEYS } from '@db-explorer/protocol';
import { formText, t, type MessageKey } from '../../lib/i18n';
import { request } from '../../rpc/client';

/**
 * 查询与导出分类（设置中心，交互稿 §16）：插件常用 VSCode settings 的代理编辑——
 * 即改即存（onChange 直写 User 作用域配置，与 VSCode 设置双向同步、不另立存储）。
 * 顶部统一入口定位到 VSCode 设置的本扩展区域（逐项定位过于突兀，实机反馈撤除）。
 */

interface NumberField {
  key: (typeof SETTINGS_ALLOWED_KEYS)[number];
  label: MessageKey;
  description: MessageKey;
  /** 单位后缀（'行' 等语言相关值存域键，经 formText 解析；'ms' 等通用原词原样展示） */
  unit?: string;
}

const NUMBER_FIELDS: NumberField[] = [
  {
    key: 'dbExplorer.query.maxRows',
    label: 'settings.qe.maxRows',
    description: 'settings.qe.maxRowsDesc',
    unit: 'settings.qe.unitRows',
  },
  {
    key: 'dbExplorer.query.timeoutMs',
    label: 'settings.qe.timeout',
    description: 'settings.qe.timeoutDesc',
    unit: 'ms',
  },
  {
    key: 'dbExplorer.connection.connectTimeoutMs',
    label: 'settings.qe.connectTimeout',
    description: 'settings.qe.connectTimeoutDesc',
    unit: 'ms',
  },
  {
    key: 'dbExplorer.export.chunkRows',
    label: 'settings.qe.exportChunk',
    description: 'settings.qe.exportChunkDesc',
    unit: 'settings.qe.unitRows',
  },
  {
    key: 'dbExplorer.transaction.idleTimeoutMs',
    label: 'settings.qe.txIdleTimeout',
    description: 'settings.qe.txIdleTimeoutDesc',
    unit: 'ms',
  },
];

export function QueryExportSection(): React.JSX.Element {
  const [data, setData] = useState<SettingsGetResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await request<SettingsGetResult>('settings.get', {});
        if (!cancelled) {
          setData(result);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const update = async (key: string, value: unknown): Promise<void> => {
    // 乐观更新（即改即存）；失败重新拉取兜底
    setData((d) => (d ? { ...d, values: { ...d.values, [key]: value } } : d));
    try {
      await request('settings.update', { key, value });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      const result = await request<SettingsGetResult>('settings.get', {}).catch(() => null);
      if (result) {
        setData(result);
      }
    }
  };

  const valueOf = (key: string): string => String(data?.values[key] ?? '');

  if (error !== '') {
    return <div className="text-[12px] text-destructive">{error}</div>;
  }
  if (!data) {
    return <div className="text-[12px] text-muted-foreground">{t('common.loading')}</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部统一入口：定位到 VSCode 设置的本扩展区域（实机反馈：逐项链接突兀） */}
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-muted-foreground">{t('settings.qe.syncNote')}</div>
        <button
          type="button"
          className="shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => void request('settings.openInVscodeSettings', {})}
        >
          {t('settings.qe.openInVscode')}
        </button>
      </div>
      {NUMBER_FIELDS.map((f) => (
        <div key={f.key} className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12px] font-medium">{t(f.label)}</div>
            <div className="text-[11px] text-muted-foreground">{t(f.description)}</div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <input
              type="number"
              value={valueOf(f.key)}
              min={1}
              onChange={(e) => void update(f.key, Number(e.target.value))}
              className="h-7 w-24 rounded-sm border border-border bg-input px-2 text-right text-[12px] outline-none focus:border-primary"
            />
            {f.unit && <span className="text-[11px] text-muted-foreground">{formText(f.unit)}</span>}
          </div>
        </div>
      ))}

      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <div className="min-w-0">
          <div className="text-[12px] font-medium">{t('settings.qe.defaultFormat')}</div>
          <div className="text-[11px] text-muted-foreground">{t('settings.qe.defaultFormatDesc')}</div>
        </div>
        <select
          value={valueOf('dbExplorer.export.defaultFormat')}
          onChange={(e) => void update('dbExplorer.export.defaultFormat', e.target.value)}
          className="h-7 rounded-sm border border-border bg-input px-2 text-[12px] outline-none focus:border-primary"
        >
          <option value="csv">CSV</option>
          <option value="json">JSON</option>
          <option value="xlsx">Excel (xlsx)</option>
          <option value="ndjson">{t('settings.qe.fmt.ndjson')}</option>
          <option value="markdown">Markdown</option>
          <option value="insert">SQL (INSERT)</option>
        </select>
      </div>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] font-medium">{t('settings.qe.queriesDir')}</div>
          <div className="text-[11px] text-muted-foreground">{t('settings.qe.queriesDirDesc')}</div>
        </div>
        <input
          type="text"
          value={valueOf('dbExplorer.queries.directory')}
          placeholder={t('settings.qe.dirPlaceholder')}
          onChange={(e) => void update('dbExplorer.queries.directory', e.target.value)}
          className="h-7 w-56 rounded-sm border border-border bg-input px-2 text-[12px] outline-none focus:border-primary"
        />
      </div>

      <label className="flex items-start justify-between gap-3 border-t border-border pt-4">
        <div className="min-w-0">
          <div className="text-[12px] font-medium">{t('settings.qe.noPkEdit')}</div>
          <div className="text-[11px] text-muted-foreground">{t('settings.qe.noPkEditDesc')}</div>
        </div>
        <input
          type="checkbox"
          checked={data.values['dbExplorer.edit.allowNoPrimaryKey'] === true}
          onChange={(e) => void update('dbExplorer.edit.allowNoPrimaryKey', e.target.checked)}
          className="mt-1"
        />
      </label>
    </div>
  );
}
