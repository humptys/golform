import { analyzeSwing } from './swing.js';
import { PHASES, VIEWS, CLUBS, metricByKey, metricsForView, fmt, textFor } from './metrics.js';
import { buildStats, evaluate } from './profile.js';
import { extractPoses } from './pose.js';
import { lessonLink, playerLink, searchLink } from './links.js';
import { drawShot, drawSkeleton, PHASE_OF } from './annotate.js';
import { sourcesFor } from './sources.js';
import { SHOT_FIELDS, SIDE_WORDS, buildShot, analyzeShot, diagnose, sidePercent, smashFactor, fmtShot } from './shot.js';
import { readShotImage } from './ocr.js';
import { findPatterns, summarizeHistory } from './patterns.js';
import { textbookStats, publishedStats, SOURCES } from './textbook.js';
import * as db from './db.js';
import * as sync from './sync.js';
import { VERSION } from './version.js';

const PHASE_KEYS = ['address', 'top', 'impact', 'finish'];
const SEV = { good: '양호', minor: '주의', major: '교정 필요' };
const DEFAULT_PROFILE = '기본'; // 프로파일 기능 이전에 등록된 기준 영상이 속하는 이름
const BUILTIN_PROFILE = '정석 폼'; // 영상 등록 없이 쓰는 내장 기준(textbook.js)
const PRESET_PROFILES = [BUILTIN_PROFILE, '로리 맥길로이', '넬리 코다'];
const prefs = JSON.parse(localStorage.getItem('golform-prefs') || '{}');
const state = {
  tab: 'analyze', view: prefs.view || 'faceon', club: prefs.club || 'iron', profile: prefs.profile || BUILTIN_PROFILE,
  // 슬로모션 여부는 영상마다 다르므로 기억하지 않는다. 켜진 채 남으면 템포가 조용히 빠지기 때문이다.
  leftHanded: !!prefs.leftHanded, slowmo: false, saveVideo: prefs.saveVideo !== false,
  busy: false, detail: null, onSyncStatus: null,
};
const savePrefs = () => localStorage.setItem('golform-prefs', JSON.stringify({
  view: state.view, club: state.club, profile: state.profile, leftHanded: state.leftHanded, saveVideo: state.saveVideo,
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
const clubOf = (r) => r.club || 'iron'; // 클럽 구분 이전의 기록은 아이언으로 본다
const VIEW_SHORT = { faceon: '정면', dtl: '측면' };
/**
 * 기록 하나에 담긴 영상별 분석. 새 기록은 parts에 정면·측면이 함께 들어 있고,
 * 예전 기록(영상 1개)은 기록 자체를 한 부분으로 본다.
 */
const partsOf = (s) => s.parts ?? [{
  view: s.view, name: s.name, metrics: s.metrics, items: s.items, times: s.times, thumbs: s.thumbs, shots: s.shots, pose: s.pose,
  warnings: s.warnings, score: s.score, basis: s.basis, refCount: s.refCount, hasVideo: s.hasVideo, videoKey: s.id,
}];
/** 기록에 딸린 영상 원본의 저장 키들 */
const videoKeysOf = (s) => (s.parts ? s.parts.map((p) => `${s.id}:${p.view}`) : [s.id]);
async function deleteSession(s) {
  await db.del('sessions', s.id);
  for (const k of videoKeysOf(s)) await db.del('videos', k);
}
const extLink = (href, label) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label);

// ───────── 공통 UI ─────────
function viewPicker(onChange) {
  return h('div', { class: 'seg' }, Object.entries(VIEWS).map(([k, label]) =>
    h('button', { class: state.view === k ? 'on' : '', onclick: () => { if (state.busy) return; state.view = k; savePrefs(); onChange(); } }, label)));
}
/** 클럽 종류 선택. 종류마다 스윙 크기와 기준값이 달라 기록도 따로 쌓인다. */
function clubPicker(onChange) {
  return h('div', { class: 'seg field' }, Object.entries(CLUBS).map(([k, label]) =>
    h('button', { class: state.club === k ? 'on' : '', onclick: () => { if (state.busy) return; state.club = k; savePrefs(); onChange(); } }, label)));
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

const JOINTS = [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const round4 = (v) => Math.round(v * 1e4) / 1e4;

/** 네 구간의 관절이 모두 들어오도록 사람 주변만 잘라낼 영역(0~1 비율). 구간끼리 위치를 비교할 수 있게 같은 영역을 쓴다. */
function cropRect(lms, aspect) {
  const xs = lms.flatMap((lm) => JOINTS.map((i) => lm[i].x));
  const ys = lms.flatMap((lm) => JOINTS.map((i) => lm[i].y));
  const bh = Math.max(...ys) - Math.min(...ys);
  const padY = 0.18 * bh;
  const padX = (0.3 * bh) / aspect; // 팔과 클럽이 지나가는 좌우 여백
  const x0 = Math.max(0, Math.min(...xs) - padX), x1 = Math.min(1, Math.max(...xs) + padX);
  const y0 = Math.max(0, Math.min(...ys) - padY), y1 = Math.min(1, Math.max(...ys) + padY * 0.6);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 영상 1개 -> 측정값 + 구간별 사진(사람 주변 확대)과 관절 좌표 */
async function processVideo(file, { view, leftHanded, slowmo, club }, onProgress) {
  const ex = await extractPoses(file, onProgress);
  try {
    const r = analyzeSwing(ex.frames, { aspect: ex.aspect, leftHanded, view, club });
    if (slowmo) delete r.metrics.tempo; // 재생 속도가 바뀐 영상의 시간 비율은 믿을 수 없다
    onProgress(1, '구간 이미지 만드는 중…');
    // 구간 프레임이 보간된 프레임이면 가장 가까운 실제 검출 결과를 쓴다
    const lmAt = (i) => {
      for (let d = 0; d < ex.frames.length; d++) {
        const lm = ex.frames[i - d]?.lm ?? ex.frames[i + d]?.lm;
        if (lm) return lm;
      }
      return null;
    };
    const lms = Object.fromEntries(PHASE_KEYS.map((k) => [k, lmAt(r.phases[k])]));
    const rect = cropRect(Object.values(lms), ex.aspect);
    const shots = {}, pose = {}, thumbs = {};
    for (const k of PHASE_KEYS) {
      const c = await ex.capture(ex.frames[r.phases[k]].t, rect, 420);
      shots[k] = c.toDataURL('image/jpeg', 0.7);
      pose[k] = Object.fromEntries(JOINTS.map((i) => [i, [round4((lms[k][i].x - rect.x) / rect.w), round4((lms[k][i].y - rect.y) / rect.h)]]));
      const t = document.createElement('canvas');
      t.width = 150;
      t.height = Math.round((150 * c.height) / c.width);
      const g = t.getContext('2d');
      g.drawImage(c, 0, 0, t.width, t.height);
      drawSkeleton(g, pose[k], t.width, t.height, { color: '#3ddc84', width: 1.5 });
      thumbs[k] = t.toDataURL('image/jpeg', 0.7);
    }
    const warnings = [];
    if (r.bodyHeight < 0.4) warnings.push('사람이 화면에서 작게 찍혔습니다. 관절 위치 오차가 커지므로 카메라를 더 가까이 두거나 확대해서 찍으면 정확해집니다.');
    if (r.looksLike && r.looksLike !== view) warnings.push(`이 영상은 ${VIEWS[r.looksLike]}에서 찍은 것처럼 보입니다. 정면 칸과 측면 칸에 영상을 바꿔 넣지 않았는지 확인하세요. 바뀌었다면 이 결과는 맞지 않습니다.`);
    return { view: r.view, metrics: r.metrics, times: r.times, thumbs, shots, pose, warnings };
  } finally {
    ex.close();
  }
}

const pickRefs = (all, view, profile, club) => all.filter((r) => r.view === view && profileOf(r) === profile && clubOf(r) === club).sort(byDate);
const isBuiltin = (profile) => profile === BUILTIN_PROFILE;
/**
 * 비교에 쓸 기준을 정한다.
 * textbook: 내장 정석 폼 / refs: 등록한 기준 영상 / published: 선수의 공개 측정 수치 + 투어 기준(영상을 등록하면 영상이 우선)
 */
function basisFor(all, view, profile, club) {
  if (isBuiltin(profile)) return { kind: 'textbook', stats: textbookStats(club) };
  const refs = pickRefs(all, view, profile, club);
  if (refs.length) return { kind: 'refs', stats: buildStats(refs) };
  const pub = publishedStats(profile, club);
  if (pub) return { kind: 'published', stats: pub.stats, note: pub.note };
  return { kind: 'none', stats: {} };
}
const sourceList = () => h('div', { class: 'card' }, h('p', { class: 'muted' }, '측정 데이터 출처 (그 밖의 항목은 일반적인 레슨 기준입니다)'),
  h('ul', {}, SOURCES.map((x) => h('li', {}, extLink(x.url, x.label)))));

/**
 * 샷 데이터(론치 모니터 숫자) 입력 폼. 캡처 화면에서 읽어 채우거나 직접 입력한다.
 * get()은 현재 입력을 샷 객체로 돌려주고, 값이 하나도 없으면 null이다.
 */
function shotForm(initial = null) {
  const inputs = {};
  const msg = h('p', { class: 'muted' });
  const preview = h('div');
  const show = (f, v) => (f.key === 'side' ? `${v >= 0 ? 'R' : 'L'}${Math.abs(v)}` : String(v));
  const grid = h('div', { class: 'shot-grid' }, SHOT_FIELDS.map((f) => {
    inputs[f.key] = h('input', { type: 'text', inputmode: f.signed ? 'text' : 'decimal', autocomplete: 'off', placeholder: f.hint ?? '', value: initial?.[f.key] != null ? show(f, initial[f.key]) : null });
    return h('label', { class: 'shot-field' }, h('span', {}, `${f.label} (${f.unit})`), inputs[f.key]);
  }));
  // 구질 화살표(골프존 화면 등)에서 읽거나 직접 고르는 방향. 각도·스핀 숫자가 있으면 숫자가 우선한다.
  const sidePick = (key, label) => {
    inputs[key] = h('select', {}, h('option', { value: '' }, '모름'),
      Object.entries(SIDE_WORDS[key]).sort((a, b) => a[0] - b[0]).map(([v, text]) => h('option', { value: v, selected: initial?.[key] != null && String(initial[key]) === v }, text)));
    return h('label', { class: 'shot-field' }, h('span', {}, label), inputs[key]);
  };
  grid.append(sidePick('startSide', '출발 방향 (화살표)'), sidePick('curveSide', '휘는 방향 (화살표)'));
  const file = h('input', { type: 'file', accept: 'image/*', onchange: async (e) => {
    const [img] = e.target.files; e.target.value = '';
    if (!img) return;
    msg.className = 'muted'; msg.textContent = '캡처 화면에서 숫자를 읽는 중…';
    try {
      const r = await readShotImage(img);
      for (const i of Object.values(inputs)) i.classList.remove('unsure');
      for (const [k, v] of Object.entries(r.values)) if (inputs[k]) inputs[k].value = v;
      for (const k of r.uncertain) inputs[k]?.classList.add('unsure');
      preview.replaceChildren(h('img', { class: 'shot-preview', src: URL.createObjectURL(img), alt: '캡처 화면' }));
      msg.className = !r.found ? 'bad' : r.uncertain.length ? 'warn-text' : 'muted';
      msg.textContent = !r.found ? '숫자를 찾지 못했습니다. 직접 입력해 주세요.'
        : r.uncertain.length ? `${r.found}개 값을 읽었습니다. 노란 테두리 칸은 인식이 불확실하니 아래 캡처와 비교해 고쳐 주세요.`
        : `${r.found}개 값을 읽었습니다. 아래 캡처와 같은지 한 번 확인해 주세요.`
          + (r.club && r.club !== state.club ? ` 캡처는 ${CLUBS[r.club]} 샷으로 보입니다. 위에서 고른 클럽(${CLUBS[state.club]})이 맞는지 확인하세요.` : '');
    } catch (err) { msg.className = 'bad'; msg.textContent = err.message; }
  } });
  const el = h('div', {}, h('label', { class: 'btn small' }, '캡처 화면에서 읽어 오기', file), msg, grid, preview);
  return {
    el,
    get: () => buildShot(Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]))),
    clear: () => { for (const i of Object.values(inputs)) { i.value = ''; i.classList.remove('unsure'); } preview.replaceChildren(); msg.textContent = ''; },
  };
}

/**
 * 결과 화면 맨 위의 종합 진단 카드.
 * 1) 핵심 패턴: 정면·측면의 지적을 묶어, 두 방향에서 함께 보이는 것을 앞세운다.
 * 2) 샷 데이터가 있으면 구질·탄도의 특징마다 관련 자세를 잇는다. 없으면 추가할 수 있다.
 */
function summarySection(s, issues, diag, onSaved) {
  const box = h('div', { class: 'card' });
  const club = clubOf(s);
  const nums = (list) => list.map((i) => h('span', { class: `num ${i.severity}` }, String(i.n)));
  const view = () => {
    const patterns = findPatterns(issues, new Set(diag ? diag.links.keys() : [])).slice(0, 3);
    const twoViews = partsOf(s).length > 1;
    const kids = [h('div', { class: 'muted' }, ['종합 진단', twoViews && '정면 + 측면', s.shot && '샷 데이터'].filter(Boolean).join(' · '))];
    if (diag?.name) kids.push(h('div', { class: 'shape' }, diag.name));
    if (s.shot) kids.push(h('div', { class: 'chips' }, SHOT_FIELDS.filter((f) => s.shot[f.key] != null).map((f) => h('span', { class: 'chip' }, f.label + ' ', h('b', {}, fmtShot(f, s.shot[f.key])))),
      smashFactor(s.shot) != null && h('span', { class: 'chip' }, '스매시 팩터 ', h('b', {}, smashFactor(s.shot).toFixed(2))),
      Object.keys(SIDE_WORDS).filter((k) => s.shot[k] != null).map((k) => h('span', { class: 'chip' }, '화살표 ', h('b', {}, SIDE_WORDS[k][s.shot[k]])))));

    if (patterns.length) {
      kids.push(h('h3', {}, '먼저 고칠 것'));
      patterns.forEach((p, k) => {
        const shotLabels = diag ? [...new Set(p.issues.flatMap((i) => diag.links.get(`${i.key}:${i.side}`) ?? []))] : [];
        kids.push(h('div', { class: 'finding' },
          h('div', { class: 'finding-head' }, `${k + 1}. ${p.title}`),
          h('div', { class: 'evidence' },
            p.both && h('span', { class: 'tag good' }, '정면·측면 모두에서 확인'),
            Object.keys(VIEWS).filter((v) => p.views.includes(v)).map((v) => h('span', { class: 'ev' }, VIEW_SHORT[v] + ' ', nums(p.issues.filter((i) => i.view === v))))),
          shotLabels.length > 0 && h('div', { class: 'impact' }, '이번 샷과 연결: ' + shotLabels.join(' · ')),
          h('div', { class: 'cue' }, '→ ' + p.advice)));
      });
    } else {
      kids.push(h('p', { class: 'ok' }, '✓ 기준과 큰 차이가 없습니다'));
    }

    if (diag) {
      kids.push(h('h3', {}, '샷으로 본 원인'));
      for (const f of diag.findings) {
        kids.push(h('div', { class: 'finding' },
          h('div', { class: 'finding-head' }, f.label),
          h('div', { class: 'muted' }, f.text),
          f.matched.length
            ? f.matched.map((m) => h('div', { class: `cause ${m.issue.severity}` },
                h('span', { class: 'num' }, String(m.issue.n)),
                h('div', {}, h('b', {}, `${VIEW_SHORT[m.issue.view]} · ${textFor(metricByKey[m.issue.key], m.issue.side, club).title}`), h('div', { class: 'why' }, m.why))))
            : Object.keys(f.causes).length > 0 && h('div', { class: 'muted' }, '영상에서는 이와 연결되는 자세 문제가 보이지 않습니다. 그립이나 클럽 페이스처럼 영상으로 볼 수 없는 요인일 수 있습니다.')));
      }
      if (diag.summary.length) kids.push(h('ul', {}, diag.summary.map((l) => h('li', {}, l))));
    }
    if (issues.length) kids.push(h('p', { class: 'muted' }, '번호는 아래 사진의 번호와 같습니다.' + (diag ? ' 자세와 구질의 연결은 흔히 함께 나타나는 조합을 근거로 한 추정이며, 그 자세를 고쳤을 때 구질이 달라지는지로 확인하세요.' : '')));
    if (!s.shot) kids.push(h('p', { class: 'muted' }, 'GDR 같은 론치 모니터의 캡처나 숫자를 넣으면 어떤 자세가 구질·발사각과 연결되는지도 함께 진단합니다.'));
    kids.push(h('button', { class: 'btn small', onclick: edit }, s.shot ? '샷 데이터 수정' : '샷 데이터 추가'));
    box.replaceChildren(h('div', {}, kids));
  };
  const edit = () => {
    const sf = shotForm(s.shot);
    box.replaceChildren(h('div', {}, h('h3', {}, '샷 데이터'), sf.el, h('div', { class: 'row' },
      h('button', { class: 'btn primary small', onclick: async () => {
        const { shot: _old, ...rest } = s;
        const shot = sf.get();
        onSaved(await db.put('sessions', shot ? { ...rest, shot } : rest));
      } }, '저장하고 다시 진단'),
      h('button', { class: 'btn small', onclick: view }, '취소'))));
  };
  view();
  return box;
}

/** 내장 기준이 어떤 데이터로 이뤄졌는지 항목별로 보여 준다. */
function basisExplainer(basis, view) {
  const rows = metricsForView(view).filter((m) => basis.stats[m.key]).map((m) => {
    const src = sourcesFor(m.key, 'low', { club: state.club, profile: basis.kind === 'published' ? state.profile : null }).basis;
    return { m, st: basis.stats[m.key], src };
  });
  const measured = rows.filter((r) => r.src).length;
  return h('details', { class: 'explain' }, h('summary', {}, '어떤 데이터를 기준으로 쓰나요?'),
    h('p', { class: 'muted' }, `${VIEWS[view]}·${CLUBS[state.club]} 기준 ${rows.length}개 항목 중 ${measured}개는 투어 프로를 3D 장비로 측정해 공개한 데이터이고, 나머지 ${rows.length - measured}개는 골프 레슨에서 일반적으로 가르치는 자세를 수치로 옮긴 값입니다(측정 데이터 아님). 이 앱으로 실제 영상을 재서 보정한 값은 아직 없습니다.`),
    h('table', {},
      h('tr', {}, h('th', {}, '항목'), h('th', {}, '기준'), h('th', {}, '근거')),
      rows.map(({ m, st, src }) => h('tr', {},
        h('td', {}, `${PHASES[m.phase]} · ${m.label}`),
        h('td', {}, `${fmt(m, st.mean)} ±${Math.max(m.floor, st.std).toFixed(m.digits)}`),
        h('td', {}, src ? extLink(src.url, '측정 데이터') : '레슨 기준')))),
    h('p', { class: 'muted' }, '측정 데이터 출처'),
    h('ul', {}, [...new Map(rows.filter((r) => r.src).map((r) => [r.src.url, r.src])).values()].map((x) => h('li', {}, extLink(x.url, x.label)))),
    h('p', { class: 'muted' }, '허용 범위(±)를 벗어나면 「주의」, 두 배 넘게 벗어나면 「교정 필요」로 표시합니다. 직접 등록한 기준 영상을 쓰려면 위에서 다른 기준을 고르세요.'));
}

// ───────── 분석 탭 ─────────
// 같은 스윙을 정면과 측면에서 찍은 영상, 그리고 샷 데이터를 한 번에 넣어 하나의 기록으로 분석한다.
// 어느 칸에 넣었는지로 촬영 방향을 정하므로 자동 인식이 틀려 방향이 뒤바뀌는 일이 없다.
async function renderAnalyze() {
  const allRefs = await db.getAll('refs');
  const out = h('div');
  const sf = shotForm();
  const picked = { faceon: null, dtl: null };
  const slotViews = Object.keys(VIEWS).filter((v) => !(state.club === 'putter' && v === 'dtl'));
  const basisOf = Object.fromEntries(slotViews.map((v) => [v, basisFor(allRefs, v, state.profile, state.club)]));

  const startBtn = h('button', { class: 'btn primary start', disabled: true, onclick: async () => {
    if (state.busy || !slotViews.some((v) => picked[v])) return;
    startBtn.disabled = true;
    await run();
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } }, '분석 시작');
  const status = {};
  const setPick = (view, file) => {
    picked[view] = file;
    status[view].textContent = file ? `선택됨: ${file.name}` : '선택 안 함';
    startBtn.disabled = !slotViews.some((v) => picked[v]);
  };

  const run = async () => {
    state.busy = true;
    const id = db.newId();
    const parts = [], errors = [];
    const todo = slotViews.filter((v) => picked[v]);
    for (const [n, view] of todo.entries()) {
      const file = picked[view];
      const pc = progressCard();
      out.replaceChildren(h('p', { class: 'muted' }, `${VIEWS[view]} 영상 분석 중 (${n + 1}/${todo.length}) · ${file.name}`), pc.el);
      try {
        const b = basisOf[view];
        const r = await processVideo(file, { ...state, view }, pc.update);
        const ev = evaluate(r.metrics, b.stats, view);
        const part = {
          view, name: file.name, metrics: r.metrics, times: r.times, thumbs: r.thumbs, shots: r.shots, pose: r.pose, warnings: r.warnings,
          score: ev.score, items: ev.items, basis: b.kind, refCount: pickRefs(allRefs, view, state.profile, state.club).length, hasVideo: false,
        };
        if (state.saveVideo) {
          try { await db.put('videos', { id: `${id}:${view}`, blob: file }); part.hasVideo = true; } catch { /* 공간 부족 시 영상만 생략 */ }
        }
        parts.push(part);
      } catch (e) {
        errors.push(`${VIEWS[view]} 영상 (${file.name}): ${e.message}`);
      }
    }
    state.busy = false;
    const errorBox = errors.length > 0 && h('div', { class: 'card err' }, h('p', {}, '분석하지 못한 영상'), h('ul', {}, errors.map((x) => h('li', {}, x))));
    if (!parts.length) {
      out.replaceChildren(errorBox);
      startBtn.disabled = false;
      return;
    }
    const scores = parts.map((p) => p.score).filter((v) => v != null);
    const session = {
      id, date: new Date().toISOString(), club: state.club, profile: state.profile, leftHanded: state.leftHanded, parts,
      score: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    };
    const shot = sf.get();
    if (shot) session.shot = shot;
    const saved = await db.put('sessions', session);
    for (const v of slotViews) setPick(v, null);
    sf.clear();
    out.replaceChildren(...[errorBox, await resultView(saved)].filter(Boolean));
  };

  const slot = (view, n) => {
    const b = basisOf[view];
    status[view] = h('p', { class: 'muted' }, '선택 안 함');
    return h('div', { class: 'card' },
      h('h3', {}, `${n} ${VIEWS[view]} 영상`),
      b.kind === 'none'
        ? [h('p', { class: 'muted' }, `「${state.profile}」에는 ${VIEWS[view]} 기준이 없습니다. 기준 스윙 영상을 등록하거나 「정석 폼」 기준을 선택하세요.`),
           h('button', { class: 'btn small', onclick: () => { state.view = view; savePrefs(); go('refs'); } }, '기준 영상 등록하러 가기')]
        : [h('p', { class: 'muted' }, view === 'faceon' ? '몸 정면에서 찍은 영상입니다.' : '타깃 반대편 뒤에서 찍은 영상입니다.'),
           h('div', { class: 'row' },
             filePicker('영상 선택', { onFiles: ([f]) => setPick(view, f) }),
             h('button', { class: 'btn small', onclick: () => setPick(view, null) }, '지우기')),
           status[view],
           (b.kind === 'textbook' || b.kind === 'published') && basisExplainer(b, view)]);
  };
  const usable = slotViews.some((v) => basisOf[v].kind !== 'none');

  mount(
    h('h2', {}, '내 스윙 분석'),
    clubPicker(render),
    profilePicker(allRefs, render),
    check('왼손잡이 스윙', 'leftHanded'),
    check('슬로모션으로 찍은 영상', 'slowmo'),
    h('p', { class: 'muted' }, '느리게 재생되도록 찍은 영상일 때만 켜세요. 켜면 템포(백스윙·다운스윙 시간 비율)를 분석에서 뺍니다. 일반 속도 영상은 끈 채로 두세요.'),
    check('영상 원본도 이 기기에 저장 (기록에서 다시 보기)', 'saveVideo'),
    h('p', { class: 'muted' }, '같은 스윙을 정면과 측면에서 찍은 영상, 그리고 그 샷의 데이터를 함께 넣으면 하나로 묶어 진단합니다. 영상은 한쪽만 있어도 됩니다.'),
    slot('faceon', '①'),
    state.club === 'putter'
      ? h('div', { class: 'card' }, h('h3', {}, '② 측면 영상'), h('p', { class: 'muted' }, '퍼팅은 측면에서 퍼터의 움직임이 화면에 거의 드러나지 않아 정면 영상만 분석합니다.'))
      : slot('dtl', '②'),
    usable && h('div', { class: 'card' },
      h('h3', {}, '③ 샷 데이터 (선택)'),
      h('p', { class: 'muted' }, 'GDR 캡처를 올리거나 숫자를 직접 넣으면 자세와 구질을 함께 진단합니다. 없으면 비워 두세요.'), sf.el),
    usable && startBtn,
    out,
  );
}

/** 구간 사진 한 장. item이 있으면 그 문제 하나만 표시한다. 누르면 크게 본다. */
function shotCanvas(part, phase, item, leftHanded) {
  const canvas = h('canvas', { class: 'shot', onclick: (e) => e.target.closest('.phase')?.classList.toggle('zoom') });
  const m = item && metricByKey[item.key];
  const img = new Image();
  img.onload = () => drawShot(canvas, img, part.pose, phase, item, {
    leftHanded,
    fmtValue: (v) => (m ? v.toFixed(m.digits) + (m.unit === '°' ? '°' : '') : String(Math.round(v))),
  });
  img.src = part.shots[phase];
  return canvas;
}

/** 사진 옆에 붙는 메모 한 건: 무엇이 문제인지와 어떻게 할지 한 줄씩, 그리고 출처·참고 영상 링크. 긴 설명은 접어 둔다. */
function noteItem(s, i, diag = null) {
  const m = metricByKey[i.key];
  if (!m) return null;
  const club = clubOf(s), profile = profileOf(s);
  const t = textFor(m, i.side, club);
  const lesson = club === 'approach' || club === 'putter' ? searchLink(`골프 ${CLUBS[club]} ${t.cue} 레슨`) : lessonLink(i.key, i.side);
  const src = sourcesFor(i.key, i.side, { club, profile: i.basis === 'published' ? profile : null });
  return h('div', { class: `note ${i.severity}` },
    h('div', { class: 'note-head' }, h('span', { class: 'num' }, String(i.n)), h('b', {}, t.title)),
    h('div', { class: 'cue' }, '→ ' + t.cue),
    diag?.links.get(`${i.key}:${i.side}`) && h('div', { class: 'impact' }, '이번 샷: ' + diag.links.get(`${i.key}:${i.side}`).join(' · ')),
    h('div', { class: 'refs' },
      lesson && extLink(lesson, '▶ 참고 영상'),
      src.fault && extLink(src.fault.url, '출처: ' + src.fault.label),
      src.basis && extLink(src.basis.url, '기준 데이터: ' + src.basis.label),
      profile !== DEFAULT_PROFILE && !isBuiltin(profile) && extLink(playerLink(profile, i.view), `▶ ${profile} 스윙`)),
    h('details', {}, h('summary', {}, '자세히'),
      h('p', { class: 'nums' }, m.label, ': 내 값 ', h('b', {}, fmt(m, i.value)), ' · 기준 ', h('b', {}, fmt(m, i.mean)), ` (±${i.tol.toFixed(m.digits)})`),
      h('p', {}, h('b', {}, '왜 문제인가 '), t.why),
      h('p', {}, h('b', {}, '교정 '), t.fix),
      t.drill && h('p', {}, h('b', {}, '연습법 '), t.drill),
      h('p', { class: 'nums' }, '기준값 근거: ', src.basis ? extLink(src.basis.url, src.basis.label) : (i.basis === 'refs' ? '등록한 기준 영상의 측정값' : '일반적인 레슨 기준 (측정 데이터 아님)'))));
}

/** 기록의 모든 지적을 화면에 나오는 순서(정면 -> 측면, 어드레스 -> 피니시, 차이가 큰 순)로 번호를 매겨 모은다. */
function collectIssues(s) {
  const order = (i) => { const k = PHASE_KEYS.indexOf(PHASE_OF[i.key]); return k < 0 ? PHASE_KEYS.length : k; };
  const seen = new Set();
  const out = [];
  for (const part of partsOf(s)) {
    const list = part.items.filter((i) => i.severity !== 'good' && !seen.has(i.key)) // 템포처럼 두 영상에 모두 있는 항목은 한 번만
      .sort((a, b) => order(a) - order(b) || Math.abs(b.z) - Math.abs(a.z));
    for (const i of list) {
      seen.add(i.key);
      out.push({ ...i, n: out.length + 1, view: part.view, basis: part.basis });
    }
  }
  return out;
}

async function resultView(s) {
  const profile = profileOf(s), club = clubOf(s);
  const parts = partsOf(s);
  const viewsKey = (x) => partsOf(x).map((p) => p.view).join('+');
  // 직전 기록과의 비교는 같은 조합(정면만 / 측면만 / 둘 다)끼리만 한다
  const prev = (await db.getAll('sessions')).filter((x) => viewsKey(x) === viewsKey(s) && profileOf(x) === profile && clubOf(x) === club && x.date < s.date && x.score != null).sort(byDate).pop();
  const issues = collectIssues(s);
  const basisKinds = [...new Set(parts.map((p) => p.basis ?? (isBuiltin(profile) ? 'textbook' : 'refs')))];

  const el = h('div', {},
    h('div', { class: 'card' },
      h('div', { class: 'summary-head' },
        h('div', { class: 'score ring', style: `--p:${s.score ?? 0}` }, h('div', {}, h('b', {}, String(s.score ?? '-')), h('small', {}, '100점 만점'))),
        h('div', { class: 'grow' },
          h('div', { class: 'muted' }, `${fmtDateTime(s.date)}`),
          h('div', {}, h('b', {}, `${CLUBS[club]} · ${parts.map((p) => VIEW_SHORT[p.view]).join(' + ')}`)),
          h('div', { class: 'muted' }, `기준 ${profile}` + (parts.length > 1 ? ` · ${parts.map((p) => `${VIEW_SHORT[p.view]} ${p.score ?? '-'}점`).join(' · ')}` : '')),
          prev && s.score != null && h('div', { class: 'muted' }, `직전(${fmtDate(prev.date)}) 대비 ${s.score - prev.score >= 0 ? '+' : ''}${s.score - prev.score}점`),
          h('div', { class: 'tags' }, h('span', { class: 'tag major' }, `교정 필요 ${issues.filter((i) => i.severity === 'major').length}`), h('span', { class: 'tag minor' }, `주의 ${issues.filter((i) => i.severity === 'minor').length}`)))),
      h('details', {}, h('summary', {}, '점수의 의미'),
        basisKinds.map((kind) => h('p', { class: 'muted' }, kind === 'textbook'
          ? '투어 프로 공개 데이터와 일반적인 레슨 기준(정석 폼)에 얼마나 가까운지를 뜻합니다. 영상으로 보정한 기준이 아니므로, 점수 자체보다 크게 벗어난 항목과 시간에 따른 변화를 보세요.'
          : kind === 'published'
          ? `「${profile}」의 공개된 측정 수치(일부 항목)와 투어 프로 일반 기준에 얼마나 가까운지를 뜻합니다. 선수의 영상을 직접 분석한 기준은 아닙니다.`
          : `「${profile}」에 등록한 기준 영상과 얼마나 비슷한지를 뜻하며, 스윙의 절대적인 좋고 나쁨이 아닙니다.`)),
        parts.length > 1 && h('p', { class: 'muted' }, '전체 점수는 정면과 측면 점수의 평균입니다.'))),
    parts.flatMap((p) => (p.warnings ?? []).map((w) => h('div', { class: 'card warn' }, `${VIEWS[p.view]} 영상: ${w}`))),
  );

  const diag = s.shot ? diagnose(s.shot, issues, { club, leftHanded: s.leftHanded }) : null;
  el.append(summarySection(s, issues, diag, async (next) => el.replaceWith(await resultView(next))));

  el.append(h('p', { class: 'legend' }, h('span', { class: 'lg mine' }), '지금 내 자세 ', h('span', { class: 'lg goal' }), '목표 ', '➜ 옮길 방향 · 사진을 누르면 커집니다'));
  for (const part of parts) {
    const mine = issues.filter((i) => i.view === part.view);
    el.append(h('h2', {}, `${VIEWS[part.view]} 영상`, parts.length > 1 && h('span', { class: 'muted' }, ` ${part.score ?? '-'}점`)));
    if (part.hasVideo) {
      const holder = h('div', { class: 'card' }, h('button', { class: 'btn', onclick: async () => {
        const v = await db.get('videos', part.videoKey ?? `${s.id}:${part.view}`);
        holder.replaceChildren(v
          ? h('video', { class: 'replay', controls: true, playsinline: true, src: URL.createObjectURL(v.blob) })
          : h('p', { class: 'muted' }, '영상 원본은 촬영한 기기에만 저장되어 있습니다.'));
      } }, '영상 다시 보기'));
      el.append(holder);
    }
    if (part.shots && part.pose) {
      for (const phase of PHASE_KEYS) {
        const items = mine.filter((i) => PHASE_OF[i.key] === phase);
        el.append(h('h3', { class: 'phase-title' }, PHASES[phase], items.length ? h('span', { class: 'muted' }, ` 교정 ${items.length}가지`) : h('span', { class: 'ok' }, ' ✓ 기준과 비슷합니다')));
        if (!items.length) el.append(h('div', { class: 'card phase small' }, h('div', { class: 'shot-wrap' }, shotCanvas(part, phase, null, s.leftHanded)), h('div', { class: 'notes muted' }, '골격선이 몸 위에 잘 놓였는지 확인하세요.')));
        // 사진 한 장에 문제 하나씩
        for (const i of items) el.append(h('div', { class: 'card phase' }, h('div', { class: 'shot-wrap' }, shotCanvas(part, phase, i, s.leftHanded)), h('div', { class: 'notes' }, noteItem(s, i, diag))));
      }
      const rest = mine.filter((i) => !PHASE_OF[i.key]);
      if (rest.length) el.append(h('h3', { class: 'phase-title' }, '리듬'), h('div', { class: 'card' }, h('div', { class: 'notes' }, rest.map((i) => noteItem(s, i, diag)))));
    } else {
      // 사진 좌표가 저장되지 않은 예전 기록
      el.append(
        h('div', { class: 'card' }, h('div', { class: 'thumbs' }, PHASE_KEYS.map((k) => h('figure', {}, h('img', { src: part.thumbs[k], alt: PHASES[k] }), PHASES[k])))),
        mine.length > 0 && h('div', { class: 'card' }, h('div', { class: 'notes' }, mine.map((i) => noteItem(s, i, diag)))),
        h('p', { class: 'muted' }, '이 기록은 예전 방식으로 저장되어 사진 위 표시가 없습니다. 영상을 다시 분석하면 사진과 함께 볼 수 있습니다.'));
    }
  }
  el.append(h('p', { class: 'muted' }, '골격선이 몸에서 벗어나 있거나 사진이 실제 구간과 다르면 그 구간의 지적은 믿지 마세요.'));

  el.append(h('details', { class: 'card' }, h('summary', {}, '전체 측정값 보기'), h('table', {},
    h('tr', {}, h('th', {}, '항목'), h('th', {}, '내 값'), h('th', {}, '기준')),
    parts.flatMap((part) => part.items.map((i) => {
      const m = metricByKey[i.key];
      return m && h('tr', {}, h('td', {}, h('span', { class: `dot ${i.severity}` }), `${parts.length > 1 ? VIEW_SHORT[part.view] + ' · ' : ''}${PHASES[m.phase]} · ${m.label}`), h('td', {}, fmt(m, i.value)), h('td', {}, fmt(m, i.mean)));
    })))));
  return el;
}

// ───────── 기준 영상 탭 ─────────
async function renderRefs() {
  const allRefs = await db.getAll('refs');
  const refs = pickRefs(allRefs, state.view, state.profile, state.club);
  const basis = basisFor(allRefs, state.view, state.profile, state.club);
  const stats = basis.stats;
  const statsTable = (title, devLabel) => h('div', {}, h('h3', {}, title), h('div', { class: 'card' }, h('table', {},
    h('tr', {}, h('th', {}, '항목'), h('th', {}, '기준'), h('th', {}, devLabel)),
    metricsForView(state.view).filter((m) => stats[m.key]).map((m) =>
      h('tr', {}, h('td', {}, `${PHASES[m.phase]} · ${m.label}`), h('td', {}, fmt(m, stats[m.key].mean)), h('td', {}, stats[m.key].n > 1 ? '±' + Math.max(m.floor, stats[m.key].std).toFixed(m.digits) : '-'))))));
  if (isBuiltin(state.profile)) {
    return mount(
      h('h2', {}, '기준 영상'),
      viewPicker(render), clubPicker(render),
      profilePicker(allRefs, render),
      h('div', { class: 'card' },
        h('p', {}, '「정석 폼」은 앱에 내장된 기준이라 영상을 등록할 필요가 없습니다.'),
        h('p', { class: 'muted' }, '투어 프로를 3D 장비로 측정해 공개한 데이터와, 골프 레슨에서 일반적으로 가르치는 자세를 수치로 옮긴 값입니다. 위에서 고른 클럽 종류에 맞는 기준값이 쓰입니다.'),
        h('p', { class: 'muted' }, '특정 선수나 내 베스트 스윙을 기준으로 삼고 싶다면 위에서 다른 프로파일을 고르고 영상을 등록하세요.'),
        h('button', { class: 'btn primary', onclick: () => go('analyze') }, '바로 분석하러 가기')),
      statsTable(`「정석 폼」 ${VIEWS[state.view]} 기준값`, '허용 범위'),
      sourceList());
  }
  const out = h('div');
  const add = async (files) => {
    state.busy = true;
    const errors = [];
    const target = { view: state.view, club: state.club, profile: state.profile, leftHanded: state.leftHanded, slowmo: state.slowmo };
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
    viewPicker(render), clubPicker(render),
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
    basis.kind === 'published' && [
      h('div', { class: 'card' }, h('p', {}, '영상을 등록하지 않아도 공개된 측정 수치로 바로 분석할 수 있습니다.'), h('p', { class: 'muted' }, basis.note + ' 영상을 등록하면 그 영상에서 잰 값이 대신 쓰입니다.')),
      statsTable('공개 수치 + 투어 기준값', '허용 범위'),
      sourceList(),
    ],
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
  if (band) el.append(svg('rect', { x: L, y: y(band.hi), width: W - L - R, height: Math.max(1, y(band.lo) - y(band.hi)), fill: 'var(--accent)', opacity: 0.14 }));
  for (const v of [lo, (lo + hi) / 2, hi]) {
    el.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: 'var(--line)', 'stroke-width': 1 }));
    el.append(svg('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--muted)' }, format(v)));
  }
  if (points.length > 1) el.append(svg('polyline', { points: points.map((p, i) => `${x(i)},${y(p.v)}`).join(' '), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2 }));
  points.forEach((p, i) => el.append(svg('circle', { cx: x(i), cy: y(p.v), r: 3.5, fill: 'var(--accent)' })));
  el.append(svg('text', { x: L, y: H - 6, 'font-size': 10, fill: 'var(--muted)' }, points[0].label));
  if (points.length > 1) el.append(svg('text', { x: W - R, y: H - 6, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--muted)' }, points.at(-1).label));
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
            await deleteSession(s); state.detail = null; render();
          } }, '기록 삭제')),
        await resultView(s));
      return;
    }
    state.detail = null;
  }

  const allRefs = await db.getAll('refs');
  // 정면·측면을 가리지 않고 같은 클럽·같은 기준의 기록을 모두 보여 준다
  const sessions = (await db.getAll('sessions')).filter((s) => profileOf(s) === state.profile && clubOf(s) === state.club).sort(byDate);
  const statsOf = Object.fromEntries(Object.keys(VIEWS).map((v) => [v, basisFor(allRefs, v, state.profile, state.club).stats]));
  const valueOf = (s, key) => partsOf(s).map((p) => p.metrics[key]).find((v) => Number.isFinite(v));
  const trendMetrics = [...new Map(Object.keys(VIEWS).flatMap((v) => metricsForView(v).map((m) => [m.key, { m, view: v }]))).values()]
    .filter(({ m }) => sessions.some((s) => valueOf(s, m.key) != null));
  const scored = sessions.filter((s) => s.score != null);
  const metricBox = h('div');
  // 샷 데이터는 촬영 방향이나 기준과 무관하므로 같은 클럽의 모든 기록을 모아 본다
  const allShots = (await db.getAll('sessions')).filter((s) => s.shot);
  const shots = allShots.filter((s) => clubOf(s) === state.club).sort(byDate);
  const SHOT_SERIES = [
    ...SHOT_FIELDS.map((f) => ({ key: f.key, label: `${f.label} (${f.unit})`, get: (s) => s.shot[f.key], note: f.signed ? '오른쪽 +, 왼쪽 −. 0에 가까울수록 똑바릅니다.' : '' })),
    { key: 'sidePct', label: '방향 편차 (캐리 대비 %)', get: (s) => sidePercent(s.shot), note: '좌우로 벗어난 거리 ÷ 캐리. 작을수록 정확합니다.' },
    { key: 'smash', label: '스매시 팩터 (볼 ÷ 헤드 스피드)', get: (s) => smashFactor(s.shot), note: '클수록 정타에 가깝습니다. 드라이버는 1.45 안팎이 잘 맞은 샷입니다.' },
  ];
  const shotBox = h('div');
  const shotSelect = h('select', { class: 'shot-select', onchange: () => drawShotTrend() }, SHOT_SERIES.map((x) => h('option', { value: x.key }, x.label)));
  function drawShotTrend() {
    const x = SHOT_SERIES.find((q) => q.key === shotSelect.value);
    const pts = shots.filter((s) => x.get(s) != null).map((s) => ({ v: x.get(s), label: fmtDate(s.date) }));
    if (!pts.length) return shotBox.replaceChildren(h('p', { class: 'muted' }, '이 항목은 기록이 없습니다.'));
    const f1 = (v) => v.toFixed(x.key === 'smash' ? 2 : Math.abs(v) < 100 ? 1 : 0);
    const avg = pts.reduce((t, p) => t + p.v, 0) / pts.length;
    shotBox.replaceChildren(trendChart(pts, { format: f1 }),
      h('p', { class: 'muted' }, pts.length > 1 ? `첫 기록 ${f1(pts[0].v)} → 최근 ${f1(pts.at(-1).v)} · 평균 ${f1(avg)} (${pts.length}회)` : `${f1(pts[0].v)} (1회). 기록이 쌓이면 추이가 보입니다.`),
      x.note && h('p', { class: 'muted' }, x.note));
  }
  const select = h('select', { onchange: () => drawMetric() },
    trendMetrics.map(({ m, view }) => h('option', { value: m.key }, `${m.key === 'tempo' ? '' : VIEW_SHORT[view] + ' · '}${PHASES[m.phase]} · ${m.label}`)));
  function drawMetric() {
    const m = metricByKey[select.value];
    if (!m) return metricBox.replaceChildren(h('p', { class: 'muted' }, '데이터가 없습니다.'));
    const pts = sessions.filter((s) => valueOf(s, m.key) != null).map((s) => ({ v: valueOf(s, m.key), label: fmtDate(s.date) }));
    if (!pts.length) return metricBox.replaceChildren(h('p', { class: 'muted' }, '데이터가 없습니다.'));
    const st = statsOf[m.views[0]][m.key];
    const tol = st && Math.max(m.floor, st.n >= 3 ? st.std : 0);
    metricBox.replaceChildren(
      trendChart(pts, { band: st && { lo: st.mean - tol, hi: st.mean + tol }, format: (v) => v.toFixed(m.digits) }),
      h('p', { class: 'muted' }, st ? `초록 띠가 기준 범위(${fmt(m, st.mean)} ±${tol.toFixed(m.digits)})입니다. 점이 띠 안으로 들어올수록 기준에 가까워진 것입니다.` : '기준 영상이 없어 범위를 표시할 수 없습니다.'));
  }

  /** 누적 요약 카드: 여러 기록에 걸쳐 되풀이되는 패턴을 모아 먼저 고칠 것을 고른다. */
  function priorityCard() {
    const all = summarizeHistory(sessions.map((s) => ({ id: s.id, views: partsOf(s).map((p) => p.view), issues: collectIssues(s) })));
    const todo = all.filter((x) => x.status !== 'improving').slice(0, 3);
    const better = all.filter((x) => x.status === 'improving').slice(0, 2);
    const STATUS = { persistent: ['계속 나타남', 'major'], new: ['최근 생김', 'minor'], sometimes: ['가끔 나타남', ''] };
    // 가장 자주 나온 구질
    const names = shots.map((s) => analyzeShot(s.shot, { club: clubOf(s), leftHanded: s.leftHanded }).name).filter(Boolean);
    const tally = Object.entries(names.reduce((m, n) => ({ ...m, [n]: (m[n] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1])[0];
    return h('div', { class: 'card' },
      h('div', { class: 'muted' }, `누적 ${sessions.length}회 기록 기준 · ${CLUBS[state.club]}`),
      h('h3', {}, '먼저 고칠 것'),
      todo.length
        ? todo.map((x, k) => {
            // 대표 사진: 이 패턴이 가장 최근에 나타난 기록에서, 차이가 가장 큰 지적의 구간 사진
            const rec = sessions.find((q) => q.id === x.lastId);
            const pick = rec && x.lastIssues.map((i) => ({ i, part: partsOf(rec).find((p) => p.view === i.view) }))
              .find(({ i, part }) => PHASE_OF[i.key] && part?.shots && part?.pose);
            const open = () => { state.detail = x.lastId; render(); };
            return h('div', { class: 'finding' },
              h('div', { class: 'finding-head' }, `${k + 1}. ${x.title}`),
              h('div', { class: 'evidence' },
                h('span', { class: 'tag ' + STATUS[x.status][1] }, STATUS[x.status][0]),
                h('span', { class: 'marks', title: '기록마다 나타났는지(오른쪽이 최근)' }, x.marks.map((m) => h('i', { class: m ? 'on' : '' }))),
                `${x.total}회 중 ${x.count}회`),
              h('div', { class: 'phase rep' },
                pick && h('div', { class: 'shot-wrap' }, shotCanvas(pick.part, PHASE_OF[pick.i.key], pick.i, rec.leftHanded)),
                h('div', { class: 'notes' },
                  h('div', { class: 'cue' }, '→ ' + x.advice),
                  pick && h('div', { class: 'muted' }, `사진: ${fmtDate(rec.date)} ${VIEW_SHORT[pick.i.view]} ${PHASES[PHASE_OF[pick.i.key]]} · ${textFor(metricByKey[pick.i.key], pick.i.side, clubOf(rec)).title}`),
                  x.lastId && h('button', { class: 'btn small', onclick: open }, '이 기록 보기'))));
          })
        : h('p', { class: 'ok' }, '✓ 되풀이되는 문제가 없습니다'),
      better.length > 0 && h('div', { class: 'finding' }, h('div', { class: 'muted' }, '좋아지고 있는 것'),
        better.map((x) => h('p', { class: 'ok' }, `✓ ${x.title} · 최근 ${x.recentN}회 중 ${x.recentCount}회`))),
      tally && h('p', { class: 'muted' }, `가장 자주 나온 구질: ${tally[0]} (샷 기록 ${names.length}회 중 ${tally[1]}회)`),
      h('p', { class: 'muted' }, sessions.length < 3
        ? '기록이 3회 미만이라 한두 번의 스윙에 좌우됩니다. 기록이 쌓일수록 믿을 만해집니다.'
        : '점은 기록마다 그 문제가 나타났는지를 뜻합니다(오른쪽이 최근). 사진은 그 문제가 가장 최근에 나타난 기록의 것이며, 누르면 커집니다.'));
  }

  /** 샷 추이 카드: 핵심 지표가 처음보다 나아졌는지 한눈에 보여 주고, 항목별 그래프는 펼쳐서 본다. */
  function shotCard() {
    const title = h('h3', {}, `샷 추이 · ${CLUBS[state.club]}`);
    if (!shots.length) {
      const others = Object.entries(CLUBS).map(([k, label]) => [label, allShots.filter((s) => clubOf(s) === k).length]).filter(([, n]) => n > 0);
      return h('div', { class: 'card' }, title,
        h('p', { class: 'muted' }, `${CLUBS[state.club]}로 기록한 샷 데이터가 아직 없습니다. 분석 탭에서 「② 샷 데이터」에 캡처나 숫자를 넣고 분석하면 여기에 쌓입니다. 영상을 여러 개 한 번에 분석할 때는 샷 데이터가 붙지 않습니다.`),
        others.length > 0 && h('p', { class: 'muted' }, '다른 클럽의 샷 기록: ' + others.map(([label, n]) => `${label} ${n}회`).join(', ') + '. 위에서 클럽을 바꾸면 보입니다.'));
    }
    const f1 = (v) => v.toFixed(Math.abs(v) < 100 ? 1 : 0);
    const avg = (a) => a.reduce((t, v) => t + v, 0) / a.length;
    const tile = ({ key, label, unit, better }) => {
      const vals = shots.map((s) => SHOT_SERIES.find((q) => q.key === key).get(s)).filter((v) => v != null);
      if (!vals.length) return h('div', { class: 'tile' }, h('div', { class: 'muted' }, label), h('div', { class: 'tile-num' }, '-'));
      // 한 번의 샷은 편차가 크므로, 기록이 4회 이상이면 최근 몇 회 평균과 처음 몇 회 평균을 비교한다
      const k = vals.length >= 4 ? Math.min(3, Math.floor(vals.length / 2)) : 1;
      const now = avg(vals.slice(-k)), before = avg(vals.slice(0, k)), d = now - before;
      const flat = vals.length < 2 || Math.abs(d) < 1e-9;
      const good = better === 'up' ? d > 0 : d < 0;
      const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
      const xy = vals.map((v, i) => [vals.length === 1 ? 50 : 4 + (i / (vals.length - 1)) * 92, 26 - ((v - lo) / span) * 22]);
      const spark = svg('svg', { viewBox: '0 0 100 30', class: 'spark', role: 'img' });
      if (xy.length > 1) spark.append(svg('polyline', { points: xy.map((q) => q.join(',')).join(' '), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }));
      spark.append(svg('circle', { cx: xy.at(-1)[0], cy: xy.at(-1)[1], r: 2.4, fill: 'var(--accent)' }));
      return h('div', { class: 'tile' },
        h('div', { class: 'muted' }, label + (k > 1 ? ` · 최근 ${k}회 평균` : ' · 최근')),
        h('div', { class: 'tile-num' }, f1(now), h('small', {}, unit)),
        h('div', { class: 'delta ' + (flat ? 'flat' : good ? 'good' : 'bad') },
          vals.length < 2 ? '첫 기록' : flat ? '변화 없음' : `${d > 0 ? '▲' : '▼'} ${f1(Math.abs(d))}${unit} ${good ? '좋아짐' : '나빠짐'}`),
        spark);
    };
    return h('div', { class: 'card' }, title,
      h('p', { class: 'muted' }, `${shots.length}회 기록 · 처음 기록과 비교한 변화입니다. 촬영 방향과 관계없이 이 클럽의 모든 샷을 모읍니다.`),
      h('div', { class: 'tiles' }, [
        { key: 'carry', label: '캐리', unit: 'm', better: 'up' },
        { key: 'total', label: '비거리', unit: 'm', better: 'up' },
        { key: 'ballSpeed', label: '볼 스피드', unit: 'm/s', better: 'up' },
        { key: 'sidePct', label: '방향 편차', unit: '%', better: 'down' },
      ].map(tile)),
      h('p', { class: 'muted' }, '방향 편차는 좌우로 벗어난 거리 ÷ 캐리이며 작을수록 좋습니다.'),
      h('details', {}, h('summary', {}, '항목별 그래프 보기 (발사각, 스핀 등)'), shotSelect, shotBox));
  }

  mount(
    h('h2', {}, '분석 기록과 발전 추이'),
    clubPicker(render),
    profilePicker(allRefs, render),
    sessions.length === 0 && h('p', { class: 'muted' }, `「${state.profile}」 기준의 ${CLUBS[state.club]} 분석 기록이 아직 없습니다.`),
    sessions.length > 0 && priorityCard(),
    sessions.length > 0 && [
      h('div', { class: 'card' }, h('h3', {}, '점수 추이'),
        scored.length ? trendChart(scored.map((s) => ({ v: s.score, label: fmtDate(s.date) })), { min: 0, max: 100 }) : h('p', { class: 'muted' }, '데이터가 없습니다.'),
        scored.length > 1 && h('p', { class: 'muted' }, `첫 분석 ${scored[0].score}점 → 최근 ${scored.at(-1).score}점`)),
    ],
    shotCard(),
    sessions.length > 0 && [
      h('div', { class: 'card' }, h('h3', {}, '자세 항목별 추이'), select, metricBox),
      h('div', { class: 'card' }, [...sessions].reverse().map((s) => h('div', { class: 'item', onclick: () => { state.detail = s.id; render(); } },
        h('img', { src: partsOf(s)[0].thumbs?.impact, alt: '' }),
        h('div', { class: 'grow' }, h('div', {}, `${fmtDateTime(s.date)} · ${partsOf(s).map((p) => VIEW_SHORT[p.view]).join('+')}`),
          h('div', { class: 'muted' }, (() => { const all = collectIssues(s); return `교정 필요 ${all.filter((i) => i.severity === 'major').length} · 주의 ${all.filter((i) => i.severity === 'minor').length}${partsOf(s).some((p) => p.hasVideo) ? ' · 영상 저장됨' : ''}`; })()),
          s.shot && h('div', { class: 'muted' }, [analyzeShot(s.shot, { club: clubOf(s), leftHanded: s.leftHanded }).name, s.shot.carry != null && `캐리 ${s.shot.carry}m`, s.shot.side != null && fmtShot(SHOT_FIELDS[2], s.shot.side)].filter(Boolean).join(' · '))),
        h('div', { class: 'big' }, String(s.score ?? '-'))))),
    ],
  );
  if (sessions.length) drawMetric();
  if (shots.length) drawShotTrend();
}

// ───────── 설정 탭 ─────────
function syncStatusText() {
  const st = sync.status;
  if (st.state === 'syncing') return '동기화 중…';
  if (st.state === 'pending') return '가입 요청을 보냈습니다. 관리자가 승인하면 동기화가 시작됩니다. 그때까지 기록은 이 기기에만 저장됩니다.';
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
  state.onSyncStatus = () => { statusEl.textContent = syncStatusText(); statusEl.className = sync.status.state === 'error' ? 'bad' : sync.status.state === 'pending' ? 'warn-text' : 'muted'; };
  state.onSyncStatus();
  card.append(
    h('p', {}, `${user.email} 계정으로 로그인됨`), statusEl,
    h('p', { class: 'muted' }, '분석하거나 삭제하면 자동으로 동기화됩니다. 영상 원본은 동기화되지 않습니다.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => sync.syncNow() }, '지금 동기화'),
      h('button', { class: 'btn small', onclick: async () => { await sync.signOut(); render(); } }, '로그아웃')));
  if (sync.status.isAdmin) card.append(await membersBox());
  return card;
}

/** 관리자용: 가입 요청 승인. 승인된 계정만 서버에 기록을 저장할 수 있다. */
async function membersBox() {
  const box = h('div', { class: 'members' });
  const draw = async () => {
    let members;
    try {
      members = await sync.listMembers();
    } catch (e) {
      return box.replaceChildren(h('p', { class: 'bad' }, '가입 목록을 불러오지 못했습니다: ' + e.message));
    }
    const act = (m, approved, label, cls) => h('button', { class: 'btn small ' + cls, onclick: async (e) => {
      e.target.disabled = true;
      try { await sync.setApproved(m.user_id, approved); } catch (err) { alert(err.message); }
      draw();
    } }, label);
    const row = (m, button) => h('div', { class: 'item' },
      h('div', { class: 'grow' }, h('div', {}, m.email || '(이메일 없음)'), h('div', { class: 'muted' }, `${fmtDateTime(m.requested_at)} 가입`)), button);
    const pending = members.filter((m) => !m.approved), approved = members.filter((m) => m.approved);
    box.replaceChildren(h('div', {},
      h('h3', {}, `가입 요청 ${pending.length}건`),
      pending.length ? pending.map((m) => row(m, act(m, true, '승인', 'primary'))) : h('p', { class: 'muted' }, '승인을 기다리는 요청이 없습니다.'),
      h('details', {}, h('summary', {}, `승인된 계정 ${approved.length}개`),
        approved.map((m) => row(m, m.is_admin ? h('span', { class: 'tag good' }, '관리자') : act(m, false, '승인 취소', 'danger'))))));
  };
  await draw();
  return box;
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
    h('p', { class: 'muted' }, `앱 버전 v${VERSION}. 새 기능이 안 보이면 이 번호가 안내받은 번호와 같은지 확인하고, 다르면 잠시 뒤 새로고침하세요.`),
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
document.getElementById('theme')?.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  document.querySelector('meta[name=theme-color]').content = next === 'dark' ? '#0a0a0b' : '#f4f4f5';
  try { localStorage.setItem('golform-theme', next); } catch { /* 저장이 막힌 환경에서는 이번 방문에만 적용 */ }
});
tabs.addEventListener('click', (e) => { const t = e.target.closest('button')?.dataset.tab; if (t) go(t); });
window.addEventListener('golform-sync', (e) => {
  state.onSyncStatus?.();
  // 승인을 기다리는 가입 요청이 있으면 설정 탭에 표시한다
  tabs.querySelector('[data-tab=settings]')?.classList.toggle('has-badge', sync.status.pending > 0);
  // 다른 기기의 기록이 내려왔으면 목록을 다시 그린다(입력 중인 설정 화면과 분석 중인 화면은 건드리지 않는다)
  if (e.detail?.changed && !state.busy && state.tab !== 'settings' && !state.detail) render();
});
navigator.storage?.persist?.().catch(() => {});
document.querySelector('header .sub')?.append(` · v${VERSION}`);
sync.init();
// 기준 영상이 하나도 없는 프로파일이 선택돼 있으면 바로 쓸 수 있는 내장 기준으로 시작한다
db.getAll('refs').then((all) => {
  if (!isBuiltin(state.profile) && !publishedStats(state.profile) && !all.some((r) => profileOf(r) === state.profile)) { state.profile = BUILTIN_PROFILE; savePrefs(); }
}).catch(() => {}).finally(render);
