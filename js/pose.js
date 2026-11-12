// 영상 파일 -> 프레임별 포즈 랜드마크 (MediaPipe Pose Landmarker, 기기 내 실행).
// 영상은 어디에도 업로드되지 않는다. 모델 파일만 CDN에서 내려받는다.

const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

export const MAX_SECONDS = 20;
const MAX_FRAMES = 360;

let landmarkerPromise = null;
let lastTs = 0; // VIDEO 모드는 호출 간 타임스탬프가 단조 증가해야 한다

function getLandmarker() {
  landmarkerPromise ??= (async () => {
    const { FilesetResolver, PoseLandmarker } = await import(`${VISION}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
    const make = (delegate) =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
      });
    try {
      return await make('GPU');
    } catch {
      return await make('CPU');
    }
  })().catch((e) => {
    landmarkerPromise = null;
    throw new Error('포즈 분석 모델을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요. (' + e.message + ')');
  });
  return landmarkerPromise;
}

/**
 * 영상을 t초로 옮기고, 그 장면이 실제로 화면에 준비될 때까지 기다린다.
 * 'seeked' 이벤트만 믿으면 일부 기기(특히 휴대폰)에서는 아직 이전 장면이 남아 있어,
 * 사진과 골격이 서로 다른 순간의 것이 된다. 그래서 새 프레임이 표시됐다는 신호까지 확인한다.
 */
function seek(video, t) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 1e-4 && video.readyState >= 2) return resolve();
    let finished = false, seeked = false, presented = false, grace = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      video.removeEventListener('seeked', onSeeked);
      clearTimeout(timer);
      clearTimeout(grace);
      resolve();
    };
    const check = () => { if (seeked && presented) finish(); };
    const onSeeked = () => {
      seeked = true;
      check();
      // 같은 프레임으로 옮긴 경우 등 표시 신호가 오지 않을 수 있으므로 잠깐만 기다리고 넘어간다
      if (!finished) grace = setTimeout(finish, 150);
    };
    const timer = setTimeout(finish, 4000);
    video.addEventListener('seeked', onSeeked);
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => { presented = true; check(); });
    else presented = true;
    video.currentTime = t;
  });
}

async function openVideo(file) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = URL.createObjectURL(file);
  await new Promise((resolve, reject) => {
    video.onloadeddata = resolve;
    video.onerror = () => reject(new Error('이 영상 형식은 재생할 수 없습니다.'));
    video.load();
  });
  // iOS Safari는 한 번 재생을 시작해야 프레임 탐색이 안정적으로 동작한다
  await video.play().then(() => video.pause()).catch(() => {});
  if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('영상 길이를 읽을 수 없습니다.');
  return video;
}

/**
 * @returns {frames: [{t, lm|null}], aspect, duration, capture(t, rect, width) -> canvas, close()}
 */
export async function extractPoses(file, onProgress = () => {}) {
  onProgress(0, '모델 불러오는 중…');
  const landmarker = await getLandmarker();
  const video = await openVideo(file);
  const cleanup = () => URL.revokeObjectURL(video.src);
  try {
    if (video.duration > MAX_SECONDS) {
      throw new Error(`영상이 너무 깁니다(${video.duration.toFixed(0)}초). 스윙 1회만 담기도록 ${MAX_SECONDS}초 이내로 잘라 주세요.`);
    }
    const aspect = video.videoWidth / video.videoHeight;
    const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const step = Math.max(1 / 30, video.duration / MAX_FRAMES);
    const count = Math.floor(video.duration / step);
    const frames = [];
    for (let i = 0; i < count; i++) {
      const t = Math.min(video.duration - 0.001, (i + 0.5) * step);
      await seek(video, t);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      lastTs += 34;
      const res = landmarker.detectForVideo(canvas, lastTs);
      const lm = res.landmarks?.[0];
      frames.push({ t, lm: lm ? lm.map((p) => ({ x: p.x, y: p.y })) : null });
      if (i % 5 === 0) {
        onProgress((i + 1) / count, `자세 추출 중… ${Math.round(((i + 1) / count) * 100)}%`);
        await new Promise((r) => setTimeout(r)); // 화면 갱신 양보
      }
    }

    /**
     * 해당 시점의 프레임에서 rect(0~1 비율) 영역만 잘라 canvas로 돌려준다.
     * 사람 주변만 확대해 보여 주기 위한 것으로, 골격과 표시는 annotate.js가 그린다.
     */
    const capture = async (t, rect = { x: 0, y: 0, w: 1, h: 1 }, width = 420) => {
      await seek(video, t);
      const sw = rect.w * video.videoWidth;
      const sh = rect.h * video.videoHeight;
      const c = document.createElement('canvas');
      c.width = width;
      c.height = Math.round((width * sh) / sw);
      c.getContext('2d').drawImage(video, rect.x * video.videoWidth, rect.y * video.videoHeight, sw, sh, 0, 0, c.width, c.height);
      return c;
    };

    return { frames, aspect, duration: video.duration, capture, close: cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}
