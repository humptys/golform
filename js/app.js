import { analyzeSwing } from './swing.js';
import { PHASES, VIEWS, metricByKey, metricsForView, fmt } from './metrics.js';
import { buildStats, evaluate } from './profile.js';
import { extractPoses } from './pose.js';
import { lessonLink, playerLink } from './links.js';
import { textbookStats } from './textbook.js';
import * as db from './db.js';
import * as sync from './sync.js';

const PHASE_KEYS = ['address', 'top', 'impact', 'finish'];
const SEV = { good: '양호', minor: '주의', major: '교정 필요' };
const DEFAULT_PROFILE = '기본'; // 프로파일 기능 이전에 등록된 기준 영상이 속하는 이름
const BUILTIN_PROFILE = '정석 폼'; // 영상 등록 없이 쓰는 내장 기준(textbook.js)
const PRESET_PROFILES = [BUILTIN_PROFILE, '로리 맥길로이', '넬리 코다'];
const prefs = JSON.parse(localStorage.getItem('golform-prefs') || '{}');
const state = {
  tab: 'analyze', view: prefs.view || 'faceon', profile: prefs.profile || BUILTIN_PROFILE,
  leftHanded: !!prefs.leftHanded, slowmo: !!prefs.slowmo, saveVideo: prefs.saveVideo !== false,
  busy: false, detail: null, onSyncStatus: null,
};
const savePrefs = () => localStorage.setItem('golform-prefs', JSON.stringify({
  view: state.view, profile: state.profile, leftHanded: state.leftHanded, slowmo: state.slowmo, saveVideo: state.saveVideo,
}));

const root = document.getElementById('view');
const tabs = document.getElementById('tabs');

/** 작은 DOM 헬퍼. 문자열은 항상 텍스트 노드로 들어가므로 파일명 등이 HTML로 해석되지 않는다. */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
}
/** 화면 교체. replaceChildren과 달리 중첩 배열을 펼치고 null/false를 건너뛴다. */
const mount = (...kids) => root.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
const fmtDate = (iso) => new Date(iso).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
const fmtDateTime = (iso) => new Date(iso).toLocaleString('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const byDate = (a, b) => a.date.localeCompare(b.date);
const profileOf = (r) => r.profile || DEFAULT_PROFILE;
const extLink = (href, label) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label);

// ───────── 공통 UI ─────────
function viewPicker(onChange) {
  return h('div', { class: 'seg' }, Object.entries(VIEWS).map(([k, label]) =>
    h('button', { class: state.view === k ? 'on' : '', onclick: () => { if (state.busy) return; state.view = k; savePrefs(); onChange(); } }, label)));
}
/** 기준 프로파일(선수) 선택. 등록된 기준 영상에 쓰인 이름과 기본 제공 이름을 보여 준다. */
function profilePicker(allRefs, onChange) {
  const names = [...new Set([...PRESET_PROFILES, ...allRefs.map(profileOf), state.profile])];
  const NEW = '__new__';
  const select = h('select', { onchange: (e) => {
    if (state.busy) { e.target.value = state.profile; return; }
    let v = e.target.value;
    if (v === NEW) {
      v = (prompt('새 기준 프로파일 이름 (예: 선수 이름, 내 베스트 스윙)') || '').trim().slice(0, 30);
      if (!v) { e.target.value = state.profile; return; }
    }
    state.profile = v; savePrefs(); onChange();
  } },
    names.map((n) => h('option', { value: n, selected: n === state.profile }, n)),
    h('option', { value: NEW }, '+ 새 프로파일 만들기'));
  return h('div', { class: 'row field' }, h('span', { class: 'muted' }, '기준'), h('div', { class: 'grow' }, select));
}
function check(label, key) {
  return h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: state[key], onchange: (e) => { state[key] = e.target.checked; savePrefs(); } }), label);
}
function filePicker(label, { multiple = false, onFiles }) {
  const input = h('input', { type: 'file', accept: 'video/*', multiple, onchange: (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) onFiles(f); } });
  return h('label', { class: 'btn primary' }, label, input);
}
function progressCard() {
  const bar = h('progress', { max: 1, value: 0 });
  const text = h('p', { class: 'muted' }, '준비 중…');
  const el = h('div', { class: 'card' }, text, bar);
  return { el, update: (v, msg) => { bar.value = v; if (msg) text.textContent = msg; } };
}
const errorCard = (e) => h('div', { class: 'card err' }, e?.message || String(e));

