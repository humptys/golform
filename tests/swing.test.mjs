import test from 'node:test';
import assert from 'node:assert/strict';
import { LM, analyzeSwing, prepareFrames, detectPhases, angle3, SwingError } from '../js/swing.js';
import { buildStats, evaluate } from '../js/profile.js';
import { METRICS, metricsForView } from '../js/metrics.js';

const FPS = 30;
const lerp = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];

/**
 * 정면에서 본 오른손잡이 합성 스윙.
 * 0.6s 정지 -> 0.9s 백스윙 -> 0.3s 다운스윙 -> 0.5s 폴로스루 -> 정지
 * opts.headSway: 탑에서 머리가 타깃 반대쪽으로 밀리는 양(정규화 x)
 * opts.hipShift: 임팩트에서 골반이 타깃 쪽으로 이동하는 양
 */
function synth(opts = {}) {
  const { headSway = 0, hipShift = 0.03, backTime = 0.9, mirror = false } = opts;
  const P = { addr: [0.5, 0.62], top: [0.4, 0.25], imp: [0.52, 0.62], fin: [0.6, 0.22] };
  const t0 = 0.6, t1 = t0 + backTime, t2 = t1 + 0.3, t3 = t2 + 0.5, end = t3 + 0.7;
  const frames = [];
  for (let i = 0; i * (1 / FPS) <= end; i++) {
    const t = i / FPS;
    let h, sway = 0, shift = 0;
    if (t <= t0) h = P.addr;
    else if (t <= t1) { const u = (t - t0) / (t1 - t0); const s = u * u * (3 - 2 * u); h = lerp(P.addr, P.top, s); sway = s; }
    else if (t <= t2) { const u = (t - t1) / (t2 - t1); h = lerp(P.top, P.imp, u * u); sway = 1 - u; shift = u; }
    else if (t <= t3) { const u = (t - t2) / (t3 - t2); h = lerp(P.imp, P.fin, 1 - (1 - u) ** 2); shift = 1 + u; }
    else { h = P.fin; shift = 2; }
    const hx = hipShift * shift;
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5 }));
    const set = (i, x, y) => { lm[i] = { x: mirror ? 1 - x : x, y }; };
    // 오른손잡이를 정면에서 보면 본인의 왼쪽(리드)이 화면 오른쪽
    const L = mirror ? 'R' : 'L', R = mirror ? 'L' : 'R';
    set(LM.NOSE, 0.5 - headSway * sway, 0.27);
    set(LM[`${L}_SH`], 0.56, 0.35); set(LM[`${R}_SH`], 0.44, 0.36);
    set(LM[`${L}_HIP`], 0.53 + hx, 0.55); set(LM[`${R}_HIP`], 0.47 + hx, 0.55);
    set(LM[`${L}_KNEE`], 0.55, 0.7); set(LM[`${R}_KNEE`], 0.45, 0.7);
    set(LM[`${L}_ANK`], 0.58, 0.85); set(LM[`${R}_ANK`], 0.42, 0.85);
    set(LM[`${L}_WR`], h[0] + 0.01, h[1]); set(LM[`${R}_WR`], h[0] - 0.01, h[1]);
    const le = lerp([0.56, 0.35], h, 0.5), re = lerp([0.44, 0.36], h, 0.5);
    set(LM[`${L}_EL`], le[0], le[1]); set(LM[`${R}_EL`], re[0], re[1]);
    frames.push({ t, lm });
  }
  return { frames, t: { address: t0, top: t1, impact: t2, finish: t3 } };
}

test('angle3: 직각과 일직선', () => {
  assert.ok(Math.abs(angle3([1, 0], [0, 0], [0, 1]) - 90) < 1e-9);
  assert.ok(Math.abs(angle3([-1, 0], [0, 0], [1, 0]) - 180) < 1e-9);
});

test('스윙 4구간을 실제 시점 근처에서 찾는다', () => {
  const s = synth();
  const r = analyzeSwing(s.frames, { aspect: 1, leftHanded: false, view: 'faceon' });
  for (const k of ['address', 'top', 'impact', 'finish']) {
    assert.ok(Math.abs(r.times[k] - s.t[k]) <= 0.12, `${k}: ${r.times[k]} vs ${s.t[k]}`);
  }
  assert.ok(r.phases.address < r.phases.top && r.phases.top < r.phases.impact && r.phases.impact < r.phases.finish);
});

test('템포는 백스윙/다운스윙 시간 비', () => {
  const r = analyzeSwing(synth({ backTime: 0.9 }).frames, { aspect: 1, view: 'faceon' });
  assert.ok(Math.abs(r.metrics.tempo - 3) < 0.6, `tempo ${r.metrics.tempo}`);
  const fast = analyzeSwing(synth({ backTime: 0.45 }).frames, { aspect: 1, view: 'faceon' });
  assert.ok(fast.metrics.tempo < r.metrics.tempo - 0.8);
});

