/* ============================================================================
   fetch-live.mjs — 시세를 받아 live.json 으로 저장한다 (GitHub Actions 전용)
   ----------------------------------------------------------------------------
   왜 브라우저가 직접 안 부르고 여기서 받나:

   증권 API는 대부분 CORS 헤더를 주지 않아서, GitHub Pages 같은 정적 페이지의
   자바스크립트가 직접 호출하면 브라우저가 응답을 막는다. 공개 CORS 프록시를
   끼우는 방법도 있지만 남의 서버에 의존하게 되고 언제 죽을지 모른다.

   그래서 **GitHub Actions 러너가 서버 자격으로 받아와** 저장소에 커밋하고,
   앱은 같은 출처(Pages)에서 live.json 을 읽는다. CORS 문제가 아예 없고,
   Cloudflare 계정 같은 외부 인프라도 필요 없다.

   정직하게 말해 이건 "실시간"이 아니라 **주기적 스냅샷**이다. 크론 간격만큼
   늦고, GitHub 크론은 혼잡하면 몇 분 더 밀린다. 그래서 live.json 에 asOf 를
   같이 넣고 화면에 "몇 분 전 값"인지 항상 표시한다.

   ⚠️ 실패해도 기존 파일을 덮지 않는다. 낡은 값보다 나쁜 건 깨진 값이다.
   ========================================================================== */

import { writeFileSync, existsSync, readFileSync } from 'node:fs';

const SYMBOLS = ['^KS11', '^KQ11', 'KRW=X', '^GSPC', '^IXIC', '^VIX'];
const UA = 'Mozilla/5.0 (compatible; bluechip-compass/1.0)';
const OUT = 'live.json';

async function getJson(url, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

/* Yahoo chart API. meta 에 현재가와 전일 종가가 같이 들어온다. */
function chartUrl(sym, range, interval) {
  return 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(sym) + '?interval=' + interval + '&range=' + range;
}

async function quote(sym) {
  /* 등락률은 meta.previousClose 를 쓰지 않고 **일별 종가 두 개로 직접 계산**한다.
     Yahoo 의 previousClose 는 지수·환율·휴장일에 따라 어느 세션을 가리키는지가
     흔들려서, 그대로 쓰면 화면에 -6.9% 같은 값이 사실처럼 찍힌다.
     차트 시리즈의 마지막 두 종가는 의미가 하나뿐이라 흔들리지 않는다. */
  const j = await getJson(chartUrl(sym, '1mo', '1d'));
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error('no result');
  const m = res.meta || {};

  const closes = (res.indicators?.quote?.[0]?.close || []).filter(v => typeof v === 'number');
  if (closes.length < 2) throw new Error('not enough closes');

  const last = closes[closes.length - 1];
  const live = typeof m.regularMarketPrice === 'number' ? m.regularMarketPrice : last;

  /* 장중이면 마지막 일봉이 오늘치라 그 앞을 전일로 본다.
     장이 닫혀 현재가와 마지막 종가가 같으면 그 앞 두 개를 비교한다. */
  const sameAsLast = Math.abs(live - last) < Math.max(1e-6, Math.abs(last) * 1e-6);
  const prev = sameAsLast ? closes[closes.length - 2] : last;
  if (!prev) throw new Error('no prev close');

  return {
    price: live,
    prev,
    chg: Math.round((live - prev) / prev * 10000) / 100,
    basis: sameAsLast ? 'prev-daily-close' : 'last-daily-close',
    time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null
  };
}

/* 원/달러는 1년 범위 안에서 지금 어디쯤인지도 같이 낸다.
   "원화 약세인가"를 감이 아니라 위치로 판단하게 하기 위해서다. */
async function fxRange() {
  const j = await getJson(chartUrl('KRW=X', '1y', '1d'));
  const res = j?.chart?.result?.[0];
  const closes = (res?.indicators?.quote?.[0]?.close || []).filter(v => typeof v === 'number');
  if (closes.length < 30) return null;
  const low = Math.min(...closes), high = Math.max(...closes);
  const cur = closes[closes.length - 1];
  if (high === low) return null;
  return {
    low52: Math.round(low * 100) / 100,
    high52: Math.round(high * 100) / 100,
    pct: Math.round((cur - low) / (high - low) * 1000) / 1000
  };
}

const quotes = {};
const failed = [];
for (const s of SYMBOLS) {
  try { quotes[s] = await quote(s); }
  catch (e) { failed.push(s + ': ' + e.message); }
}

let fx = null;
try { fx = await fxRange(); } catch (e) { failed.push('fxRange: ' + e.message); }

if (failed.length) console.error('실패:', failed.join(' | '));

/* 전부 실패하면 아무것도 쓰지 않는다 — 기존 값을 유지하는 편이 낫다. */
if (Object.keys(quotes).length === 0) {
  console.error('모든 심볼 실패 — live.json 을 건드리지 않는다');
  process.exit(1);
}

/* 일부만 실패했으면 이전 값을 살려 둔다(장 마감·일시 오류로 빠지는 걸 막는다). */
if (existsSync(OUT)) {
  try {
    const old = JSON.parse(readFileSync(OUT, 'utf8'));
    for (const s of SYMBOLS) {
      if (!quotes[s] && old.quotes?.[s]) { quotes[s] = old.quotes[s]; quotes[s].stale = true; }
    }
    if (!fx && old.fx) fx = old.fx;
  } catch { /* 이전 파일이 깨졌으면 무시하고 새로 쓴다 */ }
}

writeFileSync(OUT, JSON.stringify({
  asOf: new Date().toISOString(),
  source: 'Yahoo Finance chart API',
  quotes,
  fx,
  failed
}, null, 2) + '\n');

console.log('완료:', Object.keys(quotes).length + '/' + SYMBOLS.length, '심볼');
