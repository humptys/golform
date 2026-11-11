import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../js/reconcile.js';

let clock = Date.parse('2026-01-01T00:00:00Z');
const now = () => new Date((clock += 1000)).toISOString();

/** 기기 한 대의 저장소 */
function device() {
  const recs = new Map();
  const tombs = new Map();
  return {
    recs,
    add(id, kind = 'session', extra = {}) { recs.set(id, { id, kind, updatedAt: now(), data: { id, ...extra } }); },
    delete(id) { const r = recs.get(id); recs.delete(id); tombs.set(id, { id, kind: r.kind, updatedAt: now() }); },
    ids() { return [...recs.keys()].sort(); },
    all: async () => [...recs.values()],
    tombs: async () => [...tombs.values()],
    apply: async (kind, data, updatedAt) => { recs.set(data.id, { id: data.id, kind, updatedAt, data }); },
    remove: async (kind, id) => { recs.delete(id); },
    clearTomb: async (id) => { tombs.delete(id); },
    tombCount: () => tombs.size,
  };
}
/** 서버 */
function server() {
  const rows = new Map();
  return {
    rows,
    list: async () => [...rows.values()].map(({ id, kind, deleted, updated_at }) => ({ id, kind, deleted, updated_at })),
    fetch: async (ids) => ids.map((id) => rows.get(id)).filter(Boolean),
    upsert: async (list) => { for (const r of list) rows.set(r.id, { ...r }); },
  };
}

test('새 기기는 서버의 기록을 모두 내려받는다', async () => {
  const a = device(), b = device(), s = server();
  a.add('r1', 'ref'); a.add('s1'); a.add('s2');
  assert.deepEqual(await reconcile(a, s), { pulled: 0, pushed: 3, removed: 0 });
  assert.deepEqual(await reconcile(b, s), { pulled: 3, pushed: 0, removed: 0 });
  assert.deepEqual(b.ids(), ['r1', 's1', 's2']);
  assert.equal(b.recs.get('r1').kind, 'ref');
});

test('두 기기에서 따로 만든 기록이 합쳐진다', async () => {
  const a = device(), b = device(), s = server();
  a.add('a1'); b.add('b1');
  await reconcile(a, s); await reconcile(b, s); await reconcile(a, s);
  assert.deepEqual(a.ids(), ['a1', 'b1']);
  assert.deepEqual(b.ids(), ['a1', 'b1']);
});

test('변화가 없으면 아무것도 주고받지 않는다', async () => {
  const a = device(), s = server();
  a.add('a1');
  await reconcile(a, s);
  assert.deepEqual(await reconcile(a, s), { pulled: 0, pushed: 0, removed: 0 });
});

test('한 기기에서 삭제하면 다른 기기에서도 사라지고 되살아나지 않는다', async () => {
  const a = device(), b = device(), s = server();
  a.add('x'); a.add('y');
  await reconcile(a, s); await reconcile(b, s);
  b.delete('x');
  await reconcile(b, s);
  assert.equal(b.tombCount(), 0);
  assert.equal(s.rows.get('x').deleted, true);
  assert.equal(s.rows.get('x').data, null);
  assert.deepEqual(await reconcile(a, s), { pulled: 0, pushed: 0, removed: 1 });
  assert.deepEqual(a.ids(), ['y']);
  await reconcile(b, s); await reconcile(a, s);
  assert.deepEqual(a.ids(), ['y']);
  assert.deepEqual(b.ids(), ['y']);
});

test('동기화 전에 만들고 지운 기록은 서버에 올라가지 않는다', async () => {
  const a = device(), s = server();
  a.add('tmp'); a.delete('tmp');
  assert.deepEqual(await reconcile(a, s), { pulled: 0, pushed: 0, removed: 0 });
  assert.equal(s.rows.size, 0);
  assert.equal(a.tombCount(), 0);
});

test('더 최근에 수정된 쪽이 이긴다', async () => {
  const a = device(), b = device(), s = server();
  a.add('x', 'session', { v: 1 });
  await reconcile(a, s); await reconcile(b, s);
  b.add('x', 'session', { v: 2 });
  await reconcile(b, s); await reconcile(a, s);
  assert.equal(a.recs.get('x').data.v, 2);
  // 서버가 다른 표기(+00:00)로 시각을 돌려줘도 같은 시각으로 본다
  const row = s.rows.get('x');
  row.updated_at = row.updated_at.replace('Z', '+00:00');
  assert.deepEqual(await reconcile(a, s), { pulled: 0, pushed: 0, removed: 0 });
});

test('기록이 많아도 나눠서 모두 옮긴다', async () => {
  const a = device(), b = device(), s = server();
  for (let i = 0; i < 57; i++) a.add('s' + i);
  await reconcile(a, s);
  assert.equal((await reconcile(b, s)).pulled, 57);
  assert.equal(b.ids().length, 57);
});
