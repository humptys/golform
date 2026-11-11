// 구간 사진 위에 골격과 교정 표시를 그린다. 한 장에는 문제 하나만 그린다.
// 빨강/노랑 = 지금 내 자세, 초록 점선 = 목표, 흰 화살표 = 옮길 방향.
// 좌표는 저장된 사진(사람 주변만 잘라낸 것) 기준 0~1 값이다.

const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
const NOW = { major: '#ff6b5e', minor: '#f2c14e' };
const GOAL = '#3ddc84';
const INK = '#0b140f';
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** 측정 항목이 어느 구간 사진에 그려지는지. 사진으로 보여줄 수 없는 항목(템포)은 없다. */
export const PHASE_OF = {
  fo_stance: 'address', fo_shoulder_tilt_addr: 'address',
  fo_head_sway_top: 'top', fo_hip_sway_top: 'top', fo_shoulder_turn_top: 'top', fo_hip_turn_top: 'top', fo_lead_arm_top: 'top', fo_head_lift_top: 'top',
  fo_hip_shift_impact: 'impact', fo_head_impact: 'impact', fo_lead_arm_impact: 'impact', fo_hands_fwd_impact: 'impact',
  fo_finish_weight: 'finish',
  dtl_spine_addr: 'address', dtl_knee_addr: 'address',
  dtl_spine_change_top: 'top', dtl_trail_knee_top: 'top', dtl_hands_height_top: 'top', dtl_lead_arm_top: 'top', dtl_head_lift_top: 'top',
  dtl_spine_change_impact: 'impact', dtl_hip_thrust_impact: 'impact', dtl_head_lift_impact: 'impact',
};

export function drawSkeleton(g, pts, w, h, { color = 'rgba(255,255,255,0.85)', width = 2 } = {}) {
  const P = (i) => [pts[i][0] * w, pts[i][1] * h];
  g.save();
  g.strokeStyle = color;
  g.lineWidth = width;
  g.lineCap = 'round';
  for (const [a, b] of BONES) {
    if (!pts[a] || !pts[b]) continue;
    g.beginPath(); g.moveTo(...P(a)); g.lineTo(...P(b)); g.stroke();
  }
  g.restore();
}

