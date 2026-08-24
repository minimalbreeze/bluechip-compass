/* ============================================================================
   fetch-prices.mjs — 보유 종목 시세를 넓게 받아 prices.json 에 쓴다
   ----------------------------------------------------------------------------
   왜 live.json 과 나눴나

     live.json 은 앱을 열 때마다 무조건 내려받는 파일이다(지수·뉴스·국면).
     여기에 수백 종목을 밀어 넣으면 아무것도 등록하지 않은 사람까지 매번 그
     무게를 진다. prices.json 은 **보유 종목이나 모의투자 계좌가 있을 때만**
     내려받는다.

   왜 갱신 주기도 나눴나

     유니버스 26종목은 모의투자 체결가로 쓰여서 30분마다 받는다(live.json).
     이쪽은 "내 보유 종목이 오늘 얼마인가"라서 하루 두 번이면 충분하다.
     장기 투자 앱에서 자기 종목을 30분 단위로 들여다볼 이유가 없고 —
     그러지 말라는 게 이 앱이 하는 말이다 — Yahoo 를 두드리는 횟수도 준다.

   ⚠️ 실패해도 기존 파일을 덮지 않는다. 낡은 값보다 나쁜 건 깨진 값이다.
   ========================================================================== */

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { US, KR } from './price-list.mjs';

const UA = 'Mozilla/5.0 (compatible; bluechip-compass/1.0)';
const OUT = 'prices.json';
const CONC = 8;          // 동시 요청 수. 올리면 빨라지지만 차단 위험이 는다.

/* 야후 표기: 코스피는 .KS 접미사, 미국은 점 대신 하이픈(BRK.B → BRK-B) */
const SYMBOLS = [
  ...KR.map(t => ({ mk: 'kr', t, y: t + '.KS' })),
  ...US.map(t => ({ mk: 'us', t, y: t.replace(/\./g, '-') }))
];

async function getJson(url, ms = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

/* fetch-live.mjs 의 quote 와 같은 셈법이다 — 등락률은 meta.previousClose 가
   아니라 일별 종가 두 개로 직접 계산한다. 그 필드는 어느 세션을 가리키는지가
   흔들려서 화면에 틀린 값이 사실처럼 찍힌다. */
async function quote(sym) {
  const j = await getJson('https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(sym) + '?interval=1d&range=1mo');
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error('no result');
  const m = res.meta || {};
  const closes = (res.indicators?.quote?.[0]?.close || []).filter(v => typeof v === 'number');
  if (closes.length < 2) throw new Error('not enough closes');
  const last = closes[closes.length - 1];
  const live = typeof m.regularMarketPrice === 'number' ? m.regularMarketPrice : last;
  const sameAsLast = Math.abs(live - last) < Math.max(1e-6, Math.abs(last) * 1e-6);
  const prev = sameAsLast ? closes[closes.length - 2] : last;
  if (!prev) throw new Error('no prev close');
  return {
    price: live,
    chg: Math.round((live - prev) / prev * 10000) / 100
  };
}

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); }
      catch (e) { out[idx] = { error: e.message, item: items[idx] }; }
    }
  }));
  return out;
}

const failed = [];
const stocks = { kr: {}, us: {} };

const res = await pool(SYMBOLS, CONC, async (s) => ({ s, q: await quote(s.y) }));
for (const r of res) {
  if (r && r.q) stocks[r.s.mk][r.s.t] = r.q;
  else if (r && r.error) failed.push(r.item.mk + '/' + r.item.t + ': ' + r.error);
}

const got = Object.keys(stocks.kr).length + Object.keys(stocks.us).length;
console.log('받아옴: 국내 ' + Object.keys(stocks.kr).length + '/' + KR.length +
            ' · 미국 ' + Object.keys(stocks.us).length + '/' + US.length);
if (failed.length) {
  console.error('실패 ' + failed.length + '건:');
  failed.forEach(f => console.error('  ' + f));
}

/* 절반도 못 받았으면 뭔가 잘못된 것이다(차단·장애). 기존 파일을 지킨다. */
if (got < SYMBOLS.length / 2) {
  console.error('절반 이상 실패 — prices.json 을 건드리지 않는다');
  process.exit(1);
}

/* 일부만 실패했으면 그것만 이전 값으로 메운다 */
if (existsSync(OUT)) {
  try {
    const old = JSON.parse(readFileSync(OUT, 'utf8'));
    for (const mk of ['kr', 'us']) {
      for (const t in (old.stocks?.[mk] || {})) {
        if (!stocks[mk][t]) { stocks[mk][t] = old.stocks[mk][t]; stocks[mk][t].stale = true; }
      }
    }
  } catch { /* 이전 파일이 깨졌으면 무시하고 새로 쓴다 */ }
}

writeFileSync(OUT, JSON.stringify({
  asOf: new Date().toISOString(),
  source: 'Yahoo Finance chart API',
  note: '평가 대상이 아니라 시세만 받아오는 목록입니다. 이 앱이 채점하는 종목은 data.js 의 유니버스뿐입니다.',
  stocks,
  failed
}) + '\n');

console.log('완료: ' + got + '종목 · ' + (JSON.stringify(stocks).length / 1024).toFixed(0) + 'KB');
