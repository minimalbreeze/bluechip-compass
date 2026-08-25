/* ============================================================================
   analyze-stocks.mjs — 종목마다 "이게 뭐하는 회사인가"를 AI 로 정리한다
   ----------------------------------------------------------------------------
   "궁금한 주식을 치면 답을 받는" 화면에 쓸 자료를 만든다. 브라우저에서 AI 를
   부를 수는 없다 — 정적 사이트라 키를 심으면 소스에 그대로 노출된다. 그래서
   워크플로가 미리 만들어 analysis.json 에 넣고, 앱은 그 파일을 읽기만 한다.

   ⚠️ 이 파일이 만들지 않는 것 (앱 최상위 원칙과 직결)
     · **매수·매도 의견을 내지 않는다.** "사세요/파세요/비중을 늘리세요"는
       schema 에도 없고, 나와도 검증기가 걸러낸다.
     · **수치를 쓰지 않는다.** PER 12배, 부채비율 40%, 목표주가 같은 숫자는
       쓰는 순간 낡는다. 빌드도 서버도 없는 앱이라 고칠 방법이 없고, 초보자는
       그 틀린 숫자를 믿는다. 대신 `check` 로 **확인할 지표의 이름**을 주고
       원자료(DART·SEC)로 보낸다.
     · **주가를 예측하지 않는다.** "미래에 어떨 것인가"에는 주가가 아니라
       **50년 뒤에도 이 회사가 있을까**로 답한다. 그게 이 앱이 답할 수 있는
       유일한 미래다.

   점수 축은 유니버스 13종목과 **같은 잣대**를 쓴다(data.js AXES). 잣대가
   다르면 나란히 놓고 볼 수 없다.
   ========================================================================== */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const OUT = 'analysis.json';
const AXES = ['demand', 'moat', 'balance', 'cash', 'payout', 'geo'];

/* 한 번에 부르는 종목 수. 너무 많이 묶으면 한 종목당 설명이 얇아진다. */
const PER_CALL = 4;
/* 동시에 부르는 요청 수 */
const CONC = 3;

const SYSTEM = `당신은 한국 개인투자자용 앱의 종목 해설가입니다. 주식을 처음 시작하는 사람이 읽습니다.

받은 종목마다 "이게 뭐하는 회사이고, 50년 뒤에도 있을 회사인가"를 정리하세요.

## 점수 축 (각 1~5점)
- demand 수요 지속성: 50년 뒤에도 사람들이 이걸 필요로 할까? 기술이 아니라 욕구를 본다.
- moat 해자: 경쟁자가 돈을 퍼부어도 못 뺏는 게 있나? (브랜드·전환비용·네트워크효과·규모·규제장벽)
- balance 재무 체력: 불황이 3년 와도 버티나? 회사는 이익이 줄어서가 아니라 빚 만기를 못 넘겨서 망한다.
- cash 현금창출력: 장사해서 실제로 현금이 남나? 회계상 이익이 아니라 잉여현금흐름.
- payout 주주환원 지속성: 주주에게 돌려준 역사가 있나? 배당 이력은 경영진의 성격 검사지다.
- geo 지정학·규제 내성: 나라 하나, 규제 하나에 목숨이 걸려 있나?

## 반드시 지킬 것

1. **매수·매도 의견을 내지 마세요.** "사세요", "파세요", "추천합니다", "비중을 늘리세요",
   "지금이 기회", "저평가/고평가" 같은 말을 쓰지 마세요. 당신이 하는 일은 회사를 설명하는
   것이지 매매를 권하는 게 아닙니다.
2. **숫자를 쓰지 마세요.** PER, 부채비율, 영업이익률, 배당수익률, 목표주가, 시가총액 같은
   수치를 본문에 넣지 마세요. 이 파일은 오래 남고 수치는 금방 낡습니다. 수치가 필요한
   자리에는 check 에 "확인할 지표의 이름"만 적으세요.
3. **주가를 예측하지 마세요.** "오를 것", "떨어질 것", "성장할 것으로 기대" 같은 표현을
   쓰지 마세요. 미래에 대한 판단은 오직 점수 축(50년 존속 가능성)으로만 표현합니다.
4. 모르면 모른다고 하세요. 헷갈리는 회사는 점수를 낮게 주고 risk 에 왜 판단하기 어려운지
   적으세요. 지어내지 마세요.
5. 모든 문장은 한국어. 초보자가 읽습니다. 전문용어를 쓰면 괄호로 쉬운 말을 붙이세요.

## 각 항목
- one: 한 문장. 이 회사가 뭐하는 회사인지. 40자 안팎.
- how: 돈을 어떻게 버는지. 2~3문장. 초보자가 "아 이렇게 버는구나" 하고 알 수 있게.
- scores: 위 여섯 축 각 1~5.
- why: 3개의 문장. 점수를 그렇게 준 근거. 강점 2개 약점 1개를 섞으세요.
- risk: 이 회사를 구조적으로 무너뜨릴 수 있는 것. 2~3문장. 막연한 "경쟁 심화" 말고 구체적으로.
- check: 4개. 직접 확인할 지표의 **이름**만. 수치를 적지 마세요. 예: "분기 영업이익 (사이클 위치)"
- beginner: 초보자에게 한마디. 이 회사를 볼 때 흔히 하는 오해나 주의할 점. 2문장.`;

