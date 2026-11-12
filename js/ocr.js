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

/** @returns {values: {필드: 문자열}, uncertain: [두 번 읽은 결과가 달라 확인이 필요한 필드], found: 읽어낸 필드 수} */
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