/** 영상 1개 -> 측정값 + 구간별 썸네일 */
async function processVideo(file, { view, leftHanded, slowmo }, onProgress) {
  const ex = await extractPoses(file, onProgress);
  try {
    const r = analyzeSwing(ex.frames, { aspect: ex.aspect, leftHanded, view });
    if (slowmo) delete r.metrics.tempo; // 재생 속도가 바뀐 영상의 시간 비율은 믿을 수 없다
    onProgress(1, '구간 이미지 만드는 중…');
    const thumbs = {};
    for (const k of PHASE_KEYS) {
      const f = ex.frames[r.phases[k]];
      thumbs[k] = await ex.capture(f.t, f.lm);
    }
    return { metrics: r.metrics, times: r.times, thumbs };
  } finally {
    ex.close();
  }
}

const pickRefs = (all, view, profile) => all.filter((r) => r.view === view && profileOf(r) === profile).sort(byDate);
const isBuiltin = (profile) => profile === BUILTIN_PROFILE;
const statsFor = (all, view, profile) => (isBuiltin(profile) ? textbookStats() : buildStats(pickRefs(all, view, profile)));

// ───────── 분석 탭 ─────────
async function renderAnalyze() {
  const allRefs = await db.getAll('refs');
  const refs = pickRefs(allRefs, state.view, state.profile);
  const builtin = isBuiltin(state.profile);
  const out = h('div');
  const run = async ([file]) => {
    state.busy = true;
    const pc = progressCard();
    out.replaceChildren(pc.el);
    try {
      const r = await processVideo(file, state, pc.update);
      const ev = evaluate(r.metrics, statsFor(allRefs, state.view, state.profile), state.view);
      const session = {
        id: db.newId(), date: new Date().toISOString(), view: state.view, profile: state.profile, leftHanded: state.leftHanded, name: file.name,
        metrics: r.metrics, times: r.times, thumbs: r.thumbs, score: ev.score, items: ev.items, refCount: refs.length, builtin, hasVideo: false,
      };
      if (state.saveVideo) {
        try { await db.put('videos', { id: session.id, blob: file }); session.hasVideo = true; } catch { /* 공간 부족 시 영상만 생략 */ }
      }
      await db.put('sessions', session);
      state.busy = false;
      out.replaceChildren(await resultView(session));
    } catch (e) {
      state.busy = false;
      out.replaceChildren(errorCard(e));
    }
  };

  mount(
    h('h2', {}, '내 스윙 분석'),
    viewPicker(render),
    profilePicker(allRefs, render),
    check('왼손잡이 스윙', 'leftHanded'),
    check('슬로모션 영상 (템포 비교 제외)', 'slowmo'),
    check('영상 원본도 이 기기에 저장 (기록에서 다시 보기)', 'saveVideo'),
    !builtin && refs.length === 0
      ? h('div', { class: 'card warn' },
          h('p', {}, `「${state.profile}」의 ${VIEWS[state.view]} 기준 영상이 아직 없습니다.`),
          h('p', { class: 'muted' }, '먼저 이 프로파일에 기준 스윙 영상을 등록해야 비교할 수 있습니다.'),
          h('button', { class: 'btn', onclick: () => go('refs') }, '기준 영상 등록하러 가기'))
      : h('div', { class: 'card' },
          h('p', { class: 'muted' }, builtin
            ? '내장된 「정석 폼」 기준과 비교합니다. 기준 영상을 등록하지 않아도 바로 분석할 수 있습니다. 미들 아이언 풀스윙 기준입니다.'
            : `「${state.profile}」 ${VIEWS[state.view]} 기준 영상 ${refs.length}개와 비교합니다.` + (refs.length < 3 ? ' 3개 이상 등록하면 기준이 더 안정적입니다.' : '')),
          filePicker('스윙 영상 선택', { onFiles: run })),
    out,
  );
}

