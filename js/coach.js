// 조언 탭의 순수 로직: 모델에 넘길 "사용자 기록" 요약과, AI를 쓸 수 없을 때의 내장 답변.
import { matchConcerns, reviewConcern, CONCERNS } from './concerns.js';
import { summarizeHistory } from './patterns.js';
import { metricByKey, textFor, CLUBS } from './metrics.js';
import { SHOT_FIELDS, fmtShot, smashFactor } from './shot.js';

const STATUS = { persistent: '계속 나타남', new: '최근 생김', sometimes: '가끔 나타남', improving: '줄어드는 중' };

/**
 * 누적 기록을 모델이 읽을 수 있는 짧은 글로 요약한다. 영상이나 개인 정보는 들어가지 않는다.
 * @param history 시간순 [{id, views, issues, shot, name}] (기록 탭의 자가진단과 같은 형식)
 */
export function buildContext({ club, leftHanded = false, history = [], concern = '' }) {
  const lines = [`클럽: ${CLUBS[club] ?? club}, ${leftHanded ? '왼손잡이' : '오른손잡이'}, 영상 분석 기록 ${history.length}회`];
  const patterns = summarizeHistory(history).slice(0, 4);
  if (patterns.length) {
    lines.push('영상에서 되풀이된 자세 문제(자주·크게 나타난 순):');
    for (const p of patterns) lines.push(`- ${p.title}: ${p.total}회 중 ${p.count}회, ${STATUS[p.status]}`);
  } else if (history.length) {
    lines.push('영상에서 되풀이된 자세 문제: 없음');
  }
  const latest = history.at(-1);
  if (latest?.issues.length) {
    lines.push('가장 최근 분석의 지적: ' + latest.issues.slice(0, 6).map((i) => textFor(metricByKey[i.key], i.side, club).title).join('; '));
  }
  const shots = history.filter((h) => h.shot);
  if (shots.length) {
    const names = shots.map((s) => s.name).filter(Boolean);
    const top = Object.entries(names.reduce((m, n) => ({ ...m, [n]: (m[n] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1])[0];
    if (top) lines.push(`샷 기록 ${shots.length}회, 가장 흔한 구질: ${top[0]} (${top[1]}회)`);
    const s = shots.at(-1).shot;
    const sm = smashFactor(s);
    lines.push('가장 최근 샷: ' + SHOT_FIELDS.filter((f) => s[f.key] != null).map((f) => `${f.label} ${fmtShot(f, s[f.key])}`).join(', ') + (sm != null ? `, 스매시 팩터 ${sm.toFixed(2)}` : ''));
  }
  if (concern.trim()) lines.push(`본인이 적은 고민: ${concern.trim().slice(0, 200)}`);
  if (!history.length) lines.push('아직 영상 분석 기록이 없습니다.');
  return lines.join('\n');
}

/**
 * AI를 쓸 수 없을 때의 답변. 질문의 낱말로 주제를 찾아, 앱에 들어 있는 설명과 사용자의 기록으로 답을 만든다.
 * @returns {text, matched: 찾은 주제 수}
 */
export function localAnswer(question, { club, history = [] }) {
  const found = matchConcerns(question).slice(0, 2);
  if (!found.length) {
    return {
      matched: 0,
      text: '이 질문은 내장 답변으로는 답하기 어렵습니다. 아래 주제의 낱말을 넣어 물어보시면 기록을 바탕으로 답해 드립니다.\n' + CONCERNS.map((c) => c.label).join(', '),
    };
  }
  const blocks = found.map((c) => {
    const r = reviewConcern(c, history);
    const out = [`■ ${c.label}`, c.note, ...r.shotLines.map((l) => `· ${l}`)];
    if (r.postures.length) {
      out.push(`내 기록 ${r.sessions}회 중 ${r.withAny}회에서 관련 자세가 보였습니다. 먼저 볼 것:`);
      for (const p of r.postures.slice(0, 2)) {
        const t = textFor(metricByKey[p.key], p.side, club);
        out.push(`· ${t.title} (${p.total}회 중 ${p.count}회) → ${t.fix}` + (t.drill ? ` 연습: ${t.drill}` : ''));
      }
    } else if (r.sessions) {
      out.push(`내 기록 ${r.sessions}회의 영상에서는 관련 자세가 보이지 않았습니다. 그립이나 클럽 페이스처럼 영상으로 볼 수 없는 요인일 수 있습니다.`);
    } else {
      // 기록이 없으면 일반적인 원인 두 가지를 알려 준다
      out.push('아직 이 문제를 볼 수 있는 영상 기록이 없어 일반적인 원인을 알려 드립니다:');
      for (const k of c.keys.slice(0, 2)) {
        const [key, side] = k.split(':');
        const t = textFor(metricByKey[key], side, club);
        out.push(`· ${t.title} → ${t.fix}`);
      }
    }
    return out.join('\n');
  });
  return { matched: found.length, text: blocks.join('\n\n') };
}
