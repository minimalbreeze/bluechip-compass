/* ============================================================================
   judge-regime.mjs — 시장 국면을 자동으로 판정한다
   ----------------------------------------------------------------------------
   예전에는 사용자가 다이얼 5개를 직접 맞춰야 했다. "무엇을 봐야 하는지"를
   배운다는 장점이 있었지만, 매일 확인하라는 요구 자체가 부담이라 결국
   낡은 값으로 앱을 쓰게 됐다.

   그래서 판정을 자동화하되, **근거를 반드시 함께 낸다.** 값만 바뀌고 왜
   그런지 말하지 못하면 사용자는 그 판정을 검증할 수 없고, 그러면 이 앱이
   싫어하는 "그냥 믿으세요"가 된다. 판정마다 한 줄 이유를 붙이고, 무엇으로
   판정했는지(규칙/AI)도 화면에 밝힌다.

   두 갈래:
     · 규칙  — 키 없이 항상 동작. 실제 수치에서 기계적으로 도출한다.
               다만 금리·경기·밸류에이션은 **대용 지표**라 한계가 있다.
     · AI    — ANTHROPIC_API_KEY 가 있으면 같은 수치와 헤드라인을 함께 읽고
               판정한다. 규칙이 못 보는 맥락(관세 발표, 정책 전환 등)을 잡는다.
               실패하면 조용히 규칙으로 돌아간다.

   ⚠️ 어느 쪽이든 사용자가 직접 고칠 수 있어야 한다(앱의 "직접 고치기").
      자동 판정은 출발점이지 결론이 아니다.
   ========================================================================== */

const DIALS = {
  rates:     ['cut', 'hold', 'hike'],
  growth:    ['expand', 'slow', 'reces'],
  valuation: ['cheap', 'fair', 'rich'],
  fx:        ['strong', 'neutral', 'weak'],
  geo:       ['calm', 'tense', 'shock']
};

const IDX = { kr: '^KS11', us: '^GSPC' };

/* ── 규칙 판정 ────────────────────────────────────────────────
   수치가 없으면 그 항목만 'hold'/'fair' 같은 중립값으로 두고 이유에 밝힌다.
   모르면서 아는 척하지 않는 게 이 앱의 원칙이다.                          */
export function judgeByRules(marketKey, hist) {
  const idx = hist[IDX[marketKey]];
  const fx = hist['KRW=X'];
  const vix = hist['^VIX'];
  const tnx = hist['^TNX'];
  const out = { why: {} };

  /* 금리 — 미국 10년물 국채금리를 대용으로 쓴다. 정책금리 자체는 무료로
     안정적으로 받을 곳이 마땅치 않다.
     방향(3개월 변화)만 보면 1년 최고 구간에 눌러앉은 금리를 "멈춰 있음"으로
     읽는다. 그건 시장이 받는 압력과 다르다. 그래서 1년 범위 위치도 같이 본다:
     방향이 완만해도 극단에 있으면 그 극단 쪽으로 판정한다. */
  if (tnx && tnx.chg3m !== null) {
    if (tnx.chg3m > 8 || (tnx.chg3m > 2 && tnx.pct52 >= 0.85)) out.rates = 'hike';
    else if (tnx.chg3m < -8 || (tnx.chg3m < -2 && tnx.pct52 <= 0.15)) out.rates = 'cut';
    else out.rates = 'hold';
    out.why.rates = '미국 10년물 금리가 지금 ' + tnx.last + '%로, 3개월 전보다 ' +
      Math.abs(tnx.chg3m) + '% ' + (tnx.chg3m >= 0 ? '높고' : '낮고') +
      ' 최근 1년 범위(' + tnx.low52 + '~' + tnx.high52 + ')의 ' +
      Math.round(tnx.pct52 * 100) + '% 지점입니다. 정책금리 자체가 아니라 대용 지표입니다.';
  } else {
    out.rates = 'hold';
    out.why.rates = '금리 지표를 못 받아와 중립으로 뒀습니다.';
  }

  /* 경기 — 지수의 3개월 변화를 대용으로 쓴다. 주가는 경기를 앞서 반영한다. */
  if (idx && idx.chg3m !== null) {
    out.growth = idx.chg3m <= -12 ? 'reces' : idx.chg3m <= -2 ? 'slow' : 'expand';
    out.why.growth = '지수가 3개월 전보다 ' + (idx.chg3m > 0 ? '+' : '') + idx.chg3m +
      '% 입니다. 주가는 경기를 앞서 반영하므로 대용 지표로 씁니다.';
  } else {
    out.growth = 'slow';
    out.why.growth = '지수 히스토리를 못 받아와 보수적으로 뒀습니다.';
  }

  /* 밸류에이션 — 지수 PER 은 무료로 받기 어려워 1년 범위 위치로 대신한다.
     "비싸다"의 근사일 뿐 실제 밸류에이션이 아니라는 걸 이유에 적는다. */
  if (idx) {
    out.valuation = idx.pct52 >= 0.8 ? 'rich' : idx.pct52 <= 0.35 ? 'cheap' : 'fair';
    out.why.valuation = '지수가 최근 1년 범위의 ' + Math.round(idx.pct52 * 100) +
      '% 지점입니다. PER 이 아니라 가격 위치로 본 근사치입니다.';
  } else {
    out.valuation = 'fair';
    out.why.valuation = '지수 히스토리를 못 받아와 중립으로 뒀습니다.';
  }

  /* 환율 — 1년 범위 위치. 이건 대용이 아니라 정확한 지표다. */
  if (fx) {
    out.fx = fx.pct52 >= 0.66 ? 'weak' : fx.pct52 <= 0.33 ? 'strong' : 'neutral';
    out.why.fx = '원/달러가 ' + fx.last + '원으로 최근 1년(' + fx.low52 + '~' + fx.high52 +
      ') 범위의 ' + Math.round(fx.pct52 * 100) + '% 지점입니다.';
  } else {
    out.fx = 'neutral';
    out.why.fx = '환율을 못 받아와 중립으로 뒀습니다.';
  }

  /* 지정학 — VIX. 시장이 매긴 불안의 값이라 대용이 아니라 직접 지표에 가깝다. */
  if (vix) {
    out.geo = vix.last >= 30 ? 'shock' : vix.last >= 20 ? 'tense' : 'calm';
    out.why.geo = 'VIX 가 ' + vix.last + '입니다. 20 미만은 평온, 20~30은 긴장, 30 이상은 충격 구간으로 봅니다.';
  } else {
    out.geo = 'calm';
    out.why.geo = 'VIX 를 못 받아와 중립으로 뒀습니다.';
  }

  out.summary = '실제 수치에서 기계적으로 도출한 판정입니다. 금리·경기·밸류에이션은 대용 지표라 한계가 있습니다.';
  return out;
}

