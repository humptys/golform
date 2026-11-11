import { analyzeSwing } from './swing.js';
import { METRICS, PHASES, VIEWS, metricByKey, metricsForView, fmt } from './metrics.js';
import { buildStats, evaluate } from './profile.js';
import { extractPoses } from './pose.js';
import * as db from './db.js';

const PHASE_KEYS = ['address', 'top', 'impact', 'finish'];
const SEV = { good: '양호', minor: '주의', major: '교정 필요' };
const prefs = JSON.parse(localStorage.getItem('golform-prefs') || '{}');
const state = { tab: 'analyze', view: prefs.view || 'faceon', leftHanded: !!prefs.leftHanded, saveVideo: prefs.saveVideo !== false, busy: false, detail: null };
const savePrefs = () => localStorage.setItem('golform-prefs', JSON.stringify({ view: state.view, leftHanded: state.leftHanded, saveVideo: state.saveVideo }));

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

// ───────── 공통 UI ─────────
function viewPicker(onChange) {
  return h('div', { class: 'seg' }, Object.entries(VIEWS).map(([k, label]) =>
    h('button', { class: state.view === k ? 'on' : '', onclick: () => { if (state.busy) return; state.view = k; savePrefs(); onChange(); } }, label)));
}
function check(label, key) {
  return h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: state[key], onchange: (e) => { state[key] = e.target.checked; savePrefs(); } }), label);
}
function filePicker(label, { multiple = false, onFiles, disabled = false }) {
  const input = h('input', { type: 'file', accept: 'video/*', multiple, disabled, onchange: (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) onFiles(f); } });
  return h('label', { class: 'btn primary' + (disabled ? ' disabled' : '') }, label, input);
}
function progressCard() {
  const bar = h('progress', { max: 1, value: 0 });
  const text = h('p', { class: 'muted' }, '준비 중…');
  const el = h('div', { class: 'card' }, text, bar);
  return { el, update: (v, msg) => { bar.value = v; if (msg) text.textContent = msg; } };
}
const errorCard = (e) => h('div', { class: 'card err' }, e?.message || String(e));

