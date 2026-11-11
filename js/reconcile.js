// 기기와 서버의 기록을 맞추는 순수 로직. 저장소 구현에 의존하지 않아 node --test 로 검증한다.
//
// 규칙: 기록마다 수정 시각을 비교해 더 새로운 쪽이 이긴다(삭제도 하나의 수정으로 취급).
// 기록은 한 번 만들어지면 거의 바뀌지 않으므로 실제 충돌은 "한쪽에서 삭제" 정도뿐이다.
//
// local:  { all() -> [{id, kind, updatedAt, data}], tombs() -> [{id, kind, updatedAt}],
//           apply(kind, data, updatedAt), remove(kind, id), clearTomb(id) }
// remote: { list() -> [{id, kind, deleted, updated_at}], fetch(ids) -> [{id, kind, data, updated_at}], upsert(rows) }

const ts = (s) => Date.parse(s) || 0;
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export async function reconcile(local, remote) {
  const rows = await remote.list();
  const recs = await local.all();
  const tombs = await local.tombs();
  const R = new Map(rows.map((r) => [r.id, r]));
  const L = new Map(recs.map((r) => [r.id, r]));
  const T = new Map(tombs.map((t) => [t.id, t]));
  const pull = [];
  const push = [];
  let removed = 0;

  for (const r of rows) {
    const l = L.get(r.id);
    if (r.deleted) {
      // 다른 기기에서 삭제됨. 이 기기의 사본이 삭제 이후에 수정된 게 아니라면 따라 지운다.
      if (l && ts(l.updatedAt) <= ts(r.updated_at)) {
        await local.remove(l.kind, l.id);
        L.delete(r.id);
        removed++;
      }
      continue;
    }
    const t = T.get(r.id);
    if (t && ts(t.updatedAt) > ts(r.updated_at)) continue; // 이 기기에서 삭제함 -> 아래에서 삭제를 올린다
    if (!l || ts(r.updated_at) > ts(l.updatedAt)) pull.push(r.id);
  }

  for (const l of L.values()) {
    const r = R.get(l.id);
    if (!r || ts(l.updatedAt) > ts(r.updated_at)) push.push({ id: l.id, kind: l.kind, data: l.data, deleted: false, updated_at: l.updatedAt });
  }
  for (const t of tombs) {
    const r = R.get(t.id);
    if (r && !r.deleted && ts(t.updatedAt) > ts(r.updated_at)) push.push({ id: t.id, kind: t.kind, data: null, deleted: true, updated_at: t.updatedAt });
  }

  let pulled = 0;
  for (const ids of chunks(pull, 20)) {
    for (const row of await remote.fetch(ids)) {
      if (!row.data) continue;
      await local.apply(row.kind, row.data, row.updated_at);
      pulled++;
    }
  }
  for (const part of chunks(push, 10)) await remote.upsert(part);
  // 서버에 삭제가 기록되었거나 애초에 올라간 적 없는 기록이므로 표식은 더 필요 없다
  for (const t of tombs) await local.clearTomb(t.id);

  return { pulled, pushed: push.length, removed };
}