async function resultView(s) {
  const profile = profileOf(s);
  const prev = (await db.getAll('sessions')).filter((x) => x.view === s.view && profileOf(x) === profile && x.date < s.date && x.score != null).sort(byDate).pop();
  const issues = s.items.filter((i) => i.severity !== 'good').sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  const nums = (i, m) => h('p', { class: 'nums' }, '내 값 ', h('b', {}, fmt(m, i.value)), ' · 기준 ', h('b', {}, fmt(m, i.mean)), ` (허용 ±${i.tol.toFixed(m.digits)})`);

  const el = h('div', {},
    h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('div', { class: 'grow' },
          h('div', { class: 'muted' }, `${fmtDateTime(s.date)} · ${VIEWS[s.view]} · 기준 ${profile}`),
          h('div', { class: 'score' }, String(s.score ?? '-'), h('small', {}, ' / 100')),
          prev && h('div', { class: 'muted' }, `직전 분석(${fmtDate(prev.date)}) 대비 ${s.score - prev.score >= 0 ? '+' : ''}${s.score - prev.score}점`)),
        h('div', {}, h('span', { class: 'tag major' }, `교정 필요 ${issues.filter((i) => i.severity === 'major').length}`), h('span', { class: 'tag minor' }, `주의 ${issues.filter((i) => i.severity === 'minor').length}`))),
      h('p', { class: 'muted' }, isBuiltin(profile)
        ? '점수는 일반적인 레슨 기준(정석 폼)과 얼마나 비슷한지를 뜻합니다. 기준값은 실제 선수를 측정한 것이 아니라 통상적인 권장 범위이므로, 점수 자체보다 크게 벗어난 항목과 시간에 따른 변화를 보세요.'
        : `점수는 「${profile}」 기준 영상 ${s.refCount}개와 얼마나 비슷한지를 뜻하며, 스윙의 절대적인 좋고 나쁨이 아닙니다.`)),
    h('div', { class: 'card' },
      h('div', { class: 'thumbs' }, PHASE_KEYS.map((k) => h('figure', {}, h('img', { src: s.thumbs[k], alt: PHASES[k] }), PHASES[k]))),
      h('p', { class: 'muted' }, '자동으로 찾은 구간입니다. 이미지가 실제 구간과 다르거나 골격선이 몸에서 벗어나 있으면 이 분석 결과는 믿지 마세요.')),
  );

  if (s.hasVideo) {
    const holder = h('div', { class: 'card' }, h('button', { class: 'btn', onclick: async () => {
      const v = await db.get('videos', s.id);
      if (v) holder.replaceChildren(h('video', { class: 'replay', controls: true, playsinline: true, src: URL.createObjectURL(v.blob) }));
    } }, '영상 다시 보기'));
    el.append(holder);
  }

  el.append(h('h2', {}, issues.length ? '고쳐야 할 점 (차이가 큰 순)' : '기준과 큰 차이가 없습니다'));
  for (const i of issues) {
    const m = metricByKey[i.key];
    if (!m) continue;
    const t = m[i.side];
    const lesson = lessonLink(i.key, i.side);
    el.append(h('div', { class: `card issue ${i.severity}` },
      h('div', {}, h('span', { class: `tag ${i.severity}` }, SEV[i.severity]), h('span', { class: 'tag' }, PHASES[m.phase])),
      h('h3', {}, t.title),
      h('p', { class: 'muted' }, m.label), nums(i, m),
      h('p', {}, h('b', {}, '왜 문제인가 '), t.why),
      h('p', {}, h('b', {}, '이렇게 고치세요 '), t.fix),
      t.drill && h('p', {}, h('b', {}, '연습법 '), t.drill),
      h('p', { class: 'links' },
        lesson && extLink(lesson, '▶ 교정 레슨 영상 찾기'),
        profile !== DEFAULT_PROFILE && !isBuiltin(profile) && extLink(playerLink(profile, s.view), `▶ ${profile} ${VIEWS[s.view].replace(/\(.*/, '')} 스윙 보기`))));
  }
  if (issues.length) el.append(h('p', { class: 'muted' }, '참고 영상 링크는 유튜브 검색 결과로 연결됩니다. 특정 영상을 추천하는 것이 아니므로 여러 영상을 비교해 보세요.'));

  el.append(h('h2', {}, '전체 측정값'), h('div', { class: 'card' }, h('table', {},
    h('tr', {}, h('th', {}, '항목'), h('th', {}, '내 값'), h('th', {}, '기준')),
    s.items.map((i) => {
      const m = metricByKey[i.key];
      return m && h('tr', {}, h('td', {}, h('span', { class: `dot ${i.severity}` }), `${PHASES[m.phase]} · ${m.label}`), h('td', {}, fmt(m, i.value)), h('td', {}, fmt(m, i.mean)));
    }))));
  return el;
}

