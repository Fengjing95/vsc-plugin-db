import { useEffect, useState } from 'react';
import type {
  ConnMetaResult,
  ConnTestResult,
  FormFieldPayload,
  FormSchemaPayload,
} from '@db-explorer/protocol';
import { request } from '../rpc/client';

type TestPhase = 'idle' | 'testing' | 'ok' | 'fail';

/**
 * 连接表单（概要设计 5.2 / 交互稿 §3）：
 * - 字段完全由驱动 FormSchema 驱动渲染，无 schema 的分组整体隐藏
 * - 密码永不回显；留空 = 沿用已存密码（hasSecret）
 * - 测试连接状态机：idle → testing → ok/fail
 */
export function ConnectionFormPage({ connId }: { connId: string | null }) {
  const [drivers, setDrivers] = useState<Array<{ id: string; displayName: string }>>([]);
  const [driverId, setDriverId] = useState('');
  const [schema, setSchema] = useState<FormSchemaPayload | null>(null);
  const [name, setName] = useState('');
  const [env, setEnv] = useState<'dev' | 'test' | 'prod'>('dev');
  const [readOnly, setReadOnly] = useState(false);
  const [options, setOptions] = useState<Record<string, unknown>>({});
  const [password, setPassword] = useState('');
  const [hasSecret, setHasSecret] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<TestPhase>('idle');
  const [testInfo, setTestInfo] = useState<ConnTestResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const meta = await request<ConnMetaResult>('conn.getMeta', { connId: connId ?? null });
      if (cancelled) return;
      setDrivers(meta.drivers);
      setSchema(meta.schema);
      const first = meta.config?.driverId ?? meta.drivers[0]?.id ?? '';
      setDriverId(first);
      if (meta.config) {
        setName(meta.config.name);
        if (meta.config.env) setEnv(meta.config.env);
        setReadOnly(meta.config.readOnly);
        setOptions(meta.config.options);
        setHasSecret(meta.config.hasSecret);
      } else {
        setOptions(defaultsOf(meta.schema));
      }
    })().catch((e: unknown) => {
      setErrors({ _global: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      cancelled = true;
    };
  }, [connId]);

  function defaultsOf(s: FormSchemaPayload): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of s.fields) {
      out[f.key] = f.default ?? (f.type === 'boolean' ? false : '');
    }
    return out;
  }

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!name.trim()) {
      errs._name = '请输入连接名称';
    }
    if (!driverId) {
      errs._driver = '请选择驱动类型';
    }
    if (schema) {
      for (const f of schema.fields) {
        if (f.type === 'password') continue; // 密码可为空（沿用已存）
        const v = options[f.key];
        const empty = v === undefined || v === null || String(v).trim() === '';
        if (f.required && empty) {
          errs[f.key] = `请输入${f.label}`;
          continue;
        }
        if (empty) continue;
        if (f.type === 'number' && Number.isNaN(Number(v))) {
          errs[f.key] = '请输入数字';
          continue;
        }
        if (f.validator === 'port') {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 1 || n > 65535) {
            errs[f.key] = '端口范围 1-65535';
          }
        }
        if (f.validator === 'regex' && f.validationRegex) {
          try {
            if (!new RegExp(f.validationRegex).test(String(v))) {
              errs[f.key] = `${f.label} 格式不正确`;
            }
          } catch {
            // 驱动提供了非法正则：跳过该规则
          }
        }
      }
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function switchDriver(next: string) {
    setDriverId(next);
    setPhase('idle');
    setTestInfo(null);
    const r = await request<{ schema: FormSchemaPayload }>('conn.getSchema', { driverId: next });
    setSchema(r.schema);
    setOptions(defaultsOf(r.schema));
  }

  async function onTest() {
    if (!validate()) return;
    setPhase('testing');
    try {
      const r = await request<ConnTestResult>('conn.test', {
        driverId,
        options,
        password: password || null,
        connId: connId ?? null,
      });
      setTestInfo(r);
      setPhase(r.ok ? 'ok' : 'fail');
    } catch (e) {
      setTestInfo({
        ok: false,
        errorCode: 'E_INTERNAL',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      setPhase('fail');
    }
  }

  async function onSave() {
    if (!validate()) return;
    // 保存成功后由 Host 关闭面板；树随 store 变更自动刷新
    await request('conn.save', {
      connId: connId ?? undefined,
      name: name.trim(),
      driverId,
      env,
      readOnly,
      options,
      password: password || null,
    });
  }

  const baseFields = schema?.fields.filter((f) => !f.group) ?? [];
  const advancedFields = schema?.fields.filter((f) => f.group) ?? [];

  return (
    <div className="form-wrap">
      <h2>{connId ? '编辑连接' : '新建连接'}</h2>
      {errors._global && <div className="form-banner error">{errors._global}</div>}

      <div className="form-row">
        <label>
          驱动类型 <em>*</em>
        </label>
        <select value={driverId} onChange={(e) => void switchDriver(e.target.value)}>
          {drivers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.displayName}
            </option>
          ))}
        </select>
        {errors._driver && <span className="field-error">{errors._driver}</span>}
      </div>

      <div className="form-row">
        <label>
          名称 <em>*</em>
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：本地 MySQL"
        />
        {errors._name && <span className="field-error">{errors._name}</span>}
      </div>

      {baseFields.map((f) => (
        <FieldRow
          key={f.key}
          field={f}
          value={options[f.key]}
          error={errors[f.key]}
          passwordState={{ value: password, hasSecret, onChange: setPassword }}
          onChange={(v) => setOptions((prev) => ({ ...prev, [f.key]: v }))}
        />
      ))}

      <div className="form-row">
        <label>环境</label>
        <select value={env} onChange={(e) => setEnv(e.target.value as 'dev' | 'test' | 'prod')}>
          <option value="dev">开发（dev）</option>
          <option value="test">测试（test）</option>
          <option value="prod">生产（prod）</option>
        </select>
      </div>

      <div className="form-row inline">
        <label>只读保护</label>
        <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
        <span className="hint">开启后 Host 层拒绝一切写操作</span>
      </div>

      {advancedFields.length > 0 && (
        <details className="advanced">
          <summary>高级选项</summary>
          {advancedFields.map((f) => (
            <FieldRow
              key={f.key}
              field={f}
              value={options[f.key]}
              error={errors[f.key]}
              passwordState={{ value: password, hasSecret, onChange: setPassword }}
              onChange={(v) => setOptions((prev) => ({ ...prev, [f.key]: v }))}
            />
          ))}
        </details>
      )}

      <div className={`form-status ${phase}`}>
        {phase === 'idle' && 'ⓘ 尚未测试（保存不强制先测试）'}
        {phase === 'testing' && '⏳ 正在测试连接…'}
        {phase === 'ok' && (
          <span className="ok">
            ✓ 连接成功
            {testInfo?.latencyMs !== undefined ? ` · ${testInfo.latencyMs}ms` : ''}
            {testInfo?.serverVersion ? ` · ${testInfo.serverVersion}` : ''}
          </span>
        )}
        {phase === 'fail' && (
          <span className="fail">
            ✗ [{testInfo?.errorCode ?? 'E_INTERNAL'}]{' '}
            {testInfo?.errorMessage ?? '连接失败'}
          </span>
        )}
      </div>

      <div className="form-actions">
        <button className="btn-secondary" disabled={phase === 'testing'} onClick={() => void onTest()}>
          测试连接
        </button>
        <span className="spacer" />
        <button
          className="btn-primary"
          disabled={phase === 'testing'}
          onClick={() => void onSave()}
        >
          保存
        </button>
      </div>
    </div>
  );
}

