// GolForm 조언 기능: 무료 LLM 여러 곳에 같은 질문을 보내고, 답변들을 비교해 하나로 정리해 돌려준다.
// Supabase Edge Function으로 배포한다. API 키는 이 함수의 비밀값(Secrets)에만 두고 앱에는 넣지 않는다.
//
// 비밀값(있는 것만 사용): GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY
// 모델 이름은 자주 바뀌므로 GEMINI_MODELS, GROQ_MODELS, OPENROUTER_MODELS(쉼표로 구분)로 덮어쓸 수 있다.
// 타입 표기 없이 작성해 Deno와 Node(테스트) 양쪽에서 그대로 실행된다.

const DEFAULT_MODELS = {
  gemini: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite'],
  groq: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'],
  openrouter: ['openrouter/free'],
};
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const TIMEOUT_MS = 15000; // 모델 하나를 기다리는 최대 시간
const MAX_TOKENS = 700;
// 답을 모으는 규칙: 두 곳이 답하면 나머지는 GRACE_MS만 더 기다리고, 한 곳만 답했어도 DEADLINE_MS가 지나면 그 답으로 진행한다.
// 느린 한 곳 때문에 전체가 늦어지지 않게 하기 위함이다. (비밀값 COACH_GRACE_MS, COACH_DEADLINE_MS로 바꿀 수 있다)
const GRACE_MS = 2500;
const DEADLINE_MS = 12000;

export const SYSTEM = `당신은 아마추어 골퍼를 돕는 골프 스윙 코치입니다.
- 한국어 존댓말로, 핵심부터 8문장 이내로 답합니다.
- 원인 한두 가지와 바로 해 볼 수 있는 연습 방법 한두 가지를 구체적으로 제시합니다.
- 아래에 "사용자 기록"이 주어지면 그 내용을 근거로 삼고, 기록에 없는 수치나 사실을 지어내지 않습니다.
- 영상만으로는 클럽 페이스와 그립을 알 수 없다는 점 등, 확실하지 않은 부분은 확실하지 않다고 말합니다.
- 통증이나 부상에 관한 질문은 의료 전문가와 상의하도록 안내합니다.
- 골프와 관계없는 질문에는 골프에 관한 질문만 답할 수 있다고 짧게 답합니다.`;

const clip = (s, n) => String(s ?? '').slice(0, n);

/** 모델에 보낼 대화. history는 [{role: 'user' | 'assistant', text}] */
export function buildMessages(question, context, history = []) {
  const turns = history.slice(-6).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: clip(m.text, 600) }));
  const ctx = clip(context, 2500).trim();
  return [...turns, { role: 'user', content: (ctx ? `[사용자 기록]\n${ctx}\n\n` : '') + `[질문]\n${clip(question, 600)}` }];
}

