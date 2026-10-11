import { useState } from 'react';

type CopyCommandProps = { command: string };

/** 安装命令胶囊 + 一键复制 */
export function CopyCommand({ command }: CopyCommandProps) {
  const [copied, setCopied] = useState(false);

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
    <button type="button" className="copy-cmd" onClick={copy} aria-label={`复制命令 ${command}`}>
      <code>{command}</code>
      <span className={`copy-cmd__hint${copied ? ' is-copied' : ''}`} aria-live="polite">
        {copied ? '已复制 ✓' : '复制'}
      </span>
    </button>
  );
}
