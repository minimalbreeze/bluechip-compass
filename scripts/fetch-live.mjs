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
import { judgeByRules, judgeByAI, validate } from './judge-regime.mjs';
import { judgeAllByRules, judgeNewsByAI, validateNews } from './judge-news.mjs';

const SYMBOLS = ['^KS11', '^KQ11', 'KRW=X', '^GSPC', '^IXIC', '^VIX', '^TNX'];

/* 국면 판정에 쓸 1년 히스토리. 지금 값 하나로는 "비싼가/싼가"를 말할 수 없다 —
   같은 지수라도 1년 범위의 어디쯤인지를 알아야 판단이 선다. */
const HIST_SYMBOLS = ['^KS11', '^KQ11', 'KRW=X', '^GSPC', '^IXIC', '^VIX', '^TNX'];

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

/* ── 미국 기사 한국어 번역 ─────────────────────────────────────
   기계 번역은 금융 헤드라인의 뜻을 뒤집을 때가 있다("beat expectations"를
   "기대를 이겼다"로 옮기는 식). 그래서 앱은 **번역과 원문을 나란히** 보여주고
   기계 번역임을 밝힌다. 번역을 못 해도 원문이 그대로 보이므로 손해는 없다.

   같은 헤드라인을 30분마다 다시 번역할 이유가 없어 결과를 캐시한다.
   실제로 새로 번역해야 하는 건 하루 수십 건 수준이다.

   제공자:
     · DEEPL_API_KEY 를 저장소 시크릿에 넣으면 DeepL 을 쓴다(품질이 낫다)
     · 없으면 MyMemory 공개 API 를 쓴다(키 없이 되지만 하루 한도가 있다)
       MYMEMORY_EMAIL 을 넣으면 한도가 늘어난다                            */
const TR_MAX_PER_RUN = 12;     // 한 번에 새로 번역할 최대 건수
const TR_CACHE_MAX = 300;      // 캐시에 보관할 최대 항목 수
const NV_CACHE_MAX = 300;      // 기사 판정 캐시(같은 기사를 30분마다 다시 판정할 이유가 없다)
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

/* 번역 결과도 남의 서버에서 온 문자열이다. 저장 단계에서 꺾쇠를 지운다
   (앱에서도 다시 이스케이프한다). */
