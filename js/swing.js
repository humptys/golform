// 순수 로직: 포즈 랜드마크 시퀀스 -> 스윙 구간 검출 -> 측정값 계산.
// 브라우저 API에 의존하지 않으므로 node --test 로 검증할 수 있다.

export const LM = {
  NOSE: 0,
  L_EAR: 7, R_EAR: 8,
  L_SH: 11, R_SH: 12,
  L_EL: 13, R_EL: 14,
  L_WR: 15, R_WR: 16,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANK: 27, R_ANK: 28,
};
const USED = Object.values(LM);
const SWAP = [[7, 8], [11, 12], [13, 14], [15, 16], [23, 24], [25, 26], [27, 28]];

export class SwingError extends Error {}

const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const deg = (r) => (r * 180) / Math.PI;

/** b를 꼭짓점으로 하는 a-b-c 각도(도). */
export function angle3(a, b, c) {
  const v1 = [a[0] - b[0], a[1] - b[1]];
  const v2 = [c[0] - b[0], c[1] - b[1]];
  const n = Math.hypot(...v1) * Math.hypot(...v2);
  if (n === 0) return NaN;
  return deg(Math.acos(clamp((v1[0] * v2[0] + v1[1] * v2[1]) / n, -1, 1)));
}

/**
 * 원본 프레임을 분석용으로 정리한다.
 * - 화면 비율 보정(x에 aspect 곱)으로 각도/거리가 왜곡되지 않게 함
 * - 왼손잡이는 좌우 반전해 이후 로직은 항상 오른손잡이 기준으로 동작
 * - 검출 실패 프레임은 선형 보간, 3프레임 이동평균으로 떨림 완화
 * @param raw [{t, lm: [{x,y}] | null}]
 */
export function prepareFrames(raw, { aspect = 1, leftHanded = false } = {}) {
  const valid = raw.filter((f) => f.lm).length;
  if (raw.length < 10 || valid / raw.length < 0.6) {
    throw new SwingError('영상에서 사람을 충분히 인식하지 못했습니다. 전신이 화면에 다 나오는 영상인지 확인해 주세요.');
  }
  let frames = raw.map((f) => {
    if (!f.lm) return { t: f.t, p: null };
    const p = [];
    for (const i of USED) {
      const x = leftHanded ? 1 - f.lm[i].x : f.lm[i].x;
      p[i] = [x * aspect, f.lm[i].y];
    }
    if (leftHanded) for (const [a, b] of SWAP) [p[a], p[b]] = [p[b], p[a]];
    return { t: f.t, p };
  });

  // 보간
  const idx = frames.map((f, i) => (f.p ? i : -1)).filter((i) => i >= 0);
  frames = frames.map((f, i) => {
    if (f.p) return f;
    const prev = idx.filter((j) => j < i).pop();
    const next = idx.find((j) => j > i);
    if (prev === undefined) return { t: f.t, p: frames[next].p };
    if (next === undefined) return { t: f.t, p: frames[prev].p };
    const w = (i - prev) / (next - prev);
    const p = [];
    for (const k of USED) {
      p[k] = [
        frames[prev].p[k][0] * (1 - w) + frames[next].p[k][0] * w,
        frames[prev].p[k][1] * (1 - w) + frames[next].p[k][1] * w,
      ];
    }
    return { t: f.t, p };
  });

  // 이동평균(3)
  return frames.map((f, i) => {
    const nb = [frames[i - 1], f, frames[i + 1]].filter(Boolean);
    const p = [];
    for (const k of USED) {
      p[k] = [
        nb.reduce((s, g) => s + g.p[k][0], 0) / nb.length,
        nb.reduce((s, g) => s + g.p[k][1], 0) / nb.length,
      ];
    }
    return { t: f.t, p };
  });
}