/* ── 검증 ──────────────────────────────────────────────────────
   화면에 나가는 건 사용자가 그대로 읽는 문장이다. 모델이 규칙을 어기면
   그 종목은 통째로 버린다 — 반쯤 어긴 걸 고쳐서 내보내는 것보다,
   없는 게 낫다. 없으면 앱이 "아직 정리되지 않았습니다"라고 말한다. */
const ADVICE = /(사세요|파세요|매수\s?추천|매도\s?추천|추천합니다|추천드립|비추천|담으세요|정리하세요|비중을?\s?(늘|줄)|지금이\s?(기회|적기)|저평가|고평가|매력적인\s?가격|사도\s?될|팔아야)/;
/* 낡을 수치. "50년", "3년" 같은 기간 표현은 살려야 하므로 단위를 특정한다. */
const NUMERIC = /(\d+(\.\d+)?\s?(배|%p|퍼센트)|per\s?\d|pbr\s?\d|roe\s?\d|목표\s?주가|시가총액\s?\d|배당수익률\s?\d|부채비율\s?\d|영업이익률\s?\d)/i;
const FUTURE = /(오를\s?것|상승할\s?것|하락할\s?것|떨어질\s?것|급등|급락|유망합니다|기대됩니다)/;

export function validateOne(a) {
  if (!a || typeof a !== 'object') return null;
  const text = [a.one, a.how, a.risk, a.beginner, ...(a.why || []), ...(a.check || [])]
    .filter(s => typeof s === 'string').join(' ');
  if (!text.trim()) return null;
  if (ADVICE.test(text))  return { bad: 'advice' };
  if (NUMERIC.test(text)) return { bad: 'numeric' };
  if (FUTURE.test(text))  return { bad: 'future' };

  const sc = {};
  for (const k of AXES) {
    const v = Number(a.scores ? a.scores[k] : NaN);
    if (!(v >= 1 && v <= 5)) return { bad: 'scores' };
    sc[k] = Math.round(v);
  }
  const why = (a.why || []).filter(s => typeof s === 'string' && s.trim()).slice(0, 3);
  const check = (a.check || []).filter(s => typeof s === 'string' && s.trim()).slice(0, 4);
  if (why.length < 2 || check.length < 2) return { bad: 'thin' };

  return {
    one: String(a.one || '').trim(),
    how: String(a.how || '').trim(),
    scores: sc, why, risk: String(a.risk || '').trim(),
    check, beginner: String(a.beginner || '').trim(),
    by: 'ai'
  };
}

