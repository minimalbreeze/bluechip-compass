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

/* 뉴스 RSS. 위에서부터 시도해서 필요한 개수가 차면 멈춘다.
   한 곳이 죽어도 다른 곳으로 메워지도록 여러 개를 둔다. */
const FEEDS = {
  kr: [
    { name: '연합뉴스', url: 'https://www.yna.co.kr/rss/economy.xml' },
    { name: '한국경제', url: 'https://www.hankyung.com/feed/finance' },
    { name: '매일경제', url: 'https://www.mk.co.kr/rss/50200011/' }
  ],
  us: [
    { name: 'CNBC', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258' },
    { name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
    { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex' }
  ]
};
const NEWS_PER_MARKET = 6;
const PER_FEED = 20;

/* ── 개별 종목 시세 ───────────────────────────────────────────
   모의투자가 의미 있으려면 지수만으로는 안 되고 종목 시세가 있어야 한다.
   유니버스는 data.js 한 곳에만 적혀 있으므로 여기서 그 파일을 읽어 티커를
   뽑는다. 목록을 두 군데 적으면 반드시 어긋난다.                         */
function universeSymbols() {
  const src = readFileSync('data.js', 'utf8');
  const usAt = src.indexOf('var US_PICKS');
  if (usAt < 0) throw new Error('data.js 구조가 바뀌었다 — US_PICKS 를 찾을 수 없다');
  const grab = (text) => [...text.matchAll(/ticker:\s*'([^']+)'/g)].map(m => m[1]);
  const kr = grab(src.slice(0, usAt));
  const us = grab(src.slice(usAt));
  if (kr.length < 5 || us.length < 5) throw new Error('티커 추출 실패 kr=' + kr.length + ' us=' + us.length);
  return {
    /* 야후 표기: 코스피는 .KS 접미사, 미국은 점 대신 하이픈(BRK.B → BRK-B) */
    kr: kr.map(t => ({ t, y: t + '.KS' })),
    us: us.map(t => ({ t, y: t.replace(/\./g, '-') }))
  };
}

/* 26개를 하나씩 부르면 느리다. 소규모 동시 실행 풀로 돌린다. */
async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); }
      catch (e) { out[idx] = { error: e.message }; }
    }
  }));
  return out;
}

/* 증권과 상관있는 기사만 고르기 위한 단어들.
   경제 RSS에는 건강기능식품 재평가, 지역 개발 같은 기사가 섞여 들어온다.
   제목만으로 거르는 거친 방법이지만, 이 앱에 필요한 건 "오늘 시장 이야기"
   여섯 줄이지 경제면 전체가 아니다. */
const MARKET_WORDS = {
  kr: /코스피|코스닥|증시|증권|주가|주식|상장|공모주|청약|배당|자사주|실적|영업이익|어닝|외국인|기관|순매수|순매도|반도체|금리|환율|원\/달러|채권|국채|연준|한은|기준금리|뉴욕증시|나스닥|다우|시가총액|시총|밸류업|공시|인수|합병|증자/,
  /* \b 를 각 낱말마다 붙인다. 안 붙이면 supermarket 이 market 에 걸린다. */
  us: /\b(stocks?|markets?|shares?|equit\w*|nasdaq|dow|s&p|fed|rates?|yields?|earnings|inflation|treasur\w*|bonds?|wall street|index|indexes|futures|dividends?|buybacks?|ipo|tariffs?|cpi|jobs report|rally|selloff|bull market|bear market)\b/i
};
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

