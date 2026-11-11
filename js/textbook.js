// 내장 기준 「정석 폼」.
// 특정 선수를 측정한 값이 아니라, 골프 레슨에서 일반적으로 가르치는 자세를 이 앱의 측정 항목으로 옮긴 값이다.
// 미들 아이언 풀스윙 기준이며, 2D 영상 추정 오차와 체형 차이를 감안해 허용 범위(tol)를 넉넉히 두었다.
// 실제 영상으로 보정된 값이 아니므로 절대 점수보다 "어느 항목이 크게 벗어나는가"와 시간에 따른 변화를 보는 용도다.

const T = {
  // ── 정면 ──
  fo_stance:              { mean: 1.35, tol: 0.3 },  // 발목 간격 / 어깨 관절 간격. 아이언은 어깨 폭 안팎, 드라이버는 더 넓다
  fo_shoulder_tilt_addr:  { mean: 6,    tol: 5 },    // 트레일 어깨가 약간 낮음
  fo_head_sway_top:       { mean: -4,   tol: 8 },    // 머리는 거의 제자리, 약간 타깃 반대쪽 허용
  fo_hip_sway_top:        { mean: -2,   tol: 7 },    // 골반은 밀리지 않고 회전
  fo_shoulder_turn_top:   { mean: 85,   tol: 15 },   // 어깨 약 90도
  fo_hip_turn_top:        { mean: 42,   tol: 12 },   // 골반 약 45도
  fo_lead_arm_top:        { mean: 168,  tol: 14 },   // 리드 팔은 거의 펴짐
  fo_head_lift_top:       { mean: 0,    tol: 5 },    // 높이 유지
  fo_hip_shift_impact:    { mean: 20,   tol: 10 },   // 골반이 타깃 쪽으로 이동
  fo_head_impact:         { mean: -4,   tol: 8 },    // 머리는 공 뒤
  fo_lead_arm_impact:     { mean: 172,  tol: 12 },   // 리드 팔 펴짐
  fo_hands_fwd_impact:    { mean: 12,   tol: 10 },   // 핸드 퍼스트
  fo_finish_weight:       { mean: -5,   tol: 12 },   // 골반이 리드 발 위까지
  // ── 측면 ──
  dtl_spine_addr:          { mean: 37,  tol: 7 },    // 고관절에서 숙인 상체
  dtl_knee_addr:           { mean: 157, tol: 9 },    // 무릎은 가볍게 굽힘
  dtl_spine_change_top:    { mean: 0,   tol: 6 },    // 척추 각 유지
  dtl_trail_knee_top:      { mean: 5,   tol: 9 },    // 트레일 무릎 굴곡 대부분 유지
  dtl_hands_height_top:    { mean: 30,  tol: 18 },   // 손이 어깨보다 위
  dtl_lead_arm_top:        { mean: 165, tol: 16 },
  dtl_head_lift_top:       { mean: 0,   tol: 5 },
  dtl_spine_change_impact: { mean: -2,  tol: 6 },    // 임팩트까지 숙임 유지
  dtl_hip_thrust_impact:   { mean: -2,  tol: 6 },    // 골반이 공 쪽으로 나오지 않음
  dtl_head_lift_impact:    { mean: -2,  tol: 5 },
  // ── 공통 ──
  tempo:                   { mean: 3.0, tol: 0.7 },  // 백스윙 : 다운스윙 = 3 : 1
};

export const TEXTBOOK_KEYS = Object.keys(T);

/** profile.js의 evaluate가 받는 형식(평균/편차/표본 수)으로 돌려준다. */
export function textbookStats() {
  return Object.fromEntries(Object.entries(T).map(([k, v]) => [k, { mean: v.mean, std: v.tol, n: 99 }]));
}