// ───────── 기준 영상 탭 ─────────
async function renderRefs() {
  const allRefs = await db.getAll('refs');
  const refs = pickRefs(allRefs, state.view, state.profile);
  const stats = statsFor(allRefs, state.view, state.profile);
  const statsTable = (title, devLabel) => h('div', {}, h('h3', {}, title), h('div', { class: 'card' }, h('table', {},
    h('tr', {}, h('th', {}, '항목'), h('th', {}, '기준'), h('th', {}, devLabel)),
    metricsForView(state.view).filter((m) => stats[m.key]).map((m) =>
      h('tr', {}, h('td', {}, `${PHASES[m.phase]} · ${m.label}`), h('td', {}, fmt(m, stats[m.key].mean)), h('td', {}, stats[m.key].n > 1 ? '±' + Math.max(m.floor, stats[m.key].std).toFixed(m.digits) : '-'))))));
  if (isBuiltin(state.profile)) {
    return mount(
      h('h2', {}, '기준 영상'),
      viewPicker(render),
      profilePicker(allRefs, render),
      h('div', { class: 'card' },
        h('p', {}, '「정석 폼」은 앱에 내장된 기준이라 영상을 등록할 필요가 없습니다.'),
        h('p', { class: 'muted' }, '골프 레슨에서 일반적으로 가르치는 자세를 수치로 옮긴 값이며, 특정 선수를 측정한 것은 아닙니다. 미들 아이언 풀스윙 기준이라 드라이버는 스탠스·어깨 기울기 항목이 다르게 나올 수 있습니다.'),
        h('p', { class: 'muted' }, '특정 선수나 내 베스트 스윙을 기준으로 삼고 싶다면 위에서 다른 프로파일을 고르고 영상을 등록하세요.'),
        h('button', { class: 'btn primary', onclick: () => go('analyze') }, '바로 분석하러 가기')),
      statsTable(`「정석 폼」 ${VIEWS[state.view]} 기준값`, '허용 범위'));
  }
  const out = h('div');
  const add = async (files) => {
    state.busy = true;
    const errors = [];
    const target = { view: state.view, profile: state.profile, leftHanded: state.leftHanded, slowmo: state.slowmo };
    for (const [n, file] of files.entries()) {
      const pc = progressCard();
      out.replaceChildren(h('p', { class: 'muted' }, `${n + 1} / ${files.length} · ${file.name}`), pc.el);
      try {
        const r = await processVideo(file, target, pc.update);
        await db.put('refs', { id: db.newId(), date: new Date().toISOString(), ...target, name: file.name, metrics: r.metrics, times: r.times, thumbs: r.thumbs });
      } catch (e) {
        errors.push(`${file.name}: ${e.message}`);
      }
    }
    state.busy = false;
    await renderRefs();
    if (errors.length) root.append(h('div', { class: 'card err' }, h('p', {}, '등록하지 못한 영상'), h('ul', {}, errors.map((x) => h('li', {}, x)))));
  };

  mount(
    h('h2', {}, '기준 영상'),
    viewPicker(render),
    profilePicker(allRefs, render),
    check('왼손잡이 스윙', 'leftHanded'),
    check('슬로모션 영상 (템포는 기준에서 제외)', 'slowmo'),
    h('div', { class: 'card' },
      h('p', { class: 'muted' }, `「${state.profile}」의 ${VIEWS[state.view]} 스윙 영상 파일을 등록하세요. 고정된 카메라로 전신이 나오는 스윙 1회, 20초 이내여야 합니다. 화면이 움직이거나 장면이 바뀌는 중계 영상은 쓸 수 없습니다.`),
      h('p', { class: 'muted' }, '한 프로파일에는 한 사람의 스윙만 넣으세요. 여러 선수를 섞으면 누구의 폼도 아닌 기준이 됩니다.'),
      h('div', { class: 'row' },
        filePicker('기준 영상 추가', { multiple: true, onFiles: add }),
        state.profile !== DEFAULT_PROFILE && extLink(playerLink(state.profile, state.view), '어떤 영상이 있는지 찾아보기'))),
    out,
    h('h3', {}, `「${state.profile}」 ${VIEWS[state.view]} 기준 ${refs.length}개`),
    refs.length
      ? h('div', { class: 'card' }, refs.map((r) => h('div', { class: 'item' },
          h('img', { src: r.thumbs?.top, alt: '' }),
          h('div', { class: 'grow' }, h('div', {}, r.name), h('div', { class: 'muted' }, `${fmtDate(r.date)} 등록 · ` + (r.metrics.tempo != null ? `템포 ${r.metrics.tempo.toFixed(1)} : 1` : '슬로모션'))),
          h('button', { class: 'btn small danger', onclick: async () => { if (confirm('이 기준 영상을 삭제할까요?')) { await db.del('refs', r.id); renderRefs(); } } }, '삭제'))))
      : h('p', { class: 'muted' }, '아직 없습니다.'),
    refs.length > 0 && statsTable('학습된 기준값', '편차'),
  );
}

