// 구간 사진 위에 골격과 교정 표시(번호, 내 위치, 기준 범위, 움직일 방향 화살표)를 그린다.
// 좌표는 저장된 사진(사람 주변만 잘라낸 것) 기준 0~1 값이다.

const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
const COLOR = { major: '#ff6b5e', minor: '#f2c14e', ok: '#3ddc84' };
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
  g.fillStyle = '#fff';
  for (const i of new Set(BONES.flat().concat(0))) {
    if (!pts[i]) continue;
    g.beginPath(); g.arc(...P(i), width * 1.3, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

/**
 * @param g      canvas 2d context (사진이 이미 그려진 상태)
 * @param pose   {address, top, impact, finish} 각 구간의 관절 좌표(0~1)
 * @param phase  지금 그리는 구간
 * @param items  이 구간의 지적 [{n, key, value, mean, tol, severity}]
 */
export function drawPhase(g, w, h, pose, phase, items, { leftHanded = false } = {}) {
  const px = (pts) => Object.fromEntries(Object.entries(pts).map(([i, p]) => [i, [p[0] * w, p[1] * h]]));
  const A = px(pose.address);
  const C = px(pose[phase]);
  const s = Math.max(1, w / 300); // 선 굵기 배율
  // 리드(타깃 쪽) = 오른손잡이의 왼쪽
  const L = leftHanded ? { SH: 12, EL: 14, WR: 16, HIP: 24, KNEE: 26, ANK: 28 } : { SH: 11, EL: 13, WR: 15, HIP: 23, KNEE: 25, ANK: 27 };
  const T = leftHanded ? { SH: 11, HIP: 23, KNEE: 25, ANK: 27 } : { SH: 12, HIP: 24, KNEE: 26, ANK: 28 };
  const targetDir = leftHanded ? -1 : 1; // 정면 영상에서 타깃 방향
  const shMid = (p) => mid(p[11], p[12]);
  const hipMid = (p) => mid(p[23], p[24]);
  const hands = (p) => mid(p[15], p[16]);
  const nose = (p) => p[0];
  const shW = dist(A[11], A[12]);
  const torso = dist(shMid(A), hipMid(A));
  const ballDir = Math.sign(hands(A)[0] - hipMid(A)[0]) || 1; // 측면 영상에서 공이 있는 쪽

  drawSkeleton(g, pose[phase], w, h, { width: 2 * s });

  const line = (a, b, color, width = 4, dash = null) => {
    g.save(); g.strokeStyle = color; g.lineWidth = width * s; g.lineCap = 'round';
    if (dash) g.setLineDash(dash.map((d) => d * s));
    g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke(); g.restore();
  };
  const dot = (p, color, r = 6) => {
    g.save(); g.fillStyle = color; g.strokeStyle = '#0b140f'; g.lineWidth = 2 * s;
    g.beginPath(); g.arc(...p, r * s, 0, Math.PI * 2); g.fill(); g.stroke(); g.restore();
  };
  const arrow = (a, b, color) => {
    const len = dist(a, b);
    if (len < 8 * s) return;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len, hs = Math.min(11 * s, len * 0.6);
    line(a, [b[0] - ux * hs * 0.6, b[1] - uy * hs * 0.6], '#0b140f', 7);
    line(a, [b[0] - ux * hs * 0.6, b[1] - uy * hs * 0.6], color, 4);
    g.save(); g.fillStyle = color; g.strokeStyle = '#0b140f'; g.lineWidth = 1.5 * s;
    g.beginPath(); g.moveTo(...b);
    g.lineTo(b[0] - ux * hs - uy * hs * 0.6, b[1] - uy * hs + ux * hs * 0.6);
    g.lineTo(b[0] - ux * hs + uy * hs * 0.6, b[1] - uy * hs - ux * hs * 0.6);
    g.closePath(); g.fill(); g.stroke(); g.restore();
  };
  const band = (x, y, bw, bh) => {
    g.save(); g.fillStyle = 'rgba(61,220,132,0.28)'; g.strokeStyle = 'rgba(61,220,132,0.9)'; g.lineWidth = 1.5 * s;
    g.fillRect(x, y, bw, bh); g.strokeRect(x, y, bw, bh); g.restore();
  };
  const badge = (p, n, color) => {
    const r = 11 * s;
    const x = Math.min(w - r - 2, Math.max(r + 2, p[0]));
    const y = Math.min(h - r - 2, Math.max(r + 2, p[1]));
    g.save(); g.fillStyle = color; g.strokeStyle = '#0b140f'; g.lineWidth = 2 * s;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = '#0b140f'; g.font = `bold ${13 * s}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(n), x, y + 0.5 * s); g.restore();
  };

  // 좌우 위치: 초록 띠 = 있어야 할 범위, 색 점 = 내 위치, 화살표 = 옮길 방향
  const shiftX = (it, cur, baseX, unit, dir) => {
    const c = COLOR[it.severity];
    const ideal = baseX + (dir * it.mean / 100) * unit;
    const half = Math.max(4 * s, (it.tol / 100) * unit);
    band(ideal - half, cur[1] - 0.4 * torso, half * 2, 0.8 * torso);
    arrow(cur, [ideal, cur[1]], c);
    dot(cur, c);
    badge([cur[0], cur[1] - 0.4 * torso - 14 * s], it.n, c);
  };
  // 상하 위치
  const shiftY = (it, cur, baseY, cx) => {
    const c = COLOR[it.severity];
    const ideal = baseY - (it.mean / 100) * torso;
    const half = Math.max(4 * s, (it.tol / 100) * torso);
    band(cx - 0.6 * shW, ideal - half, 1.2 * shW, half * 2);
    arrow(cur, [cur[0], ideal], c);
    dot(cur, c);
    badge([cur[0] + 0.6 * shW + 14 * s, cur[1]], it.n, c);
  };
  // 관절 각도: 해당 팔다리를 굵게 표시
  const joint = (it, a, b, c2) => {
    const c = COLOR[it.severity];
    line(a, b, '#0b140f', 8); line(b, c2, '#0b140f', 8);
    line(a, b, c, 5); line(b, c2, c, 5);
    dot(b, c, 5);
    badge([b[0] + 16 * s, b[1] - 16 * s], it.n, c);
  };
  // 선의 기울기 비교: 점선 = 기준이 되는 선, 색 선 = 내 자세
  const compareLine = (it, a, b, refA, refB) => {
    const c = COLOR[it.severity];
    line(refA, refB, 'rgba(255,255,255,0.95)', 2.5, [6, 5]);
    line(a, b, '#0b140f', 8); line(a, b, c, 5);
    badge([mid(a, b)[0] + 16 * s, mid(a, b)[1] - 16 * s], it.n, c);
  };

  for (const it of items) {
    switch (it.key) {
      case 'fo_head_sway_top': case 'fo_head_impact': shiftX(it, nose(C), nose(A)[0], shW, targetDir); break;
      case 'fo_hip_sway_top': case 'fo_hip_shift_impact': shiftX(it, hipMid(C), hipMid(A)[0], shW, targetDir); break;
      case 'fo_hands_fwd_impact': shiftX(it, hands(C), hands(A)[0], shW, targetDir); break;
      case 'fo_finish_weight': shiftX(it, hipMid(C), C[L.ANK][0], shW, targetDir); break;
      case 'dtl_hip_thrust_impact': shiftX(it, hipMid(C), hipMid(A)[0], torso, ballDir); break;
      case 'fo_head_lift_top': case 'dtl_head_lift_top': case 'dtl_head_lift_impact': shiftY(it, nose(C), nose(A)[1], nose(C)[0]); break;
      case 'dtl_hands_height_top': shiftY(it, hands(C), shMid(C)[1], hands(C)[0]); break;
      case 'fo_lead_arm_top': case 'fo_lead_arm_impact': case 'dtl_lead_arm_top': joint(it, C[L.SH], C[L.EL], C[L.WR]); break;
      case 'dtl_trail_knee_top': joint(it, C[T.HIP], C[T.KNEE], C[T.ANK]); break;
      case 'dtl_knee_addr': joint(it, C[T.HIP], C[T.KNEE], C[T.ANK]); break;
      case 'fo_shoulder_turn_top': case 'fo_shoulder_tilt_addr': {
        const m = shMid(C), half = shW / 2;
        compareLine(it, C[11], C[12], [m[0] - half, m[1]], [m[0] + half, m[1]]);
        break;
      }
      case 'fo_hip_turn_top': {
        const m = hipMid(C), half = dist(A[23], A[24]) / 2;
        compareLine(it, C[23], C[24], [m[0] - half, m[1]], [m[0] + half, m[1]]);
        break;
      }
      case 'fo_stance': {
        const m = mid(C[27], C[28]), half = (it.mean * shW) / 2; // 점선 = 기준 스탠스 폭
        compareLine(it, C[27], C[28], [m[0] - half, m[1] + 10 * s], [m[0] + half, m[1] + 10 * s]);
        break;
      }
      case 'dtl_spine_addr': case 'dtl_spine_change_top': case 'dtl_spine_change_impact': {
        // 점선 = 기준 상체 각도(어드레스 항목은 기준값, 변화 항목은 내 어드레스 각도 + 기준 변화량)
        const hip = hipMid(C), len = dist(hip, shMid(C));
        const addrAng = Math.atan2((shMid(A)[0] - hipMid(A)[0]) * ballDir, hipMid(A)[1] - shMid(A)[1]);
        const ang = it.key === 'dtl_spine_addr' ? (it.mean * Math.PI) / 180 : addrAng + (it.mean * Math.PI) / 180;
        compareLine(it, hip, shMid(C), hip, [hip[0] + Math.sin(ang) * len * ballDir, hip[1] - Math.cos(ang) * len]);
        break;
      }
      default: break;
    }
  }
}
