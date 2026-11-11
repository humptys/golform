// IndexedDB 래퍼. 데이터는 우선 이 기기의 브라우저에 저장되고, 로그인하면 sync.js가 서버와 맞춘다.
// refs: 기준 영상의 측정값 / sessions: 내 분석 기록 / videos: 내 영상 원본(이 기기 전용)
// tombs: 삭제 표식. 다른 기기에도 삭제를 전달하기 위해 동기화 전까지 보관한다.

const NAME = 'golform';
const STORES = ['refs', 'sessions', 'videos', 'tombs'];
const SYNCED = { refs: 'ref', sessions: 'session' };
let dbPromise = null;
let onChange = () => {};

/** 동기화 대상 데이터가 바뀔 때 호출될 콜백을 등록한다. */
export const setChangeListener = (fn) => { onChange = fn; };

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, 2);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const req = fn((name) => tx.objectStore(name));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('저장에 실패했습니다. 저장 공간이 부족할 수 있습니다.'));
  });
}

export const getAll = (store) => run(store, 'readonly', (s) => s(store).getAll());
export const get = (store, id) => run(store, 'readonly', (s) => s(store).get(id));
export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * 저장. 동기화 대상(refs, sessions)은 수정 시각을 찍는다.
 * local: true 는 서버에서 내려받은 내용을 그대로 반영할 때 쓴다(시각 유지, 변경 알림 없음).
 */
export async function put(store, value, { local = false } = {}) {
  const synced = store in SYNCED;
  const v = synced && !local ? { ...value, updatedAt: new Date().toISOString() } : value;
  await run(synced ? [store, 'tombs'] : store, 'readwrite', (s) => {
    if (synced) s('tombs').delete(v.id);
    return s(store).put(v);
  });
  if (synced && !local) onChange();
  return v;
}

/** 삭제. 동기화 대상은 삭제 표식을 남긴다. */
export async function del(store, id, { local = false } = {}) {
  const synced = store in SYNCED;
  await run(synced ? [store, 'tombs'] : store, 'readwrite', (s) => {
    if (synced && !local) s('tombs').put({ id, kind: SYNCED[store], updatedAt: new Date().toISOString() });
    return s(store).delete(id);
  });
  if (synced && !local) onChange();
}

/** 영상 원본을 제외한 전체 데이터를 JSON으로 내보낸다. */
export async function exportAll() {
  return { app: 'golform', version: 1, exportedAt: new Date().toISOString(), refs: await getAll('refs'), sessions: await getAll('sessions') };
}

export async function importAll(data) {
  if (data?.app !== 'golform' || !Array.isArray(data.refs) || !Array.isArray(data.sessions)) {
    throw new Error('GolForm 백업 파일이 아닙니다.');
  }
  for (const r of data.refs) if (r?.id && r.metrics) await put('refs', r);
  for (const s of data.sessions) if (s?.id && s.metrics) await put('sessions', { ...s, hasVideo: !!(await get('videos', s.id)) });
  return { refs: data.refs.length, sessions: data.sessions.length };
}