// ───────── 기록 탭 ─────────
const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, text) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}
/** 시간순 추이 선 그래프. band가 있으면 기준 허용 범위를 띠로 표시한다. */
function trendChart(points, { min, max, band, format = (v) => String(Math.round(v)) }) {
  const W = 320, H = 150, L = 40, R = 10, T = 12, B = 24;
  const vals = points.map((p) => p.v).concat(band ? [band.lo, band.hi] : []);
  let lo = min ?? Math.min(...vals), hi = max ?? Math.max(...vals);
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  if (min == null) { const pad = (hi - lo) * 0.12; lo -= pad; hi += pad; }
  const x = (i) => (points.length === 1 ? (L + W - R) / 2 : L + (i / (points.length - 1)) * (W - L - R));
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const el = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
  if (band) el.append(svg('rect', { x: L, y: y(band.hi), width: W - L - R, height: Math.max(1, y(band.lo) - y(band.hi)), fill: '#3ddc84', opacity: 0.14 }));
  for (const v of [lo, (lo + hi) / 2, hi]) {
    el.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: '#2a3c31', 'stroke-width': 1 }));
    el.append(svg('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 10, fill: '#9db3a5' }, format(v)));
  }
  if (points.length > 1) el.append(svg('polyline', { points: points.map((p, i) => `${x(i)},${y(p.v)}`).join(' '), fill: 'none', stroke: '#3ddc84', 'stroke-width': 2 }));
  points.forEach((p, i) => el.append(svg('circle', { cx: x(i), cy: y(p.v), r: 3.5, fill: '#3ddc84' })));
  el.append(svg('text', { x: L, y: H - 6, 'font-size': 10, fill: '#9db3a5' }, points[0].label));
  if (points.length > 1) el.append(svg('text', { x: W - R, y: H - 6, 'text-anchor': 'end', 'font-size': 10, fill: '#9db3a5' }, points.at(-1).label));
  return el;
}

