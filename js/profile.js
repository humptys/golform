// 기준 프로파일(기준 영상들의 측정값 분포) 생성과 비교 평가.
import { metricsForView } from './metrics.js';

/** 기준 영상들의 측정값 -> 항목별 평균/표준편차. */
export function buildStats(samples) {
  const stats = {};
  const keys = new Set(samples.flatMap((s) => Object.keys(s.metrics)));
  for (const k of keys) {
    const vals = samples.map((s) => s.metrics[k]).filter((v) => Number.isFinite(v));
    if (!vals.length) continue;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const std = vals.length > 1 ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1)) : 0;
    stats[k] = { mean, std, n: vals.length };
  }
  return stats;
}

/**
 * 내 측정값을 기준과 비교한다.
 * 허용 오차 = max(항목별 최소 오차, 기준 영상 간 표준편차). 표준편차는 기준이 3개 이상일 때만 신뢰한다.
 * 편차가 허용 오차 1배 이내면 양호, 1~2배면 주의, 2배 이상이면 교정 필요.
 */
export function evaluate(metrics, stats, view) {
  const items = [];
  for (const m of metricsForView(view)) {
    const value = metrics[m.key];
    const s = stats[m.key];
    if (!Number.isFinite(value) || !s) continue;
    const tol = Math.max(m.floor, s.n >= 3 ? s.std : 0);
    const z = (value - s.mean) / tol;
    const a = Math.abs(z);
    const severity = a < 1 ? 'good' : a < 2 ? 'minor' : 'major';
    const side = z > 0 ? 'high' : 'low';
    items.push({
      key: m.key, value, mean: s.mean, tol, z, severity, side,
      score: 100 * Math.min(1, Math.max(0, 1 - (a - 1) / 2)),
    });
  }
  const score = items.length ? Math.round(items.reduce((t, i) => t + i.score, 0) / items.length) : null;
  const issues = items.filter((i) => i.severity !== 'good').sort((x, y) => Math.abs(y.z) - Math.abs(x.z));
  return { score, items, issues };
}
