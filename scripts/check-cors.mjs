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
  ['야후 시세(query1)', 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1d'],
  ['야후 시세(query2)', 'https://query2.finance.yahoo.com/v8/finance/chart/005930.KS?range=1d&interval=1d'],
  ['스투크(stooq)',     'https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcv&h&e=csv'],
  ['연합뉴스 RSS',      'https://www.yna.co.kr/rss/economy.xml'],
  ['CNBC RSS',          'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258']
];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 한 번 두드려 본다. withOrigin 이면 브라우저처럼 Origin 을 실어 보낸다.
   429 는 잠깐 쉬었다 두 번 더 본다 — 한 번의 429 로 "막혔다"고 단정하면
   일시적인 혼잡을 영구적인 차단으로 오독하게 된다. */
async function probe(url, withOrigin) {
  const h = { 'User-Agent': UA, 'Accept': '*/*' };
  if (withOrigin) h['Origin'] = ORIGIN;
  for (let i = 0; i < 3; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(url, { signal: ctl.signal, headers: h });
      clearTimeout(t);
      if (r.status === 429 && i < 2) { await sleep(3000 * (i + 1)); continue; }
      return { status: r.status, acao: r.headers.get('access-control-allow-origin') };
    } catch (e) {
      if (i === 2) return { err: e.message };
      await sleep(2000);
    }
  }
  return { status: 429, acao: null, throttled: true };
}

function say(r) {
  if (r.err) return '못 부름 — ' + r.err;
  const a = r.acao;
  const cors = a === '*' ? '허용 *' : a ? '허용 ' + a : 'CORS 헤더 없음';
  return 'HTTP ' + r.status + (r.throttled ? '(계속 429)' : '') + ' · ' + cors;
}

console.log('각 주소를 두 가지로 두드린다 — Origin 없이(서버처럼) / Origin 실어서(브라우저처럼)\n');
for (const [name, url] of TARGETS) {
  const plain = await probe(url, false);
  await sleep(700);
  const cross = await probe(url, true);
  /* 브라우저가 실제로 쓸 수 있으려면: Origin 을 실어 보냈을 때 2xx 이고
     Access-Control-Allow-Origin 이 * 이거나 우리 출처여야 한다. */
  const usable = !cross.err && cross.status >= 200 && cross.status < 300 &&
                 (cross.acao === '*' || cross.acao === ORIGIN);
  console.log((usable ? '✅' : '❌') + ' ' + name);
  console.log('     서버처럼   : ' + say(plain));
  console.log('     브라우저처럼: ' + say(cross));
  if (!usable && plain.status >= 200 && plain.status < 300)
    console.log('     → 러너는 받을 수 있지만 브라우저는 막힌다. 지금 구조(러너가 대신 받기)가 맞다.');
  console.log('');
  await sleep(800);
}
console.log('판단: ✅ 인 자료만 브라우저가 직접 받아올 수 있다.');
console.log('      ❌ 는 크론이 밀리면 낡을 수밖에 없고, 앱은 그 사실을 화면에 적어야 한다.');
