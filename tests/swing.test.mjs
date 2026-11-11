import test from 'node:test';
import assert from 'node:assert/strict';
import { LM, analyzeSwing, prepareFrames, detectPhases, angle3, SwingError } from '../js/swing.js';
import { buildStats, evaluate } from '../js/profile.js';
import { METRICS, metricsForView } from '../js/metrics.js';
import { textbookStats, publishedStats, TEXTBOOK_KEYS } from '../js/textbook.js';

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
    set(LM[`${L}_EAR`], 0.52 - headSway * sway, 0.26); set(LM[`${R}_EAR`], 0.48 - headSway * sway, 0.26);
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

test('내장 기준(정석 폼)은 모든 항목을 덮고, 기준과 같은 값이면 100점이다', () => {
  assert.deepEqual([...TEXTBOOK_KEYS].sort(), METRICS.map((m) => m.key).sort());
  const stats = textbookStats();
  for (const view of ['faceon', 'dtl']) {
    const ideal = Object.fromEntries(metricsForView(view).map((m) => [m.key, stats[m.key].mean]));
    const ev = evaluate(ideal, stats, view);
    assert.equal(ev.score, 100);
    assert.equal(ev.items.length, metricsForView(view).length);
    // 얼리 익스텐션처럼 크게 벗어난 값은 지적된다
    if (view === 'dtl') {
      const bad = evaluate({ ...ideal, dtl_hip_thrust_impact: 15, dtl_spine_change_impact: -16 }, stats, view);
      assert.deepEqual(bad.issues.map((i) => i.key).sort(), ['dtl_hip_thrust_impact', 'dtl_spine_change_impact']);
      assert.ok(bad.issues.every((i) => i.severity === 'major'));
    }
  }
});

test('선수의 공개 수치는 해당 항목만 덮어쓴다', () => {
  const base = textbookStats();
  const rory = publishedStats('로리 맥길로이');
  assert.equal(rory.stats.fo_shoulder_turn_top.mean, 116);
  assert.equal(rory.stats.fo_hip_turn_top.mean, 42);
  for (const k of TEXTBOOK_KEYS) if (!rory.keys.includes(k)) assert.deepEqual(rory.stats[k], base[k], k);
  assert.equal(publishedStats('넬리 코다'), null);
});

test('어깨가 90도를 넘게 돌아 좌우가 뒤집히면 회전량이 90도보다 크게 나온다', () => {
  const s = synth();
  // 탑 부근(1.2~1.6초)에서 어깨의 좌우 위치를 절반 폭으로 뒤집는다 -> acos(-0.5) = 120도
  const frames = s.frames.map((f) => {
    if (f.t < 1.2 || f.t > 1.6) return f;
    const lm = f.lm.map((p) => ({ ...p }));
    lm[LM.L_SH].x = 0.47; lm[LM.R_SH].x = 0.53;
    return { t: f.t, lm };
  });
  const m = analyzeSwing(frames, { aspect: 1, view: 'faceon' }).metrics;
  assert.ok(Math.abs(m.fo_shoulder_turn_top - 120) < 3, `turn ${m.fo_shoulder_turn_top}`);
});

/** 정면에서 본 합성 퍼팅/어프로치: 손이 주로 좌우로 움직인다. rise는 손이 올라가는 높이. */
function shortGame({ back = 0.06, through = 0.08, rise = 0 } = {}) {
  const base = synth().frames[0].lm;
  const frames = [];
  const sm = (u) => u * u * (3 - 2 * u);
  for (let i = 0; i / FPS <= 3; i++) {
    const t = i / FPS;
    let x = 0.5, y = 0.62;
    if (t > 0.6 && t <= 1.2) { const u = sm((t - 0.6) / 0.6); x = 0.5 - back * u; y = 0.62 - rise * u; }
    else if (t > 1.2 && t <= 1.8) { const u = sm((t - 1.2) / 0.6); x = 0.5 - back + (back + through) * u; y = 0.62 - rise * Math.abs(1 - 2 * u); }
    else if (t > 1.8) { x = 0.5 + through; y = 0.62 - rise; }
    const lm = base.map((p) => ({ ...p }));
    lm[LM.L_WR] = { x: x + 0.01, y }; lm[LM.R_WR] = { x: x - 0.01, y };
    frames.push({ t, lm });
  }
  return frames;
}

