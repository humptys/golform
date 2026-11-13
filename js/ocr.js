// 론치 모니터 캡처 화면에서 숫자를 읽어 온다(Tesseract.js, 기기 내 실행. 이미지는 전송되지 않는다).
// 큰 숫자 4개가 한 줄에 놓인 행 두 개(거리 행, 볼 정보 행)와 "m/s" 앞의 숫자를 찾는다.
// 오인식 가능성이 있으므로 결과는 사용자가 캡처와 비교해 확인한다.

const LIB = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js';
const ROWS = [['total', 'carry', 'side', 'apex'], ['launch', 'dir', 'backSpin', 'sideSpin']];
const NUM = /^-?[RL]?-?\d[\d.]*$/;

let workerPromise = null;
/** 화면 전체를 읽는 작업자(기본 설정)와 숫자 칸 하나를 읽는 작업자(숫자만, 한 줄)를 따로 둔다. */
function getWorkers() {
  workerPromise ??= (async () => {
    const { default: Tesseract } = await import(LIB);
    const page = await Tesseract.createWorker('eng');
    const cell = await Tesseract.createWorker('eng');
    await cell.setParameters({ tessedit_char_whitelist: '0123456789.-RL', tessedit_pageseg_mode: '7' });
    return { page, cell };
  })().catch((e) => {
    workerPromise = null;
    throw new Error('글자 인식 모듈을 불러오지 못했습니다. 인터넷 연결을 확인하거나 직접 입력해 주세요. (' + e.message + ')');
  });
  return workerPromise;
}