async function renderHistory() {
  if (state.detail) {
    const s = await db.get('sessions', state.detail);
    if (s) {
      mount(
        h('div', { class: 'row' },
          h('button', { class: 'btn small', onclick: () => { state.detail = null; render(); } }, '← 목록'),
          h('span', { class: 'grow' }),
          h('button', { class: 'btn small danger', onclick: async () => {
            if (!confirm('이 기록을 삭제할까요?')) return;
            await db.del('sessions', s.id); await db.del('videos', s.id); state.detail = null; render();
          } }, '기록 삭제')),
        await resultView(s));
      return;
    }
    state.detail = null;
  }

  const allRefs = await db.getAll('refs');
  const sessions = (await db.getAll('sessions')).filter((s) => s.view === state.view && profileOf(s) === state.profile).sort(byDate);
  const stats = statsFor(allRefs, state.view, state.profile);
  const scored = sessions.filter((s) => s.score != null);
  const metricBox = h('div');
  const select = h('select', { onchange: () => drawMetric() }, metricsForView(state.view).map((m) => h('option', { value: m.key }, `${PHASES[m.phase]} · ${m.label}`)));
  function drawMetric() {
    const m = metricByKey[select.value];
    const pts = sessions.filter((s) => Number.isFinite(s.metrics[m.key])).map((s) => ({ v: s.metrics[m.key], label: fmtDate(s.date) }));
    if (!pts.length) return metricBox.replaceChildren(h('p', { class: 'muted' }, '데이터가 없습니다.'));
    const st = stats[m.key];
    const tol = st && Math.max(m.floor, st.n >= 3 ? st.std : 0);
    metricBox.replaceChildren(
      trendChart(pts, { band: st && { lo: st.mean - tol, hi: st.mean + tol }, format: (v) => v.toFixed(m.digits) }),
      h('p', { class: 'muted' }, st ? `초록 띠가 기준 범위(${fmt(m, st.mean)} ±${tol.toFixed(m.digits)})입니다. 점이 띠 안으로 들어올수록 기준에 가까워진 것입니다.` : '기준 영상이 없어 범위를 표시할 수 없습니다.'));
  }

  mount(
    h('h2', {}, '분석 기록과 발전 추이'),
    viewPicker(render),
    profilePicker(allRefs, render),
    sessions.length === 0 ? h('p', { class: 'muted' }, `「${state.profile}」 기준의 ${VIEWS[state.view]} 분석 기록이 아직 없습니다.`) : [
      h('div', { class: 'card' }, h('h3', {}, '점수 추이'),
        scored.length ? trendChart(scored.map((s) => ({ v: s.score, label: fmtDate(s.date) })), { min: 0, max: 100 }) : h('p', { class: 'muted' }, '데이터가 없습니다.'),
        scored.length > 1 && h('p', { class: 'muted' }, `첫 분석 ${scored[0].score}점 → 최근 ${scored.at(-1).score}점`)),
      h('div', { class: 'card' }, h('h3', {}, '항목별 추이'), select, metricBox),
      h('div', { class: 'card' }, [...sessions].reverse().map((s) => h('div', { class: 'item', onclick: () => { state.detail = s.id; render(); } },
        h('img', { src: s.thumbs?.impact, alt: '' }),
        h('div', { class: 'grow' }, h('div', {}, fmtDateTime(s.date)),
          h('div', { class: 'muted' }, `교정 필요 ${s.items.filter((i) => i.severity === 'major').length} · 주의 ${s.items.filter((i) => i.severity === 'minor').length}${s.hasVideo ? ' · 영상 저장됨' : ''}`)),
        h('div', { class: 'big' }, String(s.score ?? '-'))))),
    ],
  );
  if (sessions.length) drawMetric();
}

// ───────── 설정 탭 ─────────
function syncStatusText() {
  const st = sync.status;
  if (st.state === 'syncing') return '동기화 중…';
  if (st.state === 'error') return '동기화 실패: ' + st.message;
  return st.lastSync ? `마지막 동기화 ${fmtDateTime(st.lastSync)}` : '아직 동기화하지 않았습니다.';
}