function sanitizeTr(x) {
  return String(x || '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    /* 무료 번역기가 흔히 내는 자잘한 흠을 다듬는다. 뜻을 바꾸지 않는
       표기 수준만 손대고, 어색한 번역 자체는 건드리지 않는다 —
       원문을 나란히 보여주는 게 그 몫이다. */
    .replace(/([$€£¥₩])\s+(?=[\d.,])/g, '$1')   // "$ 1,000" → "$1,000"
    .replace(/\s+([%,.])/g, '$1')                 // " %" " ," 앞 공백
    .replace(/\s*:\s*/g, ': ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function translateDeepL(texts, key) {
  const host = /:fx$/.test(key) ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const body = new URLSearchParams();
  body.set('target_lang', 'KO');
  body.set('source_lang', 'EN');
  texts.forEach(t => body.append('text', t));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(host + '/v2/translate', {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'Authorization': 'DeepL-Auth-Key ' + key,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return (j.translations || []).map(t => sanitizeTr(t.text));
  } finally { clearTimeout(timer); }
}

async function translateMyMemory(text) {
  const email = process.env.MYMEMORY_EMAIL;
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text.slice(0, 480)) +
    '&langpair=en|ko' + (email ? '&de=' + encodeURIComponent(email) : '');
  const j = await getJson(url, 15000);
  const out = j && j.responseData ? String(j.responseData.translatedText || '') : '';
  /* 한도 초과나 오류일 때 경고 문구를 번역문인 척 돌려준다 — 걸러내야 한다 */
  if (!out || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(out)) throw new Error('사용 불가 응답');
  if (j.responseStatus && Number(j.responseStatus) !== 200) throw new Error('status ' + j.responseStatus);
  return sanitizeTr(out);
}

/* items 의 title 을 한국어로 채운다. 캐시에 있으면 건너뛴다. */
async function translateNews(items, cache) {
  const key = process.env.DEEPL_API_KEY;
  const need = [];
  for (const it of items) {
    if (cache[it.title]) {
      /* 캐시에 담긴 예전 번역에도 다듬기를 다시 적용한다 — 후처리 규칙을
         고쳤을 때 이미 저장된 것만 낡은 표기로 남는 걸 막는다. */
      it.ko = sanitizeTr(cache[it.title]);
      cache[it.title] = it.ko;
      continue;
    }
    if (need.length < TR_MAX_PER_RUN) need.push(it);
  }
  if (!need.length) return;

  try {
    if (key) {
      const res = await translateDeepL(need.map(x => x.title), key);
      need.forEach((it, i) => {
        if (res[i] && res[i] !== it.title) { it.ko = res[i]; cache[it.title] = res[i]; }
      });
    } else {
      /* MyMemory 는 한 번에 하나씩만 받는다. 순차로 돌리되 실패하면 멈춘다 —
         한도에 걸린 상태에서 계속 두드릴 이유가 없다. */
      for (const it of need) {
        const ko = await translateMyMemory(it.title);
        if (ko && ko !== it.title) { it.ko = ko; cache[it.title] = ko; }
      }
    }
  } catch (e) {
    failed.push('translate: ' + e.message);
  }
}

/* Yahoo chart API. meta 에 현재가와 전일 종가가 같이 들어온다. */
function chartUrl(sym, range, interval) {
  return 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(sym) + '?interval=' + interval + '&range=' + range;
}

/* 거래소 시각 기준 날짜(YYYY-MM-DD). 시간대를 손으로 더하지 않는다 —
   자정 근처에서 하루가 어긋난다. */
function dayIn(tz, epochSec) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(epochSec * 1000))
    .reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${f.year}-${f.month}-${f.day}`;
}

async function quote(sym) {
  /* ── 전일 종가를 어떻게 정하나 ──────────────────────────────────
     이 값 하나가 틀리면 **오른 날을 내린 날로 보여준다.** 실제로 그랬다:
     2026-09-03 장중에 코스피가 +1.6% 인데 앱은 -2.91% 로 찍었다.

     원인은 예전 방식이었다 — 일별 종가 배열에서 **뒤에서 두 번째**를 전일로
     집었다. 시각을 보지 않으니, 야후의 일봉이 하루 밀려 어제(9/2) 봉이 아직
     안 들어온 날에는 그저께(9/1) 종가를 전일로 집는다.

     지금은 두 갈래로 구해서 **서로 맞는지 본다.**
       (1) meta.previousClose — 거래소가 말하는 직전 세션 종가
       (2) 일봉 시리즈에서 **거래소 날짜로 오늘보다 앞선** 마지막 종가
     둘이 어긋나면 **전일 종가를 모르는 것이다.** 그때는 등락률을 내지 않는다
     (chg: null). 틀린 방향을 자신 있게 보여주느니 모른다고 하는 편이 낫다 —
     이 앱의 첫 번째 약속이다. */
  const j = await getJson(chartUrl(sym, '1mo', '1d'));
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error('no result');
  const m = res.meta || {};
  const tz = m.exchangeTimezoneName || 'UTC';

  const rawC = res.indicators?.quote?.[0]?.close || [];
  const ts = res.timestamp || [];
  const bars = ts.map((t, i) => ({ t, c: rawC[i] }))
    .filter(b => typeof b.c === 'number' && typeof b.t === 'number');
  if (!bars.length) throw new Error('not enough closes');

  const live = typeof m.regularMarketPrice === 'number'
    ? m.regularMarketPrice : bars[bars.length - 1].c;

  /* (2) 오늘 봉을 빼고 남은 마지막 종가 */
  const today = dayIn(tz, Math.floor(Date.now() / 1000));
  const older = bars.filter(b => dayIn(tz, b.t) < today);
  const fromSeries = older.length ? older[older.length - 1].c : null;

  /* (1) 거래소가 말하는 직전 종가 */
  const fromMeta = [m.previousClose, m.chartPreviousClose]
    .find(v => typeof v === 'number' && v > 0) ?? null;

  /* 시리즈가 며칠씩 밀려 있으면 그 값을 전일로 볼 수 없다.
     (달력 기준 4일을 넘으면 밀린 것으로 본다 — 주말·공휴일은 3일까지 벌어진다) */
  const seriesDay = older.length ? dayIn(tz, older[older.length - 1].t) : null;
  const seriesLagDays = seriesDay
    ? Math.round((Date.parse(today) - Date.parse(seriesDay)) / 86400000) : Infinity;
  const seriesStale = seriesLagDays > 4;

  let prev = null, basis = null;
  if (fromMeta && fromSeries && !seriesStale) {
    /* 둘 다 있고 시리즈도 멀쩡하다. 5% 안에서 서로 비슷하면 **거래소 값**을
       쓴다(일봉은 하루 밀릴 수 있고 meta 는 안 밀린다). 많이 어긋나면 meta
       쪽이 엉뚱한 세션을 가리키는 것이므로 시리즈를 쓴다. */
    const gap = Math.abs(fromMeta - fromSeries) / fromSeries;
    if (gap <= 0.05) { prev = fromMeta; basis = 'prev-close'; }
    else { prev = fromSeries; basis = 'prev-close-series'; }
  } else if (fromMeta) {
    /* 시리즈가 없거나 밀렸다 — 거래소 값이 유일하게 믿을 만하다. */
    prev = fromMeta; basis = 'prev-close-meta';
  } else if (fromSeries && !seriesStale) {
    prev = fromSeries; basis = 'prev-close-series';
  } else {
    /* 어느 쪽도 못 믿는다. **숫자를 만들지 않는다.** */
    basis = 'unknown';
  }

  return {
    price: live,
    prev,
    /* 모르면 숫자를 만들지 않는다. 앱은 null 을 받으면 등락률 자리를 비운다. */
    chg: prev ? Math.round((live - prev) / prev * 10000) / 100 : null,
    basis,
    time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null
  };
}

/* 1년 종가에서 판정에 쓸 요약치를 뽑는다.
     pct52  최근 1년 범위에서 지금 위치 (0=최저, 1=최고)
     chg3m  3개월 전 대비 변화율(%)
   둘 다 "지금 값 하나"로는 알 수 없는 것들이다. */
async function history(sym) {
  const j = await getJson(chartUrl(sym, '1y', '1d'));
  const res = j?.chart?.result?.[0];
  const closes = (res?.indicators?.quote?.[0]?.close || []).filter(v => typeof v === 'number');
  if (closes.length < 60) throw new Error('종가가 부족하다: ' + closes.length);
  const last = closes[closes.length - 1];
  const low = Math.min(...closes), high = Math.max(...closes);
  const back = closes[Math.max(0, closes.length - 63)];   // 약 3개월(거래일 기준)
  return {
    last: Math.round(last * 100) / 100,
    low52: Math.round(low * 100) / 100,
    high52: Math.round(high * 100) / 100,
    pct52: high === low ? 0.5 : Math.round((last - low) / (high - low) * 1000) / 1000,
    chg3m: back ? Math.round((last - back) / back * 10000) / 100 : null
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

/* 판정용 히스토리 */
const hist = {};
for (const sym of HIST_SYMBOLS) {
  try { hist[sym] = await history(sym); }
  catch (e) { failed.push('hist/' + sym + ': ' + e.message); }
}

const news = { kr: await fetchNews('kr'), us: await fetchNews('us') };

/* 미국 기사만 번역한다. 국내 기사는 이미 한국어다. */
let trCache = {};
if (existsSync(OUT)) {
  try { trCache = JSON.parse(readFileSync(OUT, 'utf8')).trCache || {}; }
  catch { trCache = {}; }
}
await translateNews(news.us, trCache);

/* 캐시가 무한정 자라지 않게 최근 것만 남긴다 */
const trKeys = Object.keys(trCache);
if (trKeys.length > TR_CACHE_MAX) {
  const keep = {};
  trKeys.slice(-TR_CACHE_MAX).forEach(k => { keep[k] = trCache[k]; });
  trCache = keep;
}

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
    /* 히스토리도 빠진 것만 메운다 — 판정이 통째로 중립으로 무너지는 걸 막는다 */
    for (const sym of HIST_SYMBOLS) {
      if (!hist[sym] && old.hist?.[sym]) hist[sym] = old.hist[sym];
    }
  } catch { /* 이전 파일이 깨졌으면 무시하고 새로 쓴다 */ }
}

/* ── 국면 판정 ──────────────────────────────────────────────
   먼저 규칙으로 판정한다(키 없이도 항상 나온다). 키가 있으면 AI 가 같은
   수치와 헤드라인을 읽고 다시 판정하고, 실패하면 규칙 값을 그대로 쓴다.
   어느 쪽으로 판정했는지는 by 에 남겨 화면에 밝힌다.                     */
const rulesKR = judgeByRules('kr', hist);
const rulesUS = judgeByRules('us', hist);

/* 지난 판정을 읽어 둔다. 아래 두 가지에 쓴다 —
   (1) 하루가 안 지났으면 그대로 이어 쓰고, (2) AI 를 못 불렀을 때도
   그대로 이어 쓴다. 둘 다 "안 바뀐 것을 바뀐 것처럼 만들지 않기" 위해서다. */
let prevRegime = null;
if (existsSync(OUT)) {
  try { prevRegime = JSON.parse(readFileSync(OUT, 'utf8')).regime || null; } catch (e) {}
}
const prevAge = prevRegime && prevRegime.asOf
  ? (Date.now() - Date.parse(prevRegime.asOf)) / 3600000 : Infinity;

/* ⚠️ 국면은 **하루에 한 번만** 판정한다.
   예전에는 심장박동이 돌 때마다(장중 10분마다) 다시 판정했다. 시장 국면은
   10분짜리 값이 아닌데 10분마다 물으니, 같은 날 안에서 hold↔hike, calm↔tense
   가 오갔다. 실제 이력에 8/28·8/31 하루에 세 가지 국면이 찍혀 있다. 시장이
   세 번 바뀐 게 아니라 **경계선 위의 값을 매번 새로 물어서** 생긴 흔들림이다.
   이 앱은 노후자금을 굴리는 앱이고, 국면이 흔들리면 목표 배분이 흔들리고
   기준계좌가 그걸 따라 매매한다. 하루 한 번으로 못 박는다. */
/* ── 언제 새로 판정하나 ────────────────────────────────────────
   "20시간마다"로 두면 판정 시각이 매일 조금씩 뒤로 밀린다. 오늘 07시에
   판정하면 내일은 03시 이후 첫 회차, 그다음은 또 달라진다. 사용자가
   "매일 언제 갱신되는지" 알 수 없다.

   그래서 **한국 날짜 기준 하루 한 번**으로 못 박는다. 기준 시각은
   06:30 KST — 미국장이 21:00 UTC(06:00 KST)에 닫히므로, 그 뒤에 판정하면
   **직전 미국장 종가와 국내장 전일 종가를 모두 반영한 하나의 판정**이
   국내장 개장(09:00) 전에 준비된다.

   ⚠️ 시간대를 손으로 계산하지 않는다. UTC+9 를 더하는 식으로 쓰면 자정
      근처에서 날짜가 어긋난다. Intl 로 한국 날짜를 그대로 얻는다. */
const KST_JUDGE_HOUR = 6, KST_JUDGE_MIN = 30;
const kstParts = (d) => {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  return { date: `${f.year}-${f.month}-${f.day}`, min: +f.hour * 60 + +f.minute };
};
const nowK = kstParts(new Date());
const prevK = prevRegime && prevRegime.asOf ? kstParts(new Date(prevRegime.asOf)) : null;
const pastJudgeTime = nowK.min >= KST_JUDGE_HOUR * 60 + KST_JUDGE_MIN;
/* 오늘 아직 판정 안 했고, 기준 시각이 지났으면 판정한다.
   손으로 돌릴 때(REGIME_FORCE=1)는 언제든 다시 판정한다. */
const regimeDue = !!process.env.REGIME_FORCE ||
  !prevRegime || !prevK || (prevK.date !== nowK.date && pastJudgeTime);

let regime;

if (!regimeDue) {
  /* 아직 차례가 아니다 — 오늘 판정을 그대로 쓴다. asOf 도 그대로 둔다.
     여기서 asOf 를 지금으로 갈면 화면이 "방금 판정"이라고 거짓말을 한다. */
  regime = prevRegime;
  console.log(`국면: ${prevAge.toFixed(1)}시간 전(${prevK.date}) 판정을 그대로 씁니다 ` +
    `· 다음 판정은 ${prevK.date === nowK.date ? '내일' : '오늘'} 06:30 KST 이후 첫 회차`);
} else if (process.env.ANTHROPIC_API_KEY) {
  try {
    const ai = await judgeByAI({
      hist, news, rulesKR, rulesUS,
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL
    });
    regime = {
      by: 'ai',
      asOf: new Date().toISOString(),
      kr: validate(ai.kr, rulesKR),
      us: validate(ai.us, rulesUS)
    };
    console.log('국면: AI 로 새로 판정했습니다');
  } catch (e) {
    failed.push('regime-ai: ' + e.message);
    /* ⚠️ 실패했다고 **규칙 판정으로 갈아타지 않는다.**
       규칙과 AI 는 같은 수치에도 다른 답을 낸다(실제로 규칙은 reces, AI 는
       slow 였다). 크레딧이 떨어진 날 국면이 둔화→침체로 뛰었고, 그건 시장이
       아니라 판정 주체가 바뀐 것이다. 결제 문제로 배분이 움직여선 안 된다.
       지난 판정을 이어 쓰고, 낡았다는 사실만 화면에 남긴다. */
    if (prevRegime) {
      regime = { ...prevRegime, stale: true, staleWhy: e.message.slice(0, 120) };
      console.error('AI 판정 실패 — 지난 판정을 그대로 씁니다:', e.message);
    } else {
      regime = { by: 'rules', asOf: new Date().toISOString(), kr: rulesKR, us: rulesUS };
      console.error('AI 판정 실패 · 지난 판정도 없음 — 규칙 판정을 씁니다:', e.message);
    }
  }
} else {
  /* 키가 아예 없는 환경(첫 실행 등). 규칙 판정이라도 있어야 앱이 돈다. */
  regime = prevRegime || { by: 'rules', asOf: new Date().toISOString(), kr: rulesKR, us: rulesUS };
}

/* ── 기사 판정 ──────────────────────────────────────────────
   기사마다 "그래서 오늘 뭘 해야 하나"를 붙인다. 사용자가 3문항을 스스로
   답하지 않아도 되게 하는 게 목적이다.

   ⚠️ 캐시에는 **AI 판정만** 담는다. 규칙 판정은 다시 계산해도 공짜인데,
      캐시에 넣어 두면 규칙을 고쳐도 예전 판정이 그대로 남는다.
      캐시의 목적은 API 호출을 아끼는 것이지 계산을 아끼는 게 아니다.    */
let nvCache = {};
if (existsSync(OUT)) {
  try {
    /* 예전 파일에는 규칙 판정도 담겨 있다. 그걸 그대로 읽으면 규칙을 고쳐도
       예전 판정이 계속 이긴다 — 읽는 단계에서 AI 판정만 남긴다. */
    const raw = JSON.parse(readFileSync(OUT, 'utf8')).nvCache || {};
    for (const k in raw) if (raw[k] && raw[k].by === 'ai') nvCache[k] = raw[k];
  } catch { nvCache = {}; }
}

let newsBy = 'rules';
for (const mk of ['kr', 'us']) {
  const list = news[mk];
  if (!list.length) continue;

  const rules = judgeAllByRules(list);
  /* AI 판정이 이미 있는 기사는 건너뛴다. 나머지만 새로 부른다. */
  const fresh = [];
  list.forEach((n, i) => { if (!nvCache[n.link]) fresh.push({ n, i }); });

  let judged = null;
  if (process.env.ANTHROPIC_API_KEY && fresh.length) {
    try {
      const res = await judgeNewsByAI({
        list: fresh.map(f => f.n),
        marketKey: mk,
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: process.env.ANTHROPIC_MODEL
      });
      judged = {};
      res.forEach(r => { if (r && r.i >= 1 && r.i <= fresh.length) judged[r.i - 1] = r; });
    } catch (e) {
      failed.push('news-ai/' + mk + ': ' + e.message);
      console.error('기사 AI 판정 실패 — 규칙 판정을 쓴다:', e.message);
    }
  }

  /* AI 가 답을 준 것만 캐시에 남긴다 */
  fresh.forEach((f, k) => {
    if (!judged || !judged[k]) return;
    nvCache[f.n.link] = { ...validateNews(judged[k], rules[f.i]), by: 'ai' };
  });

  list.forEach((n, i) => {
    const v = nvCache[n.link] || rules[i];
    n.act = v.act; n.lasting = v.lasting; n.scope = v.scope || null; n.why = v.why;
    n.by = v.by || 'rules';
  });
}

/* 한 건이라도 AI 판정이면 화면에 'AI 판정'이라고 밝힌다. 이번 실행에서
   새로 부른 게 없어도(전부 캐시) 그 판정을 만든 건 AI 다. */
for (const mk of ['kr', 'us']) {
  if (news[mk].some(n => n.by === 'ai')) { newsBy = 'ai'; break; }
}

/* 캐시가 무한정 자라지 않게 최근 것만 남긴다 */
const nvKeys = Object.keys(nvCache);
if (nvKeys.length > NV_CACHE_MAX) {
  const keep = {};
  nvKeys.slice(-NV_CACHE_MAX).forEach(k => { keep[k] = nvCache[k]; });
  nvCache = keep;
}

writeFileSync(OUT, JSON.stringify({
  asOf: new Date().toISOString(),
  source: 'Yahoo Finance chart API',
  quotes,
  fx,
  hist,
  regime,
  stocks,
  news,
  newsBy,
  trCache,
  nvCache,
  failed
}, null, 2) + '\n');

console.log('완료: 지수 ' + Object.keys(quotes).length + '/' + SYMBOLS.length,
  '· 종목 kr ' + Object.keys(stocks.kr).length + ' / us ' + Object.keys(stocks.us).length,
  '· 뉴스 kr ' + news.kr.length + ' / us ' + news.us.length +
  ' (번역 ' + news.us.filter(n => n.ko).length + ')');
