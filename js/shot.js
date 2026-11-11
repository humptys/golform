// 론치 모니터(GDR 등) 샷 데이터 해석. 순수 로직.
// 공의 출발 방향과 휘는 방향으로 구질을 판정하고, 자세 분석에서 나온 문제 중 관련 가능성이 있는 것을 고른다.
// 몸의 자세와 구질의 연결은 "흔히 함께 나타나는 조합"일 뿐 인과를 증명하지 않는다. 클럽 페이스와 그립은 이 앱이 볼 수 없다.

export const SHOT_FIELDS = [
  { key: 'carry', label: '캐리', unit: 'm' },
  { key: 'total', label: '비거리', unit: 'm' },
  { key: 'side', label: '좌우거리', unit: 'm', signed: true, hint: 'R3.3 또는 L2' },
  { key: 'apex', label: '최고높이', unit: 'm' },
  { key: 'ballSpeed', label: '볼 스피드', unit: 'm/s' },
  { key: 'launch', label: '발사각', unit: '°' },
  { key: 'dir', label: '좌우방향각', unit: '°', signed: true, hint: '오른쪽 +, 왼쪽 −' },
  { key: 'backSpin', label: '백스핀', unit: 'rpm' },
  { key: 'sideSpin', label: '사이드스핀', unit: 'rpm', signed: true, hint: '화면 숫자 그대로' },
];

