import type { ReactElement } from 'react';
import { useState } from 'react';
import { AiSection } from './settings/AiSection';
import { QueryExportSection } from './settings/QueryExportSection';
import { AboutSection } from './settings/AboutSection';

/**
 * 设置中心（交互稿 §16）：左侧分类导航 + 右侧内容区，形态对齐 VSCode 设置。
 * 分类切换为 webview 内部状态（不经 RPC）；bootstrap params.category 深链初始分类
 * （AI 入口「去配置」引导 → ai）。
 */

type Category = 'ai' | 'queryExport' | 'about';

const CATEGORIES: Array<{ id: Category; icon: string; label: string }> = [
  { id: 'ai', icon: '✦', label: 'AI 辅助' },
  { id: 'queryExport', icon: '⚙', label: '查询与导出' },
  { id: 'about', icon: 'ⓘ', label: '关于' },
];

export function SettingsPage(): ReactElement {
  const initial = (window.__BOOTSTRAP__?.params.category ?? '') as Category | '';
  const [category, setCategory] = useState<Category>(
    CATEGORIES.some((c) => c.id === initial) ? (initial as Category) : 'ai',
  );

  const content =
    category === 'ai' ? <AiSection /> : category === 'queryExport' ? <QueryExportSection /> : <AboutSection />;
  const active = CATEGORIES.find((c) => c.id === category);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* 分类导航（窄侧栏） */}
      <nav className="flex w-40 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-panel p-2" aria-label="设置分类">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-current={c.id === category ? 'true' : undefined}
            className={`flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] ${
              c.id === category
                ? 'bg-selected font-medium text-selected-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            }`}
            onClick={() => setCategory(c.id)}
          >
            <span aria-hidden="true">{c.icon}</span>
            {c.label}
          </button>
        ))}
      </nav>
      {/* 内容区 */}
      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
        <h2 className="mb-4 text-[15px] font-semibold">{active?.label}</h2>
        {content}
      </div>
    </div>
  );
}
