/* ============================================================================
   quote.mjs — 야후 차트 응답에서 "현재가 · 전일 종가 · 등락률"을 뽑는다
   ----------------------------------------------------------------------------
   ⚠️ 이 셈법을 **두 벌로 두지 않는다.** 예전에는 fetch-live.mjs 와
      fetch-prices.mjs 가 각자 같은 계산을 들고 있었고, 주석에도 "같은
      셈법이다"라고 적혀 있었다. 그러다 fetch-live 만 고쳐서 **보유 종목
      시세(prices.json)는 틀린 채로 남았다.** 한 곳에 둔다.

   ── 전일 종가를 어떻게 정하나 (진단으로 확인한 사실) ──────────
   야후 응답을 직접 찍어 보고(diag → chart) 알아낸 것:

     1. `meta.previousClose` 는 **아예 없다**(undefined).
     2. `meta.chartPreviousClose` 는 어제가 아니라 **요청 구간(1개월) 직전**의
        종가다. KRW=X 에서 1435.70(한 달 전)이 나왔다. 쓰지 않는다.
     3. 일봉의 close 가 **null 인 날이 있다.** ^KS11 은 09-02 가 null 이었다.
        null 을 걸러내고 "뒤에서 두 번째"를 집으면 그저께 종가를 전일로
        쓰게 된다 — 코스피가 +1.6% 인 날 앱이 -2.91% 를 찍은 원인이다.

   그래서 야후만 믿지 않는다. 이 앱은 10분마다 스냅샷을 남기므로 **그날
   마지막으로 본 값을 스스로 기억**해 두었다가(dayClose) 야후의 빈칸을 메운다.

   고르는 순서: 야후 일봉의 마지막 유효 봉과 내 기억 중 **날짜가 더 최근인
   쪽**. 둘 다 없으면 등락률을 내지 않는다(chg: null) — 틀린 방향을 자신
   있게 보여주느니 모른다고 하는 편이 낫다.
   ========================================================================== */

/* 거래소 시각 기준 날짜(YYYY-MM-DD). 시간대를 손으로 더하지 않는다 —
   자정 근처에서 하루가 어긋난다. */
export function dayIn(tz, epochSec) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(epochSec * 1000))
    .reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${f.year}-${f.month}-${f.day}`;
}

export const DAYCLOSE_KEEP = 12;   /* 종목당 최근 며칠치만 들고 간다 */

/* res: chart.result[0] · dayClose: 지난 회차에서 넘어온 기억(수정된다) */
export function pickQuote(res, sym, dayClose) {
  const m = res.meta || {};
  const tz = m.exchangeTimezoneName || 'UTC';

  const rawC = res.indicators?.quote?.[0]?.close || [];
  const ts = res.timestamp || [];
  const bars = ts.map((t, i) => ({ t, c: rawC[i] }))
    .filter(b => typeof b.c === 'number' && typeof b.t === 'number');

  const live = typeof m.regularMarketPrice === 'number'
    ? m.regularMarketPrice
    : (bars.length ? bars[bars.length - 1].c : null);
  if (typeof live !== 'number') throw new Error('no price');

  const today = dayIn(tz, Math.floor(Date.now() / 1000));

  /* (1) 야후 일봉에서 오늘보다 앞선 마지막 **값이 있는** 봉 */
  const older = bars.filter(b => dayIn(tz, b.t) < today);
  const fromBar = older.length
    ? { day: dayIn(tz, older[older.length - 1].t), v: older[older.length - 1].c } : null;

  /* (2) 내가 기억해 둔, 오늘보다 앞선 마지막 날의 값 */
  const mem = (dayClose && dayClose[sym]) || {};
  const memDays = Object.keys(mem).filter(d => d < today).sort();
  const fromMem = memDays.length
    ? { day: memDays[memDays.length - 1], v: mem[memDays[memDays.length - 1]] } : null;

  let pick = null, basis = 'unknown';
  if (fromBar && fromMem) {
    pick = fromMem.day > fromBar.day ? fromMem : fromBar;
    basis = fromMem.day > fromBar.day ? 'prev-close-memo' : 'prev-close-bar';
  } else if (fromBar) { pick = fromBar; basis = 'prev-close-bar'; }
  else if (fromMem) { pick = fromMem; basis = 'prev-close-memo'; }

  /* 오늘 본 값을 기억해 둔다. 하루 동안 계속 덮어써서, 장 마감 뒤 회차의
     값이 그날의 마지막 값으로 남는다. */
  if (dayClose) {
    if (!dayClose[sym]) dayClose[sym] = {};
    dayClose[sym][today] = live;
    const keep = Object.keys(dayClose[sym]).sort().slice(-DAYCLOSE_KEEP);
    const trimmed = {};
    keep.forEach(d => { trimmed[d] = dayClose[sym][d]; });
    dayClose[sym] = trimmed;
  }

  let prev = pick ? pick.v : null;

  /* ⚠️ 액면분할·병합이 있으면 어제 종가와 오늘 가격이 **다른 단위**가 된다.
     그러면 등락률이 +901% 같은 값으로 나온다(실제로 prices.json 에 그런 값이
     12건 있었다). 하루에 35% 넘게 움직였다는 계산이 나오면 그건 시장이 아니라
     **전일 종가를 잘못 집은 것**으로 본다 — 국내 상·하한가가 ±30% 라 그
     바깥은 사실상 계산 오류다. 지어낸 숫자를 보여주느니 비운다. */
  const JUMP = 35;
  if (prev && Math.abs((live - prev) / prev * 100) > JUMP) {
    prev = null;
    basis = 'unknown-jump';
    pick = null;
  }

  return {
    price: live,
    prev,
    /* 모르면 숫자를 만들지 않는다. 앱은 null 을 받으면 등락률 자리를 비운다. */
    chg: prev ? Math.round((live - prev) / prev * 10000) / 100 : null,
    prevDay: pick ? pick.day : null,
    basis,
    time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null
  };
}