async function syncCard() {
  const card = h('div', { class: 'card' }, h('h3', {}, '기기 간 동기화'));
  const msg = h('p', { class: 'muted' });
  const say = (text, bad = false) => { msg.textContent = text; msg.className = bad ? 'bad' : 'muted'; };
  const guard = (fn) => async () => { try { say('처리 중…'); await fn(); } catch (e) { say(e.message, true); } };
  const cfg = sync.getConfig();

  if (!cfg) {
    const url = h('input', { type: 'url', placeholder: 'Project URL (https://xxxx.supabase.co)', autocomplete: 'off' });
    const key = h('input', { type: 'text', placeholder: 'anon public 키', autocomplete: 'off' });
    card.append(
      h('p', { class: 'muted' }, '로그인하면 기준 프로파일과 분석 기록(수치·구간 이미지)이 여러 기기에서 같게 유지됩니다. 영상 원본은 촬영한 기기에만 남습니다.'),
      h('p', { class: 'muted' }, '무료 Supabase 프로젝트가 필요합니다. 만드는 방법은 저장소의 README 「기기 간 동기화 설정」을 따라 하세요. 한 번만 하면 됩니다.'),
      url, key,
      h('button', { class: 'btn', onclick: guard(() => { sync.setConfig(url.value, key.value); render(); }) }, '연결 정보 저장'), msg);
    return card;
  }

  let user = null;
  try {
    user = await sync.getUser();
  } catch {
    card.append(h('p', { class: 'bad' }, '동기화 서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.'));
  }
  if (!user) {
    const email = h('input', { type: 'email', placeholder: '이메일 주소', autocomplete: 'email' });
    const pw = h('input', { type: 'password', placeholder: '비밀번호 (6자 이상, 새로 정하기)', autocomplete: 'current-password' });
    card.append(
      h('p', { class: 'muted' }, '처음이라면 사용할 이메일과 새 비밀번호를 직접 정해 아래에 입력하고 「처음이면 가입」을 누르세요. 미리 만들어 둔 계정은 필요 없습니다. 이후 모든 기기에서 같은 이메일·비밀번호로 로그인하면 기록이 합쳐집니다.'),
      email, pw,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: guard(async () => { await sync.signIn(email.value.trim(), pw.value); await sync.syncNow(); render(); }) }, '로그인'),
        h('button', { class: 'btn', onclick: guard(async () => {
          if (await sync.signUp(email.value.trim(), pw.value)) { await sync.syncNow(); render(); } else say('확인 메일을 보냈습니다. 메일의 링크를 누른 뒤 여기서 로그인해 주세요.');
        }) }, '처음이면 가입'),
        !cfg.fixed && h('button', { class: 'btn small', onclick: () => { if (confirm('저장한 연결 정보를 지울까요?')) { sync.clearConfig(); render(); } } }, '연결 정보 지우기')),
      msg);
    return card;
  }

  const statusEl = h('p', { class: 'muted' }, syncStatusText());
  state.onSyncStatus = () => { statusEl.textContent = syncStatusText(); statusEl.className = sync.status.state === 'error' ? 'bad' : 'muted'; };
  state.onSyncStatus();
  card.append(
    h('p', {}, `${user.email} 계정으로 로그인됨`), statusEl,
    h('p', { class: 'muted' }, '분석하거나 삭제하면 자동으로 동기화됩니다. 영상 원본은 동기화되지 않습니다.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => sync.syncNow() }, '지금 동기화'),
      h('button', { class: 'btn small', onclick: async () => { await sync.signOut(); render(); } }, '로그아웃')));
  return card;
}

async function backupCard() {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const mb = (n) => (n / 1048576).toFixed(0) + 'MB';
  const importInput = h('input', { type: 'file', accept: 'application/json,.json', onchange: async (e) => {
    const [f] = e.target.files; e.target.value = '';
    if (!f) return;
    try { const r = await db.importAll(JSON.parse(await f.text())); alert(`가져오기 완료: 기준 ${r.refs}개, 기록 ${r.sessions}개`); render(); } catch (err) { alert('가져오기 실패: ' + err.message); }
  } });
  return h('div', { class: 'card' }, h('h3', {}, '파일 백업'),
    h('p', { class: 'muted' }, '동기화를 쓰지 않는다면 기록은 이 기기의 브라우저에만 있습니다. 백업 파일에 영상 원본은 포함되지 않습니다.'),
    est?.usage != null && h('p', { class: 'muted' }, `사용 중 ${mb(est.usage)} / 사용 가능 약 ${mb(est.quota)}`),
    h('div', { class: 'row' },
      h('button', { class: 'btn small', onclick: async () => {
        const blob = new Blob([JSON.stringify(await db.exportAll())], { type: 'application/json' });
        const a = h('a', { href: URL.createObjectURL(blob), download: `golform-backup-${new Date().toISOString().slice(0, 10)}.json` });
        a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } }, '백업 파일 내보내기'),
      h('label', { class: 'btn small' }, '백업 파일 가져오기', importInput)));
}