/* ── AI 판정 ──────────────────────────────────────────────────
   같은 수치에 헤드라인을 얹어 읽힌다. 규칙이 못 보는 맥락을 잡되,
   값은 반드시 정해진 선택지 안에서만 고르게 한다.                        */
function brief(marketKey, hist, news, rules) {
  const pick = (s) => hist[s] ? `${s}: 현재 ${hist[s].last}, 1년범위 ${hist[s].low52}~${hist[s].high52} (위치 ${Math.round(hist[s].pct52 * 100)}%), 3개월 변화 ${hist[s].chg3m}%` : `${s}: 자료 없음`;
  const lines = [
    `시장: ${marketKey === 'kr' ? '한국(코스피)' : '미국(S&P500)'}`,
    pick(IDX[marketKey]),
    pick('KRW=X'),
    pick('^VIX'),
    pick('^TNX'),
    '',
    '최근 헤드라인:',
    ...(news || []).slice(0, 6).map((n, i) => `${i + 1}. ${n.ko || n.title}`),
    '',
    '규칙 기반 1차 판정(참고): ' + JSON.stringify({
      rates: rules.rates, growth: rules.growth, valuation: rules.valuation, fx: rules.fx, geo: rules.geo
    })
  ];
  return lines.join('\n');
}

const SYSTEM = `당신은 한국 개인투자자용 앱의 시장 국면 판정기입니다.

주어진 수치와 헤드라인만 근거로, 아래 5개 항목을 각각 정해진 선택지 중 하나로 판정하세요.

- rates(금리 방향): cut(내리는 중) / hold(멈춰 있음) / hike(올리는 중)
- growth(경기): expand(괜찮음) / slow(둔화 중) / reces(침체 신호)
- valuation(밸류에이션): cheap(싼 편) / fair(보통) / rich(비싼 편)
- fx(원/달러): strong(원화 강세) / neutral(보통) / weak(원화 약세)
- geo(지정학·정책 긴장도): calm(평온) / tense(긴장) / shock(충격 발생)

규칙:
1. 각 판정마다 한국어로 한 문장 근거를 쓰세요. 근거에는 **주어진 수치를 인용**하세요.
2. 자료에 없는 사실을 지어내지 마세요. 근거가 약하면 중립값을 고르고 그렇게 말하세요.
3. 특정 종목을 추천하거나 매수·매도를 권하지 마세요. 이 앱은 투자 교육 자료입니다.
4. 수익률을 예측하지 마세요. 지금 상태를 분류하는 것이 전부입니다.
5. summary 는 한국어 두 문장 이내로, 지금 국면을 초보자가 이해할 말로 씁니다.`;

export async function judgeByAI({ hist, news, rulesKR, rulesUS, apiKey, model }) {
  const [{ default: Anthropic }, { z }, { zodOutputFormat }] = await Promise.all([
    import('@anthropic-ai/sdk'),
    import('zod'),
    import('@anthropic-ai/sdk/helpers/zod')
  ]);

  const One = z.object({
    rates: z.enum(DIALS.rates),
    growth: z.enum(DIALS.growth),
    valuation: z.enum(DIALS.valuation),
    fx: z.enum(DIALS.fx),
    geo: z.enum(DIALS.geo),
    why: z.object({
      rates: z.string(), growth: z.string(), valuation: z.string(),
      fx: z.string(), geo: z.string()
    }),
    summary: z.string()
  });
  const Schema = z.object({ kr: One, us: One });

  const client = new Anthropic({ apiKey });
  const response = await client.messages.parse({
    model: model || 'claude-opus-5',
    max_tokens: 4000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    output_config: { format: zodOutputFormat(Schema) },
    messages: [{
      role: 'user',
      content: '아래 두 시장을 각각 판정하세요.\n\n=== 한국 ===\n' +
        brief('kr', hist, news.kr, rulesKR) +
        '\n\n=== 미국 ===\n' + brief('us', hist, news.us, rulesUS)
    }]
  });

  if (response.stop_reason === 'refusal') throw new Error('refusal: ' + (response.stop_details?.category || ''));
  if (!response.parsed_output) throw new Error('구조화 출력 파싱 실패');
  return response.parsed_output;
}

/* 값이 선택지 안에 있는지 확인한다. 모델이 이상한 값을 내면 규칙 값으로 되돌린다. */
export function validate(judged, fallback) {
  const out = { why: {}, summary: judged.summary || fallback.summary };
  for (const k in DIALS) {
    out[k] = DIALS[k].indexOf(judged[k]) >= 0 ? judged[k] : fallback[k];
    out.why[k] = (judged.why && judged.why[k]) || fallback.why[k];
  }
  return out;
}
