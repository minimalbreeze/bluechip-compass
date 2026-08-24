/* ============================================================================
   judge-news.mjs — 기사마다 "그래서 오늘 뭘 해야 하나"를 판정한다
   ----------------------------------------------------------------------------
   예전에는 뉴스 밑에 3문항 자가점검을 두고 사용자가 스스로 답하게 했다.
   좋은 질문이었지만, 헤드라인 여섯 개를 읽을 때마다 세 번씩 자문하라는 건
   현실적으로 아무도 하지 않는다. 결국 헤드라인만 읽고 불안해지는 화면이 됐다.

   그래서 같은 3문항을 **판정기가 대신 답한다.** 사용자가 확인할 것은
   기사 옆에 붙은 한 줄뿐이다.

   ⚠️ 절대 하지 않는 것
     · "팔아라 / 사라"를 말하지 않는다. 이 앱은 추천하지 않는다.
       판정값은 셋뿐이다 — 오늘 할 일 없음 / 지켜보기 / 근거 다시 확인.
     · 헤드라인에서 인과("이 뉴스 때문에 시장이 빠졌다")를 지어내지 않는다.
       확인할 수 없는 인과관계다.
     · 종목을 지목하지 않는다. scope 로 "무엇에 관한 이야기인지"만 말한다.

   두 갈래는 judge-regime.mjs 와 같다. 키가 없어도 항상 판정이 나온다.
   ========================================================================== */

/* why 는 앱에서 이스케이프해 넣는다(AI 출력이 같은 칸에 들어가므로).
   그래서 아래 규칙 문장에도 HTML 태그를 쓰지 않는다. */
const ACT     = ['none', 'watch', 'review'];
const LASTING = ['temporary', 'structural'];
const SCOPE   = ['market', 'sector', 'company'];

/* 구조 변화를 의심할 만한 낱말. 규제·판결·기술 대체처럼 "10년 뒤 이익"을
   실제로 바꿀 수 있는 사건들이다. 키워드는 거친 잣대라 최대 'watch' 까지만
   올린다 — 제목 몇 글자로 "근거를 다시 확인하라"까지 말할 수는 없다. */
const STRUCTURAL = /(규제|제재|판결|소송|특허|반독점|국유화|파산|회생|상장폐지|인수|합병|분할|관세|수출\s?통제|금수|리콜|불매|사업\s?철수|구조조정|감산|증설|공장\s?신설|기술\s?유출|해킹|담합|과징금|법인세|세제\s?개편|sanction|tariff|antitrust|lawsuit|verdict|patent|bankrupt|delist|merger|acquisition|recall|export\s+control|ban(?:ned|s)?\b|probe|indict)/i;

/* 대부분의 뉴스가 여기에 해당한다. 분기 실적, 목표주가, 정치 발언, 하루 등락. */
const TEMPORARY = /(전망|목표주가|의견|발언|기대|우려|급등|급락|강세|약세|반등|하락\s?마감|상승\s?마감|장중|주간|전문가|분석|추천|랠리|조정|forecast|outlook|target\s+price|analyst|rally|slip|jump|surge|tumble|close[sd]?\s+(?:up|down)|premarket|futures)/i;

const COMPANY = /(실적|영업이익|매출|배당|자사주|주주총회|CEO|대표이사|신제품|수주|계약|earnings|revenue|dividend|buyback|guidance|launch)/i;
const MARKETW = /(코스피|코스닥|지수|환율|금리|연준|한국은행|물가|고용|국채|유가|S&P|Nasdaq|Dow|Fed|inflation|jobs|treasury|yield|oil)/i;

/* ── 규칙 판정 ────────────────────────────────────────────────
   키워드는 제목 몇 글자만 보는 거친 잣대다. 그래서 기본값을 "오늘 할 일 없음"
   으로 두고, 구조 변화 신호어가 보일 때만 한 단계 올린다. 모르면 아무것도
   하지 않는 쪽으로 기우는 게 이 앱의 원칙이다.                             */
export function judgeNewsByRules(item) {
  const t = (item.ko || item.title || '');
  const structural = STRUCTURAL.test(t) && !TEMPORARY.test(t);
  const scope = MARKETW.test(t) ? 'market' : COMPANY.test(t) ? 'company' : 'sector';

  if (structural) {
    return {
      act: 'watch', lasting: 'structural', scope,
      why: '제목에 규제·판결·인수처럼 구조를 바꿀 수 있는 낱말이 있습니다. ' +
           '보유 종목과 관련 있는지만 확인하세요.'
    };
  }
  return {
    act: 'none', lasting: 'temporary', scope,
    why: '실적·전망·등락처럼 이미 가격에 반영됐을 이야기로 보입니다.'
  };
}

