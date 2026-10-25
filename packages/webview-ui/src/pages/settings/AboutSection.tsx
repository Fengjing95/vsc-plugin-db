import { useEffect, useState } from 'react';
import { t, type MessageKey } from '../../lib/i18n';
import { request } from '../../rpc/client';

/** 关于页动作（与 extension SettingsHub.hubAction 的枚举对齐） */
type HubAction = 'openLog' | 'openGitHub' | 'openIssues' | 'openWebsite';

const LINKS: Array<{ action: HubAction; label: MessageKey; description: MessageKey }> = [
  { action: 'openLog', label: 'settings.about.openLog', description: 'settings.about.openLogDesc' },
  { action: 'openGitHub', label: 'settings.about.github', description: 'settings.about.githubDesc' },
  { action: 'openIssues', label: 'settings.about.issues', description: 'settings.about.issuesDesc' },
  { action: 'openWebsite', label: 'settings.about.website', description: 'settings.about.websiteDesc' },
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
        <div className="mt-1 text-[11px] leading-5 text-muted-foreground">{t('settings.about.tagline')}</div>
      </div>
      <div className="flex flex-col divide-y divide-border border-t border-border">
        {LINKS.map((l) => (
          <button
            key={l.action}
            type="button"
            className="flex items-center justify-between px-1 py-2 text-left hover:bg-accent"
            onClick={() => void request('settings.hubAction', { action: l.action })}
          >
            <span className="text-[12px]">{t(l.label)}</span>
            <span className="text-[11px] text-muted-foreground">{t(l.description)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