async function renderSettings() {
  state.onSyncStatus = null;
  mount(
    h('h2', {}, '설정'),
    await syncCard(),
    await backupCard(),
    h('h2', {}, '사용 방법'),
    h('div', { class: 'card' }, h('ol', {},
      h('li', {}, '「기준 영상」에서 프로파일(선수)을 고르고, 그 사람의 스윙 영상 파일을 촬영 방향별로 등록합니다. 3개 이상을 권장합니다.'),
      h('li', {}, '「분석」에서 같은 프로파일·같은 방향으로 내 스윙 영상을 선택합니다.'),
      h('li', {}, '기준과 차이가 큰 항목부터 원인, 교정 방법, 참고 영상 링크를 확인합니다.'),
      h('li', {}, '「기록」에서 점수와 항목별 수치가 기준에 가까워지는지 확인합니다.'))),
    h('h2', {}, '영상 조건 (결과의 정확도를 좌우합니다)'),
    h('div', { class: 'card' }, h('ul', {},
      h('li', {}, h('b', {}, '정면: '), '몸 정면에서, 카메라를 손 높이 정도에 두고 촬영한 영상.'),
      h('li', {}, h('b', {}, '측면(타깃 후방): '), '타깃 반대편 뒤에서, 손을 지나는 타깃 라인 위에 카메라를 둔 영상.'),
      h('li', {}, '머리부터 발끝까지 전신이 스윙 내내 화면 안에 있어야 합니다.'),
      h('li', {}, '카메라가 고정되어 있어야 합니다. 화면이 움직이거나 확대·장면 전환이 있는 중계 영상은 수치가 틀어집니다.'),
      h('li', {}, '영상 하나에 스윙 1회, 어드레스에서 1초쯤 멈춘 뒤 스윙하고 20초 이내로 자릅니다.'),
      h('li', {}, '슬로모션 영상은 「슬로모션 영상」을 체크하세요. 템포 비교만 빠지고 자세 비교는 그대로 됩니다.'),
      h('li', {}, '기준 영상과 내 영상의 촬영 방향·높이가 비슷할수록 비교가 정확합니다.'))),
    h('h2', {}, '이 앱이 볼 수 없는 것'),
    h('div', { class: 'card' }, h('ul', {},
      h('li', {}, '클럽 페이스 방향, 그립, 클럽 궤도, 공의 구질은 측정하지 않습니다. 몸의 관절 위치만 봅니다.'),
      h('li', {}, '카메라 한 대의 2D 영상이라 회전량은 추정치이며, 몸에 가려진 쪽 팔다리는 오차가 큽니다.'),
      h('li', {}, '프로와 체형·유연성이 달라 똑같이 만들 수 없는 항목도 있습니다. 「주의」 수준의 차이는 참고만 하세요.'),
      h('li', {}, '통증이 있거나 큰 폼 변경을 할 때는 레슨 프로의 확인을 받으세요.'))),
    h('p', { class: 'muted' }, '영상 분석은 이 기기 안에서만 이뤄지며 영상이 서버로 전송되지 않습니다.'),
  );
}

// ───────── 라우팅 ─────────
const TABS = { analyze: renderAnalyze, history: renderHistory, refs: renderRefs, settings: renderSettings };
function go(tab) {
  if (state.busy) return alert('분석이 끝난 뒤 이동해 주세요.');
  state.tab = tab;
  state.detail = null;
  render();
}
async function render() {
  for (const b of tabs.querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === state.tab);
  try {
    await TABS[state.tab]();
  } catch (e) {
    mount(errorCard(e));
  }
}
tabs.addEventListener('click', (e) => { const t = e.target.closest('button')?.dataset.tab; if (t) go(t); });
window.addEventListener('golform-sync', (e) => {
  state.onSyncStatus?.();
  // 다른 기기의 기록이 내려왔으면 목록을 다시 그린다(입력 중인 설정 화면과 분석 중인 화면은 건드리지 않는다)
  if (e.detail?.changed && !state.busy && state.tab !== 'settings' && !state.detail) render();
});
navigator.storage?.persist?.().catch(() => {});
sync.init();
// 기준 영상이 하나도 없는 프로파일이 선택돼 있으면 바로 쓸 수 있는 내장 기준으로 시작한다
db.getAll('refs').then((all) => {
  if (!isBuiltin(state.profile) && !all.some((r) => profileOf(r) === state.profile)) { state.profile = BUILTIN_PROFILE; savePrefs(); }
}).catch(() => {}).finally(render);