/** 영상 1개 -> 측정값 + 구간별 썸네일 */
async function processVideo(file, { view, leftHanded }, onProgress) {
  const ex = await extractPoses(file, onProgress);
  try {
    const r = analyzeSwing(ex.frames, { aspect: ex.aspect, leftHanded, view });
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

async function refsFor(view) {
  return (await db.getAll('refs')).filter((r) => r.view === view).sort(byDate);
}

// ───────── 분석 탭 ─────────
async function renderAnalyze() {
  const refs = await refsFor(state.view);
  const out = h('div');
  const run = async ([file]) => {
    state.busy = true;
    const pc = progressCard();
    out.replaceChildren(pc.el);
    try {
      const r = await processVideo(file, state, pc.update);
      const ev = evaluate(r.metrics, buildStats(refs), state.view);
      const session = {
        id: db.newId(), date: new Date().toISOString(), view: state.view, leftHanded: state.leftHanded, name: file.name,
        metrics: r.metrics, times: r.times, thumbs: r.thumbs, score: ev.score, items: ev.items, refCount: refs.length, hasVideo: false,
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
    check('왼손잡이 스윙', 'leftHanded'),
    check('영상 원본도 이 기기에 저장 (기록에서 다시 보기)', 'saveVideo'),
    refs.length === 0
      ? h('div', { class: 'card warn' },
          h('p', {}, `${VIEWS[state.view]} 기준 영상이 아직 없습니다.`),
          h('p', { class: 'muted' }, '먼저 프로나 잘 치는 사람의 스윙 영상을 기준으로 등록해야 비교할 수 있습니다.'),
          h('button', { class: 'btn', onclick: () => go('refs') }, '기준 영상 등록하러 가기'))
      : h('div', { class: 'card' },
          h('p', { class: 'muted' }, `${VIEWS[state.view]} 기준 영상 ${refs.length}개와 비교합니다.` + (refs.length < 3 ? ' 3개 이상 등록하면 기준이 더 안정적입니다.' : '')),
          filePicker('스윙 영상 선택', { onFiles: run })),
    out,
  );
}

async function resultView(s) {
  const prev = (await db.getAll('sessions')).filter((x) => x.view === s.view && x.date < s.date && x.score != null).sort(byDate).pop();
  const issues = s.items.filter((i) => i.severity !== 'good').sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  const nums = (i, m) => h('p', { class: 'nums' }, '내 값 ', h('b', {}, fmt(m, i.value)), ' · 기준 ', h('b', {}, fmt(m, i.mean)), ` (허용 ±${i.tol.toFixed(m.digits)})`);

  const el = h('div', {},
    h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('div', { class: 'grow' },
          h('div', { class: 'muted' }, `${fmtDateTime(s.date)} · ${VIEWS[s.view]}`),
          h('div', { class: 'score' }, String(s.score ?? '-'), h('small', {}, ' / 100')),
          prev && h('div', { class: 'muted' }, `직전 분석(${fmtDate(prev.date)}) 대비 ${s.score - prev.score >= 0 ? '+' : ''}${s.score - prev.score}점`)),
        h('div', {}, h('span', { class: 'tag major' }, `교정 필요 ${issues.filter((i) => i.severity === 'major').length}`), h('span', { class: 'tag minor' }, `주의 ${issues.filter((i) => i.severity === 'minor').length}`))),
      h('p', { class: 'muted' }, `점수는 기준 영상 ${s.refCount}개와 얼마나 비슷한지를 뜻하며, 스윙의 절대적인 좋고 나쁨이 아닙니다.`)),
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
    el.append(h('div', { class: `card issue ${i.severity}` },
      h('div', {}, h('span', { class: `tag ${i.severity}` }, SEV[i.severity]), h('span', { class: 'tag' }, PHASES[m.phase])),
      h('h3', {}, t.title),
      h('p', { class: 'muted' }, m.label), nums(i, m),
      h('p', {}, h('b', {}, '왜 문제인가 '), t.why),
      h('p', {}, h('b', {}, '이렇게 고치세요 '), t.fix),
      t.drill && h('p', {}, h('b', {}, '연습법 '), t.drill)));
  }

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
  const refs = await refsFor(state.view);
  const stats = buildStats(refs);
  const out = h('div');
  const add = async (files) => {
    state.busy = true;
    const errors = [];
    for (const [n, file] of files.entries()) {
      const pc = progressCard();
      out.replaceChildren(h('p', { class: 'muted' }, `${n + 1} / ${files.length} · ${file.name}`), pc.el);
      try {
        const r = await processVideo(file, state, pc.update);
        await db.put('refs', { id: db.newId(), date: new Date().toISOString(), view: state.view, leftHanded: state.leftHanded, name: file.name, metrics: r.metrics, times: r.times, thumbs: r.thumbs });
      } catch (e) {
        errors.push(`${file.name}: ${e.message}`);
      }
    }
    state.busy = false;
    await renderRefs();
    if (errors.length) root.append(h('div', { class: 'card err' }, h('p', {}, '등록하지 못한 영상'), h('ul', {}, errors.map((x) => h('li', {}, x)))));
  };

  mount(
    h('h2', {}, '기준 영상 (프로·잘 치는 사람)'),
    viewPicker(render),
    check('왼손잡이 스윙', 'leftHanded'),
    h('div', { class: 'card' },
      h('p', { class: 'muted' }, `${VIEWS[state.view]}에서 찍은 스윙 영상을 등록하세요. 영상마다 스윙 1회, 전신이 나와야 합니다. 여러 개를 한 번에 선택할 수 있습니다.`),
      filePicker('기준 영상 추가', { multiple: true, onFiles: add })),
    out,
    h('h3', {}, `등록된 기준 ${refs.length}개`),
    refs.length
      ? h('div', { class: 'card' }, refs.map((r) => h('div', { class: 'item' },
          h('img', { src: r.thumbs?.top, alt: '' }),
          h('div', { class: 'grow' }, h('div', {}, r.name), h('div', { class: 'muted' }, `${fmtDate(r.date)} 등록 · 템포 ${r.metrics.tempo?.toFixed(1) ?? '-'} : 1`)),
          h('button', { class: 'btn small danger', onclick: async () => { if (confirm('이 기준 영상을 삭제할까요?')) { await db.del('refs', r.id); renderRefs(); } } }, '삭제'))))
      : h('p', { class: 'muted' }, '아직 없습니다.'),
    refs.length > 0 && h('div', {}, h('h3', {}, '학습된 기준값'), h('div', { class: 'card' }, h('table', {},
      h('tr', {}, h('th', {}, '항목'), h('th', {}, '평균'), h('th', {}, '편차')),
      metricsForView(state.view).filter((m) => stats[m.key]).map((m) =>
        h('tr', {}, h('td', {}, `${PHASES[m.phase]} · ${m.label}`), h('td', {}, fmt(m, stats[m.key].mean)), h('td', {}, stats[m.key].n > 1 ? '±' + stats[m.key].std.toFixed(m.digits) : '-')))))),
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

  const sessions = (await db.getAll('sessions')).filter((s) => s.view === state.view).sort(byDate);
  const stats = buildStats(await refsFor(state.view));
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
    sessions.length === 0 ? h('p', { class: 'muted' }, `${VIEWS[state.view]} 분석 기록이 아직 없습니다.`) : [
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
    await backupCard(),
  );
  if (sessions.length) drawMetric();
}

async function backupCard() {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const mb = (n) => (n / 1048576).toFixed(0) + 'MB';
  const importInput = h('input', { type: 'file', accept: 'application/json,.json', onchange: async (e) => {
    const [f] = e.target.files; e.target.value = '';
    if (!f) return;
    try { const r = await db.importAll(JSON.parse(await f.text())); alert(`가져오기 완료: 기준 ${r.refs}개, 기록 ${r.sessions}개`); render(); } catch (err) { alert('가져오기 실패: ' + err.message); }
  } });
  return h('div', { class: 'card' }, h('h3', {}, '백업'),
    h('p', { class: 'muted' }, '기록은 이 기기의 브라우저에만 저장됩니다. 브라우저 데이터를 지우거나 기기를 바꾸면 사라지므로 가끔 백업하세요. 백업 파일에 영상 원본은 포함되지 않습니다.'),
    est?.usage != null && h('p', { class: 'muted' }, `사용 중 ${mb(est.usage)} / 사용 가능 약 ${mb(est.quota)}`),
    h('div', { class: 'row' },
      h('button', { class: 'btn small', onclick: async () => {
        const blob = new Blob([JSON.stringify(await db.exportAll())], { type: 'application/json' });
        const a = h('a', { href: URL.createObjectURL(blob), download: `golform-backup-${new Date().toISOString().slice(0, 10)}.json` });
        a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } }, '백업 파일 내보내기'),
      h('label', { class: 'btn small' }, '백업 파일 가져오기', importInput)));
}

// ───────── 안내 탭 ─────────
function renderGuide() {
  mount(
    h('h2', {}, '사용 방법'),
    h('div', { class: 'card' }, h('ol', {},
      h('li', {}, '「기준 영상」에 프로나 잘 치는 사람의 스윙 영상을 촬영 방향별로 등록합니다. 3개 이상을 권장합니다.'),
      h('li', {}, '「분석」에서 같은 방향으로 찍은 내 스윙 영상을 선택합니다.'),
      h('li', {}, '기준과 차이가 큰 항목부터 원인과 교정 방법을 확인합니다.'),
      h('li', {}, '「기록」에서 점수와 항목별 수치가 기준에 가까워지는지 확인합니다.'))),
    h('h2', {}, '촬영 방법 (결과의 정확도를 좌우합니다)'),
    h('div', { class: 'card' }, h('ul', {},
      h('li', {}, h('b', {}, '정면: '), '몸 정면에서, 카메라를 손 높이 정도에 두고 촬영합니다.'),
      h('li', {}, h('b', {}, '측면(타깃 후방): '), '타깃 반대편 뒤에서, 손을 지나는 타깃 라인 위에 카메라를 두고 촬영합니다.'),
      h('li', {}, '머리부터 발끝까지 전신이 스윙 내내 화면 안에 있어야 합니다.'),
      h('li', {}, '삼각대 등으로 카메라를 고정하세요. 흔들리면 머리·골반 이동 수치가 틀어집니다.'),
      h('li', {}, '영상 하나에 스윙 1회, 어드레스에서 1초쯤 멈춘 뒤 스윙하고 20초 이내로 자릅니다.'),
      h('li', {}, '가능하면 슬로모션이 아닌 일반 속도(60fps면 더 좋음)로 찍으세요. 슬로모션 영상은 템포 수치가 달라집니다.'),
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
const TABS = { analyze: renderAnalyze, history: renderHistory, refs: renderRefs, guide: renderGuide };
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
navigator.storage?.persist?.().catch(() => {});
render();

// 테스트에서 쓰는 훅
window.__golform = { METRICS };
