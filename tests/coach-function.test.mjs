import test from 'node:test';
import assert from 'node:assert/strict';
import { answer, handle, buildMessages } from '../supabase/functions/coach/index.ts';

/** 가짜 제공자들. replies: {gemini, groq, openrouter} 각각 문자열 | Error | (호출 정보) => 문자열 */
function fakeFetch(replies, { user = true, approved = true } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    const res = (status, obj) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj), json: async () => obj });
    if (url.includes('/auth/v1/user')) return res(user ? 200 : 401, {});
    if (url.includes('/rpc/golform_is_approved')) return approved === 'missing' ? res(404, {}) : res(200, approved);
    const provider = url.includes('googleapis') ? 'gemini' : url.includes('groq') ? 'groq' : 'openrouter';
    const model = provider === 'gemini' ? url.match(/models\/([^:]+):/)[1] : body.model;
    const prompt = provider === 'gemini' ? body.contents.at(-1).parts[0].text : body.messages.at(-1).content;
    const system = provider === 'gemini' ? body.systemInstruction.parts[0].text : body.messages[0].content;
    calls.push({ provider, model, prompt, system, body });
    let r = replies[provider];
    if (typeof r === 'function') r = r({ model, prompt, system });
    if (r instanceof Error) return res(Number(r.message) || 500, { error: { message: 'boom' } });
    return provider === 'gemini' ? res(200, { candidates: [{ content: { parts: [{ text: r }] } }] }) : res(200, { model: provider === 'openrouter' ? 'some/free-model:free' : model, choices: [{ message: { content: r } }] });
  };
  fn.calls = calls;
  return fn;
}
const KEYS = { SUPABASE_URL: 'https://x.supabase.co', GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', OPENROUTER_API_KEY: 'o' };

test('대화 구성: 기록과 질문을 함께 보내고 이전 대화는 최근 것만 넣는다', () => {
  const m = buildMessages('슬라이스 고치는 법?', '캐리 200m', Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 't' + i })));
  assert.equal(m.length, 7);
  assert.match(m.at(-1).content, /\[사용자 기록\]\n캐리 200m[\s\S]*\[질문\]\n슬라이스/);
  assert.equal(buildMessages('q', '', []).at(-1).content, '[질문]\nq');
});

test('여러 모델의 답을 받아 한 모델이 정리한다', async () => {
  const isJudge = (c) => c.system.includes('편집자');
  const f = fakeFetch({
    gemini: '제미니 답',
    groq: (c) => (isJudge(c) ? '정리된 최종 답' : '그록 답'), openrouter: '오픈라우터 답',
  });
  const r = await answer('슬라이스?', '기록', [], KEYS, f);
  assert.equal(r.answer, '정리된 최종 답');
  assert.deepEqual(r.models, ['openai/gpt-oss-120b', 'gemini-3.8-flash', 'some/free-model:free']);
  assert.equal(r.judgedBy, 'openai/gpt-oss-120b'); // 빠른 곳이 정리를 맡는다
  const judge = f.calls.find(isJudge);
  assert.match(judge.prompt, /후보 1:\n그록 답[\s\S]*후보 2:\n제미니 답[\s\S]*후보 3:\n오픈라우터 답/);
});

test('모델이 없어졌으면 다음 모델로, 한 곳이 실패해도 나머지로 답한다', async () => {
  const f = fakeFetch({
    gemini: ({ model }) => (model === 'gemini-3.8-flash' ? new Error('404') : '제미니 예비 모델 답'),
    groq: new Error('429'), openrouter: new Error('500'),
  });
  const r = await answer('q', '', [], KEYS, f);
  assert.equal(r.answer, '제미니 예비 모델 답');
  assert.deepEqual(r.models, ['gemini-3.6-flash']);
  assert.equal(r.judgedBy, null);
  assert.deepEqual(r.failed.map((x) => x.provider), ['groq', 'openrouter']);
});