test('머리 스웨이와 골반 이동이 부호까지 맞게 측정된다', () => {
  const base = analyzeSwing(synth().frames, { aspect: 1, view: 'faceon' }).metrics;
  const sway = analyzeSwing(synth({ headSway: 0.05 }).frames, { aspect: 1, view: 'faceon' }).metrics;
  assert.ok(Math.abs(base.fo_head_sway_top) < 3);
  // 어깨 폭 0.12 대비 0.05 이동 -> 약 -40%
  assert.ok(sway.fo_head_sway_top < -30, `sway ${sway.fo_head_sway_top}`);
  assert.ok(base.fo_hip_shift_impact > 15, `hip ${base.fo_hip_shift_impact}`);
  const noShift = analyzeSwing(synth({ hipShift: 0 }).frames, { aspect: 1, view: 'faceon' }).metrics;
  assert.ok(Math.abs(noShift.fo_hip_shift_impact) < 2);
});

test('왼손잡이 영상은 반전되어 오른손잡이와 같은 값이 나온다', () => {
  const r = analyzeSwing(synth({ headSway: 0.04 }).frames, { aspect: 1, leftHanded: false, view: 'faceon' }).metrics;
  const l = analyzeSwing(synth({ headSway: 0.04, mirror: true }).frames, { aspect: 1, leftHanded: true, view: 'faceon' }).metrics;
  for (const k of Object.keys(r)) assert.ok(Math.abs(r[k] - l[k]) < 1e-6, k);
});

test('화면 비율이 달라도 비율 기반 측정값은 유지된다', () => {
  // 세로 영상(9:16): 같은 사람이라면 정규화 x가 16/9배로 늘어난다
  const s = synth({ headSway: 0.04 });
  const tall = s.frames.map((f) => ({ t: f.t, lm: f.lm.map((p) => ({ x: p.x * (16 / 9), y: p.y })) }));
  const a = analyzeSwing(s.frames, { aspect: 1, view: 'faceon' }).metrics;
  const b = analyzeSwing(tall, { aspect: 9 / 16, view: 'faceon' }).metrics;
  // acos는 1 근처에서 부동소수 오차를 키우므로 허용치를 넉넉히 둔다
  for (const k of Object.keys(a)) assert.ok(Math.abs(a[k] - b[k]) < 1e-3, k);
});

test('검출 실패 프레임은 보간되고, 너무 많으면 오류', () => {
  const s = synth();
  const holes = s.frames.map((f, i) => (i % 5 === 2 ? { t: f.t, lm: null } : f));
  const r = analyzeSwing(holes, { aspect: 1, view: 'faceon' });
  assert.ok(Math.abs(r.times.impact - s.t.impact) <= 0.12);
  const bad = s.frames.map((f, i) => (i % 2 ? { t: f.t, lm: null } : f));
  assert.throws(() => prepareFrames(bad), SwingError);
});

test('스윙이 없는 영상은 오류', () => {
  const still = synth().frames.slice(0, 15).map((f, i) => ({ t: i / FPS, lm: f.lm }));
  assert.throws(() => detectPhases(prepareFrames(still)), SwingError);
});

test('측면 측정값이 계산된다', () => {
  const r = analyzeSwing(synth().frames, { aspect: 1, view: 'dtl' });
  for (const m of metricsForView('dtl')) assert.ok(Number.isFinite(r.metrics[m.key]), m.key);
});

test('기준과 같으면 100점, 벗어나면 해당 항목이 지적된다', () => {
  const view = 'faceon';
  const refs = [0, 0.004, -0.004].map((d) => ({ metrics: analyzeSwing(synth({ headSway: d }).frames, { aspect: 1, view }).metrics }));
  const stats = buildStats(refs);
  const good = evaluate(refs[0].metrics, stats, view);
  assert.equal(good.score, 100);
  assert.equal(good.issues.length, 0);

  const mine = analyzeSwing(synth({ headSway: 0.05, hipShift: 0 }).frames, { aspect: 1, view }).metrics;
  const ev = evaluate(mine, stats, view);
  assert.ok(ev.score < 100);
  const sway = ev.issues.find((i) => i.key === 'fo_head_sway_top');
  assert.equal(sway.severity, 'major');
  assert.equal(sway.side, 'low');
  const hip = ev.issues.find((i) => i.key === 'fo_hip_shift_impact');
  assert.equal(hip.side, 'low');
  assert.ok(Math.abs(ev.issues[0].z) >= Math.abs(ev.issues.at(-1).z));
});

test('모든 항목에 양방향 교정 문구가 있다', () => {
  const keys = new Set();
  for (const m of METRICS) {
    assert.ok(!keys.has(m.key), m.key);
    keys.add(m.key);
    for (const side of ['low', 'high']) for (const f of ['title', 'why', 'fix']) assert.ok(m[side][f], `${m.key}.${side}.${f}`);
    assert.ok(m.floor > 0);
  }
});
