import { useEffect } from 'react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { formText, t } from '../lib/i18n';
import { destructiveCount } from '../lib/tableDesign';
import { useDatabaseDesignStore } from '../store/databaseDesignStore';

/**
 * 库级 DDL 弹窗页（M8-DBDDL，概要 D-19 / 交互稿 §8.3）：
 * 动态表单（驱动 getDatabaseFormSchema 字段子集：string/number/select/boolean + hint）→
 * SQL 预览（destructive 红条复用表结构编辑器样式）→ 执行（Host 同源生成；成功 Host 关面板）。
 * 编辑态 name 只读（不支持重命名，D-19）。
 */

export function DatabaseDesignPage() {
  const phase = useDatabaseDesignStore((s) => s.phase);
  const errorMsg = useDatabaseDesignStore((s) => s.errorMsg);
  const db = useDatabaseDesignStore((s) => s.db);
  const kind = useDatabaseDesignStore((s) => s.kind);
  const fields = useDatabaseDesignStore((s) => s.fields);
  const values = useDatabaseDesignStore((s) => s.values);
  const errors = useDatabaseDesignStore((s) => s.errors);
  const preview = useDatabaseDesignStore((s) => s.preview);
  const executing = useDatabaseDesignStore((s) => s.executing);
  const executeError = useDatabaseDesignStore((s) => s.executeError);
  const load = useDatabaseDesignStore((s) => s.load);
  const setValue = useDatabaseDesignStore((s) => s.setValue);
  const requestPreview = useDatabaseDesignStore((s) => s.requestPreview);
  const closePreview = useDatabaseDesignStore((s) => s.closePreview);
  const execute = useDatabaseDesignStore((s) => s.execute);
  const close = useDatabaseDesignStore((s) => s.close);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === 'loading') {
    return <div className="status">{t('common.loading')}</div>;
  }
  if (phase === 'error') {
    return (
      <div className="wrap" style={{ padding: 16 }}>
        <div className="status error">{t('dbddl.loadFailed', [errorMsg])}</div>
        <div style={{ marginTop: 12 }}>
          <Button size="sm" onClick={() => void load()}>
            {t('common.retry')}
          </Button>
        </div>
      </div>
    );
  }

  const title = kind === 'alter' ? t('dbddl.title.edit', [db]) : t('dbddl.title.new');
  const hasChanges = () => {
    const stmts = preview;
    return !stmts || stmts.length === 0;
  };

  return (
    <div className="wrap" style={{ padding: 16, overflow: 'auto', height: '100vh' }}>
      <h2 style={{ margin: '0 0 12px', fontSize: 15 }}>{title}</h2>

      <div style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
        {fields.map((f) => {
          const readonly = kind === 'alter' && f.key === 'name';
          return (
            <div key={f.key}>
              <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
                {formText(f.label)}
                {f.required ? ' *' : ''}
              </label>
              {f.type === 'boolean' ? (
                <input
                  type="checkbox"
                  checked={values[f.key] === true}
                  disabled={readonly}
                  onChange={(e) => setValue(f.key, e.target.checked)}
                />
              ) : f.type === 'select' && f.options ? (
                <select
                  value={String(values[f.key] ?? '')}
                  disabled={readonly}
                  onChange={(e) => setValue(f.key, e.target.value)}
                  style={{ width: '100%' }}
                >
                  {f.options.map((o) => (
                    <option key={String(o.value)} value={String(o.value)}>
                      {formText(o.label)}
                    </option>
                  ))}
                </select>
              ) : f.type === 'password' ? (
                /* @since v0.1.16（M8-Oracle / D-23）：建库密码字段（CREATE USER）——
                 * 输入掩码显示；值随 spec 瞬时经 RPC 提交，不落任何存储（与连接表单同边界，C-10） */
                <Input
                  type="password"
                  autoComplete="off"
                  value={String(values[f.key] ?? '')}
                  placeholder={formText(f.placeholder ?? '')}
                  readOnly={readonly}
                  onChange={(e) => setValue(f.key, e.target.value)}
                />
              ) : (
                <Input
                  value={String(values[f.key] ?? '')}
                  placeholder={formText(f.placeholder ?? '')}
                  readOnly={readonly}
                  onChange={(e) => setValue(f.key, e.target.value)}
                />
              )}
              {f.hint ? <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>{formText(f.hint)}</div> : null}
              {errors[f.key] ? (
                <div style={{ fontSize: 12, color: 'var(--vscode-errorForeground)', marginTop: 2 }}>{errors[f.key]}</div>
              ) : null}
            </div>
          );
        })}
      </div>

      {executeError ? (
        <div
          role="alert"
          style={{
            marginTop: 12,
            padding: '8px 10px',
            border: '1px solid var(--vscode-errorForeground)',
            color: 'var(--vscode-errorForeground)',
            fontSize: 12,
          }}
        >
          {t('dbddl.executeError', [executeError.index, executeError.code, executeError.message])}
        </div>
      ) : null}

      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <Button size="sm" onClick={() => void requestPreview()}>
          {t('dbddl.previewButton')}
        </Button>
        <Button size="sm" onClick={() => void close()}>
          {t('common.close')}
        </Button>
      </div>

      {preview ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 50,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              background: 'var(--vscode-editor-background)',
              border: '1px solid var(--vscode-widget-border, rgba(255,255,255,0.1))',
              maxWidth: 720,
              width: '90%',
              maxHeight: '80vh',
              display: 'flex',
              flexDirection: 'column',
              padding: 12,
            }}
          >
            <div style={{ fontSize: 13, marginBottom: 8 }}>{t('dbddl.previewTitle', [preview.length])}</div>
            {destructiveCount(preview) > 0 ? (
              <div
                style={{
                  background: 'var(--vscode-inputValidation-errorBackground, rgba(180,0,0,0.2))',
                  color: 'var(--vscode-errorForeground)',
                  padding: '6px 8px',
                  fontSize: 12,
                  marginBottom: 8,
                }}
              >
                {t('dbddl.destructiveWarning', [destructiveCount(preview)])}
              </div>
            ) : null}
            <div style={{ overflow: 'auto', flex: 1 }}>
              {preview.map((s, i) => (
                <pre
                  key={i}
                  style={{
                    margin: '0 0 8px',
                    padding: 8,
                    fontSize: 12,
                    whiteSpace: 'pre-wrap',
                    background: s.destructive
                      ? 'var(--vscode-inputValidation-errorBackground, rgba(180,0,0,0.12))'
                      : 'var(--vscode-textCodeBlock-background)',
                  }}
                >
                  {s.sql}
                </pre>
              ))}
            </div>
            <div style={{ marginTop: 10, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button size="sm" onClick={closePreview}>
                {t('dbddl.backToEdit')}
              </Button>
              <Button size="sm" disabled={executing || hasChanges()} onClick={() => void execute()}>
                {executing ? t('dbddl.executing') : t('dbddl.execute')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
