// Supabase를 통한 기기 간 동기화. 수치와 구간 이미지만 다루고 영상 원본은 기기에 남긴다.
import * as db from './db.js';
import { reconcile } from './reconcile.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
const TABLE = 'golform_records';
const CFG_KEY = 'golform-sync';
const STORE = { ref: 'refs', session: 'sessions' };

let client = null;
let running = null;
let timer = null;
export const status = { state: 'idle', message: '', lastSync: localStorage.getItem('golform-last-sync') };
const emit = (detail = {}) => window.dispatchEvent(new CustomEvent('golform-sync', { detail }));

export function getConfig() {
  if (SUPABASE_URL && SUPABASE_ANON_KEY) return { url: SUPABASE_URL, key: SUPABASE_ANON_KEY, fixed: true };
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY));
    return c?.url && c?.key ? c : null;
  } catch {
    return null;
  }
}
export function setConfig(url, key) {
  url = url.trim().replace(/\/+$/, '');
  key = key.trim();
  if (!/^https:\/\/[^\s/]+$/.test(url)) throw new Error('Project URL은 https://xxxx.supabase.co 형태여야 합니다.');
  if (key.length < 20) throw new Error('anon 키가 올바르지 않습니다.');
  localStorage.setItem(CFG_KEY, JSON.stringify({ url, key }));
  client = null;
}
export function clearConfig() {
  localStorage.removeItem(CFG_KEY);
  client = null;
}

async function getClient() {
  const cfg = getConfig();
  if (!cfg) return null;
  if (!client) {
    const { createClient } = await import(LIB);
    client = createClient(cfg.url, cfg.key);
  }
  return client;
}

export async function getUser() {
  const c = await getClient();
  if (!c) return null;
  const { data } = await c.auth.getSession();
  return data.session?.user ?? null;
}

const authMessage = (e) => {
  const m = e?.message || String(e);
  if (/invalid login credentials/i.test(m)) return '이메일 또는 비밀번호가 맞지 않습니다.';
  if (/email not confirmed/i.test(m)) return '가입 확인 메일의 링크를 먼저 눌러 주세요.';
  if (/already registered/i.test(m)) return '이미 가입된 이메일입니다. 로그인해 주세요.';
  if (/anonymous sign-ins/i.test(m)) return '이메일과 비밀번호를 입력해 주세요.';
  if (/signups? not allowed|signup is disabled/i.test(m)) return '새 가입이 막혀 있습니다. 이미 만든 계정으로 로그인해 주세요.';
  if (/at least 6/i.test(m)) return '비밀번호는 6자 이상이어야 합니다.';
  if (/failed to fetch|networkerror/i.test(m)) return '서버에 연결하지 못했습니다. Project URL과 인터넷 연결을 확인해 주세요.';
  return m;
};

function requireCredentials(email, password) {
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('위 칸에 이메일 주소를 입력해 주세요.');
  if ((password || '').length < 6) throw new Error('위 칸에 비밀번호를 6자 이상 입력해 주세요.');
}

export async function signIn(email, password) {
  requireCredentials(email, password);
  const c = await getClient();
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(authMessage(error));
}
/** @returns 바로 로그인되었으면 true, 확인 메일의 링크를 눌러야 하면 false */
export async function signUp(email, password) {
  requireCredentials(email, password);
  const c = await getClient();
  const { data, error } = await c.auth.signUp({ email, password });
  if (error) throw new Error(authMessage(error));
  return !!data.session;
}
export async function signOut() {
  const c = await getClient();
  await c?.auth.signOut();
  emit();
}

const localSide = {
  async all() {
    const out = [];
    for (const [kind, store] of Object.entries(STORE)) {
      for (const r of await db.getAll(store)) {
        const { hasVideo, updatedAt, ...data } = r; // 영상 보유 여부는 기기마다 다르므로 올리지 않는다
        if (data.parts) data.parts = data.parts.map(({ hasVideo: _own, ...part }) => part);
        out.push({ id: r.id, kind, updatedAt: updatedAt ?? r.date, data });
      }
    }
    return out;
  },
  tombs: () => db.getAll('tombs'),
  async apply(kind, data, updatedAt) {
    if (!STORE[kind] || !data?.id) return;
    const rec = { ...data, updatedAt };
    if (kind === 'session' && rec.parts) {
      rec.parts = await Promise.all(rec.parts.map(async (part) => ({ ...part, hasVideo: !!(await db.get('videos', `${data.id}:${part.view}`)) })));
    } else if (kind === 'session') {
      rec.hasVideo = !!(await db.get('videos', data.id));
    }
    await db.put(STORE[kind], rec, { local: true });
  },
  async remove(kind, id) {
    await db.del(STORE[kind], id, { local: true });
    if (kind === 'session') for (const k of [id, `${id}:faceon`, `${id}:dtl`]) await db.del('videos', k);
  },
  clearTomb: (id) => db.del('tombs', id),
};

function remoteSide(c, userId) {
  const check = ({ data, error }) => {
    if (error) {
      if (/golform_records|schema cache|does not exist/i.test(error.message)) throw new Error('서버에 테이블이 없습니다. supabase/schema.sql 을 SQL Editor에서 실행해 주세요.');
      throw new Error(error.message);
    }
    return data;
  };
  return {
    async list() {
      const out = [];
      for (let from = 0; ; from += 1000) {
        const page = check(await c.from(TABLE).select('id,kind,deleted,updated_at').order('id').range(from, from + 999));
        out.push(...page);
        if (page.length < 1000) return out;
      }
    },
    fetch: async (ids) => check(await c.from(TABLE).select('id,kind,data,updated_at').in('id', ids)),
    upsert: async (rows) => check(await c.from(TABLE).upsert(rows.map((r) => ({ ...r, user_id: userId })), { onConflict: 'user_id,id' })),
  };
}

/** 지금 동기화한다. 로그인하지 않았으면 아무 일도 하지 않는다. */
export function syncNow() {
  running ??= (async () => {
    try {
      const user = await getUser();
      if (!user) return null;
      status.state = 'syncing';
      status.message = '';
      emit();
      const result = await reconcile(localSide, remoteSide(client, user.id));
      status.state = 'ok';
      status.lastSync = new Date().toISOString();
      localStorage.setItem('golform-last-sync', status.lastSync);
      emit({ changed: result.pulled + result.removed > 0 });
      return result;
    } catch (e) {
      status.state = 'error';
      status.message = authMessage(e);
      emit();
      return null;
    } finally {
      running = null;
    }
  })();
  return running;
}

/** 저장·삭제 직후 잠시 모아서 동기화한다. */
export function requestSync() {
  clearTimeout(timer);
  timer = setTimeout(syncNow, 1500);
}

export function init() {
  db.setChangeListener(requestSync);
  if (getConfig()) syncNow();
  window.addEventListener('online', syncNow);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
}
