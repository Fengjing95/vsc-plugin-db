import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { hexDump, parseJsonText, prettyJson, sniffImageKind } from '../../lib/cellViewer';
import { parseCellInput } from '../../lib/editValues';
import { useTableStore } from '../../store/tableStore';

interface ViewerState {
  rowIndex: number;
  colIndex: number;
  kind: 'text' | 'json' | 'binary';
  value: unknown;
  loading: boolean;
}

/** JSON 折叠树（树视图 tab）：对象/数组可折叠（深度 <2 默认展开），原语内联呈现 */
function JsonNode({ label, value, depth }: { label: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  if (value === null || typeof value !== 'object') {
    return (
      <div className="whitespace-pre-wrap break-all">
        {label !== '' && <span className="text-muted-foreground">{label}: </span>}
        <span>{JSON.stringify(value) ?? 'null'}</span>
      </div>
    );
  }
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  return (
    <div>
      <button type="button" className="text-left hover:text-link" onClick={() => setOpen((v) => !v)}>
        {label !== '' && <span className="text-muted-foreground">{label}: </span>}
        <span aria-hidden>{open ? '▾' : '▸'}</span>{' '}
        <span className="text-muted-foreground">
          {Array.isArray(value) ? `Array(${entries.length})` : `{${entries.length}}`}
        </span>
      </button>
      {open && (
        <div className="ml-3 border-l border-border pl-2">
          {entries.map(([k, v]) => (
            <JsonNode key={k} label={k} value={v} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 单元格查看器（交互稿 §4.6）：大文本（等宽编辑 + 格式化 + 保存写回 ChangeSet）、
 * JSON（折叠树 / 原文编辑切换 + 合法校验禁用保存）、二进制（只读 hex 前 64KB +
 * PNG/JPEG/GIF 预嗅探预览 + 另存为文件）。lazyCell 驱动的整值经 cell.fetch 覆盖行内值，
 * 加载完成前显示「加载中」；保存复用 parseCellInput（编辑值编码同源）→ confirmParsed。
 */
export function CellViewerModal() {
  const viewer = useTableStore((s) => s.viewer);
  const columns = useTableStore((s) => s.columns);
  const closeCellViewer = useTableStore((s) => s.closeCellViewer);
  const db = useTableStore((s) => s.db);
  const obj = useTableStore((s) => s.obj);

  return (
    <Dialog
      open={viewer !== null}
      onOpenChange={(open) => {
        if (!open) {
          closeCellViewer();
        }
      }}
      title={
        viewer ? (
          <span>
            值查看器{' '}
            <span className="font-normal text-muted-foreground">
              · {columns[viewer.colIndex]?.name} · {db}.{obj}
              {viewer.loading ? ' · 加载中…' : ''}
            </span>
          </span>
        ) : (
          ''
        )
      }
      contentClassName="w-[min(980px,94vw)]"
    >
      {viewer && <ViewerBody key={`${viewer.rowIndex}:${viewer.colIndex}`} viewer={viewer} />}
    </Dialog>
  );
}

function ViewerBody({ viewer }: { viewer: ViewerState }) {
  const columns = useTableStore((s) => s.columns);
  const primaryKey = useTableStore((s) => s.primaryKey);
  const editEnabled = useTableStore((s) => s.editEnabled);
  const applyCellValue = useTableStore((s) => s.applyCellValue);
  const closeCellViewer = useTableStore((s) => s.closeCellViewer);
  const showToast = useTableStore((s) => s.showToast);

  const col = columns[viewer.colIndex];
  const isJson = viewer.kind === 'json';
  const [tab, setTab] = useState<'tree' | 'raw'>(isJson ? 'tree' : 'raw');
  const [text, setText] = useState(() => (isJson ? prettyJson(viewer.value) : String(viewer.value ?? '')));

  // 主键列 / 只读连接 / 二进制列与 beginEdit 同口径（Host 侧 editGuard 仍强制校验）
  const editable = editEnabled && col !== undefined && viewer.kind !== 'binary' && !primaryKey.includes(col.name);
  const parsed = viewer.kind === 'binary' ? null : parseCellInput(text, col?.type ?? 'string');

  const save = () => {
    if (!col || !parsed) {
      return;
    }
    if (!parsed.ok) {
      showToast({ kind: 'error', text: `${col.name}：${parsed.error}` });
      return;
    }
    applyCellValue(viewer.rowIndex, viewer.colIndex, parsed.value);
  };

  const format = () => {
    const check = parseJsonText(text);
    if (!check.ok) {
      showToast({ kind: 'error', text: '内容不是合法 JSON，无法格式化' });
      return;
    }
    setText(prettyJson(check.value));
  };

  if (viewer.loading) {
    return (
      <div className="flex h-full min-h-[160px] items-center justify-center text-[13px] text-muted-foreground">
        加载中…
      </div>
    );
  }

  if (viewer.kind === 'binary') {
    return <BinaryBody viewer={viewer} />;
  }

  return (
    <div className="flex h-full min-h-[320px] flex-col">
      {isJson && (
        <div className="flex shrink-0 gap-1 border-b border-border px-4 pt-1.5">
          {(['tree', 'raw'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`border-b-2 px-2 py-1 text-[12px] ${
                tab === t ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground'
              }`}
            >
              {t === 'tree' ? '树视图' : '原文编辑'}
            </button>
          ))}
        </div>
      )}

      {isJson && tab === 'tree' ? (
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-[12px] leading-relaxed">
          <JsonNode label="" value={viewer.value} depth={0} />
        </div>
      ) : (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          readOnly={!editable}
          spellCheck={false}
          aria-label={`${col?.name ?? ''} 值编辑`}
          className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-[12px] leading-relaxed text-foreground outline-none"
        />
      )}

      <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2">
        {!editable && <span className="text-[11px] text-muted-foreground">当前列不可编辑（只读连接 / 主键列），仅查看</span>}
        {parsed && !parsed.ok && <span className="text-[11px] text-destructive">{parsed.error}</span>}
        <span className="mr-auto" />
        {(viewer.kind === 'text' || (isJson && tab === 'raw')) && (
          <Button variant="secondary" size="md" onClick={format}>
            格式化
          </Button>
        )}
        {editable && (
          <Button variant="primary" size="md" disabled={!parsed?.ok} onClick={save}>
            保存写回
          </Button>
        )}
        <Button variant="secondary" size="md" onClick={closeCellViewer}>
          关闭
        </Button>
      </div>
    </div>
  );
}

function BinaryBody({ viewer }: { viewer: ViewerState }) {
  const saveViewerBinary = useTableStore((s) => s.saveViewerBinary);
  const closeCellViewer = useTableStore((s) => s.closeCellViewer);
  const base64 = typeof viewer.value === 'string' ? viewer.value : '';
  const imageKind = sniffImageKind(base64);
  const hex = hexDump(base64);

  return (
    <div className="flex h-full min-h-[320px] flex-col">
      {imageKind ? (
        <div className="flex shrink-0 justify-center border-b border-border py-3">
          <img
            src={`data:image/${imageKind};base64,${base64}`}
            alt="二进制图片预览"
            className="max-h-56 rounded border border-border"
          />
        </div>
      ) : null}
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre px-4 py-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {hex}
      </pre>
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2">
        <span className="text-[11px] text-muted-foreground">
          只读 · 前 64KB hex 视图{imageKind ? ` · 已识别 ${imageKind.toUpperCase()} 图片` : ''}
        </span>
        <span className="mr-auto" />
        <Button variant="secondary" size="md" onClick={() => void saveViewerBinary()}>
          另存为文件
        </Button>
        <Button variant="secondary" size="md" onClick={closeCellViewer}>
          关闭
        </Button>
      </div>
    </div>
  );
}
