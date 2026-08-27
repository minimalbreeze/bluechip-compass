/* ============================================================================
   check-cors.mjs — 브라우저가 이 주소를 직접 부를 수 있는지 확인한다
   ----------------------------------------------------------------------------
   이 저장소의 구조 전체가 "증권 API 는 CORS 를 안 줘서 러너가 대신 받는다"는
   전제 위에 서 있다(fetch-live.mjs 머리말). 그런데 그 전제가 지금도 맞는지
   확인해 본 적이 없었고, GitHub 크론이 밀리면서 그 대가가 커졌다 —
   8시간 넘게 시세가 안 들어온 날이 나왔다.

   전제가 틀렸다면(= 야후가 CORS 를 준다면) 브라우저가 직접 받아올 수 있고,
   그러면 시세만큼은 크론에서 완전히 자유로워진다. 그래서 실제 응답 헤더를
   확인한다. 러너에서만 돌린다 — 이 안에서는 CORS 가 적용되지 않으므로
   **헤더를 읽어 브라우저가 어떻게 판단할지를 추론**하는 것이다.
   ========================================================================== */
const ORIGIN = 'https://maumjaro.minimalbreeze.com';
const TARGETS = [
  ['야후 시세(차트)', 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1d'],
  ['야후 시세(대체)', 'https://query2.finance.yahoo.com/v8/finance/chart/005930.KS?range=1d&interval=1d'],
  ['연합뉴스 RSS',   'https://www.yna.co.kr/rss/economy.xml'],
  ['CNBC RSS',       'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258']
];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function verdict(h, status) {
  const allow = h.get('access-control-allow-origin');
  if (!allow) return ['❌', '브라우저가 막는다 (Access-Control-Allow-Origin 없음)'];
  if (allow === '*') return ['✅', '브라우저가 직접 부를 수 있다 (허용: *)'];
  if (allow === ORIGIN) return ['✅', `브라우저가 직접 부를 수 있다 (허용: ${allow})`];
  return ['⚠️', `다른 출처만 허용한다 (${allow})`];
}

for (const [name, url] of TARGETS) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    /* 브라우저가 보내는 것과 같은 Origin 을 실어 보낸다 */
    const r = await fetch(url, { signal: ctl.signal,
      headers: { 'User-Agent': UA, 'Origin': ORIGIN, 'Accept': '*/*' } });
    clearTimeout(t);
    const [mark, say] = verdict(r.headers, r.status);
    console.log(`${mark} ${name}`);
    console.log(`     HTTP ${r.status} · ${say}`);
    const vary = r.headers.get('vary');
    if (vary && /origin/i.test(vary)) console.log(`     (Vary: ${vary})`);
  } catch (e) {
    console.log(`❌ ${name}`);
    console.log(`     못 불렀다: ${e.message}`);
  }
}
console.log('\n판단 기준: ✅ 가 하나라도 있으면 그 자료는 브라우저가 직접 받아올 수 있고,');
console.log('           크론이 밀려도 앱을 여는 순간 최신값을 볼 수 있다.');
