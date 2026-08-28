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

const SYSTEM = `당신은 한국 개인투자자용 앱 "블루칩 나침반"의 상담 담당입니다.

## 읽는 사람
주식을 처음 시작하는 평범한 사람입니다. **노후자금**을 굴리려는 사람이고,
단타(데이트레이딩)를 하려는 사람이 아닙니다. 크게 버는 것보다 **크게 다치지
않는 것**이 훨씬 중요합니다.

## 반드시 지킬 것

1. **매수·매도를 권하지 마세요.** "사세요", "파세요", "지금이 기회",
   "저평가/고평가", 목표주가, 매수 타이밍은 쓰지 마세요.
   대신 **자리**로 답하세요 — 노후자금의 중심(코어) 자리인가, 곁다리(위성)
   자리인가, 지금은 지켜보는 자리인가, 이 목적과 아예 맞지 않는가.
   "이 목적에는 맞지 않아 보인다"는 말은 해도 됩니다. 그건 가격 예측이 아니라
   **목적과의 적합성** 판단입니다.

2. **금액으로 답하지 마세요. 비율로만 답하세요.** 이 사람의 투자금이 얼마인지
   당신은 모르고, 알아서도 안 됩니다. "전체 투자금의 몇 %"로만 말하세요.
   원 단위 환산은 앱이 사용자 기기 안에서 합니다.

3. **단타 질문에는 그 목적이 이 앱과 다르다고 말하세요.** 며칠 안의 등락,
   "언제 사면 되나", "얼마까지 갈까"는 답하지 말고 그 이유를 짧게 적으세요.

4. **모르면 모른다고 하세요.** 최근 실적이나 사건을 확실히 모르면 지어내지
   말고 "여기까지는 확인이 안 됩니다. 아래 원자료에서 직접 보세요"라고 쓰세요.

5. **수치를 단정하지 마세요.** PER, 부채비율, 목표주가 같은 숫자를 사실처럼
   적지 마세요. 대신 "무엇을 확인해야 하는지" 이름으로 알려주세요.

6. 존댓말로, 짧은 문장으로, 어려운 말에는 괄호로 뜻을 달아 쓰세요.
   전체를 휴대폰 한두 화면 안에서 읽을 수 있는 길이로 쓰세요.

7. 마지막에 "손실이 날 수도 있고 판단은 본인의 몫"이라는 취지를 한 줄로
   적으세요. 어떤 수익도 보장하지 마세요.`;

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
  const Schema = z.object({
    verdict: z.enum(['core', 'satellite', 'watch', 'unsuited', 'general'])
      .describe('core=노후자금의 중심 자리로 볼 만함 / satellite=곁다리 자리까지 / watch=지금은 지켜보는 자리 / unsuited=이 목적과 맞지 않음 / general=종목 판단이 아닌 일반 질문'),
    headline: z.string().describe('답을 한 문장으로. 20자 안팎'),
    pctLo: z.number().describe('전체 투자금 대비 하한 %. 해당 없으면 0'),
    pctHi: z.number().describe('전체 투자금 대비 상한 %. 담지 않는 쪽이거나 일반 질문이면 0'),
    checks: z.array(z.string()).describe('사용자가 직접 확인할 것의 이름. 없으면 빈 배열')
  });
  const res = await client.messages.parse({
    model, max_tokens: 1500,
    system: '아래 상담 답변에서 값만 뽑아 정리하세요. 새로운 판단을 만들지 말고 글에 있는 것만 옮기세요.',
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

  /* 이 앱이 이미 아는 것을 먼저 붙인다. AI 가 같은 걸 다시 조사하느라
     엉뚱한 소리를 하지 않게, 그리고 앱 화면과 답이 어긋나지 않게. */
  const parts = [];
  parts.push('## 이 사람에 대해 아는 것');
  parts.push('- 투자 성향: ' + style);
  parts.push('- 보고 있는 시장: ' + (mk === 'kr' ? '한국(코스피)' : '미국(나스닥·S&P 500)'));
  parts.push('- 목적: 노후자금을 손실 없이 불려 나가는 것. 단타가 아님');
  parts.push('- 투자 금액은 알려주지 않습니다. 비율로만 답하세요.');

  const rg = live.regime && live.regime[mk];
  if (rg) {
    parts.push('\n## 지금 시장 국면 (이 앱이 실제 수치로 판정한 것)');
    if (rg.summary) parts.push('- ' + rg.summary);
    parts.push('- 금리 ' + rg.rates + ' / 경기 ' + rg.growth + ' / 밸류 ' + rg.valuation +
      ' / 환율 ' + rg.fx + ' / 지정학 ' + rg.geo);
  }

  if (stock) {
    /* 사용자가 이 종목 화면에서 물었다는 뜻이지, 반드시 이 종목을 묻는다는
       뜻은 아니다. 삼성전자를 보다가 다른 회사를 물을 수도 있다. */
    parts.push('\n## 질문할 때 보고 있던 종목 (참고용. 질문의 주제가 아닐 수도 있습니다)\n- ' +
      stock.name + ' (' + stock.ticker + ')');
    const card = ana[stock.ticker];
    if (card) {
      parts.push('\n### 이 앱이 이미 정리해 둔 내용 (여기서 벗어나는 말을 할 때는 왜인지 적으세요)');
      if (card.one) parts.push('- 뭐하는 회사: ' + card.one);
      if (card.risk) parts.push('- 이 판단을 깨뜨리는 것: ' + card.risk);
      if (card.scores) parts.push('- 6축 점수(각 5점): ' + JSON.stringify(card.scores));
    } else {
      parts.push('- 이 앱에는 아직 이 종목 해설이 없습니다. 없다는 사실을 답에 적어 주세요.');
    }
    const px = live.stocks && live.stocks[mk] && live.stocks[mk][stock.ticker];
    if (px && typeof px.chg === 'number') parts.push('- 오늘 등락: ' + px.chg + '%');
  }

  const news = (live.news && live.news[mk]) || [];
  if (news.length) {
    parts.push('\n## 오늘 이 시장 기사 제목 (' + (live.asOf || '') + ')');
    news.slice(0, 12).forEach(n => parts.push('- ' + (n.ko || n.title || '')));
  }

  parts.push('\n## 물어본 것\n' + q);
  parts.push('\n위 질문에 답하세요. 아래 순서로, 각 항목은 짧게:\n' +
    '**뭘 물어보셨는지** / **뭐하는 회사인지**(종목 질문일 때) / ' +
    '**요즘 상황**(확인 안 되면 안 된다고) / **10년 뒤에도 있을 회사인지** / ' +
    '**노후자금에서 어떤 자리인지** / **담는다면 전체 투자금의 몇 %까지인지와 그 이유** / ' +
    '**직접 확인할 것** / **한 줄 고지**');

  const ctx = parts.join('\n');

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
