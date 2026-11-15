// 자가진단: 사용자가 직접 적은 고민을 알아듣고, 누적 기록을 그 고민 기준으로 다시 정리한다. 순수 로직.
// 글을 이해하는 것이 아니라 아래 낱말이 들어 있는지로 주제를 찾는다. 못 찾으면 못 찾았다고 알려 준다.
import { CAUSES, analyzeShot, smashFactor, sidePercent } from './shot.js';
import { THEMES } from './patterns.js';

const theme = (id) => THEMES.find((t) => t.id === id).keys.filter((k) => !k.endsWith(':*'));
const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const f1 = (v) => v.toFixed(Math.abs(v) < 100 ? 1 : 0);
/** 처음 기록들과 최근 기록들의 평균을 비교한 한 줄 */
const trend = (vals, unit, digits = null) => {
  const f = (v) => (digits != null ? v.toFixed(digits) : f1(v));
  if (vals.length < 2) return `${f(vals[0])}${unit} (기록 1회)`;
  const k = vals.length >= 4 ? Math.min(3, Math.floor(vals.length / 2)) : 1;
  return `처음 ${f(avg(vals.slice(0, k)))}${unit} → 최근 ${f(avg(vals.slice(-k)))}${unit} (${vals.length}회)`;
};
/** 구질 이름에 해당 낱말이 들어간 샷이 몇 번인지 */
const shapeCount = (words) => (shots) => {
  const named = shots.filter((s) => s.name);
  if (!named.length) return null;
  const n = named.filter((s) => words.some((w) => s.name.includes(w))).length;
  return `구질이 기록된 샷 ${named.length}회 중 ${n}회가 ${words[0]} 계열이었습니다.`;
};
const series = (label, get, unit, digits) => (shots) => {
  const vals = shots.map((s) => get(s.shot)).filter((v) => v != null);
  return vals.length ? `${label}: ${trend(vals, unit, digits)}` : null;
};

export const CONCERNS = [
  { id: 'slice', label: '슬라이스', words: ['슬라이스', '페이드', '오른쪽으로 휘', '깎여', '깎아'], keys: Object.keys(CAUSES.fade), shot: [shapeCount(['슬라이스', '페이드'])],
    note: '공이 오른쪽으로 휘는 것은 임팩트 때 페이스가 스윙 궤도보다 열려 있었다는 뜻입니다(오른손잡이 기준).' },
  { id: 'hook', label: '훅', words: ['훅', '드로우', '왼쪽으로 휘', '감겨', '감기'], keys: Object.keys(CAUSES.draw), shot: [shapeCount(['훅', '드로우'])],
    note: '공이 왼쪽으로 휘는 것은 임팩트 때 페이스가 스윙 궤도보다 닫혀 있었다는 뜻입니다(오른손잡이 기준).' },
  { id: 'push', label: '푸시(오른쪽 출발)', words: ['푸시', '오른쪽으로 출발', '오른쪽으로 나가', '밀려 나가', '밀리는 공'], keys: Object.keys(CAUSES.push), shot: [shapeCount(['푸시'])],
    note: '공이 오른쪽으로 출발하는 것은 임팩트 때 페이스가 타깃보다 오른쪽을 봤다는 뜻입니다(오른손잡이 기준).' },
  { id: 'pull', label: '풀(왼쪽 출발)', words: ['풀 ', '풀(', '풀샷', '당겨', '왼쪽으로 출발', '왼쪽으로 나가'], keys: Object.keys(CAUSES.pull), shot: [shapeCount(['풀'])],
    note: '공이 왼쪽으로 출발하는 것은 임팩트 때 페이스가 타깃보다 왼쪽을 봤다는 뜻입니다(오른손잡이 기준).' },
  { id: 'distance', label: '비거리', words: ['비거리', '거리가', '거리 ', '멀리', '짧게 나', '안 나가', '헤드 스피드', '볼 스피드'],
    keys: [...theme('turn'), ...theme('hang'), 'fo_lead_arm_impact:low', 'fo_hands_fwd_impact:low', 'dtl_spine_change_impact:low', 'dtl_hip_thrust_impact:high'],
    shot: [series('캐리', (s) => s.carry, 'm'), series('비거리', (s) => s.total, 'm'), series('볼 스피드', (s) => s.ballSpeed, 'm/s'), series('스매시 팩터', smashFactor, '', 2)],
    note: '비거리는 헤드 스피드와 정타 여부로 정해집니다. 영상에서는 회전량, 체중 이동, 임팩트 때 팔과 상체 자세가 여기에 관여합니다.' },
  { id: 'contact', label: '정타·뒤땅·탑볼', words: ['정타', '타점', '뒤땅', '탑볼', '탑핑', '생크', '얇게', '두껍게', '토핑', '헛스윙', '스윗'],
    keys: [...Object.keys(CAUSES.lowSmash), 'fo_hip_shift_impact:low', 'fo_hands_fwd_impact:low', 'fo_head_lift_top:low', 'fo_head_lift_top:high', 'dtl_head_lift_top:high'],
    shot: [series('스매시 팩터', smashFactor, '', 2)],
    note: '타점이 흔들리는 것은 스윙 중 몸의 높이나 공과의 거리가 변하거나, 최저점이 공 뒤에 생기기 때문인 경우가 많습니다.' },
  { id: 'direction', label: '방향성', words: ['방향', '좌우', '오비', 'OB', '똑바로', '일관'], keys: [...new Set([...Object.keys(CAUSES.push), ...Object.keys(CAUSES.pull), ...theme('slide')])],
    shot: [series('방향 편차', sidePercent, '%')],
    note: '방향이 흔들리는 것은 임팩트 때 페이스 방향이 매번 달라진다는 뜻입니다. 영상에서는 몸이 밀리거나 일어서는 동작이 여기에 관여합니다.' },
  { id: 'standup', label: '일어섬·배치기·헤드업', words: ['일어', '얼리', '익스텐션', '배치기', '헤드업', '머리가 들', '머리 들', '척추각', '척추 각'], keys: theme('standup'), shot: [],
    note: '임팩트 전에 상체가 일어서거나 골반이 공 쪽으로 나오는 동작입니다. 측면 영상에서 가장 잘 보입니다.' },
  { id: 'sway', label: '스웨이·몸이 밀림', words: ['스웨이', '몸이 밀', '옆으로 밀', '흔들', '중심', '슬라이드'], keys: theme('slide'), shot: [],
    note: '회전하지 않고 몸이 옆으로 밀리는 동작입니다. 정면 영상에서 가장 잘 보입니다.' },
  { id: 'weight', label: '체중 이동', words: ['체중', '뒤에 남', '오른발에 남', '왼발로'], keys: theme('hang'), shot: [],
    note: '임팩트와 피니시에서 체중이 앞발로 넘어가는지를 봅니다. 정면 영상에서 보입니다.' },
  { id: 'turn', label: '백스윙 회전', words: ['회전', '백스윙', '꼬임', '어깨 턴', '어깨턴', '오버스윙'], keys: [...theme('turn'), 'fo_shoulder_turn_top:high', 'fo_hip_turn_top:high'], shot: [],
    note: '백스윙 탑에서 어깨와 골반이 얼마나 도는지를 봅니다. 정면 영상에서 보입니다.' },
  { id: 'arms', label: '팔·손목(치킨윙·캐스팅)', words: ['치킨', '팔이 굽', '팔 굽', '손목', '캐스팅', '스쿠핑', '핸드 퍼스트', '핸드퍼스트', '릴리스'], keys: theme('arms'), shot: [],
    note: '탑과 임팩트에서 앞팔이 펴져 있는지, 손이 공보다 먼저 지나가는지를 봅니다.' },
  { id: 'tempo', label: '템포·리듬', words: ['템포', '리듬', '급하', '빨리 치', '서두'], keys: ['tempo:low', 'tempo:high'], shot: [],
    note: '백스윙과 다운스윙의 시간 비율입니다. 일반 속도 영상에서만 잴 수 있습니다.' },
  { id: 'setup', label: '어드레스 자세', words: ['어드레스', '셋업', '스탠스', '준비 자세', '준비자세'],
    keys: ['fo_stance:low', 'fo_stance:high', 'fo_shoulder_tilt_addr:low', 'fo_shoulder_tilt_addr:high', 'dtl_spine_addr:low', 'dtl_spine_addr:high', 'dtl_knee_addr:low', 'dtl_knee_addr:high'], shot: [],
    note: '스윙 전 준비 자세입니다. 여기가 틀어지면 이후 동작이 모두 보상 동작이 됩니다.' },
];

