/* ============================================================================
   ask.mjs — 사용자가 물어본 것에 AI 로 답한다
   ----------------------------------------------------------------------------
   이 앱은 정적 사이트라 브라우저에서 AI 를 부를 수 없다(키를 심으면 소스에
   그대로 노출된다). 그래서 질문은 **GitHub 이슈**로 올라오고, 이 스크립트가
   워크플로 안에서 답을 만들어 이슈에 댓글로 붙인다. 앱은 공개 GitHub API 로
   그 댓글을 읽어 화면에 보여준다. 키는 시크릿에만 있고 브라우저에는 없다.

   ⚠️ 이 파일이 지키는 것 (앱 최상위 원칙과 직결)

     · **금액을 받지 않는다.** 질문 본문에는 시드 금액이 들어오지 않는다.
       공개 저장소의 이슈라 적는 순간 공개된다. 그래서 답도 **금액이 아니라
       "시드의 몇 %"** 로 낸다. 원 단위 환산은 앱이 브라우저 안에서 한다.
       실제 금액은 이 스크립트도, 저장소도, 그 누구도 알지 못한다.

     · **매수·매도를 권하지 않는다.** "사세요/파세요/지금이 기회"는 쓰지
       않는다. 대신 **자리**로 답한다 — 노후자금의 코어 자리인가, 위성
       자리인가, 지금은 지켜보는 자리인가, 아니면 이 목적과 맞지 않는가.
       "안 하는 게 좋겠다"는 말은 할 수 있다. 그건 가격·시점에 대한 예측이
       아니라 **목적과의 적합성** 판단이다.

     · **단타를 돕지 않는다.** 목적은 노후자금이다. 며칠 안의 등락, 목표주가,
       매수 타이밍은 묻더라도 답하지 않고 그렇게 말한다.

     · **모르면 모른다고 한다.** 근거가 없으면 지어내지 않는다.
   ========================================================================== */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
/* 지시문과 맥락은 앱(ask.js)과 **한 벌**을 쓴다. 두 벌로 두면 한쪽만
   고쳐져서 같은 질문에 다른 답이 나온다. ask-brain.js 주석 참고. */
const BRAIN = createRequire(import.meta.url)('../ask-brain.js');
const SYSTEM = BRAIN.SYSTEM;

const j = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

/* ── 질문에서 종목을 알아낸다 ───────────────────────────────────
   앱이 종목 화면에서 물으면 본문에 "종목: 이름 (티커)" 줄이 붙는다.
   자유 질문이면 없을 수도 있다 — 그때는 종목 자료 없이 답한다. */
function pickStock(body) {
  const m = /^종목:\s*(.+?)\s*\(([A-Za-z0-9.\-]+)\)\s*$/m.exec(body || '');
  return m ? { name: m[1], ticker: m[2] } : null;
}
function pickMarket(body) {
  return /^시장:\s*미국/m.test(body || '') ? 'us' : 'kr';
}
function pickStyle(body) {
  const m = /^성향:\s*(.+?)\s*$/m.exec(body || '');
  return m ? m[1] : '알 수 없음';
}
/* 본문에서 "질문:" 아래 전부가 사람이 쓴 말이다. 없으면 본문 전체. */
function pickQuestion(body) {
  const i = (body || '').indexOf('질문:');
  let q = (i >= 0 ? body.slice(i + 3) : (body || ''));
  /* 앱이 맨 아래 붙이는 꼬리표는 사람이 쓴 말이 아니다. 떼어 낸다 —
     안 떼면 "블루칩 나침반 앱에서 보낸…"까지 질문으로 읽는다. */
  const cut = q.indexOf('\n---');
  if (cut >= 0) q = q.slice(0, cut);
  return q.trim().slice(0, 4000);
}

