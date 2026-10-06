import { useEffect, useState } from 'react';
import type {
  ConnMetaResult,
  ConnTestResult,
  FormFieldPayload,
  FormSchemaPayload,
} from '@db-explorer/protocol';
import { request } from '../rpc/client';
import { IconEye, IconEyeOff, IconInfo } from '../components/ui/icons';
import { groupAdvancedFields, isFieldVisible } from '../lib/formSections';

type TestPhase = 'idle' | 'testing' | 'ok' | 'fail';

/** 驱动类型卡片图标（外观装饰；未知驱动走通用图标，不影响任何逻辑） */
const DRIVER_ICONS: Record<string, string> = {
  mysql: '🐬',
  redis: '⚡',
  postgres: '🐘',
  postgresql: '🐘',
  sqlite: '🪶',
  mock: '🧪',
};

/**
 * 连接表单（概要设计 5.2 / 交互稿 §3.1 方案 A 紧凑双栏卡片）：
 * - 字段完全由驱动 FormSchema 驱动渲染，无 schema 的分组整体隐藏（布局升级不改字段契约）
 * - 密码永不回显；留空 = 沿用已存密码（hasSecret）+ 可见性切换
 * - 测试连接状态机：idle → testing → ok/fail（状态卡呈现，§3.2 测试与保存独立）
 */
