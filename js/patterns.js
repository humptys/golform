// 여러 지적을 "핵심 패턴"으로 묶는다. 순수 로직.
// 정면과 측면 영상에서 같은 패턴이 함께 보이면 한쪽 화면의 착시가 아닐 가능성이 커지므로 그만큼 앞에 세운다.
// 키는 '측정항목:방향'(low = 기준보다 작음, high = 큼, * = 양쪽).

export const THEMES = [
  {
    id: 'hang', title: '체중이 뒤에 남는다',
    advice: '다운스윙을 앞발을 밟는 동작으로 시작하고, 피니시에서 체중이 앞발 위에 올라서게 하세요.',
    keys: ['fo_hip_shift_impact:low', 'fo_finish_weight:low', 'fo_head_impact:low'],
  },
  {
    id: 'slide', title: '회전하지 않고 몸이 옆으로 밀린다',
    advice: '머리를 제자리에 두고, 골반을 옆이 아니라 뒤쪽으로 돌린다는 느낌으로 회전하세요.',
    keys: ['fo_head_sway_top:low', 'fo_hip_sway_top:low', 'fo_hip_shift_impact:high', 'fo_head_impact:high'],
  },
  {
    id: 'standup', title: '숙인 상체 각도가 풀리며 일어선다',
    advice: '엉덩이를 뒤에 남겨 둔 채, 가슴이 공을 덮고 있다는 느낌을 임팩트까지 유지하세요.',
    keys: ['dtl_spine_change_impact:low', 'dtl_hip_thrust_impact:high', 'dtl_head_lift_impact:high', 'dtl_spine_change_top:low', 'dtl_head_lift_top:high', 'fo_head_lift_top:high'],
  },
  {
    id: 'dip', title: '스윙 중 몸이 주저앉는다',
    advice: '어드레스 때의 무릎 높이와 머리 높이를 그대로 유지하며 회전하세요.',
    keys: ['fo_head_lift_top:low', 'dtl_head_lift_top:low', 'dtl_head_lift_impact:low', 'dtl_trail_knee_top:low', 'dtl_spine_change_top:high', 'dtl_spine_change_impact:high'],
  },
  {
    id: 'turn', title: '백스윙 회전이 부족하다',
    advice: '앞쪽 어깨가 턱 밑으로 들어올 때까지 등을 타깃 쪽으로 돌리세요.',
    keys: ['fo_shoulder_turn_top:low', 'fo_hip_turn_top:low', 'dtl_hands_height_top:low'],
  },
  {
    id: 'arms', title: '팔이 굽거나 손목이 일찍 풀린다',
    advice: '몸 회전을 멈추지 말고, 손이 공보다 먼저 지나가며 양팔이 타깃 쪽으로 펴지게 하세요.',
    keys: ['fo_lead_arm_top:low', 'fo_lead_arm_impact:low', 'fo_hands_fwd_impact:low', 'dtl_lead_arm_top:low'],
  },
  {
    // 준비 자세의 여러 항목은 서로 다른 문제라 "두 방향에서 같은 문제가 확인됨"으로 치지 않고, 스윙 동작 패턴보다 뒤에 둔다
    id: 'setup', title: '어드레스 자세가 기준과 다르다', corroborate: false,
    advice: '스윙 전에 스탠스 폭, 상체 숙임, 무릎 굽힘부터 맞추세요. 준비 자세가 틀어지면 이후 동작이 모두 보상 동작이 됩니다.',
    keys: ['fo_stance:*', 'fo_shoulder_tilt_addr:*', 'dtl_spine_addr:*', 'dtl_knee_addr:*'],
  },
];

/**
 * @param issues [{key, side, z, severity, view, n}]
 * @param linkedKeys 샷 데이터의 구질·탄도와 연결된 지적의 '측정항목:방향' 집합(없으면 빈 집합)
 * @returns [{id, title, advice, issues, views: ['faceon','dtl'], both, weight}] 중요한 순
 */