export function judgeAllByRules(list) {
  return (list || []).map(judgeNewsByRules);
}

/* ── AI 판정 ────────────────────────────────────────────────── */
const SYSTEM = `당신은 한국 개인투자자용 앱의 뉴스 판정기입니다. 장기 보유 초보 투자자가 독자입니다.

헤드라인 목록을 받아 기사마다 세 가지를 판정하세요. 판정의 기준은 아래 세 질문입니다.

1. 이 뉴스가 10년 뒤 그 회사(또는 시장)의 이익을 바꾸는가?
2. 처음 그 종목을 산 이유를 무너뜨리는가?
3. 일시적 사건인가, 구조의 변화인가?

각 기사에 대해:
- act: none(오늘 할 일 없음) / watch(지켜보기) / review(투자 근거를 다시 확인)
- lasting: temporary(일시적) / structural(구조 변화)
- scope: market(시장 전체) / sector(업종) / company(개별 회사)
- why: 한국어 한 문장. 왜 그렇게 봤는지.

규칙:
1. **매수·매도를 권하지 마세요.** act 는 행동 강도이지 매매 지시가 아닙니다.
   "파세요", "사세요", "정리하세요" 같은 말을 why 에 쓰지 마세요.
2. 대부분의 뉴스는 이미 가격에 반영돼 있습니다. **기본값은 none 입니다.**
   review 는 규제 판결, 기술 대체, 시장 소멸처럼 투자 근거 자체가 흔들릴 때만 쓰세요.
3. 헤드라인에 없는 사실을 지어내지 마세요. 제목만으로 알기 어려우면 none 으로 두고 그렇게 말하세요.
4. "이 뉴스 때문에 시장이 빠졌다" 같은 인과를 지어내지 마세요. 확인할 수 없습니다.
5. 종목명을 지목해 언급하지 마세요. 무엇에 관한 이야기인지는 scope 로만 말합니다.
6. why 는 40자 안팎으로 짧게. 초보자가 읽는 문장입니다.
7. 기사 번호(i)는 입력에 주어진 번호를 그대로 쓰세요.`;

export async function judgeNewsByAI({ list, marketKey, apiKey, model }) {
  const [{ default: Anthropic }, { z }, { zodOutputFormat }] = await Promise.all([
    import('@anthropic-ai/sdk'),
    import('zod'),
    import('@anthropic-ai/sdk/helpers/zod')
  ]);

  const Schema = z.object({
    items: z.array(z.object({
      i: z.number(),
      act: z.enum(ACT),
      lasting: z.enum(LASTING),
      scope: z.enum(SCOPE),
      why: z.string()
    }))
  });

  const body = list.map((n, i) => `${i + 1}. ${n.ko || n.title}`).join('\n');
  const client = new Anthropic({ apiKey });
  const response = await client.messages.parse({
    model: model || 'claude-opus-5',
    max_tokens: 4000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    output_config: { format: zodOutputFormat(Schema) },
    messages: [{
      role: 'user',
      content: (marketKey === 'kr' ? '한국 증시' : '미국 증시') + ' 헤드라인입니다.\n\n' + body
    }]
  });

  if (response.stop_reason === 'refusal') throw new Error('refusal: ' + (response.stop_details?.category || ''));
  if (!response.parsed_output) throw new Error('구조화 출력 파싱 실패');
  return response.parsed_output.items;
}

/* 모델이 선택지를 벗어나거나 매매를 권하면 규칙 판정으로 되돌린다.
   화면에 나가는 건 사용자가 읽는 문장이라, 여기서 한 번 더 막는다. */
const SELL_WORDS = /(파세요|팔아|매도하|정리하세요|사세요|매수하세요|담으세요|비중을?\s?늘리|비중을?\s?줄이)/;

export function validateNews(judged, fallback) {
  const out = {
    act:     ACT.indexOf(judged.act) >= 0 ? judged.act : fallback.act,
    lasting: LASTING.indexOf(judged.lasting) >= 0 ? judged.lasting : fallback.lasting,
    scope:   SCOPE.indexOf(judged.scope) >= 0 ? judged.scope : fallback.scope,
    why:     typeof judged.why === 'string' && judged.why.trim() ? judged.why.trim() : fallback.why
  };
  if (SELL_WORDS.test(out.why)) return fallback;
  return out;
}