interface FieldRowProps {
  field: FormFieldPayload;
  value: unknown;
  error?: string;
  passwordState: { value: string; hasSecret: boolean; onChange: (v: string) => void };
  onChange: (v: unknown) => void;
}

function FieldRow({ field, value, error, passwordState, onChange }: FieldRowProps) {
  const label = (
    <label>
      {field.label}
      {field.required && field.type !== 'password' ? <em>*</em> : null}
    </label>
  );

  let input: JSX.Element;
  if (field.type === 'password') {
    input = (
      <input
        type="password"
        value={passwordState.value}
        onChange={(e) => passwordState.onChange(e.target.value)}
        placeholder={passwordState.hasSecret ? '●●●●●●（留空保持不变）' : field.placeholder}
        autoComplete="off"
      />
    );
  } else if (field.type === 'boolean') {
    input = (
      <input
        type="checkbox"
        checked={Boolean(value)}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  } else if (field.type === 'select') {
    input = (
      <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
        {(field.options ?? []).map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (field.type === 'textarea') {
    input = (
      <textarea
        rows={3}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
      />
    );
  } else {
    input = (
      <input
        type={field.type === 'number' ? 'number' : 'text'}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => onChange(field.type === 'number' ? e.target.valueAsNumber : e.target.value)}
        placeholder={field.placeholder}
      />
    );
  }

  return (
    <div className={`form-row${field.type === 'boolean' ? ' inline' : ''}`}>
      {label}
      {input}
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}
