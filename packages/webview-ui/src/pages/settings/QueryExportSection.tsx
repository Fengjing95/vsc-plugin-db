import { useEffect, useState } from 'react';
import type { SettingsGetResult } from '@db-explorer/protocol';
import { SETTINGS_ALLOWED_KEYS } from '@db-explorer/protocol';
import { request } from '../../rpc/client';

/**
 * 查询与导出分类（设置中心，交互稿 §16）：插件常用 VSCode settings 的代理编辑——
 * 即改即存（onChange 直写 User 作用域配置，与 VSCode 设置双向同步、不另立存储）。
 * 顶部统一入口定位到 VSCode 设置的本扩展区域（逐项定位过于突兀，实机反馈撤除）。
 */

interface NumberField {
  key: (typeof SETTINGS_ALLOWED_KEYS)[number];
  label: string;
  description: string;
  unit?: string;
}

const NUMBER_FIELDS: NumberField[] = [
  {
    key: 'dbExplorer.query.maxRows',
    label: '结果行数上限',
    description: '单次查询 / 表格取数 / Console 结果的行数上限',
    unit: '行',
  },
  {
    key: 'dbExplorer.query.timeoutMs',
    label: '查询超时',
    description: '驱动调用的默认超时时间',
    unit: 'ms',
  },
  {
    key: 'dbExplorer.connection.connectTimeoutMs',
    label: '建连超时',
    description: '建立连接的超时时间（含 SSH 隧道建立）',
    unit: 'ms',
  },
  {
    key: 'dbExplorer.export.chunkRows',
    label: '导出批量',
    description: '导出时每批读取的行数',
    unit: '行',
  },
  {
    key: 'dbExplorer.transaction.idleTimeoutMs',
    label: '交互式事务空闲超时',
    description: '超时未操作自动 ROLLBACK',
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
    return <div className="text-[12px] text-muted-foreground">加载中…</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部统一入口：定位到 VSCode 设置的本扩展区域（实机反馈：逐项链接突兀） */}
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-muted-foreground">以下配置与 VSCode 设置（DB Kit 区域）双向同步。</div>
        <button
          type="button"
          className="shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => void request('settings.openInVscodeSettings', {})}
        >
          在 VSCode 设置中打开
        </button>
      </div>
      {NUMBER_FIELDS.map((f) => (
        <div key={f.key} className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12px] font-medium">{f.label}</div>
            <div className="text-[11px] text-muted-foreground">{f.description}</div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <input
              type="number"
              value={valueOf(f.key)}
              min={1}
              onChange={(e) => void update(f.key, Number(e.target.value))}
              className="h-7 w-24 rounded-sm border border-border bg-input px-2 text-right text-[12px] outline-none focus:border-primary"
            />
            {f.unit && <span className="text-[11px] text-muted-foreground">{f.unit}</span>}
          </div>
        </div>
      ))}

      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <div className="min-w-0">
          <div className="text-[12px] font-medium">导出默认格式</div>
          <div className="text-[11px] text-muted-foreground">表格与结果面板导出的默认格式</div>
        </div>
        <select
          value={valueOf('dbExplorer.export.defaultFormat')}
          onChange={(e) => void update('dbExplorer.export.defaultFormat', e.target.value)}
          className="h-7 rounded-sm border border-border bg-input px-2 text-[12px] outline-none focus:border-primary"
        >
          <option value="csv">CSV</option>
          <option value="json">JSON</option>
          <option value="xlsx">Excel (xlsx)</option>
        </select>
      </div>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] font-medium">查询文件存储目录</div>
          <div className="text-[11px] text-muted-foreground">
            树「查询」目录与保存查询的磁盘位置；留空用扩展全局存储（不与工作区绑定），支持 ~/ 前缀
          </div>
        </div>
        <input
          type="text"
          value={valueOf('dbExplorer.queries.directory')}
          placeholder="（全局存储）"
          onChange={(e) => void update('dbExplorer.queries.directory', e.target.value)}
          className="h-7 w-56 rounded-sm border border-border bg-input px-2 text-[12px] outline-none focus:border-primary"
        />
      </div>

      <label className="flex items-start justify-between gap-3 border-t border-border pt-4">
        <div className="min-w-0">
          <div className="text-[12px] font-medium">无主键表编辑</div>
          <div className="text-[11px] text-muted-foreground">
            开启后无主键表可用「全列匹配」模式编辑（WHERE 含全部列原值；含二进制列的表仍不可编辑）
          </div>
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