/** @returns {values: {필드: 문자열}, uncertain: [두 번 읽은 결과가 달라 확인이 필요한 필드], found: 읽어낸 필드 수, club?: 화면에 적힌 클럽 종류} */
export async function readShotImage(file) {
  const { page, cell } = await getWorkers();
  const img = await createImageBitmap(file);
  const full = document.createElement('canvas');
  full.width = img.width;
  full.height = img.height;
  full.getContext('2d').drawImage(img, 0, 0);

  const { data } = await page.recognize(full);
  const words = data.words.map((w) => ({ text: w.text.trim(), x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 }));
  const nums = words.filter((w) => NUM.test(w.text));

  // 큰 숫자 4개가 놓인 두 줄을 찾는다.
  // 음수 부호나 L/R이 숫자와 떨어져 따로 읽히는 경우("- 122", "L 1.2")가 있어, 가까이 붙은 조각은 한 칸으로 합친다.
  const pieces = words.filter((w) => /^[-RL]?-?[\d.]*$/.test(w.text) && w.text !== '' && w.text !== '.');
  const lines = [];
  for (const w of [...pieces].sort((a, b) => a.y0 - b.y0)) {
    const h = w.y1 - w.y0, cy = (w.y0 + w.y1) / 2;
    const line = lines.find((l) => Math.abs(l.cy - cy) < 0.5 * l.h);
    if (line) { line.items.push(w); line.h = Math.max(line.h, h); }
    else lines.push({ cy, h, items: [w] });
  }
  for (const l of lines) {
    const merged = [];
    for (const w of l.items.sort((a, b) => a.x0 - b.x0)) {
      const last = merged.at(-1);
      if (last && w.x0 - last.x1 < 0.7 * l.h) { last.x1 = w.x1; last.y0 = Math.min(last.y0, w.y0); last.y1 = Math.max(last.y1, w.y1); last.text += w.text; }
      else merged.push({ ...w });
    }
    l.items = merged;
    l.y0 = Math.min(...merged.map((w) => w.y0));
    l.y1 = Math.max(...merged.map((w) => w.y1));
  }
  // 첫 줄(거리 행): 위에서부터 처음 만나는 4칸짜리 줄. 이 줄의 칸 위치가 아래 줄의 기준이 된다.
  const top = lines.filter((l) => l.items.length === 4 && l.items.some((w) => /\d/.test(w.text))).sort((a, b) => a.cy - b.cy)[0];
  const numberRows = [];
  if (top) {
    const centers = top.items.map((w) => (w.x0 + w.x1) / 2);
    const spacing = (centers[3] - centers[0]) / 3;
    const cellsAt = (line) => centers.map((cx) => ({ x0: Math.round(cx - spacing * 0.46), x1: Math.round(cx + spacing * 0.46), y0: line.y0, y1: line.y1 }));
    numberRows.push({ h: top.y1 - top.y0, items: cellsAt(top) });
    // 둘째 줄(볼 정보 행): 첫 줄 아래에서 글자 크기가 비슷하고 칸 위치에 숫자가 놓인 줄
    const second = lines.filter((l) => l.cy > top.y1 + top.h && Math.abs(l.h - top.h) < 0.4 * top.h
      && l.items.filter((w) => centers.some((cx) => Math.abs((w.x0 + w.x1) / 2 - cx) < spacing * 0.4)).length >= 2)
      .sort((a, b) => b.items.length - a.items.length || a.cy - b.cy)[0];
    if (second) numberRows.push({ h: second.y1 - second.y0, items: cellsAt(second) });
  }

  // 각 숫자 칸을 확대해 숫자만 두 번 읽는다.
  // 론치 모니터의 좁은 글꼴은 그대로 읽으면 7이 1로 읽히고, 가로로 늘려 읽으면 7은 맞지만 소수점을 놓치곤 한다.
  // 그래서 두 결과를 합친다: 숫자는 늘려 읽은 쪽(1과 7이 갈리면 7), 소수점은 찍혀 있는 쪽을 따른다.
  const readCell = async (x0, y0, sw, sh) => {
    const scale = Math.max(1.5, Math.min(4, 170 / sh));
    const read = async (stretch) => {
      const c = document.createElement('canvas');
      c.width = Math.round(sw * scale * stretch);
      c.height = Math.round(sh * scale);
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.imageSmoothingQuality = 'high';
      g.drawImage(full, x0, y0, sw, sh, 0, 0, c.width, c.height);
      return (await cell.recognize(c)).data.text.trim().replace(/\s+/g, '');
    };
    return mergeReads(await read(1.6), await read(1));
  };

  const values = {};
  const uncertain = [];
  // 큰 숫자 줄이 없는 화면(골프존 라운드 상세 등)은 "이름  값" 형태의 줄에서 읽는다
  if (!numberRows.length) {
    const round = parseRoundLines([...data.lines].sort((a, b) => a.bbox.y0 - b.bbox.y0).map((l) => l.text));
    const uncertain = [];
    // 비거리 숫자 오른쪽의 구질 화살표(색이 있는 작은 그림)를 읽는다
    const dist = words.filter((w) => /\d{2,3}m$/.test(w.text) && /\//.test(w.text)).sort((a, b) => a.y0 - b.y0)[0]
      ?? words.filter((w) => new RegExp(`^${round.values.total}m$`).test(w.text)).sort((a, b) => a.y0 - b.y0)[0];
    if (dist) {
      const hgt = dist.y1 - dist.y0;
      const x0 = Math.round(dist.x1 + hgt * 0.1), y0 = Math.max(0, Math.round(dist.y0 - hgt * 0.8));
      const w = Math.min(full.width - x0, Math.round(hgt * 3.5)), h = Math.round(hgt * 2.6);
      if (w > 4 && h > 4) {
        const px = full.getContext('2d').getImageData(x0, y0, w, h).data;
        const mask = [];
        for (let i = 0; i < w * h; i++) {
          const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
          // 흰 배경이 아닌 화소. 화살표는 구질에 따라 빨간색일 수도, 회색(곧은 화살표)일 수도 있다.
          mask.push(Math.max(r, g, b) - Math.min(r, g, b) > 70 || r + g + b < 540);
        }
        const arrow = classifyArrow(mask, w, h);
        if (arrow) {
          round.values.startSide = String(arrow.start);
          round.values.curveSide = String(arrow.curve);
          uncertain.push('startSide', 'curveSide'); // 그림 판독이라 항상 확인을 요청한다
        }
      }
    }
    return { ...round, uncertain, found: Object.keys(round.values).length };
  }
  for (const [ri, row] of numberRows.entries()) {
    for (const [ci, w] of row.items.entries()) {
      const pad = Math.round(row.h * 0.28), key = ROWS[ri][ci];
      const r = await readCell(Math.max(0, w.x0), Math.max(0, w.y0 - pad), w.x1 - w.x0, w.y1 - w.y0 + pad * 2);
      const text = r.text.replace(/\.$/, '');
      if (!NUM.test(text)) continue; // 읽지 못한 칸은 비워 두어 사용자가 직접 넣게 한다
      values[key] = text;
      if (!r.agree) uncertain.push(key);
    }
  }
  // 볼 스피드: "m/s" 바로 왼쪽 영역을 잘라 숫자만 다시 읽는다
  const unit = words.find((w) => /m\/s/i.test(w.text));
  if (unit) {
    const uw = unit.x1 - unit.x0, uh = unit.y1 - unit.y0;
    const x0 = Math.max(0, Math.round(unit.x0 - uw * 3.2)), y0 = Math.max(0, Math.round(unit.y0 - uh * 1.1));
    const sw = Math.round(unit.x0 - x0 - uw * 0.08), sh = Math.round(uh * 2.3);
    if (sw > 10) {
      const r = await readCell(x0, y0, sw, sh);
      const m = /(\d+(?:\.\d+)?)\D*$/.exec(r.text);
      if (m) { values.ballSpeed = m[1]; if (!r.agree) uncertain.push('ballSpeed'); }
    }
  }
  return { values, uncertain, found: Object.keys(values).length };
}

/**
 * 같은 칸을 두 방식으로 읽은 결과를 합친다.
 * @param wide  가로로 늘려 읽은 결과(7을 잘 읽음)
 * @param plain 그대로 읽은 결과(소수점을 잘 읽음)
 * @returns {text, agree} agree가 false면 두 결과가 달랐다는 뜻이라 사용자 확인이 필요하다.
 */
export function mergeReads(wide, plain) {
  if (wide === plain) return { text: wide, agree: true };
  const strip = (t) => t.replace(/\./g, '');
  const a = strip(wide), b = strip(plain);
  if (!a || a.length !== b.length) return { text: wide || plain, agree: false };
  let digits = '';
  for (let i = 0; i < a.length; i++) digits += a[i] !== b[i] && '17'.includes(a[i]) && '17'.includes(b[i]) ? '7' : a[i];
  // 소수점 위치: 뒤에서부터 센 자릿수로 맞춘다
  const dotFromEnd = (t) => (t.includes('.') ? t.length - 1 - t.lastIndexOf('.') : 0);
  const d = dotFromEnd(wide) || dotFromEnd(plain);
  const text = d > 0 && d < digits.length ? digits.slice(0, digits.length - d) + '.' + digits.slice(digits.length - d) : digits;
  return { text, agree: false };
}

/**
 * 골프존 라운드 상세 화면처럼 "클럽 비거리  DR / 229m", "헤드 스피드  43.8 m/s" 줄로 된 화면을 읽는다.
 * 한글 이름은 인식하지 않으므로 줄의 생김새와 순서로 판단한다: 클럽/거리 줄, 그리고 m/s 줄(위가 헤드, 아래가 볼).
 * @param lines 위에서 아래 순서의 줄 문자열
 * @returns {values: {total, headSpeed, ballSpeed}, club: 'driver' | 'iron' | null}
 */
export function parseRoundLines(lines) {
  const values = {};
  let club = null;
  for (const line of lines) {
    // 아이언 표기 "I5"는 글자 인식에서 "15"로 읽히곤 하므로 함께 받는다
    const m = /\b([A-Z]{1,2}\d{0,2}|[1l]\d)\s*\/\s*(\d{2,3})\s*m\b/.exec(line);
    if (!m) continue;
    values.total = m[2];
    club = m[1] === 'DR' ? 'driver' : /^[I1l]\d{1,2}$/.test(m[1]) ? 'iron' : null;
    break;
  }
  const speeds = lines.map((l) => /(\d{1,3}(?:\.\d+)?)\s*m\/s/.exec(l)?.[1]).filter(Boolean);
  if (speeds.length >= 2) [values.headSpeed, values.ballSpeed] = speeds;
  else if (speeds.length === 1) values.ballSpeed = speeds[0];
  return { values, club };
}

/**
 * 구질 화살표 그림을 읽는다. 화살표는 아래에서 시작해 위로 올라가며, 끝(화살촉)이 위에 있다고 본다.
 * 아래쪽 줄기의 기울기로 출발 방향을, 줄기가 그 직선에서 얼마나 벗어나 끝나는지로 휘는 방향을 판정한다.
 * @param mask 화소별 색 여부(true = 화살표 색), 길이 w*h
 * @returns {start: -1|0|1, curve: -1|0|1} (-1 왼쪽, 0 곧게, 1 오른쪽) 또는 판독 불가 시 null
 */
export function classifyArrow(mask, w, h) {
  // 줄마다 이어진 색 구간을 구한다
  const rows = [];
  let total = 0;
  for (let y = 0; y < h; y++) {
    const runs = [];
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const from = x;
      while (x + 1 < w && mask[y * w + x + 1]) x++;
      runs.push([from, x]);
      total += x - from + 1;
    }
    rows.push(runs);
  }
  const ys = rows.map((r, y) => (r.length ? y : -1)).filter((y) => y >= 0);
  if (ys.length < 8 || total < 20) return null;
  const top = ys[0], bottom = ys.at(-1), height = bottom - top + 1;
  if (height < 8) return null;

  // 아래에서 위로 줄기를 따라간다. 화살촉의 다른 획과 섞이지 않게, 직전 위치에 가장 가까운 구간을 고른다.
  const center = (r) => (r[0] + r[1]) / 2;
  const path = [];
  let prev = null;
  for (let y = bottom; y >= top; y--) {
    const runs = rows[y];
    if (!runs.length) continue;
    const pick = prev == null ? runs.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a)) : runs.reduce((a, b) => (Math.abs(center(b) - prev) < Math.abs(center(a) - prev) ? b : a));
    if (prev != null && Math.abs(center(pick) - prev) > height * 0.45) continue; // 줄기에서 동떨어진 화소는 건너뛴다
    prev = center(pick);
    path.push([bottom - y, prev]); // [아래에서부터의 높이, x]
  }
  if (path.length < 6) return null;

  // 구간별로 직선을 맞춰 기울기(위로 한 칸 갈 때 x가 움직이는 양)를 구한다
  const slope = (pts) => {
    if (pts.length < 2) return 0;
    const mu = pts.reduce((t, p) => t + p[0], 0) / pts.length, mx = pts.reduce((t, p) => t + p[1], 0) / pts.length;
    const den = pts.reduce((t, p) => t + (p[0] - mu) ** 2, 0);
    return den > 0 ? pts.reduce((t, p) => t + (p[0] - mu) * (p[1] - mx), 0) / den : 0;
  };
  // 출발 방향: 맨 아래 30%의 기울기. 휘는 방향: 위쪽 절반이 아래쪽 절반보다 어느 쪽으로 더 기우는가.
  const startSlope = slope(path.filter(([u]) => u <= height * 0.3));
  const bend = slope(path.filter(([u]) => u > height * 0.5)) - slope(path.filter(([u]) => u <= height * 0.5));
  return { start: startSlope > 0.25 ? 1 : startSlope < -0.25 ? -1 : 0, curve: bend > 0.15 ? 1 : bend < -0.15 ? -1 : 0 };

}