async function getText(url, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml, */*' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

/* 아주 작은 RSS 파서. 의존성을 늘리지 않으려고 정규식으로 처리한다.
   제목은 남의 서버에서 온 문자열이므로 **태그를 전부 벗겨** 저장한다.
   (앱에서도 다시 이스케이프하지만, 저장 단계에서 한 번 더 막는다) */
function stripTags(x) {
  return String(x)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    /* 숫자·16진 엔티티. 안 풀면 제목에 &#x2018; 이 그대로 찍힌다.
       제어문자는 버린다. */
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, x) {
      const c = parseInt(x, 16);
      return c >= 32 ? String.fromCodePoint(c) : '';
    })
    .replace(/&#(\d+);/g, function (_, d) {
      const c = parseInt(d, 10);
      return c >= 32 ? String.fromCodePoint(c) : '';
    })
    .replace(/&amp;/g, '&')
    /* 엔티티를 되돌린 뒤 남은 꺾쇠는 통째로 버린다.
       기사 제목에 <> 가 필요한 경우는 거의 없고, 이걸 지우면 저장 단계에서
       주입 경로가 아예 사라진다. 앱에서도 다시 이스케이프한다(이중 방어). */
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function pick(block, tag) {
  const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  return m ? m[1] : '';
}
function parseRss(xml, source) {
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  const out = [];
  for (const it of items) {
    const title = stripTags(pick(it, 'title'));
    let link = stripTags(pick(it, 'link'));
    if (!link) {
      const a = it.match(/<link[^>]*href=["']([^"']+)["']/i);   // Atom 형식
      if (a) link = a[1];
    }
    const date = stripTags(pick(it, 'pubDate') || pick(it, 'updated') || pick(it, 'published'));
    if (!title || !/^https?:\/\//.test(link)) continue;
    if (title.length > 140) continue;               // 본문이 통째로 들어온 경우 버린다
    out.push({ title, link, source, date: date || null });
  }
  return out;
}

async function fetchNews(marketKey) {
  /* 피드별로 넉넉히 모은 뒤, (1) 증권 관련 여부로 거르고
     (2) 출처를 번갈아 뽑는다. 한 매체가 목록을 독점하면 그 매체의 관심사가
     곧 "오늘의 시장"이 되어 버린다. */
  const buckets = [];
  for (const f of FEEDS[marketKey]) {
    try {
      const items = parseRss(await getText(f.url), f.name).slice(0, PER_FEED);
      buckets.push(items);
    } catch (e) {
      failed.push('news/' + marketKey + '/' + f.name + ': ' + e.message);
      buckets.push([]);
    }
  }

  const re = MARKET_WORDS[marketKey];
  const seen = new Set();
  const out = [];

  /* pass 1은 증권 관련만, pass 2는 남은 것으로 채운다. */
  for (const onlyRelevant of [true, false]) {
    const cursors = buckets.map(() => 0);
    let moved = true;
    while (out.length < NEWS_PER_MARKET && moved) {
      moved = false;
      for (let b = 0; b < buckets.length && out.length < NEWS_PER_MARKET; b++) {
        while (cursors[b] < buckets[b].length) {
          const it = buckets[b][cursors[b]++];
          const key = it.title.slice(0, 40);
          if (seen.has(key)) continue;
          if (onlyRelevant && !re.test(it.title)) continue;
          seen.add(key);
          out.push(it);
          moved = true;
          break;
        }
      }
    }
    if (out.length >= NEWS_PER_MARKET) break;
  }
  return out;
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

const failed = [];
const quotes = {};
for (const s of SYMBOLS) {
  try { quotes[s] = await quote(s); }
  catch (e) { failed.push(s + ': ' + e.message); }
}

let fx = null;
try { fx = await fxRange(); } catch (e) { failed.push('fxRange: ' + e.message); }

const news = { kr: await fetchNews('kr'), us: await fetchNews('us') };

/* 개별 종목 시세 — 모의투자용 */
const stocks = { kr: {}, us: {} };
try {
  const uni = universeSymbols();
  for (const mk of ['kr', 'us']) {
    const res = await pool(uni[mk], 5, async (s) => ({ t: s.t, q: await quote(s.y) }));
    for (const r of res) {
      if (r && r.q) stocks[mk][r.t] = r.q;
      else if (r && r.error) failed.push('stock/' + mk + ': ' + r.error);
    }
  }
} catch (e) {
  failed.push('universe: ' + e.message);
}

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
    /* 뉴스도 하나도 못 받았으면 이전 것을 남긴다 — 빈 목록보다 낫다 */
    for (const mk of ['kr', 'us']) {
      if (!news[mk].length && old.news?.[mk]?.length) news[mk] = old.news[mk];
      /* 종목 시세도 빠진 것만 이전 값으로 메운다 */
      for (const t in (old.stocks?.[mk] || {})) {
        if (!stocks[mk][t]) { stocks[mk][t] = old.stocks[mk][t]; stocks[mk][t].stale = true; }
      }
    }
  } catch { /* 이전 파일이 깨졌으면 무시하고 새로 쓴다 */ }
}

writeFileSync(OUT, JSON.stringify({
  asOf: new Date().toISOString(),
  source: 'Yahoo Finance chart API',
  quotes,
  fx,
  stocks,
  news,
  failed
}, null, 2) + '\n');

console.log('완료: 지수 ' + Object.keys(quotes).length + '/' + SYMBOLS.length,
  '· 종목 kr ' + Object.keys(stocks.kr).length + ' / us ' + Object.keys(stocks.us).length,
  '· 뉴스 kr ' + news.kr.length + ' / us ' + news.us.length);
