// 相对源码导入（perf/ 不是 workspace 包，包名解析不保证可用；type-only 导入运行时擦除）
import type { ApplyResult, ChangeSet, CompletionSource, FetchRowsRequest, ResultSet } from '../../../packages/core/src/model/rows';
import { METRICS, checkMetric, loadBaseline, min, recordBaseline, type MetricVerdict } from './baseline';

/**
 * 基准跑批共用体（概要设计 §9 四项指标）：sqlite（本地零依赖恒跑）与 mysql（MYSQL_HOST
 * 门控，CI service 同口径）同一测量口径——建表种子在方言层 prepare()（不计入测量），
 * 四项指标逐项 checkMetric（设计绝对阈值 + 入库基线 × 1.2 双闸，ADR §12.4）。
 */

/** 页大小（分页取尽指标；与 dod.perf 同口径量级） */
const PAGE_SIZE = 1000;
const BIG_ROWS = 50_000;
const WIDE_ROWS = 1000;

export interface BenchTarget {
  /** 基线文件名（baselines/<driver>.json） */
  driver: string;
  db: string;
  wideObj: string;
  bigObj: string;
  /** 建表 + 种子（不计时） */
  prepare(): Promise<void>;
  fetchRows(req: FetchRowsRequest): Promise<ResultSet>;
  applyChanges(db: string, obj: string, cs: ChangeSet): Promise<ApplyResult>;
  /** 补全数据源装载（缓存未命中的 load 回调） */
  loadCompletion(): Promise<CompletionSource>;
  dispose(): Promise<void>;
}

function timeMs(): number {
  return performance.now();
}

export interface BenchReport {
  metrics: Record<string, number>;
  verdicts: Array<{ key: string; description: string } & MetricVerdict>;
  allOk: boolean;
}

export async function runBench(target: BenchTarget): Promise<BenchReport> {
  await target.prepare();

  // ── 1. 1000 行 × 20 列单页取数（取最快，2 次预热 + 7 次测量）──
  const wideReq: FetchRowsRequest = { db: target.db, obj: target.wideObj, limit: WIDE_ROWS, timeoutMs: 60_000 };
  await target.fetchRows({ ...wideReq });
  await target.fetchRows({ ...wideReq });
  const wideSamples: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t = timeMs();
    const rs = await target.fetchRows({ ...wideReq });
    wideSamples.push(timeMs() - t);
    if (rs.rowCount !== WIDE_ROWS) {
      throw new Error(`wide 取数行数异常：${rs.rowCount} ≠ ${WIDE_ROWS}`);
    }
  }
  const wideMs = min(wideSamples);

  // ── 2. 5 万行分页取尽（5 轮取最快——噪声只会拖慢不会加快，min 最稳；中位数在本机实测仍有 ±25% 波动）──
  const paginationSamples: number[] = [];
  for (let round = 0; round < 5; round++) {
    const t0 = timeMs();
    let total = 0;
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const rs = await target.fetchRows({ db: target.db, obj: target.bigObj, limit: PAGE_SIZE, offset, timeoutMs: 60_000 });
      total += rs.rowCount;
      if (rs.rowCount < PAGE_SIZE) {
        break;
      }
    }
    paginationSamples.push(timeMs() - t0);
    if (round === 0 && total !== BIG_ROWS) {
      throw new Error(`分页取尽行数异常：${total} ≠ ${BIG_ROWS}`);
    }
  }
  const paginationMs = min(paginationSamples);

  // ── 3. 100 条变更单事务提交（单轮；id 1..100 的 name 原值 = name-<id>，prepare 保证）──
  const updates = Array.from({ length: 100 }, (_, i) => {
    const id = i + 1;
    const old = `name-${id}`;
    return {
      rowKey: { id },
      original: { id, name: old },
      changes: { name: { old, new: `perf-${id}` } },
    };
  });
  const cs: ChangeSet = { inserts: [], updates, deletes: [] };
  const t1 = timeMs();
  await target.applyChanges(target.db, target.bigObj, cs);
  const commitMs = timeMs() - t1;

  // ── 4. 补全缓存命中（1 次冷装载预热 + 20 次热读取最快）──
  await target.loadCompletion();
  const completionSamples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t = timeMs();
    await target.loadCompletion();
    completionSamples.push(timeMs() - t);
  }
  const completionMs = min(completionSamples);

  const metrics: Record<string, number> = {
    wide_1000x20_fetchrows: Math.round(wideMs),
    pagination_50k_exhaust: Math.round(paginationMs),
    commit_100_changes: Math.round(commitMs),
    // 亚毫秒级热读取 1ms 下限：0 基线的 ×1.2 闸恒为 0，任何实测抖动都会假红
    completion_cache_hit: Math.max(1, Math.round(completionMs * 100) / 100),
  };

  const baseline = loadBaseline(target.driver);
  const verdicts = METRICS.map((spec) => ({
    key: spec.key,
    description: spec.description,
    ...checkMetric(spec, metrics[spec.key]!, baseline),
  }));
  const allOk = verdicts.every((v) => v.ok);

  // 报告表（基线比对可视化；record 模式在测试体里落盘）
  const lines = verdicts.map((v) => {
    const reg = v.checks.find((c) => c.kind === 'regression');
    const base = typeof v.baselineMs === 'number' ? ` 基线 ${v.baselineMs}ms（×1.2+15ms 余量）` : ' 基线未录/跨平台';
    const limit = reg ? `${Math.round(reg.limitMs)}ms` : `${v.checks[0]!.limitMs}ms`;
    return `  ${v.ok ? '✅' : '❌'} ${v.key}: ${v.measuredMs}ms（限 ${limit}）${base} — ${v.description}`;
  });
  console.log(`\n[perf:${target.driver}]\n${lines.join('\n')}\n`);

  recordBaseline(target.driver, metrics);
  await target.dispose();
  return { metrics, verdicts, allOk };
}