test('퍼팅: 좌우 움직임으로 구간을 찾고 템포를 잰다', () => {
  const frames = shortGame();
  assert.throws(() => analyzeSwing(frames, { aspect: 1, view: 'faceon', club: 'iron' }), SwingError);
  assert.throws(() => analyzeSwing(frames, { aspect: 1, view: 'dtl', club: 'putter' }), /정면/);
  const r = analyzeSwing(frames, { aspect: 1, view: 'faceon', club: 'putter' });
  assert.ok(Math.abs(r.times.address - 0.6) <= 0.15, `address ${r.times.address}`);
  assert.ok(Math.abs(r.times.top - 1.2) <= 0.1, `top ${r.times.top}`);
  assert.ok(r.times.impact > 1.35 && r.times.impact < 1.6, `impact ${r.times.impact}`);
  assert.ok(r.times.finish >= 1.7, `finish ${r.times.finish}`);
  assert.ok(r.metrics.tempo > 1.4 && r.metrics.tempo < 3.2, `tempo ${r.metrics.tempo}`);
  assert.ok(Math.abs(r.metrics.fo_head_sway_top) < 2);
  assert.ok(r.bodyHeight > 0.5 && r.bodyHeight < 0.65);
});

test('어프로치: 손이 조금만 올라가는 작은 스윙도 인식한다', () => {
  const frames = shortGame({ back: 0.08, through: 0.08, rise: 0.06 });
  assert.throws(() => analyzeSwing(frames, { aspect: 1, view: 'faceon', club: 'iron' }), SwingError);
  const r = analyzeSwing(frames, { aspect: 1, view: 'faceon', club: 'approach' });
  assert.ok(Math.abs(r.times.top - 1.2) <= 0.12, `top ${r.times.top}`);
  assert.ok(r.times.impact > 1.35 && r.times.impact < 1.65, `impact ${r.times.impact}`);
});

test('클럽별 내장 기준: 드라이버는 아이언과 다르고, 숏게임은 해당 항목만 본다', () => {
  const iron = textbookStats('iron'), driver = textbookStats('driver'), approach = textbookStats('approach'), putter = textbookStats('putter');
  assert.ok(driver.fo_stance.mean > iron.fo_stance.mean);
  assert.equal(driver.tempo.mean, iron.tempo.mean);
  assert.equal(approach.fo_shoulder_turn_top, undefined);
  assert.equal(putter.fo_lead_arm_impact, undefined);
  assert.ok(Object.keys(putter).every((k) => k === 'tempo' || k.startsWith('fo_')));
  const ev = evaluate(Object.fromEntries(Object.entries(putter).map(([k, v]) => [k, v.mean])), putter, 'faceon');
  assert.equal(ev.score, 100);
  assert.equal(ev.items.length, Object.keys(putter).length);
  assert.equal(publishedStats('로리 맥길로이', 'putter'), null);
  assert.equal(publishedStats('로리 맥길로이', 'driver').stats.fo_stance.mean, driver.fo_stance.mean);
});

test('문구: 한 줄 지시가 모든 항목에 있고 퍼팅은 전용 문구를 쓴다', async () => {
  const { textFor, metricByKey } = await import('../js/metrics.js');
  for (const m of METRICS) for (const side of ['low', 'high']) assert.ok(textFor(m, side).cue.length <= 20, `${m.key} ${side}: ${textFor(m, side).cue}`);
  const putt = textFor(metricByKey.fo_head_impact, 'high', 'putter');
  assert.match(putt.title, /공을 따라/);
  assert.equal(textFor(metricByKey.fo_head_impact, 'high', 'iron').title, metricByKey.fo_head_impact.high.title);
});

test('고개만 돌려 코가 움직여도 머리 이동으로 보지 않는다', () => {
  const s = synth();
  const frames = s.frames.map((f) => {
    if (f.t < 1.2 || f.t > 1.6) return f;
    const lm = f.lm.map((p) => ({ ...p }));
    lm[LM.NOSE].x -= 0.06; // 귀는 그대로, 코만 이동
    return { t: f.t, lm };
  });
  const m = analyzeSwing(frames, { aspect: 1, view: 'faceon' }).metrics;
  assert.ok(Math.abs(m.fo_head_sway_top) < 3, `sway ${m.fo_head_sway_top}`);
});

