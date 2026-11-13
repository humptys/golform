// 론치 모니터(GDR 등) 샷 데이터 해석. 순수 로직.
// 공의 출발 방향과 휘는 방향으로 구질을 판정하고, 자세 분석에서 나온 문제 중 관련 가능성이 있는 것을 고른다.
// 몸의 자세와 구질의 연결은 "흔히 함께 나타나는 조합"일 뿐 인과를 증명하지 않는다. 클럽 페이스와 그립은 이 앱이 볼 수 없다.

export const SHOT_FIELDS = [
  { key: 'carry', label: '캐리', unit: 'm' },
  { key: 'total', label: '비거리', unit: 'm' },
  { key: 'side', label: '좌우거리', unit: 'm', signed: true, hint: 'R3.3 또는 L2' },
  { key: 'apex', label: '최고높이', unit: 'm' },
  { key: 'ballSpeed', label: '볼 스피드', unit: 'm/s' },
  { key: 'headSpeed', label: '헤드 스피드', unit: 'm/s' },
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

// 구질·탄도의 각 특징과 흔히 함께 나타나는 자세 문제, 그리고 그 자세가 왜 그런 공을 만드는지.
// 키는 '측정항목:방향'(low = 기준보다 작음, high = 큼)이며 자세 분석의 지적과 맞춰 본다.
const CAUSES = {
  push: {
    'fo_hip_shift_impact:high': '골반이 타깃 쪽으로 밀리면 클럽이 뒤처져 페이스가 열린 채 맞습니다.',
    'dtl_hip_thrust_impact:high': '골반이 공 쪽으로 나오면 팔이 지나갈 공간이 막혀 클럽이 안에서 밖으로 밀려 나갑니다.',
    'dtl_spine_change_impact:low': '상체가 일어서면 클럽이 안에서 밖으로 밀려 나갑니다.',
    'fo_head_impact:low': '상체가 뒤로 젖혀지면 궤도가 안에서 밖으로 치우칩니다.',
  },
  pull: {
    'fo_shoulder_turn_top:low': '백스윙 회전이 부족하면 다운스윙을 상체로 시작해 클럽이 밖에서 안으로 들어옵니다.',
    'fo_hip_shift_impact:low': '체중이 뒤에 남으면 상체가 먼저 돌아 공을 당겨 칩니다.',
    'fo_finish_weight:low': '체중이 앞으로 넘어가지 못하면 상체로 당겨 치게 됩니다.',
    'fo_head_impact:high': '상체가 타깃 쪽으로 덮치면 클럽이 밖에서 안으로 들어옵니다.',
  },
  draw: {
    'dtl_hip_thrust_impact:high': '골반이 공 쪽으로 나오면 궤도가 인-아웃이 되고, 손으로 페이스를 닫아 보상하게 됩니다.',
    'fo_hands_fwd_impact:low': '손목이 일찍 풀리면 페이스가 빨리 닫혀 공이 감깁니다.',
    'fo_hip_shift_impact:low': '체중이 뒤에 남으면 몸 회전이 멈추고 손이 뒤집혀 페이스가 닫힙니다.',
    'fo_finish_weight:low': '체중이 뒤에 남은 채 손으로 치면 페이스가 닫힙니다.',
    'fo_head_impact:low': '상체가 뒤에 남으면 손이 먼저 돌아 페이스가 닫힙니다.',
  },
  fade: {
    'fo_lead_arm_impact:low': '임팩트 때 앞팔이 굽으면(치킨 윙) 페이스가 열린 채 맞습니다.',
    'fo_shoulder_turn_top:low': '백스윙 회전이 부족하면 궤도가 아웃-인이 되어 공이 깎여 맞습니다.',
    'fo_hip_shift_impact:low': '체중이 뒤에 남으면 상체가 먼저 열려 공을 깎아 칩니다.',
    'fo_head_impact:high': '상체가 타깃 쪽으로 덮치면 아웃-인 궤도로 깎여 맞습니다.',
  },
  highLaunch: {
    'fo_hip_shift_impact:low': '체중이 뒤에 남으면 클럽이 로프트가 누운 채 맞아 공이 높이 뜹니다.',
    'fo_finish_weight:low': '체중이 뒤에 남으면 올려 치게 되어 공이 높이 뜹니다.',
    'fo_hands_fwd_impact:low': '손목이 일찍 풀리면 로프트가 누워 공이 높이 뜹니다.',
    'fo_head_impact:low': '상체가 뒤로 젖혀지면 올려 치는 각도가 커집니다.',
  },
  lowLaunch: {
    'fo_hands_fwd_impact:high': '손이 지나치게 앞서면 로프트가 세워져 낮게 출발합니다.',
    'fo_head_impact:high': '상체가 공보다 앞서 나가면 찍어 쳐서 낮게 출발합니다.',
    'fo_hip_shift_impact:high': '몸이 타깃 쪽으로 밀리면 로프트가 세워진 채 맞습니다.',
  },
  // 스매시 팩터(볼 스피드 ÷ 헤드 스피드)가 낮다 = 헤드 속도에 비해 공이 덜 나갔다 = 스윗스폿을 벗어나 맞았다
  lowSmash: {
    'dtl_hip_thrust_impact:high': '골반이 공 쪽으로 나오면 몸과 공의 거리가 달라져 타점이 힐·토로 흔들립니다.',
    'dtl_spine_change_impact:low': '상체가 일어서면 클럽이 지나가는 높이가 달라져 얇게 맞습니다.',
    'dtl_head_lift_impact:high': '머리가 들리면 타점이 페이스 아래쪽으로 내려갑니다.',
    'dtl_head_lift_impact:low': '주저앉으면 타점이 페이스 위쪽이나 뒤땅으로 흔들립니다.',
    'fo_head_sway_top:low': '머리가 옆으로 밀렸다 돌아오면 최저점이 흔들려 타점이 일정하지 않습니다.',
    'fo_hip_sway_top:low': '골반이 옆으로 밀렸다 돌아오면 최저점이 흔들립니다.',
    'fo_lead_arm_impact:low': '앞팔이 굽으면 클럽이 짧아져 토 쪽이나 얇게 맞습니다.',
  },
  highSpin: {
    'fo_hands_fwd_impact:low': '손목이 일찍 풀리면 로프트가 누워 스핀이 늘어납니다.',
    'fo_lead_arm_impact:low': '앞팔이 굽어 깎여 맞으면 스핀이 늘어납니다.',
    'fo_head_impact:high': '상체가 덮치며 가파르게 내려오면 스핀이 늘어납니다.',
  },
};

/**
 * 샷의 특징을 뽑는다.
 * @returns {name, findings: [{id, label, text, causes}], summary: [문장], hasShape}
 * 방향 부호: 좌우방향각·좌우거리는 오른쪽이 +, 사이드스핀은 GDR 표시대로 음수가 왼쪽으로 휘는 회전.
 */
export function analyzeShot(shot, { club = 'iron', leftHanded = false } = {}) {
  const hand = leftHanded ? -1 : 1;
  const pushSide = leftHanded ? '왼쪽' : '오른쪽';
  const pullSide = leftHanded ? '오른쪽' : '왼쪽';
  const findings = [];
  const summary = [];
  const find = (id, label, text, causes = null) => findings.push({ id, label, text, causes: causes ? CAUSES[causes] : {} });
  let start = null, curve = null;

  if (shot.dir != null) {
    const d = shot.dir * hand; // + = 푸시 방향
    start = d >= 2 ? 'push' : d <= -2 ? 'pull' : 'straight';
    if (start === 'push') find('start', `${pushSide}으로 ${Math.abs(shot.dir)}° 출발 (푸시)`, `임팩트 순간 클럽 페이스가 타깃보다 ${pushSide}을 보고 있었습니다.`, 'push');
    else if (start === 'pull') find('start', `${pullSide}으로 ${Math.abs(shot.dir)}° 출발 (풀)`, `임팩트 순간 클럽 페이스가 타깃보다 ${pullSide}을 보고 있었습니다.`, 'pull');
    else find('start', '타깃 방향으로 똑바로 출발', '임팩트 순간 클럽 페이스가 타깃을 향했습니다.');
  }
  if (shot.sideSpin != null) {
    const sp = shot.sideSpin * hand; // 음수 = 드로우 방향
    const tilt = shot.backSpin ? (Math.atan(Math.abs(sp) / shot.backSpin) * 180) / Math.PI : null; // 회전축 기울기
    const big = tilt != null ? tilt > 25 : Math.abs(sp) > 1200;
    curve = Math.abs(sp) < 300 ? 'straight' : sp < 0 ? (big ? 'hook' : 'draw') : big ? 'slice' : 'fade';
    if (curve === 'draw' || curve === 'hook') find('curve', `${pullSide}으로 ${curve === 'hook' ? '크게 ' : ''}휨 (${curve === 'hook' ? '훅' : '드로우'})`, `스윙 궤도가 페이스 방향보다 더 ${pushSide}으로(인-아웃) 지나갔습니다.`, 'draw');
    else if (curve === 'fade' || curve === 'slice') find('curve', `${pushSide}으로 ${curve === 'slice' ? '크게 ' : ''}휨 (${curve === 'slice' ? '슬라이스' : '페이드'})`, `스윙 궤도가 페이스 방향보다 더 ${pullSide}으로(아웃-인) 지나갔습니다.`, 'fade');
    else find('curve', '거의 휘지 않음', '옆 회전이 적었습니다.');
  }
  if (club === 'driver') {
    if (shot.launch != null) {
      if (shot.launch > 16) find('launch', `발사각 ${shot.launch}° (높음)`, '드라이버는 보통 10~16°입니다. 공이 높이 떠서 비거리를 손해 볼 수 있습니다.', 'highLaunch');
      else if (shot.launch < 9) find('launch', `발사각 ${shot.launch}° (낮음)`, '드라이버는 보통 10~16°입니다. 캐리가 줄어듭니다.', 'lowLaunch');
    }
    if (shot.backSpin != null) {
      if (shot.backSpin > 3200) find('spin', `백스핀 ${shot.backSpin}rpm (많음)`, '드라이버는 보통 1800~3000rpm입니다. 공이 떠올라 비거리가 줄어듭니다.', 'highSpin');
      else if (shot.backSpin < 1700) find('spin', `백스핀 ${shot.backSpin}rpm (적음)`, '드라이버는 보통 1800~3000rpm입니다. 공이 일찍 떨어질 수 있습니다.');
    }
  }

  const smash = smashFactor(shot);
  if (smash != null && club === 'driver') {
    const v = smash.toFixed(2);
    if (smash < 1.38) find('smash', `스매시 팩터 ${v} (낮음)`, '헤드 스피드에 비해 볼 스피드가 낮습니다. 드라이버는 1.45 안팎이 잘 맞은 샷이며, 스윗스폿을 벗어나 맞았을 가능성이 큽니다.', 'lowSmash');
    else find('smash', `스매시 팩터 ${v} (${smash >= 1.44 ? '좋음' : '보통'})`, '볼 스피드 ÷ 헤드 스피드입니다. 드라이버는 1.45 안팎이 잘 맞은 샷입니다.');
  }

  const START = { push: '푸시', pull: '풀', straight: '스트레이트' };
  const CURVE = { draw: '드로우', hook: '훅', fade: '페이드', slice: '슬라이스', straight: '' };
  let name = null;
  if (start && curve) name = start === 'straight' ? CURVE[curve] || '스트레이트' : `${START[start]} ${CURVE[curve]}`.trim();
  else if (start) name = START[start];
  else if (curve) name = CURVE[curve] || '스트레이트';

  if (shot.side != null && shot.carry) {
    const pct = (Math.abs(shot.side) / shot.carry) * 100;
    summary.push(`타깃에서 ${shot.side >= 0 ? '오른쪽' : '왼쪽'}으로 ${Math.abs(shot.side)}m 떨어졌습니다. ` + (pct < 3 ? '거리 대비 방향은 좋은 편입니다.' : pct < 7 ? '방향 편차가 다소 있습니다.' : '방향 편차가 큽니다.'));
    if (pct < 3 && start && start !== 'straight' && curve && curve !== 'straight') {
      summary.push('출발 방향과 휘는 방향이 서로 상쇄되어 맞은 샷입니다. 둘 중 하나만 달라져도 크게 벗어날 수 있습니다.');
    }
  }
  return { name, findings, summary, hasShape: !!(start || curve) };
}

/**
 * 샷의 특징과 자세 분석의 지적을 잇는다.
 * @param issues 자세 분석에서 나온 지적 [{n, key, side, ...}]
 * @returns analyzeShot 결과 + findings[].matched [{issue, why}] + links: '항목:방향' -> [샷 특징 이름]
 */
export function diagnose(shot, issues, opts = {}) {
  const r = analyzeShot(shot, opts);
  const links = new Map();
  for (const f of r.findings) {
    f.matched = issues.filter((i) => f.causes[`${i.key}:${i.side}`]).map((i) => ({ issue: i, why: f.causes[`${i.key}:${i.side}`] }));
    for (const m of f.matched) {
      const k = `${m.issue.key}:${m.issue.side}`;
      links.set(k, [...(links.get(k) ?? []), f.label]);
    }
  }
  return { ...r, links };
}

/** 스매시 팩터: 볼 스피드 ÷ 헤드 스피드. 얼마나 정타로 맞았는지를 나타낸다. */
export const smashFactor = (shot) => (shot?.ballSpeed && shot?.headSpeed ? shot.ballSpeed / shot.headSpeed : null);

/** 방향 정확도: 캐리 대비 좌우로 벗어난 비율(%). 작을수록 좋다. */
export const sidePercent = (shot) => (shot?.side != null && shot.carry ? (Math.abs(shot.side) / shot.carry) * 100 : null);
