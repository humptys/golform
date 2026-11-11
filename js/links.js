// 지적 항목별 참고 영상 링크. 특정 영상 주소는 사라지거나 바뀌므로 유튜브 검색 링크로 연결한다.
const Q = {
  fo_stance: ['골프 스탠스 너비 기본 레슨', '골프 스탠스 너비 기본 레슨'],
  fo_shoulder_tilt_addr: ['골프 어드레스 어깨 기울기 척추 틸트 레슨', '골프 어드레스 상체 기울기 과도 교정'],
  fo_head_sway_top: ['골프 백스윙 스웨이 교정 드릴', '골프 리버스 피벗 교정 드릴'],
  fo_hip_sway_top: ['골프 백스윙 골반 스웨이 교정 드릴', '골프 리버스 피벗 체중 이동 교정'],
  fo_shoulder_turn_top: ['골프 백스윙 어깨 회전 늘리는 법', '골프 오버스윙 교정 드릴'],
  fo_hip_turn_top: ['골프 백스윙 골반 회전 방법 레슨', '골프 백스윙 골반 과회전 하체 고정 드릴'],
  fo_lead_arm_top: ['골프 백스윙 왼팔 펴기 스윙 아크 레슨', '골프 백스윙 팔 힘 빼기 레슨'],
  fo_head_lift_top: ['골프 백스윙 주저앉음 높이 유지 레슨', '골프 백스윙 상체 일어남 교정 드릴'],
  fo_hip_shift_impact: ['골프 다운스윙 체중 이동 드릴', '골프 다운스윙 골반 슬라이드 교정 드릴'],
  fo_head_impact: ['골프 임팩트 상체 뒤로 젖혀짐 교정', '골프 임팩트 머리 고정 헤드 비하인드 볼 드릴'],
  fo_lead_arm_impact: ['골프 치킨윙 교정 드릴', '골프 임팩트 릴리스 그립 압력 레슨'],
  fo_hands_fwd_impact: ['골프 핸드 퍼스트 임팩트 드릴 스쿠핑 교정', '골프 임팩트 과한 핸드 퍼스트 릴리스 레슨'],
  fo_finish_weight: ['골프 피니시 체중 이동 균형 드릴', '골프 피니시 균형 잡는 법 레슨'],
  dtl_spine_addr: ['골프 어드레스 자세 힙 힌지 레슨', '골프 어드레스 상체 숙임 균형 레슨'],
  dtl_knee_addr: ['골프 어드레스 무릎 굽힘 정도 레슨', '골프 어드레스 무릎 굽힘 정도 레슨'],
  dtl_spine_change_top: ['골프 백스윙 척추 각 유지 드릴', '골프 백스윙 상체 숙여짐 균형 교정'],
  dtl_trail_knee_top: ['골프 백스윙 높이 유지 무릎 레슨', '골프 백스윙 오른쪽 무릎 펴짐 교정 드릴'],
  dtl_hands_height_top: ['골프 백스윙 탑 손 위치 플랫 스윙 교정', '골프 백스윙 팔만 드는 스윙 교정 몸통 회전'],
  dtl_lead_arm_top: ['골프 백스윙 왼팔 펴기 스윙 아크 레슨', '골프 백스윙 팔 힘 빼기 레슨'],
  dtl_head_lift_top: ['골프 백스윙 주저앉음 높이 유지 레슨', '골프 백스윙 상체 일어남 교정 드릴'],
  dtl_spine_change_impact: ['골프 얼리 익스텐션 교정 드릴', '골프 다운스윙 상체 덮어치기 교정 드릴'],
  dtl_hip_thrust_impact: ['골프 임팩트 체중 뒤꿈치 쏠림 교정', '골프 얼리 익스텐션 교정 드릴'],
  dtl_head_lift_impact: ['골프 다운스윙 주저앉음 뒤땅 교정 드릴', '골프 헤드업 교정 드릴'],
  tempo: ['골프 스윙 템포 리듬 연습 3대1', '골프 백스윙 템포 리듬 연습'],
};
const EN = { '로리 맥길로이': 'Rory McIlroy', '넬리 코다': 'Nelly Korda' };

const yt = (q) => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);

/** 해당 지적(기준보다 작음 low / 큼 high)의 교정 레슨 검색 링크 */
export const lessonLink = (key, side) => (Q[key] ? yt(Q[key][side === 'low' ? 0 : 1]) : null);

/** 프로파일 이름(선수)의 스윙 영상을 촬영 방향에 맞춰 찾는 검색 링크 */
export const playerLink = (profile, view) => yt(`${EN[profile] ?? profile} swing ${view === 'faceon' ? 'face on' : 'down the line'} slow motion`);

export const LINK_KEYS = Object.keys(Q);