async function post(fetchFn, url, headers, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* JSON이 아닌 오류 응답 */ }
    if (!res.ok) throw new Error(`${res.status} ${clip(json?.error?.message ?? text, 200)}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// 제공자별 호출. 모두 {text, model}을 돌려준다.
const PROVIDERS = {
  async gemini(fetchFn, key, model, system, messages) {
    const json = await post(fetchFn, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { 'x-goog-api-key': key }, {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: 0.4 },
    });
    return { text: (json?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim(), model };
  },
  async groq(fetchFn, key, model, system, messages) {
    // gpt-oss는 답하기 전에 추론을 길게 하는 모델이라 그대로 두면 느리다. 추론을 낮게 두고, 추론에 쓰이는 몫만큼 길이 상한을 늘린다.
    const reasoning = /gpt-oss/.test(model) ? { reasoning_effort: 'low', max_tokens: MAX_TOKENS + 600 } : {};
    const json = await post(fetchFn, 'https://api.groq.com/openai/v1/chat/completions', { Authorization: `Bearer ${key}` }, {
      model, messages: [{ role: 'system', content: system }, ...messages], max_tokens: MAX_TOKENS, temperature: 0.4, ...reasoning,
    });
    return { text: (json?.choices?.[0]?.message?.content ?? '').trim(), model: json?.model ?? model };
  },
  async openrouter(fetchFn, key, model, system, messages) {
    const json = await post(fetchFn, 'https://openrouter.ai/api/v1/chat/completions', { Authorization: `Bearer ${key}` }, {
      model, messages: [{ role: 'system', content: system }, ...messages], max_tokens: MAX_TOKENS, temperature: 0.4,
    });
    return { text: (json?.choices?.[0]?.message?.content ?? '').trim(), model: json?.model ?? model }; // 무료 라우터는 실제 답한 모델 이름을 알려 준다
  },
};
const KEY_OF = { gemini: 'GEMINI_API_KEY', groq: 'GROQ_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
const modelsOf = (env, provider) => {
  const custom = (env[`${provider.toUpperCase()}_MODELS`] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return custom.length ? custom : DEFAULT_MODELS[provider];
};

/** 한 제공자에 물어본다. 모델이 없어졌거나 한도에 걸리면 목록의 다음 모델로 넘어간다. */
export async function askProvider(provider, env, fetchFn, system, messages) {
  const key = env[KEY_OF[provider]];
  if (!key) return null;
  let lastError = '모델 없음';
  for (const model of modelsOf(env, provider)) {
    try {
      const t0 = Date.now();
      const r = await PROVIDERS[provider](fetchFn, key, model, system, messages);
      if (r.text) return { provider, model: r.model, text: r.text, ms: Date.now() - t0 };
      lastError = '빈 답변';
    } catch (e) {
      lastError = e?.name === 'AbortError' ? '시간 초과' : String(e?.message ?? e);
    }
  }
  return { provider, error: lastError };
}

/**
 * 설정된 모든 제공자에 동시에 묻고, 답이 둘 이상이면 한 모델에게 비교·정리를 맡긴다.
 * @returns {answer, models: [답한 모델], judgedBy: 정리한 모델 | null, failed: [{provider, error}], ms: 전체 소요 시간, each: {모델: 소요 시간}}
 */
// 답을 정리(심사)할 때 먼저 맡길 순서: 응답이 빠른 곳부터
const PRIORITY = ['groq', 'gemini', 'openrouter'];

export async function answer(question, context, history, env, fetchFn) {
  const started = Date.now();
  const messages = buildMessages(question, context, history);
  const asked = Object.keys(PROVIDERS).filter((p) => env[KEY_OF[p]]);
  if (!asked.length) throw new Error('API 키가 하나도 설정되지 않았습니다. 함수의 Secrets에 GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY 중 하나 이상을 넣어 주세요.');
  const results = [];
  await new Promise((resolve) => {
    const grace = Number(env.COACH_GRACE_MS ?? GRACE_MS), deadline = Number(env.COACH_DEADLINE_MS ?? DEADLINE_MS);
    let graceTimer = null;
    const deadlineTimer = setTimeout(() => { if (results.some((r) => r.text)) finish(); }, deadline);
    const finish = () => { clearTimeout(graceTimer); clearTimeout(deadlineTimer); resolve(); };
    let pending = asked.length;
    for (const p of asked) {
      askProvider(p, env, fetchFn, SYSTEM, messages).then((r) => {
        results.push(r);
        pending--;
        const okCount = results.filter((x) => x.text).length;
        if (pending === 0) finish();
        else if (okCount >= 2 && !graceTimer) graceTimer = setTimeout(finish, grace);
        else if (okCount >= 1 && Date.now() - started > deadline) finish();
      });
    }
  });
  const ok = PRIORITY.flatMap((p) => results.filter((r) => r.provider === p && r.text)); // 빠른 곳이 정리를 맡도록 정해 둔 순서
  const failed = [
    ...results.filter((r) => r.error).map(({ provider, error }) => ({ provider, error })),
    ...asked.filter((p) => !results.some((r) => r.provider === p)).map((provider) => ({ provider, error: '응답이 늦어 제외' })),
  ].sort((a, b) => PRIORITY.indexOf(a.provider) - PRIORITY.indexOf(b.provider));
  if (!ok.length) throw new Error('모든 모델이 답하지 못했습니다: ' + failed.map((f) => `${f.provider} ${f.error}`).join(' / '));
  const timing = () => ({ ms: Date.now() - started, each: Object.fromEntries(ok.map((r) => [r.model, r.ms])) });
  if (ok.length === 1) return { answer: ok[0].text, models: [ok[0].model], judgedBy: null, failed, ...timing() };

  // 여러 답을 비교해 하나로 정리한다. 답변자와 심사자가 겹치지 않도록 후보 이름은 가린다.
  const judgeSystem = `당신은 골프 지도 내용을 검토하는 편집자입니다. 같은 질문에 대한 답변 후보들을 비교해 최종 답 하나를 만듭니다.
- 후보들이 공통으로 말하는 내용과, 골프 지도 원리에 맞고 사용자 기록에 부합하는 내용을 남깁니다.
- 후보끼리 어긋나거나 근거가 약한 주장, 기록에 없는 수치는 뺍니다. 후보에 없는 새 주장은 넣지 않습니다.
- 한국어 존댓말로 8문장 이내, 원인과 연습 방법이 드러나게 씁니다. 후보나 비교 과정은 언급하지 않고 최종 답만 씁니다.`;
  const judgeMessages = [{
    role: 'user',
    content: `${messages.at(-1).content}\n\n[답변 후보]\n` + ok.map((r, i) => `후보 ${i + 1}:\n${clip(r.text, 1500)}`).join('\n\n'),
  }];
  for (const r of ok) {
    const j = await askProvider(r.provider, env, fetchFn, judgeSystem, judgeMessages);
    if (j?.text) return { answer: j.text, models: ok.map((x) => x.model), judgedBy: j.model, failed, ...timing() };
  }
  return { answer: ok[0].text, models: [ok[0].model], judgedBy: null, failed, ...timing() }; // 정리에 실패하면 첫 답을 그대로 쓴다
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

/** 요청 처리: 로그인한 승인된 사용자만 쓸 수 있다. */
export async function handle(req, env, fetchFn) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST만 지원합니다.' });
  try {
    const auth = { Authorization: req.headers.get('authorization') ?? '', apikey: req.headers.get('apikey') ?? '' };
    const base = env.SUPABASE_URL;
    const who = await fetchFn(`${base}/auth/v1/user`, { headers: auth });
    if (!who.ok) return json(401, { error: '로그인이 필요합니다.' });
    // 가입 승인제를 쓰는 서버라면 승인된 계정만 허용한다(승인제를 설치하지 않은 서버는 통과)
    const ok = await fetchFn(`${base}/rest/v1/rpc/golform_is_approved`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
    if (ok.ok && (await ok.json()) === false) return json(403, { error: '관리자 승인을 기다리는 계정입니다.' });

    const body = await req.json().catch(() => ({}));
    const question = String(body.question ?? '').trim();
    if (!question) return json(400, { error: '질문이 비어 있습니다.' });
    return json(200, await answer(question, body.context, Array.isArray(body.history) ? body.history : [], env, fetchFn));
  } catch (e) {
    return json(502, { error: String(e?.message ?? e) });
  }
}

if (typeof Deno !== 'undefined') Deno.serve((req) => handle(req, Deno.env.toObject(), fetch));