/** 입력 문자열 -> 숫자. "R3.3" = +3.3, "L3.3" = -3.3. 비어 있거나 숫자가 아니면 null. */
export function parseShotValue(text) {
  const t = String(text ?? '').trim().replace(/,/g, '').replace(/\s+/g, '');
  if (!t) return null;
  const m = /^([RLrl])?([+-]?\d+(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  const v = parseFloat(m[2]);
  return m[1] ? (m[1].toUpperCase() === 'L' ? -Math.abs(v) : Math.abs(v)) : v;
}

/** 입력값 묶음 -> 샷 객체. 값이 하나도 없으면 null. */
export function buildShot(raw) {
  const shot = {};
  for (const f of SHOT_FIELDS) {
    const v = parseShotValue(raw[f.key]);
    if (v != null) shot[f.key] = v;
  }
  return Object.keys(shot).length ? shot : null;
}

export const fmtShot = (f, v) => (f.key === 'side' ? `${v >= 0 ? 'R' : 'L'}${Math.abs(v)}` : String(v)) + f.unit;

/**
 * @returns {name, lines: [문장], related: ['metricKey:side'], hasShape}
 * 방향 부호: 좌우방향각·좌우거리는 오른쪽이 +, 사이드스핀은 GDR 표시대로 음수가 왼쪽으로 휘는 회전.
 */
export function analyzeShot(shot, { club = 'iron', leftHanded = false } = {}) {
  const hand = leftHanded ? -1 : 1;
  const pushSide = leftHanded ? '왼쪽' : '오른쪽';
  const pullSide = leftHanded ? '오른쪽' : '왼쪽';
  const lines = [];
  const related = new Set();
  const add = (...keys) => keys.forEach((k) => related.add(k));
  let start = null, curve = null;

  if (shot.dir != null) {
    const d = shot.dir * hand; // + = 푸시 방향
    start = d >= 2 ? 'push' : d <= -2 ? 'pull' : 'straight';
    if (start === 'push') {
      lines.push(`공이 타깃보다 ${pushSide}으로 ${Math.abs(shot.dir)}° 출발했습니다. 임팩트 순간 클럽 페이스가 ${pushSide}을 보고 있었습니다.`);
      add('fo_hip_shift_impact:high', 'dtl_hip_thrust_impact:high', 'dtl_spine_change_impact:low', 'fo_head_impact:low');
    } else if (start === 'pull') {
      lines.push(`공이 타깃보다 ${pullSide}으로 ${Math.abs(shot.dir)}° 출발했습니다. 임팩트 순간 클럽 페이스가 ${pullSide}을 보고 있었습니다.`);
      add('fo_shoulder_turn_top:low', 'fo_hip_shift_impact:low', 'fo_head_impact:high', 'fo_finish_weight:low');
    } else {
      lines.push('공이 타깃 방향으로 거의 똑바로 출발했습니다.');
    }
  }
  if (shot.sideSpin != null) {
    const sp = shot.sideSpin * hand; // 음수 = 드로우 방향
    const tilt = shot.backSpin ? (Math.atan(Math.abs(sp) / shot.backSpin) * 180) / Math.PI : null; // 회전축 기울기
    const big = tilt != null ? tilt > 25 : Math.abs(sp) > 1200;
    curve = Math.abs(sp) < 300 ? 'straight' : sp < 0 ? (big ? 'hook' : 'draw') : big ? 'slice' : 'fade';
    if (curve === 'draw' || curve === 'hook') {
      lines.push(`날아가면서 ${pullSide}으로 ${curve === 'hook' ? '크게 ' : ''}휘었습니다. 스윙 궤도가 페이스 방향보다 더 ${pushSide}(인-아웃)으로 지나갔습니다.`);
      if (curve === 'hook') add('fo_hands_fwd_impact:low', 'fo_hip_shift_impact:low', 'fo_head_impact:low');
      add('dtl_hip_thrust_impact:high');
    } else if (curve === 'fade' || curve === 'slice') {
      lines.push(`날아가면서 ${pushSide}으로 ${curve === 'slice' ? '크게 ' : ''}휘었습니다. 스윙 궤도가 페이스 방향보다 더 ${pullSide}(아웃-인)으로 지나갔습니다.`);
      add('fo_lead_arm_impact:low', 'fo_shoulder_turn_top:low', 'fo_hip_shift_impact:low', 'fo_head_impact:high');
    } else {
      lines.push('옆 회전이 적어 거의 휘지 않았습니다.');
    }
  }

  const START = { push: '푸시', pull: '풀', straight: '스트레이트' };
  const CURVE = { draw: '드로우', hook: '훅', fade: '페이드', slice: '슬라이스', straight: '' };
  let name = null;
  if (start && curve) name = start === 'straight' ? CURVE[curve] || '스트레이트' : `${START[start]} ${CURVE[curve]}`.trim();
  else if (start) name = START[start];
  else if (curve) name = CURVE[curve] || '스트레이트';

  if (shot.side != null && shot.carry) {
    const pct = (Math.abs(shot.side) / shot.carry) * 100;
    lines.push(`결과적으로 타깃에서 ${shot.side >= 0 ? '오른쪽' : '왼쪽'}으로 ${Math.abs(shot.side)}m 떨어졌습니다. ` + (pct < 3 ? '거리 대비 방향은 좋은 편입니다.' : pct < 7 ? '방향 편차가 다소 있습니다.' : '방향 편차가 큽니다.'));
    if (pct < 3 && start && start !== 'straight' && curve && curve !== 'straight') {
      lines.push('출발 방향과 휘는 방향이 서로 상쇄되어 맞은 샷입니다. 둘 중 하나만 달라져도 크게 벗어날 수 있습니다.');
    }
  }

  if (club === 'driver') {
    if (shot.launch != null) {
      if (shot.launch > 16) { lines.push(`발사각 ${shot.launch}°는 드라이버로는 높은 편입니다(보통 10~16°).`); add('fo_hip_shift_impact:low', 'fo_finish_weight:low'); }
      else if (shot.launch < 9) lines.push(`발사각 ${shot.launch}°는 드라이버로는 낮은 편입니다(보통 10~16°). 캐리가 줄어듭니다.`);
    }
    if (shot.backSpin != null) {
      if (shot.backSpin > 3200) { lines.push(`백스핀 ${shot.backSpin}rpm은 드라이버로는 많은 편입니다(보통 1800~3000). 공이 떠서 비거리가 줄어듭니다.`); add('fo_hands_fwd_impact:low', 'fo_lead_arm_impact:low'); }
      else if (shot.backSpin < 1700) lines.push(`백스핀 ${shot.backSpin}rpm은 적은 편입니다(보통 1800~3000). 공이 일찍 떨어질 수 있습니다.`);
    }
  }

  return { name, lines, related: [...related], hasShape: !!(start || curve) };
}
