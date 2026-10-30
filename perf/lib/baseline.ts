import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 基准基线（概要设计 §12.4：超基线 20% 阻断）：
 * - baselines/<driver>.json 入库记录参考值；跑批对比「设计绝对阈值 + 基线 × 1.2」双闸
 * - 基线缺省（metrics 无该键，如 MySQL 首跑前）→ 只查设计阈值，跑批打印实测值供回填
 * - 重录基线：`PERF_RECORD=1 pnpm perf`（覆盖 baselines/<driver>.json，随批提交）
 */

/** §9 基线指标全集（key 稳定，勿改——基线文件按 key 对齐） */
export interface MetricSpec {
  key: string;
  /** 概要设计 §9 设计绝对阈值（毫秒） */
  designMaxMs: number;
  description: string;
}

export const METRICS: MetricSpec[] = [
  { key: 'wide_1000x20_fetchrows', designMaxMs: 1500, description: '1000 行 × 20 列单页取数（§9 <1.5s）' },
  { key: 'pagination_50k_exhaust', designMaxMs: 5000, description: '5 万行分页取尽（§9 <5s）' },
  { key: 'commit_100_changes', designMaxMs: 2000, description: '100 条变更单事务提交（§9 <2s）' },
  { key: 'completion_cache_hit', designMaxMs: 100, description: '补全缓存命中（§9 <100ms）' },
];

/** 回归带宽：超入库基线 20% 阻断（§12.4） */
export const REGRESSION_RATIO = 1.2;

/** 回归闸绝对余量（毫秒）：亚十毫秒级指标的 20% 带宽远小于本机抖动（实测 min 口径下
 *  wide/commit 仍可漂 ±80%——跑批时机撞上后台负载），纯比例闸必假红——限值 = 基线 ×1.2 + 15ms；
 *  产品级防线是 §9 设计绝对阈值（1.5s/5s/2s/100ms，高出噪声两个量级），回归闸只作显著回归
 *  （翻倍量级）的开发期信号 */
export const REGRESSION_SLACK_MS = 15;

export interface BaselineFile {
  recordedAt: string | null;
  /** 录制平台（darwin-arm64 等）：跨平台 runner 速度差异大，回归闸仅在平台一致时启用
   *  （CI ubuntu 与本机 mac 不互比——否则本机基线在 CI 必假红）；缺省视为通用 */
  platform?: string;
  note?: string;
  /** metric key → 参考毫秒 */
  metrics: Record<string, number>;
}

const baselinesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'baselines');

function currentPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

export function loadBaseline(driver: string): BaselineFile | null {
  const path = join(baselinesDir, `${driver}.json`);
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf8')) as BaselineFile;
}

export interface MetricVerdict {
  ok: boolean;
  measuredMs: number;
  /** 生效的判定口径与限值（两者都过才算绿，报告取更严的一个） */
  checks: Array<{ kind: 'design' | 'regression'; limitMs: number; ok: boolean }>;
  baselineMs?: number;
}

export function checkMetric(spec: MetricSpec, measuredMs: number, baseline: BaselineFile | null): MetricVerdict {
  const platformMatched = !baseline?.platform || baseline.platform === currentPlatform();
  const baselineMs = platformMatched ? baseline?.metrics[spec.key] : undefined;
  const checks: MetricVerdict['checks'] = [
    { kind: 'design', limitMs: spec.designMaxMs, ok: measuredMs <= spec.designMaxMs },
  ];
  if (typeof baselineMs === 'number') {
    const limitMs = baselineMs * REGRESSION_RATIO + REGRESSION_SLACK_MS;
    checks.push({ kind: 'regression', limitMs, ok: measuredMs <= limitMs });
  }
  return { ok: checks.every((c) => c.ok), measuredMs, checks, baselineMs };
}

/** 重录基线（PERF_RECORD=1）；返回是否写入 */
export function recordBaseline(driver: string, metrics: Record<string, number>): boolean {
  if (process.env.PERF_RECORD !== '1') {
    return false;
  }
  const path = join(baselinesDir, `${driver}.json`);
  const file: BaselineFile = {
    recordedAt: new Date().toISOString(),
    platform: currentPlatform(),
    metrics,
  };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return true;
}

/** 多次取样取最快轮（基准惯例 hyperfine 同款）：环境噪声只会拖慢不会加快，
 *  min 对持续性回归同样敏感（回归让所有轮变慢）且比中位数/均值抗抖动得多 */
export function min(values: number[]): number {
  if (values.length === 0) {
    throw new Error('min: 空样本');
  }
  return Math.min(...values);
}
