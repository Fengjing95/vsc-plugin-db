import { useEffect, useState } from 'react';
import { request } from '../../rpc/client';

/** 关于页动作（与 extension SettingsHub.hubAction 的枚举对齐） */
type HubAction = 'openLog' | 'openGitHub' | 'openIssues' | 'openWebsite';

const LINKS: Array<{ action: HubAction; label: string; description: string }> = [
  { action: 'openLog', label: '打开日志', description: '输出面板 Database Explorer 频道（问题排查第一现场）' },
  { action: 'openGitHub', label: 'GitHub 仓库', description: '源码与文档' },
  { action: 'openIssues', label: 'Issue 反馈', description: '报 bug / 提需求' },
  { action: 'openWebsite', label: '产品官网', description: '能力介绍与在线演示' },
];

export function AboutSection(): React.JSX.Element {
  const [version, setVersion] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await request<{ version: string }>('settings.get', {});
        if (!cancelled) {
          setVersion(result.version);
        }
      } catch {
        // 版本拿不到就不显示（非关键信息）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-[13px] font-semibold">DB Kit{version ? ` · v${version}` : ''}</div>
        <div className="mt-1 text-[11px] leading-5 text-muted-foreground">
          在 VSCode 内浏览、查询、编辑 MySQL / PostgreSQL / Redis / SQLite / MongoDB / SQL Server / Oracle
          的数据库工具。
        </div>
      </div>
      <div className="flex flex-col divide-y divide-border border-t border-border">
        {LINKS.map((l) => (
          <button
            key={l.action}
            type="button"
            className="flex items-center justify-between px-1 py-2 text-left hover:bg-accent"
            onClick={() => void request('settings.hubAction', { action: l.action })}
          >
            <span className="text-[12px]">{l.label}</span>
            <span className="text-[11px] text-muted-foreground">{l.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