const hands = (p) => mid(p[LM.L_WR], p[LM.R_WR]);
const shMid = (p) => mid(p[LM.L_SH], p[LM.R_SH]);
const hipMid = (p) => mid(p[LM.L_HIP], p[LM.R_HIP]);
// 머리 위치는 양 귀의 중점으로 잡는다. 코는 고개를 돌리거나 숙이기만 해도 크게 움직여 머리 이동으로 오인된다.
const head = (p) => mid(p[LM.L_EAR], p[LM.R_EAR]);
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/**
 * 손(양 손목 중점)의 궤적으로 스윙 4구간을 찾는다.
 * 임팩트: 손 속도가 최대인 부근에서 손이 가장 낮은 프레임
 * 탑: 임팩트 직전 구간에서 손이 가장 높은 프레임
 * 어드레스: 탑 이전, 손이 임팩트 위치 근처에서 정지해 있던 마지막 프레임
 * 피니시: 임팩트 이후 손이 가장 높은 프레임
 *
 * club 'approach'는 손이 조금만 올라가도 스윙으로 인정하고,
 * 'putter'는 손이 거의 수평으로만 움직이므로 좌우 이동으로 구간을 찾는다(정면 영상 전용).
 */
export function detectPhases(frames, { club = 'iron' } = {}) {
  const n = frames.length;
  const torso = median(frames.map((f) => dist(shMid(f.p), hipMid(f.p))));
  const h = frames.map((f) => hands(f.p));
  const t = frames.map((f) => f.t);
  const speed = h.map((_, i) => {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    return dist(h[a], h[b]) / Math.max(1e-6, t[b] - t[a]) / torso;
  });
  const argBest = (lo, hi, score) => {
    let best = -1;
    for (let i = Math.max(0, lo); i <= Math.min(n - 1, hi); i++) {
      if (best < 0 || score(i) > score(best)) best = i;
    }
    return best;
  };
  const idxAt = (time) => {
    let i = 0;
    while (i < n - 1 && t[i] < time) i++;
    return i;
  };

  if (club === 'putter') return detectPutt({ n, torso, h, t, speed, argBest, idxAt });

  const peak = argBest(0, n - 1, (i) => speed[i]);
  const impact = argBest(idxAt(t[peak] - 0.1), idxAt(t[peak] + 0.15), (i) => h[i][1]);
  const top = argBest(idxAt(t[impact] - 2.0), idxAt(t[impact] - 0.08) - 1, (i) => -h[i][1]);
  const fail = () => {
    throw new SwingError('스윙 동작을 찾지 못했습니다. 어드레스부터 피니시까지 스윙 1회가 담긴 영상을 사용해 주세요.');
  };
  if (top < 0 || top >= impact) fail();
  if (h[impact][1] - h[top][1] < (club === 'approach' ? 0.12 : 0.5) * torso) fail();

  const thr = 0.07 * speed[peak];
  let address = -1;
  for (let i = top - 1; i >= 0; i--) {
    if (speed[i] < thr && dist(h[i], h[impact]) < 0.6 * torso) {
      address = i;
      break;
    }
  }
  if (address < 0) address = argBest(idxAt(t[top] - 1.5), top - 1, (i) => h[i][1]);
  if (address < 0 || address >= top) fail();

  // 임팩트 보정: 임팩트 순간 손은 어드레스 때 위치로 돌아온다. 속도 최대 지점은 모션 블러로 흔들리기 쉬우므로
  // 탑 이후 손이 어드레스 위치에 가장 가까워지는 프레임을 임팩트로 삼는다(폴로스루로 넘어가지 않게 범위를 제한).
  const refined = argBest(top + 1, idxAt(t[impact] + 0.12), (i) => -dist(h[i], h[address]));
  const impactFinal = refined > top ? refined : impact;

  let finish = argBest(idxAt(t[impactFinal] + 0.15), idxAt(t[impactFinal] + 2.5), (i) => -h[i][1]);
  if (finish <= impactFinal) finish = n - 1;
  if (finish <= impactFinal) fail();

  return { address, top, impact: impactFinal, finish };
}

/**
 * 퍼팅 스트로크의 구간. 타깃 방향이 +x(정면, 오른손잡이 기준)라고 가정한다.
 * 탑: 손이 타깃 반대쪽으로 가장 멀리 간 프레임 / 임팩트: 손이 어드레스 위치로 돌아온 프레임
 * 피니시: 손이 타깃 쪽으로 가장 멀리 간 프레임
 */