export function ConnectionFormPage({ connId }: { connId: string | null }) {
  const [drivers, setDrivers] = useState<Array<{ id: string; displayName: string }>>([]);
  const [driverId, setDriverId] = useState('');
  const [schema, setSchema] = useState<FormSchemaPayload | null>(null);
  const [name, setName] = useState('');
  const [env, setEnv] = useState<'dev' | 'test' | 'prod'>('dev');
  const [readOnly, setReadOnly] = useState(false);
  const [options, setOptions] = useState<Record<string, unknown>>({});
  /** 密码字段按 key 分开保存：驱动密码（key='password'）走独立参数，其余（如 sshPassword）随 options 上行由 Host 拦截 */
  const [passwords, setPasswords] = useState<Record<string, string>>({});
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

  /** 合并 schema 的密码字段（除驱动主密码 password 外）随 options 上行，Host 按类型拦截入 SecretStorage */
  function mergePasswordFields(base: Record<string, unknown>): Record<string, unknown> {
    const merged = { ...base };
    for (const f of schema?.fields ?? []) {
      if (f.type === 'password' && f.key !== 'password') {
        merged[f.key] = passwords[f.key] ?? '';
      }
    }
    return merged;
  }

  async function switchDriver(next: string) {
    setDriverId(next);
    setPhase('idle');
    setTestInfo(null);
    setPasswords({});
    try {
      const r = await request<{ schema: FormSchemaPayload }>('conn.getSchema', { driverId: next });
      setSchema(r.schema);
      setOptions(defaultsOf(r.schema));
    } catch (e) {
      // 切换失败保留原 schema（字段仍可编辑），错误横幅提示
      setErrors({ _global: `切换驱动失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  async function onTest() {
    if (!validate()) return;
    setPhase('testing');
    try {
      const r = await request<ConnTestResult>('conn.test', {
        driverId,
        options: mergePasswordFields(options),
        password: passwords['password'] || null,
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
      options: mergePasswordFields(options),
      password: passwords['password'] || null,
    });
  }

  const baseFields = schema?.fields.filter((f) => !f.group) ?? [];
  const advancedFields = schema?.fields.filter((f) => f.group) ?? [];
  /** 高级组按 section 分小节（M8 修订：小节标题/开关标题行，依赖字段随开关显隐） */
  const advancedSections = groupAdvancedFields(advancedFields);
  /** 高级组状态 chips（通用规则：组内已开启的布尔字段 label；无则不显示） */
  const advancedChips = advancedFields
    .filter((f) => f.type === 'boolean' && options[f.key] === true)
    .map((f) => f.label);

  const inputCls =
    'h-7 w-full rounded-sm border border-input bg-input px-2 text-[13px] text-foreground outline-none focus:border-[var(--vscode-focusBorder)] disabled:opacity-50';
  const labelCls = 'mb-1 block text-[12px] text-muted-foreground';

  return (
    <div className="min-h-screen bg-background text-panel-foreground">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-5 px-6 py-6">
        <div>
          <h1 className="text-[15px] font-semibold">{connId ? '编辑连接' : '新建连接'}</h1>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            字段由驱动定义；保存不强制先测试，但建议先验证连通性
          </p>
        </div>
        {errors._global && (
          <div className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            {errors._global}
          </div>
        )}

        {/* 驱动类型：图标选择卡片（§3.1 方案 A） */}
        <div>
          <span className={labelCls}>
            驱动类型 <span className="text-destructive">*</span>
          </span>
          <div
            className="mt-1 grid gap-2"
            style={{ gridTemplateColumns: `repeat(${Math.min(drivers.length, 3)}, minmax(0, 1fr))` }}
            role="radiogroup"
            aria-label="驱动类型"
          >
            {drivers.map((d) => {
              const active = d.id === driverId;
              return (
                <button
                  key={d.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`rounded-md border px-2 py-2.5 text-center text-[13px] ${
                    active
                      ? 'border-[var(--vscode-focusBorder)] bg-input text-foreground'
                      : 'border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  }`}
                  onClick={() => void switchDriver(d.id)}
                >
                  <span aria-hidden className="block text-lg leading-none">
                    {DRIVER_ICONS[d.id] ?? '🗄'}
                  </span>
                  <span className="mt-1 block">{d.displayName}</span>
                </button>
              );
            })}
          </div>
          {errors._driver && <span className="mt-1 block text-[12px] text-destructive">{errors._driver}</span>}
        </div>

        {/* 名称 */}
        <div>
          <label className={labelCls} htmlFor="conn-name">
            名称 <span className="text-destructive">*</span>
          </label>
          <input
            id="conn-name"
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：本地 MySQL"
          />
          {errors._name && <span className="mt-1 block text-[12px] text-destructive">{errors._name}</span>}
        </div>

        {/* 基础字段：schema 驱动，双列网格（textarea 跨两列）；区块间以间距区分（无边框） */}
        {baseFields.length > 0 && (
          <section className="flex flex-col gap-3">
            <div className="text-[11px] font-medium tracking-wider text-muted-foreground">连接参数</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-3">
              {baseFields.map((f) => (
                <div key={f.key} className={f.type === 'textarea' ? 'col-span-2' : ''}>
                  <FieldRow
                    field={f}
                    value={options[f.key]}
                    error={errors[f.key]}
                    inputCls={inputCls}
                    labelCls={labelCls}
                    passwordState={{
                      value: passwords[f.key] ?? '',
                      hasSecret: f.key === 'password' ? hasSecret : false,
                      onChange: (v) => setPasswords((prev) => ({ ...prev, [f.key]: v })),
                    }}
                    onChange={(v) => setOptions((prev) => ({ ...prev, [f.key]: v }))}
                  />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 环境与保护（三段控件；prod 红色警示与 §5.8 护栏呼应） */}
        <section className="flex flex-col gap-3">
          <div className="text-[11px] font-medium tracking-wider text-muted-foreground">环境与保护</div>
          <div className="flex items-center gap-4">
            <div className="flex overflow-hidden rounded-sm border border-border" role="radiogroup" aria-label="环境">
              {(
                [
                  ['dev', '开发'],
                  ['test', '测试'],
                  ['prod', '生产'],
                ] as const
              ).map(([value, label]) => {
                const active = env === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`px-3 py-1 text-[12px] ${
                      active
                        ? value === 'prod'
                          ? 'bg-destructive text-[#fff]'
                          : 'bg-[var(--vscode-button-background)] text-[#fff]'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    }`}
                    onClick={() => setEnv(value)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <label className="flex items-center gap-1.5 text-[12px]">
              <input
                type="checkbox"
                checked={readOnly}
                onChange={(e) => setReadOnly(e.target.checked)}
              />
              只读保护
              <span className="text-muted-foreground">（Host 层拒绝一切写操作）</span>
            </label>
          </div>
          {env === 'prod' && (
            <div className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-[12px] text-destructive">
              生产环境：所有写操作与危险语句将强制二次确认（输入名称匹配），该约束不可关闭
            </div>
          )}
        </section>

        {/* 高级选项：按 section 分小节（M8 修订）——开关在标题行、开启才显示配置；单列无边框 */}
        {advancedSections.length > 0 && (
          <details className="group">
            <summary className="cursor-pointer text-[12px] text-muted-foreground hover:text-foreground">
              高级选项
              {advancedChips.length > 0 && (
                <span className="ml-2 inline-flex gap-1.5">
                  {advancedChips.map((label) => (
                    <span key={label} className="rounded-full bg-[var(--vscode-badge-background)] px-2 py-0.5 text-[11px] text-foreground">
                      {label} · 开
                    </span>
                  ))}
                </span>
              )}
            </summary>
            <div className="mt-3 flex flex-col gap-5">
              {advancedSections.map((sec, i) => {
                const headerOn = sec.header ? options[sec.header.key] === true : false;
                // 独立布尔小节：复选框自身即标题（如 mysql「启用 SSL」），不渲染小节标题文字
                const standaloneBool =
                  !sec.header && sec.fields.length === 1 && sec.fields[0].type === 'boolean';
                return (
                  <div key={sec.title ?? i} className="flex flex-col gap-2.5">
                    {sec.header ? (
                      <label className="flex items-center gap-2 text-[13px] font-medium">
                        <input
                          type="checkbox"
                          checked={headerOn}
                          onChange={(e) => setOptions((prev) => ({ ...prev, [sec.header!.key]: e.target.checked }))}
                        />
                        {sec.header.label}
                        {sec.header.hint && <HintTip text={sec.header.hint} />}
                      </label>
                    ) : sec.title && !standaloneBool ? (
                      <div className="text-[12px] font-medium text-foreground">{sec.title}</div>
                    ) : null}
                    {sec.header && !headerOn && sec.fields.length > 0 && (
                      <div className="text-[12px] text-muted-foreground">开启后可配置</div>
                    )}
                    {sec.fields
                      .filter((f) => isFieldVisible(f, options))
                      .map((f) => (
                        <FieldRow
                          key={f.key}
                          field={f}
                          value={options[f.key]}
                          error={errors[f.key]}
                          inputCls={inputCls}
                          labelCls={labelCls}
                          passwordState={{
                            value: passwords[f.key] ?? '',
                            hasSecret: f.key === 'password' ? hasSecret : false,
                            onChange: (v) => setPasswords((prev) => ({ ...prev, [f.key]: v })),
                          }}
                          onChange={(v) => setOptions((prev) => ({ ...prev, [f.key]: v }))}
                        />
                      ))}
                  </div>
                );
              })}
            </div>
          </details>
        )}

        {/* 测试状态卡（§3.1 方案 A：内联状态卡） */}
        <div
          role="status"
          className={`rounded-md border px-3 py-2 text-[12px] ${
            phase === 'ok'
              ? 'border-[rgba(115,201,145,.35)] bg-[rgba(115,201,145,.12)] text-[var(--vscode-testing-iconPassed)]'
              : phase === 'fail'
                ? 'border-destructive/40 bg-destructive/10 text-destructive'
                : 'border-border bg-panel text-muted-foreground'
          }`}
        >
          {phase === 'idle' && 'ⓘ 尚未测试（保存不强制先测试）'}
          {phase === 'testing' && '⏳ 正在测试连接…'}
          {phase === 'ok' && (
            <span>
              ✓ 连接成功
              {testInfo?.latencyMs !== undefined ? ` · ${testInfo.latencyMs}ms` : ''}
              {testInfo?.serverVersion ? ` · ${testInfo.serverVersion}` : ''}
            </span>
          )}
          {phase === 'fail' && (
            <span>
              ✗ [{testInfo?.errorCode ?? 'E_INTERNAL'}] {testInfo?.errorMessage ?? '连接失败'}
            </span>
          )}
        </div>

        {/* 操作栏 */}
        <div className="flex items-center gap-2.5">
          <button
            className="h-7 rounded-sm border border-border bg-[var(--vscode-button-secondaryBackground)] px-3.5 text-[13px] hover:bg-accent disabled:opacity-50"
            disabled={phase === 'testing'}
            onClick={() => void onTest()}
          >
            测试连接
          </button>
          <span className="flex-1" />
          <button
            className="h-7 rounded-sm bg-[var(--vscode-button-background)] px-3.5 text-[13px] text-[#fff] hover:bg-[var(--vscode-button-hoverBackground)] disabled:opacity-50"
            disabled={phase === 'testing'}
            onClick={() => void onSave()}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

interface FieldRowProps {
  field: FormFieldPayload;
  value: unknown;
  error?: string;
  inputCls: string;
  labelCls: string;
  passwordState: { value: string; hasSecret: boolean; onChange: (v: string) => void };
  onChange: (v: unknown) => void;
}

function FieldRow({ field, value, error, inputCls, labelCls, passwordState, onChange }: FieldRowProps) {
  /** 密码可见性切换（§3.1 方案 A）：系统图标 eye/eye-off；默认密文 */
  const [show, setShow] = useState(false);
  /** label↔input 关联（交互稿 §11 无障碍：读屏可读、测试可定位） */
  const inputId = `conn-field-${field.key}`;
  /** hint 经 aria-describedby 提供读屏可读（可见形态是标题后的 tips 图标） */
  const hintId = `${inputId}-hint`;
  const describedBy = field.hint ? hintId : undefined;

  const label = (
    <label className={`${labelCls} flex items-center gap-1`} htmlFor={inputId}>
      {field.label}
      {field.required && field.type !== 'password' ? <span className="text-destructive"> *</span> : null}
      {field.hint && <HintTip text={field.hint} />}
    </label>
  );

  let input: JSX.Element;
  if (field.type === 'password') {
    input = (
      <div className="relative">
        <input
          id={inputId}
          aria-describedby={describedBy}
          type={show ? 'text' : 'password'}
          className={`${inputCls} pr-8`}
          value={passwordState.value}
          onChange={(e) => passwordState.onChange(e.target.value)}
          placeholder={passwordState.hasSecret ? '●●●●●●（留空保持不变）' : field.placeholder}
          autoComplete="off"
        />
        <button
          type="button"
          aria-label={show ? '隐藏密码' : '显示密码'}
          title={show ? '隐藏密码' : '显示密码'}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground hover:text-foreground"
          onClick={() => setShow(!show)}
        >
          {show ? <IconEyeOff size={14} /> : <IconEye size={14} />}
        </button>
      </div>
    );
  } else if (field.type === 'boolean') {
    input = (
      <label className="flex h-7 items-center gap-1.5 text-[13px]" htmlFor={inputId}>
        <input
          id={inputId}
          aria-describedby={describedBy}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className={value ? 'text-foreground' : 'text-muted-foreground'}>{value ? '开启' : '关闭'}</span>
      </label>
    );
  } else if (field.type === 'select') {
    input = (
      <select id={inputId} aria-describedby={describedBy} className={inputCls} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
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
        id={inputId}
        aria-describedby={describedBy}
        rows={3}
        className={`${inputCls} h-auto py-1.5`}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
      />
    );
  } else {
    input = (
      <input
        id={inputId}
        aria-describedby={describedBy}
        type={field.type === 'number' ? 'number' : 'text'}
        className={inputCls}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => onChange(field.type === 'number' ? e.target.valueAsNumber : e.target.value)}
        placeholder={field.placeholder}
      />
    );
  }

  return (
    <div>
      {label}
      {input}
      {field.hint && (
        <span id={hintId} className="sr-only">
          {field.hint}
        </span>
      )}
      {error && <span className="mt-1 block text-[12px] text-destructive">{error}</span>}
    </div>
  );
}

/** 提示文案的 tips 形式（M8 修订）：标题后的 ⓘ 图标（aria-hidden，hover 显示 title 气泡，不占版面）；
 *  提示文本本身经 aria-describedby 提供读屏可读（见 FieldRow 的 sr-only 段） */
function HintTip({ text }: { text: string }) {
  return (
    <span
      aria-hidden
      title={text}
      className="inline-flex cursor-help items-center text-muted-foreground hover:text-foreground"
    >
      <IconInfo size={12} />
    </span>
  );
}
