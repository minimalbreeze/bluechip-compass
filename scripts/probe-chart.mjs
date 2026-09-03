/* ============================================================================
   probe-chart.mjs — 야후가 실제로 무엇을 주는지 눈으로 본다 (진단 전용)
   ----------------------------------------------------------------------------
   전일 종가를 어디서 가져와야 하는지 몇 번 잘못 짚었다. 개발 환경에서는
   야후가 막혀 있어 응답을 볼 수가 없어서, 추측으로 고치다 오히려 나빠졌다.
   (환율 전일 종가가 1,372 → 1,435 로 더 틀어진 회차가 있었다.)

   그래서 응답의 핵심만 로그에 찍는 워크플로를 따로 둔다. **고치기 전에
   먼저 본다.** 비밀은 하나도 안 쓰고 공개 API 만 부른다.
   ========================================================================== */
const SYMS = (process.env.PROBE_SYMS || '^KS11,KRW=X,^IXIC,005930.KS').split(',');

const dayIn = (tz, sec) => new Intl.DateTimeFormat('en-CA', {
  timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'
}).formatToParts(new Date(sec * 1000))
  .reduce((a, p) => (a[p.type] = p.value, a), {});

const fmtDay = (tz, sec) => { const f = dayIn(tz, sec); return `${f.year}-${f.month}-${f.day}`; };

for (const sym of SYMS) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(sym) + '?interval=1d&range=1mo';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) { console.log(`\n${sym}: HTTP ${r.status}`); continue; }
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    if (!res) { console.log(`\n${sym}: no result`); continue; }
    const m = res.meta || {}, tz = m.exchangeTimezoneName || 'UTC';
    const ts = res.timestamp || [];
    const cl = res.indicators?.quote?.[0]?.close || [];
    const adj = res.indicators?.adjclose?.[0]?.adjclose || null;

    console.log(`\n════════ ${sym} ════════`);
    console.log('  exchangeTimezoneName :', tz);
    console.log('  regularMarketPrice   :', m.regularMarketPrice);
    console.log('  regularMarketTime    :', m.regularMarketTime ? new Date(m.regularMarketTime*1000).toISOString() : null);
    console.log('  previousClose        :', m.previousClose);
    console.log('  chartPreviousClose   :', m.chartPreviousClose);
    console.log('  regularMarketDayHigh :', m.regularMarketDayHigh, '/ Low:', m.regularMarketDayLow);
    console.log('  timestamp 개수       :', ts.length, '· close 개수:', cl.length,
                '· adjclose:', adj ? adj.length : '없음');
    console.log('  오늘(거래소 기준)    :', fmtDay(tz, Math.floor(Date.now()/1000)));
    console.log('  --- 마지막 8개 봉 ---');
    for (let i = Math.max(0, ts.length - 8); i < ts.length; i++) {
      console.log(`    ${fmtDay(tz, ts[i])}  close=${cl[i]}` +
        (adj ? `  adj=${adj[i]}` : '') + `  (ts=${ts[i]})`);
    }
  } catch (e) {
    console.log(`\n${sym}: ERROR ${e.message}`);
  }
}