function detectPutt({ n, torso, h, t, speed, argBest, idxAt }) {
  const fail = () => {
    throw new SwingError('퍼팅 스트로크를 찾지 못했습니다. 정면에서 찍은, 스트로크 1회가 담긴 영상을 사용해 주세요.');
  };
  const vx = h.map((_, i) => {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    return (h[b][0] - h[a][0]) / Math.max(1e-6, t[b] - t[a]) / torso;
  });
  const peak = argBest(0, n - 1, (i) => vx[i]);
  const lo = idxAt(t[peak] - 1.5);
  const top = argBest(lo, peak - 1, (i) => -h[i][0]);
  if (top < 0 || h[peak][0] - h[top][0] < 0.04 * torso) fail();

  // 어드레스: 탑 이전, 손이 뒤로 빠지기 전 위치에서 멈춰 있던 마지막 프레임
  const start = argBest(lo, top - 1, (i) => h[i][0]);
  if (start < 0) fail();
  const backLen = h[start][0] - h[top][0];
  if (backLen < 0.04 * torso) fail();
  let address = -1;
  for (let i = top - 1; i >= 0; i--) {
    if (speed[i] < 0.1 * vx[peak] && h[i][0] - h[top][0] > 0.6 * backLen) {
      address = i;
      break;
    }
  }
  if (address < 0) address = start;

  let impact = -1;
  for (let i = top + 1; i < n; i++) {
    if (h[i][0] >= h[address][0]) {
      impact = i;
      break;
    }
  }
  if (impact < 0) impact = peak;
  if (impact <= top) fail();
  let finish = argBest(impact + 1, idxAt(t[impact] + 1.5), (i) => h[i][0]);
  if (finish <= impact) finish = n - 1;
  if (finish <= impact) fail();
  return { address, top, impact, finish };
}

/**
 * 구간별 자세에서 측정값을 계산한다. 왼손잡이는 prepareFrames에서 반전되었으므로
 * 리드(타깃 쪽) = 왼쪽, 트레일 = 오른쪽으로 고정이다.
 * @param view 'faceon'(정면) | 'dtl'(타깃 후방/측면)
 */