/* ── 1단계: 조사해서 사람이 읽을 답을 쓴다 ──────────────────── */
async function research(client, model, ctx, useSearch) {
  const req = {
    model, max_tokens: 6000, system: SYSTEM,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: ctx }]
  };
  if (useSearch) req.tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }];
  const res = await client.messages.create(req);
  return (res.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

/* ── 2단계: 그 답에서 앱이 쓸 값만 뽑는다 ───────────────────────
   비율(pct)을 굳이 따로 뽑는 이유: 앱이 브라우저 안에서 원 단위로 바꿔
   보여주려면 숫자가 필요하다. 글에서 정규식으로 긁으면 틀린다. */
async function extract(client, model, z, zodOutputFormat, answer) {
  const S = BRAIN.SHAPE;
  const Schema = z.object({
    verdict: z.enum(['core', 'satellite', 'watch', 'unsuited', 'general']).describe(S.verdict),
    headline: z.string().describe(S.headline),
    pctLo: z.number().describe(S.pctLo),
    pctHi: z.number().describe(S.pctHi),
    checks: z.array(z.string()).describe(S.checks)
  });
  const res = await client.messages.parse({
    model, max_tokens: 1500,
    system: BRAIN.EXTRACT_SYSTEM,
    output_config: { format: zodOutputFormat(Schema) },
    messages: [{ role: 'user', content: answer }]
  });
  if (!res.parsed_output) throw new Error('요약 파싱 실패');
  return res.parsed_output;
}

/* ── 본체 ──────────────────────────────────────────────────── */
export async function run({ body, apiKey, model }) {
  const stock = pickStock(body);
  const mk = pickMarket(body);
  const style = pickStyle(body);
  const q = pickQuestion(body);
  if (!q) throw new Error('질문이 비어 있습니다');

  const live = j('live.json', {});
  const ana = j('analysis.json', { items: {} }).items || {};

  /* 맥락도 앱과 같은 것을 쓴다(ask-brain.js). 이 앱이 이미 아는 것을 먼저
     붙여야 AI 가 같은 걸 다시 조사하다 엉뚱한 소리를 하지 않고, 화면과 답이
     어긋나지도 않는다. */
  const card = stock ? (ana[stock.ticker] || null) : null;
  const px = stock && live.stocks && live.stocks[mk] ? live.stocks[mk][stock.ticker] : null;
  const ctx = BRAIN.buildContext({
    style, mk, question: q,
    regime: (live.regime && live.regime[mk]) || null,
    news: (live.news && live.news[mk]) || [],
    asOf: live.asOf || '',
    stock: stock ? { name: stock.name, ticker: stock.ticker } : null,
    card,
    chg: px && typeof px.chg === 'number' ? px.chg : null
  });


  /* 무엇을 보내는지 눈으로 확인하는 길. 크레딧을 쓰지 않는다.
     금액이 새어 나가지 않는지 보는 데에도 이걸 쓴다. */
  if (process.env.ASK_DRYRUN) {
    console.log(ctx);
    return { answer: '(dry run)', meta: null, stock };
  }

  const [{ default: Anthropic }, { z }, { zodOutputFormat }] = await Promise.all([
    import('@anthropic-ai/sdk'), import('zod'), import('@anthropic-ai/sdk/helpers/zod')
  ]);
  const client = new Anthropic({ apiKey });
  const m = model || 'claude-opus-5';

  /* 웹 검색이 되면 "요즘 상황"이 진짜 요즘이 된다. 계정에서 안 되면
     조용히 검색 없이 다시 부른다 — 검색이 안 된다고 답을 못 줄 이유는 없다. */
  let answer;
  try {
    answer = await research(client, m, ctx, true);
  } catch (e) {
    console.log('웹 검색 없이 다시 시도합니다:', e.message);
    answer = await research(client, m, ctx, false);
  }
  if (!answer) throw new Error('답이 비어 있습니다');

  let meta = null;
  try {
    meta = await extract(client, m, z, zodOutputFormat, answer);
  } catch (e) {
    console.log('값 뽑기 실패 — 글만 붙입니다:', e.message);
  }

  return { answer, meta, stock };
}