/* ── AI 호출 ───────────────────────────────────────────────── */
async function askBatch(batch, marketKey, apiKey, model) {
  const [{ default: Anthropic }, { z }, { zodOutputFormat }] = await Promise.all([
    import('@anthropic-ai/sdk'),
    import('zod'),
    import('@anthropic-ai/sdk/helpers/zod')
  ]);
  const Schema = z.object({
    items: z.array(z.object({
      ticker: z.string(),
      one: z.string(),
      how: z.string(),
      scores: z.object({
        demand: z.number(), moat: z.number(), balance: z.number(),
        cash: z.number(), payout: z.number(), geo: z.number()
      }),
      why: z.array(z.string()),
      risk: z.string(),
      check: z.array(z.string()),
      beginner: z.string()
    }))
  });
  const body = batch.map(b => `- ${b.ticker} : ${b.name}`).join('\n');
  const client = new Anthropic({ apiKey });
  const res = await client.messages.parse({
    model: model || 'claude-opus-5',
    max_tokens: 8000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    output_config: { format: zodOutputFormat(Schema) },
    messages: [{
      role: 'user',
      content: (marketKey === 'kr' ? '한국(KOSPI/KOSDAQ)' : '미국') +
        ' 상장 종목입니다. ticker 는 입력 그대로 쓰세요.\n\n' + body
    }]
  });
  if (res.stop_reason === 'refusal') throw new Error('refusal');
  if (!res.parsed_output) throw new Error('파싱 실패');
  return res.parsed_output.items;
}

/* ── 본체 ──────────────────────────────────────────────────── */
export async function run({ want, apiKey, model, limit }) {
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { items: {} };
  const items = prev.items || {};

  /* 이미 있는 건 다시 만들지 않는다. 회사 설명은 자주 바뀌는 자료가 아니고,
     매번 다시 부르면 같은 회사가 날마다 다른 점수를 받는다. */
  const todo = want.filter(w => !items[w.ticker]).slice(0, limit);
  if (!todo.length) {
    console.log(`할 일 없음 — ${Object.keys(items).length}종목 이미 정리돼 있습니다.`);
    return { added: 0, total: Object.keys(items).length };
  }
  console.log(`정리할 종목 ${todo.length}건 (이미 있음 ${Object.keys(items).length}건)`);

  const batches = [];
  for (let i = 0; i < todo.length; i += PER_CALL) batches.push(todo.slice(i, i + PER_CALL));

  let added = 0, dropped = 0;
  let bi = 0;
  async function worker() {
    while (bi < batches.length) {
      const batch = batches[bi++];
      const mk = batch[0].market;
      try {
        const got = await askBatch(batch, mk, apiKey, model);
        for (const g of got) {
          const want1 = batch.find(b => b.ticker.toUpperCase() === String(g.ticker || '').toUpperCase());
          if (!want1) continue;
          const ok = validateOne(g);
          if (!ok || ok.bad) {
            dropped++;
            console.log(`  ✕ ${want1.ticker} ${want1.name} — 규칙 위반(${ok ? ok.bad : 'empty'}), 버립니다`);
            continue;
          }
          items[want1.ticker] = Object.assign({ name: want1.name, market: mk }, ok);
          added++;
          console.log(`  ✓ ${want1.ticker} ${want1.name}`);
        }
      } catch (e) {
        console.log(`  ! 배치 실패(${batch.map(b => b.ticker).join(',')}): ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, batches.length) }, worker));

  writeFileSync(OUT, JSON.stringify({
    asOf: new Date().toISOString(),
    model: model || 'claude-opus-5',
    items
  }, null, 0));
  const total = Object.keys(items).length;
  console.log(`\n새로 ${added}건, 버린 것 ${dropped}건. 파일에 모두 ${total}종목.`);
  return { added, dropped, total };
}
