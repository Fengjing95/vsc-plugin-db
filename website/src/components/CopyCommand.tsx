import { useState } from 'react';
import { getSiteContent } from '../content/site';
import { useSiteLang } from '../i18n/lang';

type CopyCommandProps = { command: string };

/** 安装命令胶囊 + 一键复制 */
export function CopyCommand({ command }: CopyCommandProps) {
  const [copied, setCopied] = useState(false);
  const lang = useSiteLang();
  const c = getSiteContent(lang);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // 剪贴板不可用（权限/非安全上下文）：静默，用户仍可手动选择文本
    }
  };

  return (
    <button type="button" className="copy-cmd" onClick={copy} aria-label={c.ui.copy.aria.replace('{0}', command)}>
      <code>{command}</code>
      <span className={`copy-cmd__hint${copied ? ' is-copied' : ''}`} aria-live="polite">
        {copied ? c.ui.copy.copied : c.ui.copy.copy}
      </span>
    </button>
  );
}