export function computeMetrics(frames, ph, view) {
  const A = frames[ph.address].p;
  const T = frames[ph.top].p;
  const I = frames[ph.impact].p;
  const F = frames[ph.finish].p;
  const torso = dist(shMid(A), hipMid(A));
  const shW = dist(A[LM.L_SH], A[LM.R_SH]);
  const m = {};

  const back = frames[ph.top].t - frames[ph.address].t;
  const down = frames[ph.impact].t - frames[ph.top].t;
  m.tempo = back / Math.max(1e-6, down);

  const leadArm = (p) => angle3(p[LM.L_SH], p[LM.L_EL], p[LM.L_WR]);
  const headLift = (p) => (-(head(p)[1] - head(A)[1]) / torso) * 100;

  if (view === 'faceon') {
    // 정면: 오른손잡이 기준 타깃 방향 = 화면 오른쪽(+x)
    const pctX = (a, b) => ((a[0] - b[0]) / shW) * 100;
    // 화면상 좌우 폭이 줄어든 비율로 회전량을 추정한다. 90도를 넘게 돌면 좌우 순서가 뒤집혀 비율이 음수가 된다.
    const turn = (p, l, r) => deg(Math.acos(clamp((p[l][0] - p[r][0]) / (A[l][0] - A[r][0]), -1, 1)));
    m.fo_stance = dist(A[LM.L_ANK], A[LM.R_ANK]) / shW;
    m.fo_shoulder_tilt_addr = deg(Math.atan2(A[LM.R_SH][1] - A[LM.L_SH][1], Math.abs(A[LM.L_SH][0] - A[LM.R_SH][0])));
    m.fo_head_sway_top = pctX(head(T), head(A));
    m.fo_hip_sway_top = pctX(hipMid(T), hipMid(A));
    m.fo_shoulder_turn_top = turn(T, LM.L_SH, LM.R_SH);
    m.fo_hip_turn_top = turn(T, LM.L_HIP, LM.R_HIP);
    m.fo_lead_arm_top = leadArm(T);
    m.fo_head_lift_top = headLift(T);
    m.fo_hip_shift_impact = pctX(hipMid(I), hipMid(A));
    m.fo_head_impact = pctX(head(I), head(A));
    m.fo_lead_arm_impact = leadArm(I);
    m.fo_hands_fwd_impact = pctX(hands(I), hands(A));
    m.fo_finish_weight = pctX(hipMid(F), F[LM.L_ANK]);
  } else {
    // 측면: 공이 있는 방향(어드레스 때 손이 골반보다 나가 있는 쪽)을 +로 둔다
    const ballDir = Math.sign(hands(A)[0] - hipMid(A)[0]) || 1;
    const spine = (p) => deg(Math.atan2((shMid(p)[0] - hipMid(p)[0]) * ballDir, hipMid(p)[1] - shMid(p)[1]));
    const knee = (p, h, k, a) => angle3(p[h], p[k], p[a]);
    m.dtl_spine_addr = spine(A);
    m.dtl_knee_addr = (knee(A, LM.L_HIP, LM.L_KNEE, LM.L_ANK) + knee(A, LM.R_HIP, LM.R_KNEE, LM.R_ANK)) / 2;
    m.dtl_spine_change_top = spine(T) - spine(A);
    m.dtl_trail_knee_top = knee(T, LM.R_HIP, LM.R_KNEE, LM.R_ANK) - knee(A, LM.R_HIP, LM.R_KNEE, LM.R_ANK);
    m.dtl_hands_height_top = ((shMid(T)[1] - hands(T)[1]) / torso) * 100;
    m.dtl_lead_arm_top = leadArm(T);
    m.dtl_head_lift_top = headLift(T);
    m.dtl_spine_change_impact = spine(I) - spine(A);
    m.dtl_hip_thrust_impact = (((hipMid(I)[0] - hipMid(A)[0]) * ballDir) / torso) * 100;
    m.dtl_head_lift_impact = headLift(I);
  }
  for (const k of Object.keys(m)) if (!Number.isFinite(m[k])) delete m[k];
  return m;
}

/**
 * 어드레스 자세로 촬영 방향을 추정한다.
 * 정면에서는 양 어깨·골반이 좌우로 벌어져 보이고, 측면(타깃 후방)에서는 거의 겹쳐 보인다.
 */
export function detectView(A) {
  const torso = dist(shMid(A), hipMid(A));
  const shoulders = Math.abs(A[LM.L_SH][0] - A[LM.R_SH][0]) / torso;
  const hips = Math.abs(A[LM.L_HIP][0] - A[LM.R_HIP][0]) / torso;
  return shoulders + hips > 0.75 ? 'faceon' : 'dtl';
}

/** 원본 프레임 -> {phases, times, view, metrics} 한 번에. view가 'auto'면 촬영 방향을 추정한다. */
export function analyzeSwing(raw, { aspect, leftHanded, view, club = 'iron' }) {
  if (club === 'putter' && view === 'dtl') throw new SwingError('퍼팅은 정면에서 찍은 영상만 분석할 수 있습니다.');
  const frames = prepareFrames(raw, { aspect, leftHanded });
  const phases = detectPhases(frames, { club });
  if (view === 'auto') view = club === 'putter' ? 'faceon' : detectView(frames[phases.address].p);
  const times = Object.fromEntries(Object.entries(phases).map(([k, i]) => [k, frames[i].t]));
  // 화면에서 사람이 차지하는 키(코~발목, 화면 높이 대비). 너무 작으면 관절 위치 오차가 커진다.
  const A = frames[phases.address].p;
  const bodyHeight = (A[LM.L_ANK][1] + A[LM.R_ANK][1]) / 2 - A[LM.NOSE][1];
  return { phases, times, view, metrics: computeMetrics(frames, phases, view), bodyHeight };
}
