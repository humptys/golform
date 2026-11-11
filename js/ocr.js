// 론치 모니터 캡처 화면에서 숫자를 읽어 온다(Tesseract.js, 기기 내 실행. 이미지는 전송되지 않는다).
// 큰 숫자 4개가 한 줄에 놓인 행 두 개(거리 행, 볼 정보 행)와 "m/s" 앞의 숫자를 찾는다.
// 글꼴에 따라 7을 1로 읽는 등 오인식이 있으므로 결과는 반드시 사용자가 확인해야 한다.

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

/** @returns {values: {필드: 문자열}, found: 읽어낸 필드 수} */
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

  // 같은 높이에 놓인 숫자 4개짜리 행을 위에서부터 찾는다
  const rows = [];
  for (const w of [...nums].sort((a, b) => a.y0 - b.y0)) {
    const h = w.y1 - w.y0, cy = (w.y0 + w.y1) / 2;
    const row = rows.find((r) => Math.abs(r.cy - cy) < 0.5 * r.h && Math.abs(r.h - h) < 0.4 * r.h);
    if (row) row.items.push(w);
    else rows.push({ cy, h, items: [w] });
  }
  const numberRows = rows.filter((r) => r.items.length === 4).sort((a, b) => a.cy - b.cy).slice(0, 2);

  // 각 숫자 칸을 확대해 숫자만 다시 읽는다(소수점이 살아난다)
  const values = {};
  for (const [ri, row] of numberRows.entries()) {
    const cells = row.items.sort((a, b) => a.x0 - b.x0);
    for (const [ci, w] of cells.entries()) {
      const pad = Math.round(row.h * 0.28), scale = Math.max(1.5, Math.min(4, 170 / row.h));
      const sw = w.x1 - w.x0 + pad * 2, sh = w.y1 - w.y0 + pad * 2;
      const c = document.createElement('canvas');
      c.width = Math.round(sw * scale);
      c.height = Math.round(sh * scale);
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.imageSmoothingQuality = 'high';
      g.drawImage(full, w.x0 - pad, w.y0 - pad, sw, sh, 0, 0, c.width, c.height);
      const text = (await cell.recognize(c)).data.text.trim().replace(/\s+/g, '');
      values[ROWS[ri][ci]] = NUM.test(text) ? text.replace(/\.$/, '') : w.text;
    }
  }
  // 볼 스피드: "m/s" 바로 왼쪽 영역을 잘라 숫자만 다시 읽는다
  const unit = words.find((w) => /m\/s/i.test(w.text));
  if (unit) {
    const uw = unit.x1 - unit.x0, uh = unit.y1 - unit.y0;
    const x0 = Math.max(0, Math.round(unit.x0 - uw * 3.2)), y0 = Math.max(0, Math.round(unit.y0 - uh * 1.1));
    const sw = Math.round(unit.x0 - x0 - uw * 0.08), sh = Math.round(uh * 2.3), scale = Math.max(1.5, Math.min(4, 170 / sh));
    if (sw > 10) {
      const c = document.createElement('canvas');
      c.width = Math.round(sw * scale);
      c.height = Math.round(sh * scale);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(full, x0, y0, sw, sh, 0, 0, c.width, c.height);
      const m = /(\d+(?:\.\d+)?)\D*$/.exec((await cell.recognize(c)).data.text.trim());
      if (m) values.ballSpeed = m[1];
    }
  }
  return { values, found: Object.keys(values).length };
}
