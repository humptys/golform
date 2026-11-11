// IndexedDB 래퍼. 모든 데이터는 이 기기의 브라우저 안에만 저장된다.
// refs: 기준 영상의 측정값 / sessions: 내 분석 기록 / videos: 내 영상 원본(선택)

const NAME = 'golform';
const STORES = ['refs', 'sessions', 'videos'];
let dbPromise = null;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('저장에 실패했습니다. 저장 공간이 부족할 수 있습니다.'));
  });
}

export const getAll = (store) => run(store, 'readonly', (s) => s.getAll());
export const get = (store, id) => run(store, 'readonly', (s) => s.get(id));
export const put = (store, value) => run(store, 'readwrite', (s) => s.put(value));
export const del = (store, id) => run(store, 'readwrite', (s) => s.delete(id));
export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 영상 원본을 제외한 전체 데이터를 JSON으로 내보낸다. */
export async function exportAll() {
  return { app: 'golform', version: 1, exportedAt: new Date().toISOString(), refs: await getAll('refs'), sessions: await getAll('sessions') };
}

export async function importAll(data) {
  if (data?.app !== 'golform' || !Array.isArray(data.refs) || !Array.isArray(data.sessions)) {
    throw new Error('GolForm 백업 파일이 아닙니다.');
  }
  for (const r of data.refs) if (r?.id && r.metrics) await put('refs', r);
  for (const s of data.sessions) if (s?.id && s.metrics) await put('sessions', { ...s, hasVideo: false });
  return { refs: data.refs.length, sessions: data.sessions.length };
}