test('키가 있는 제공자만 부르고, 키가 없거나 모두 실패하면 이유를 알린다', async () => {
  const f = fakeFetch({ groq: '그록 답' });
  const r = await answer('q', '', [], { GROQ_API_KEY: 'q' }, f);
  assert.deepEqual([r.answer, r.models.length], ['그록 답', 1]);
  assert.ok(Number.isFinite(r.ms) && Number.isFinite(r.each['openai/gpt-oss-120b']));
  assert.deepEqual([...new Set(f.calls.map((c) => c.provider))], ['groq']);
  await assert.rejects(answer('q', '', [], {}, fakeFetch({})), /API 키가 하나도/);
  await assert.rejects(answer('q', '', [], { GROQ_API_KEY: 'q' }, fakeFetch({ groq: new Error('429') })), /모든 모델이 답하지 못했습니다: groq 429/);
  // 모델 목록을 비밀값으로 덮어쓸 수 있다
  const g = fakeFetch({ groq: '답' });
  assert.deepEqual((await answer('q', '', [], { GROQ_API_KEY: 'q', GROQ_MODELS: 'my-model, other' }, g)).models, ['my-model']);
});

test('요청 처리: 로그인·승인 확인, 빈 질문 거절, 교차 출처 허용', async () => {
  const req = (body, method = 'POST') => new Request('https://x.supabase.co/functions/v1/coach', { method, headers: { authorization: 'Bearer t', apikey: 'k', 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined });
  const ok = await handle(req({ question: '슬라이스?' }), KEYS, fakeFetch({ groq: '답' }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await ok.json()).answer, '답');
  assert.equal((await handle(req({ question: 'q' }), KEYS, fakeFetch({ groq: '답' }, { user: false }))).status, 401);
  assert.equal((await handle(req({ question: 'q' }), KEYS, fakeFetch({ groq: '답' }, { approved: false }))).status, 403);
  assert.equal((await handle(req({ question: 'q' }), KEYS, fakeFetch({ groq: '답' }, { approved: 'missing' }))).status, 200);
  assert.equal((await handle(req({ question: '  ' }), KEYS, fakeFetch({ groq: '답' }))).status, 400);
  assert.equal((await handle(req(null, 'OPTIONS'), KEYS, fakeFetch({}))).status, 200);
  const fail = await handle(req({ question: 'q' }), { SUPABASE_URL: 'https://x.supabase.co' }, fakeFetch({}));
  assert.equal(fail.status, 502);
  assert.match((await fail.json()).error, /API 키가 하나도/);
});

test('느린 한 곳을 끝까지 기다리지 않는다', async () => {
  const base = fakeFetch({ gemini: '제미니 답', groq: (c) => (c.system.includes('편집자') ? '정리된 답' : '그록 답'), openrouter: '늦은 답' });
  const slow = async (url, init) => {
    if (url.includes('openrouter')) await new Promise((r) => setTimeout(r, 400));
    return base(url, init);
  };
  const t0 = Date.now();
  const r = await answer('q', '', [], { ...KEYS, COACH_GRACE_MS: '30' }, slow);
  assert.ok(Date.now() - t0 < 300, `took ${Date.now() - t0}ms`);
  assert.equal(r.answer, '정리된 답');
  assert.deepEqual(r.models, ['openai/gpt-oss-120b', 'gemini-3.8-flash']);
  assert.deepEqual(r.failed, [{ provider: 'openrouter', error: '응답이 늦어 제외' }]);
  // 한 곳만 답했고 나머지가 계속 늦으면, 기한이 지난 뒤 그 답으로 진행한다
  const verySlow = async (url, init) => {
    if (!url.includes('groq') && !url.includes('supabase')) await new Promise((r) => setTimeout(r, 500));
    return base(url, init);
  };
  const t1 = Date.now();
  const one = await answer('q', '', [], { ...KEYS, COACH_DEADLINE_MS: '60' }, verySlow);
  assert.ok(Date.now() - t1 < 350, `took ${Date.now() - t1}ms`);
  assert.deepEqual([one.answer, one.judgedBy], ['그록 답', null]);
});

test('추론형 모델은 추론을 낮게 두고, 그 설정을 거절당하면 다음 모델로 넘어간다', async () => {
  const f = fakeFetch({ groq: '답' });
  await answer('q', '', [], { GROQ_API_KEY: 'q' }, f);
  assert.equal(f.calls[0].body.reasoning_effort, 'low');
  assert.ok(f.calls[0].body.max_tokens > 700);
  // 서버가 그 설정을 모른다고 400을 돌려주는 경우
  const g = fakeFetch({ groq: ({ model }) => (model.includes('gpt-oss') ? new Error('400') : '라마 답') });
  const r = await answer('q', '', [], { GROQ_API_KEY: 'q' }, g);
  assert.deepEqual([r.answer, r.models[0]], ['라마 답', 'llama-3.3-70b-versatile']);
  assert.equal(g.calls.at(-1).body.reasoning_effort, undefined);
});
