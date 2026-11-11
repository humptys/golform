// 지적 항목의 출처.
// fault: 그 문제(스윙 결함)를 정의하고 원인·교정을 설명하는 자료
// basis: 기준값이 나온 측정 데이터. 없으면 그 항목의 기준은 일반적인 레슨 통념이다.
import { SOURCES, publishedStats } from './textbook.js';

const tpi = (slug, name) => ({ label: `TPI 스윙 특성: ${name}`, url: `https://www.mytpi.com/improve-my-game/swing-characteristics/${slug}` });
const SWAY = tpi('sway', 'Sway');
const SLIDE = tpi('slide', 'Slide');
const HANG = tpi('hanging-back', 'Hanging Back');
const REVERSE = tpi('reverse-spine-angle', 'Reverse Spine Angle');
const POSTURE = tpi('loss-of-posture', 'Loss of Posture');
const EXT = tpi('early-extension', 'Early Extension');
const WING = tpi('chicken-winging', 'Chicken Winging');
const SCOOP = tpi('scooping', 'Scooping');
const LUNGE = tpi('forward-lunge', 'Forward Lunge');

// [기준보다 작을 때, 클 때]
const FAULT = {
  fo_head_sway_top: [SWAY, REVERSE],
  fo_hip_sway_top: [SWAY, REVERSE],
  fo_head_lift_top: [POSTURE, POSTURE],
  fo_hip_shift_impact: [HANG, SLIDE],
  fo_head_impact: [HANG, LUNGE],
  fo_lead_arm_impact: [WING, null],
  fo_hands_fwd_impact: [SCOOP, null],
  fo_finish_weight: [HANG, null],
  dtl_spine_change_top: [POSTURE, POSTURE],
  dtl_head_lift_top: [POSTURE, POSTURE],
  dtl_spine_change_impact: [EXT, POSTURE],
  dtl_hip_thrust_impact: [null, EXT],
  dtl_head_lift_impact: [POSTURE, EXT],
};
const BASIS = { fo_shoulder_turn_top: SOURCES[0], fo_hip_turn_top: SOURCES[0], fo_hip_shift_impact: SOURCES[1], tempo: SOURCES[2] };

/**
 * @returns {fault, basis} 각각 {label, url} 또는 null.
 * 숏게임(어프로치·퍼팅)은 풀스윙 결함 자료와 뜻이 달라 fault를 붙이지 않는다.
 */
export function sourcesFor(key, side, { club = 'iron', profile = null } = {}) {
  const full = club === 'driver' || club === 'iron';
  const fault = full ? FAULT[key]?.[side === 'low' ? 0 : 1] ?? null : null;
  let basis = full || key === 'tempo' ? BASIS[key] ?? null : null;
  if (profile && publishedStats(profile, club)?.keys.includes(key)) basis = SOURCES[3];
  return { fault, basis };
}