/** 적은 글에서 주제를 찾는다. 낱말이 글에 먼저 나온 순서대로 돌려준다. */
export function matchConcerns(text) {
  const t = ` ${String(text ?? '').replace(/\s+/g, ' ')} `;
  return CONCERNS.map((c) => ({ c, at: Math.min(...c.words.map((w) => t.indexOf(w)).filter((i) => i >= 0), Infinity) }))
    .filter((x) => x.at !== Infinity).sort((a, b) => a.at - b.at).map((x) => x.c);
}

const VIEW_OF = (key) => (key.startsWith('fo_') ? ['faceon'] : key.startsWith('dtl_') ? ['dtl'] : ['faceon', 'dtl']);

/**
 * 한 주제에 대해 누적 기록을 다시 정리한다.
 * @param concern CONCERNS의 항목
 * @param history 시간순 [{id, views, issues: [{key, side, z, view}], shot?, name?}]
 * @returns {sessions: 관련 자세를 볼 수 있던 기록 수, withAny: 그중 하나라도 나타난 수,
 *           postures: [{key, side, count, total, marks, last: {id, issue}}] 자주·크게 나타난 순,
 *           shotLines: [문장]}
 */
export function reviewConcern(concern, history) {
  const postures = [];
  for (const k of concern.keys) {
    const [key, side] = k.split(':');
    const views = VIEW_OF(key);
    const eligible = history.filter((h) => h.views.some((v) => views.includes(v)));
    const found = eligible.map((h) => h.issues.find((i) => i.key === key && i.side === side) ?? null);
    const hits = found.filter(Boolean);
    if (!hits.length) continue;
    const lastIndex = found.map(Boolean).lastIndexOf(true);
    postures.push({
      key, side, count: hits.length, total: eligible.length, marks: found.slice(-8).map(Boolean),
      weight: (hits.length / eligible.length) * avg(hits.map((i) => Math.min(4, Math.abs(i.z ?? 1)))),
      last: { id: eligible[lastIndex].id, issue: found[lastIndex] },
    });
  }
  postures.sort((a, b) => b.weight - a.weight);
  const views = [...new Set(concern.keys.flatMap((k) => VIEW_OF(k.split(':')[0])))];
  const eligibleAll = history.filter((h) => h.views.some((v) => views.includes(v)));
  const withAny = eligibleAll.filter((h) => h.issues.some((i) => concern.keys.includes(`${i.key}:${i.side}`))).length;
  const shots = history.filter((h) => h.shot);
  return { sessions: eligibleAll.length, withAny, postures, shotLines: concern.shot.map((fn) => fn(shots)).filter(Boolean) };
}

/** 기록의 샷에 구질 이름을 붙여 돌려준다(reviewConcern의 history에 넣을 때 쓴다). */
export const shotName = (shot, opts) => (shot ? analyzeShot(shot, opts).name : null);