export function findPatterns(issues, linkedKeys = new Set()) {
  const out = [];
  for (const t of THEMES) {
    const hit = issues.filter((i) => t.keys.includes(`${i.key}:${i.side}`) || t.keys.includes(`${i.key}:*`));
    if (!hit.length) continue;
    const views = [...new Set(hit.map((i) => i.view))];
    // 편차가 큰 지적이 여럿일수록 무겁게. 한 항목이 지나치게 좌우하지 않도록 4로 자른다.
    const weight = hit.reduce((s, i) => s + Math.min(4, Math.abs(i.z ?? 1)), 0);
    const linked = hit.some((i) => linkedKeys.has(`${i.key}:${i.side}`));
    out.push({ id: t.id, title: t.title, advice: t.advice, issues: hit, views, both: views.length > 1 && t.corroborate !== false, linked, weight: t.corroborate === false ? weight * 0.5 : weight });
  }
  // 두 방향에서 확인된 것, 그다음 이번 샷의 구질과 연결된 것, 그다음 편차가 큰 것 순
  return out.sort((a, b) => Number(b.both) - Number(a.both) || Number(b.linked) - Number(a.linked) || b.weight - a.weight);
}

const VIEW_OF_PREFIX = { fo_: 'faceon', dtl_: 'dtl' };
/** 그 패턴을 제대로 볼 수 있는 촬영 방향: 해당 방향의 근거 항목이 둘 이상인 경우만 친다. */
const themeViews = (t) => {
  const n = {};
  for (const k of t.keys) {
    const v = VIEW_OF_PREFIX[Object.keys(VIEW_OF_PREFIX).find((p) => k.startsWith(p))];
    if (v) n[v] = (n[v] ?? 0) + 1;
  }
  return Object.keys(n).filter((v) => n[v] >= 2);
};

/**
 * 누적 기록에서 되풀이되는 패턴을 뽑아 우선순위를 매긴다.
 * @param history 시간순 기록 [{id, views: ['faceon','dtl'], issues: [{key, side, z, view}]}]
 * @returns [{id, title, advice, total, count, marks, recentCount, recentN, status, priority, lastId, lastIssues}]
 *   total: 그 패턴을 볼 수 있는 방향의 영상이 있던 기록 수 / count: 그중 패턴이 나타난 수
 *   marks: 기록마다 나타났는지(시간순, 최근 8회) / status: persistent(계속) | new(최근 생김) | improving(줄어듦) | sometimes(가끔)
 */
export function summarizeHistory(history) {
  const out = [];
  for (const t of THEMES) {
    const views = themeViews(t);
    const weightOf = (h) => findPatterns(h.issues).find((x) => x.id === t.id)?.weight ?? 0;
    // 그 패턴을 볼 수 있는 방향의 영상이 있었거나, 실제로 패턴이 나타난 기록만 센다
    const eligible = history.filter((h) => h.views.some((v) => views.includes(v)) || weightOf(h) > 0);
    if (!eligible.length) continue;
    const hits = eligible.map(weightOf);
    const count = hits.filter((w) => w > 0).length;
    if (!count) continue;
    const recentN = Math.min(3, eligible.length);
    const recent = hits.slice(-recentN), earlier = hits.slice(0, -recentN);
    const rate = (a) => (a.length ? a.filter((w) => w > 0).length / a.length : 0);
    const recentRate = rate(recent), earlierRate = rate(earlier);
    let status = recentRate >= 0.67 ? 'persistent' : 'sometimes';
    if (earlier.length >= 2) {
      if (earlierRate - recentRate >= 0.34) status = 'improving';
      else if (earlierRate === 0 && recentRate > 0) status = 'new';
    }
    const avgWeight = hits.filter((w) => w > 0).reduce((a, b) => a + b, 0) / count;
    // 최근에 자주, 크게 나타날수록 먼저. 최근 기록에 더 무게를 둔다.
    const priority = (recentRate * 0.6 + (count / eligible.length) * 0.4) * avgWeight;
    const last = [...eligible].reverse().find((h, i) => hits[hits.length - 1 - i] > 0);
    out.push({
      id: t.id, title: t.title, advice: t.advice, total: eligible.length, count,
      marks: hits.slice(-8).map((w) => w > 0), recentCount: recent.filter((w) => w > 0).length, recentN, status, priority,
      lastId: last?.id ?? null,
      // 가장 최근에 나타난 기록에서 이 패턴에 해당하는 지적들(차이가 큰 순). 대표 사진을 고르는 데 쓴다.
      lastIssues: last ? [...findPatterns(last.issues).find((x) => x.id === t.id).issues].sort((a, b) => Math.abs(b.z ?? 0) - Math.abs(a.z ?? 0)) : [],
    });
  }
  return out.sort((a, b) => b.priority - a.priority);
}