/** 사람이 사진을 가득 채우도록, 이 구간과 어드레스의 관절이 모두 들어오는 영역을 고른다. */
function tightRect(pose, phase) {
  const pts = [...Object.values(pose[phase]), ...Object.values(pose.address)];
  let x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
  let y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
  const padX = (x1 - x0) * 0.35 + 0.04, padTop = (y1 - y0) * 0.16, padBottom = (y1 - y0) * 0.08;
  x0 = Math.max(0, x0 - padX); x1 = Math.min(1, x1 + padX);
  y0 = Math.max(0, y0 - padTop); y1 = Math.min(1, y1 + padBottom);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * 구간 사진 한 장을 그린다. item이 있으면 그 문제 하나만 표시하고, 없으면 골격만 그린다.
 * @param item {key, value, mean, tol, severity, side} | null
 */
export function drawShot(canvas, img, pose, phase, item, { leftHanded = false, fmtValue = (v) => String(Math.round(v)) } = {}) {
  const rect = tightRect(pose, phase);
  const W = 360;
  const H = Math.round((W * rect.h * img.height) / (rect.w * img.width));
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  g.drawImage(img, rect.x * img.width, rect.y * img.height, rect.w * img.width, rect.h * img.height, 0, 0, W, H);
  g.fillStyle = 'rgba(8,14,11,0.42)'; // 사진을 조금 어둡게 해 선이 잘 보이게 한다
  g.fillRect(0, 0, W, H);

  const tr = (pts) => Object.fromEntries(Object.entries(pts).map(([i, p]) => [i, [((p[0] - rect.x) / rect.w) * W, ((p[1] - rect.y) / rect.h) * H]]));
  const A = tr(pose.address);
  const C = tr(pose[phase]);
  const s = W / 300;

  g.save();
  g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 1.6 * s; g.lineCap = 'round';
  for (const [a, b] of BONES) { g.beginPath(); g.moveTo(...C[a]); g.lineTo(...C[b]); g.stroke(); }
  g.restore();
  if (!item) return;

  const L = leftHanded ? { SH: 12, EL: 14, WR: 16, ANK: 28 } : { SH: 11, EL: 13, WR: 15, ANK: 27 };
  const T = leftHanded ? { SH: 11, HIP: 23, KNEE: 25, ANK: 27 } : { SH: 12, HIP: 24, KNEE: 26, ANK: 28 };
  const targetDir = leftHanded ? -1 : 1;
  const shMid = (p) => mid(p[11], p[12]);
  const hipMid = (p) => mid(p[23], p[24]);
  const hands = (p) => mid(p[15], p[16]);
  const head = (p) => (p[7] && p[8] ? mid(p[7], p[8]) : p[0]);
  const shW = dist(A[11], A[12]);
  const torso = dist(shMid(A), hipMid(A));
  const ballDir = Math.sign(hands(A)[0] - hipMid(A)[0]) || 1;
  const now = NOW[item.severity] ?? NOW.minor;

  const line = (a, b, color, width, dash) => {
    g.save(); g.strokeStyle = color; g.lineWidth = width * s; g.lineCap = 'round';
    if (dash) g.setLineDash(dash.map((d) => d * s));
    g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke(); g.restore();
  };
  const solid = (a, b) => { line(a, b, INK, 5.5); line(a, b, now, 3.2); };
  const goalLine = (a, b) => { line(a, b, INK, 4.5); line(a, b, GOAL, 2.4, [5, 4]); };
  const dot = (p, color, ring = false) => {
    g.save(); g.lineWidth = 2 * s;
    g.beginPath(); g.arc(...p, 5.5 * s, 0, Math.PI * 2);
    if (ring) { g.strokeStyle = INK; g.lineWidth = 4.5 * s; g.stroke(); g.strokeStyle = color; g.lineWidth = 2.4 * s; g.stroke(); }
    else { g.fillStyle = color; g.strokeStyle = INK; g.fill(); g.stroke(); }
    g.restore();
  };
  const arrow = (a, b) => {
    const len = dist(a, b);
    if (len < 10 * s) return;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len, hs = Math.min(9 * s, len * 0.5);
    const start = [a[0] + ux * 7 * s, a[1] + uy * 7 * s], end = [b[0] - ux * 7 * s, b[1] - uy * 7 * s];
    if (dist(start, end) < 4 * s) return;
    const neck = [end[0] - ux * hs * 0.7, end[1] - uy * hs * 0.7];
    line(start, neck, INK, 5); line(start, neck, '#fff', 2.6);
    g.save(); g.fillStyle = '#fff'; g.strokeStyle = INK; g.lineWidth = 1.5 * s; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(...end);
    g.lineTo(end[0] - ux * hs - uy * hs * 0.55, end[1] - uy * hs + ux * hs * 0.55);
    g.lineTo(end[0] - ux * hs + uy * hs * 0.55, end[1] - uy * hs - ux * hs * 0.55);
    g.closePath(); g.fill(); g.stroke(); g.restore();
  };
  /** 글자 표식. align: 표식이 기준점의 어느 쪽에 놓일지 */
  const tag = (text, p, color, align = 'center', dy = 0) => {
    g.save();
    g.font = `bold ${15 * s}px -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;
    const tw = g.measureText(text).width, padX = 6 * s, th = 22 * s;
    let x = align === 'left' ? p[0] + 10 * s : align === 'right' ? p[0] - 10 * s - tw - padX * 2 : p[0] - tw / 2 - padX;
    let y = p[1] + dy - th / 2;
    x = Math.min(W - tw - padX * 2 - 3, Math.max(3, x));
    y = Math.min(H - th - 3, Math.max(3, y));
    g.fillStyle = 'rgba(11,20,15,0.88)';
    g.beginPath(); g.roundRect(x, y, tw + padX * 2, th, 6 * s); g.fill();
    g.fillStyle = color; g.textBaseline = 'middle';
    g.fillText(text, x + padX, y + th / 2 + 0.5 * s);
    g.restore();
  };
  const val = (v) => fmtValue(v);

  // 위치가 어긋난 경우: 지금 위치(점) -> 목표 위치(초록 고리, 점선)로 화살표
  const move = (cur, goal, vertical) => {
    const half = 0.3 * torso;
    if (vertical) goalLine([goal[0] - half, goal[1]], [goal[0] + half, goal[1]]);
    else goalLine([goal[0], goal[1] - half], [goal[0], goal[1] + half]);
    arrow(cur, goal);
    dot(goal, GOAL, true);
    dot(cur, now);
    if (vertical) {
      tag('지금', cur, now, 'left');
      tag('목표', goal, GOAL, 'right');
    } else {
      const right = goal[0] >= cur[0];
      tag('지금', cur, now, right ? 'right' : 'left');
      tag('목표', goal, GOAL, right ? 'left' : 'right');
    }
  };
  const moveX = (cur, baseX, unit, dir) => move(cur, [baseX + ((dir * item.mean) / 100) * unit, cur[1]], false);
  const moveY = (cur, baseY) => move(cur, [cur[0], baseY - (item.mean / 100) * torso], true);

  // 관절 각도: 지금 팔다리(색 선)와 목표 방향(초록 점선)
  const joint = (a, b, c) => {
    const u = [(a[0] - b[0]) / dist(a, b), (a[1] - b[1]) / dist(a, b)];
    const v = [c[0] - b[0], c[1] - b[1]];
    const sign = Math.sign(u[0] * v[1] - u[1] * v[0]) || 1;
    const phi = (sign * item.mean * Math.PI) / 180, len = dist(b, c);
    const goal = [b[0] + (u[0] * Math.cos(phi) - u[1] * Math.sin(phi)) * len, b[1] + (u[0] * Math.sin(phi) + u[1] * Math.cos(phi)) * len];
    goalLine(b, goal);
    solid(a, b); solid(b, c);
    arrow(c, goal);
    dot(b, now);
    const right = goal[0] >= c[0];
    tag(`지금 ${val(item.value)}`, c, now, right ? 'right' : 'left', 14 * s);
    tag(`목표 ${val(item.mean)}`, goal, GOAL, right ? 'left' : 'right', -14 * s);
  };
  // 두 관절을 잇는 선(어깨선, 상체 등): 지금 선과 목표 선
  const lines = (a, b, ga, gb, anchor) => {
    goalLine(ga, gb);
    solid(a, b);
    tag(`지금 ${val(item.value)}`, anchor, now, 'right', -4 * s);
    tag(`목표 ${val(item.mean)}`, anchor, GOAL, 'left', -4 * s);
  };
  // 회전량: 어깨/골반 선과 돌릴 방향을 나타내는 둥근 화살표
  const turn = (a, b, addrHalf) => {
    const m = mid(a, b);
    solid(a, b);
    const more = item.side === 'low'; // 더 돌려야 하는가
    const rx = Math.max(addrHalf * 1.25, 26 * s), ry = rx * 0.38;
    // 백스윙은 타깃 반대쪽으로 도는 동작: 몸 앞쪽(타원의 아래 호)이 타깃 반대쪽으로 움직인다
    const from = more ? (targetDir > 0 ? 0.15 : 0.85) : (targetDir > 0 ? 0.85 : 0.15);
    const to = more ? (targetDir > 0 ? 0.85 : 0.15) : (targetDir > 0 ? 0.15 : 0.85);
    const pt = (f) => [m[0] + rx * Math.cos(Math.PI * f), m[1] + ry * Math.sin(Math.PI * f)];
    g.save(); g.lineCap = 'round';
    for (const [color, width] of [[INK, 5], ['#fff', 2.6]]) {
      g.strokeStyle = color; g.lineWidth = width * s; g.beginPath();
      for (let k = 0; k <= 16; k++) { const p = pt(from + ((to - from) * 0.9 * k) / 16); k ? g.lineTo(...p) : g.moveTo(...p); }
      g.stroke();
    }
    g.restore();
    arrow(pt(from + (to - from) * 0.75), pt(to));
    tag(`지금 ${val(item.value)}`, [m[0], Math.min(a[1], b[1])], now, 'right', -20 * s);
    tag(`목표 ${val(item.mean)}`, [m[0], Math.min(a[1], b[1])], GOAL, 'left', -20 * s);
  };

  switch (item.key) {
    case 'fo_head_sway_top': case 'fo_head_impact': moveX(head(C), head(A)[0], shW, targetDir); break;
    case 'fo_hip_sway_top': case 'fo_hip_shift_impact': moveX(hipMid(C), hipMid(A)[0], shW, targetDir); break;
    case 'fo_hands_fwd_impact': moveX(hands(C), hands(A)[0], shW, targetDir); break;
    case 'fo_finish_weight': moveX(hipMid(C), C[L.ANK][0], shW, targetDir); break;
    case 'dtl_hip_thrust_impact': moveX(hipMid(C), hipMid(A)[0], torso, ballDir); break;
    case 'fo_head_lift_top': case 'dtl_head_lift_top': case 'dtl_head_lift_impact': moveY(head(C), head(A)[1]); break;
    case 'dtl_hands_height_top': moveY(hands(C), shMid(C)[1]); break;
    case 'fo_lead_arm_top': case 'fo_lead_arm_impact': case 'dtl_lead_arm_top': joint(C[L.SH], C[L.EL], C[L.WR]); break;
    case 'dtl_knee_addr': joint(C[T.HIP], C[T.KNEE], C[T.ANK]); break;
    case 'dtl_trail_knee_top': {
      // 변화량 항목: 목표 무릎 각도 = 어드레스 때 각도 + 기준 변화량
      const ang = (a, b, c) => (Math.acos(Math.max(-1, Math.min(1, ((a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1])) / (dist(a, b) * dist(b, c))))) * 180) / Math.PI;
      const addr = ang(A[T.HIP], A[T.KNEE], A[T.ANK]);
      const saved = { value: item.value, mean: item.mean };
      item = { ...item, value: addr + saved.value, mean: addr + saved.mean };
      joint(C[T.HIP], C[T.KNEE], C[T.ANK]);
      break;
    }
    case 'fo_shoulder_turn_top': turn(C[11], C[12], shW / 2); break;
    case 'fo_hip_turn_top': turn(C[23], C[24], dist(A[23], A[24]) / 2); break;
    case 'fo_shoulder_tilt_addr': {
      const m = shMid(C), half = shW / 2, r = (item.mean * Math.PI) / 180;
      const sx = Math.sign(C[T.SH][0] - m[0]) || -1; // 트레일 어깨가 있는 쪽
      lines(C[11], C[12], [m[0] + sx * half * Math.cos(r), m[1] + half * Math.sin(r)], [m[0] - sx * half * Math.cos(r), m[1] - half * Math.sin(r)], [m[0], m[1] - 24 * s]);
      break;
    }
    case 'fo_stance': {
      const m = mid(C[27], C[28]), half = (item.mean * shW) / 2, y = Math.max(C[27][1], C[28][1]) + 12 * s;
      lines(C[27], C[28], [m[0] - half, y], [m[0] + half, y], [m[0], Math.min(C[27][1], C[28][1]) - 22 * s]);
      break;
    }
    case 'dtl_spine_addr': case 'dtl_spine_change_top': case 'dtl_spine_change_impact': {
      const hip = hipMid(C), sh = shMid(C), len = dist(hip, sh);
      const addrAng = (Math.atan2((shMid(A)[0] - hipMid(A)[0]) * ballDir, hipMid(A)[1] - shMid(A)[1]) * 180) / Math.PI;
      const abs = item.key === 'dtl_spine_addr';
      const goalDeg = abs ? item.mean : addrAng + item.mean;
      const r = (goalDeg * Math.PI) / 180;
      const shown = abs ? item : { ...item, value: addrAng + item.value, mean: goalDeg };
      item = shown;
      lines(hip, sh, hip, [hip[0] + Math.sin(r) * len * ballDir, hip[1] - Math.cos(r) * len], [sh[0], sh[1] - 22 * s]);
      break;
    }
    default: break;
  }
}