test('임팩트는 손이 어드레스 위치로 돌아온 프레임으로 잡는다', () => {
  const s = synth();
  // 임팩트 직후 손목 검출이 튀어 속도 최대 지점이 뒤로 밀린 상황
  const frames = s.frames.map((f) => {
    if (Math.abs(f.t - 1.9) > 0.02) return f;
    const lm = f.lm.map((p) => ({ ...p }));
    lm[LM.L_WR].x += 0.12; lm[LM.R_WR].x += 0.12; lm[LM.L_WR].y += 0.03; lm[LM.R_WR].y += 0.03;
    return { t: f.t, lm };
  });
  const r = analyzeSwing(frames, { aspect: 1, view: 'faceon' });
  assert.ok(Math.abs(r.times.impact - s.t.impact) <= 0.07, `impact ${r.times.impact}`);
});

test('샷 데이터: 입력 해석과 구질 판정', async () => {
  const { parseShotValue, buildShot, analyzeShot } = await import('../js/shot.js');
  assert.equal(parseShotValue('R3.3'), 3.3);
  assert.equal(parseShotValue('L 2'), -2);
  assert.equal(parseShotValue('-735'), -735);
  assert.equal(parseShotValue(''), null);
  assert.equal(parseShotValue('abc'), null);
  assert.equal(buildShot({ carry: '', dir: ' ' }), null);

  // 사용자의 GDR 화면: 오른쪽으로 7.1도 출발, 왼쪽으로 휘어 R3.3m
  const shot = buildShot({ total: '219', carry: '202', side: 'R3.3', apex: '31.7', ballSpeed: '61.3', launch: '18', dir: '7.1', backSpin: '1966', sideSpin: '-735' });
  const r = analyzeShot(shot, { club: 'driver' });
  assert.equal(r.name, '푸시 드로우');
  assert.ok(r.lines.some((l) => l.includes('상쇄')));
  assert.ok(r.lines.some((l) => l.includes('발사각 18°')));
  assert.ok(r.related.includes('fo_hip_shift_impact:high'));
  // 왼손잡이에게 같은 숫자는 풀 페이드
  assert.equal(analyzeShot(shot, { club: 'driver', leftHanded: true }).name, '풀 페이드');
  // 회전축이 크게 기울면 슬라이스
  assert.equal(analyzeShot({ dir: 0.5, backSpin: 2500, sideSpin: 1600 }, {}).name, '슬라이스');
  assert.equal(analyzeShot({ dir: -4 }, {}).name, '풀');
  assert.equal(analyzeShot({ carry: 150 }, {}).hasShape, false);
});

test('촬영 방향 자동 인식: 어깨와 골반이 벌어져 보이면 정면, 겹쳐 보이면 측면', () => {
  const s = synth();
  const face = analyzeSwing(s.frames, { aspect: 1, view: 'auto' });
  assert.equal(face.view, 'faceon');
  assert.ok(Number.isFinite(face.metrics.fo_stance));
  // 측면: 좌우 관절이 거의 겹친다
  const side = s.frames.map((f) => {
    const lm = f.lm.map((p) => ({ ...p }));
    for (const [l, r] of [[LM.L_SH, LM.R_SH], [LM.L_HIP, LM.R_HIP], [LM.L_KNEE, LM.R_KNEE], [LM.L_ANK, LM.R_ANK]]) {
      const c = (lm[l].x + lm[r].x) / 2;
      lm[l].x = c + 0.008; lm[r].x = c - 0.008;
    }
    return { t: f.t, lm };
  });
  const dtl = analyzeSwing(side, { aspect: 1, view: 'auto' });
  assert.equal(dtl.view, 'dtl');
  assert.ok(Number.isFinite(dtl.metrics.dtl_spine_addr));
  assert.equal(analyzeSwing(s.frames, { aspect: 1, view: 'faceon' }).view, 'faceon');
});
