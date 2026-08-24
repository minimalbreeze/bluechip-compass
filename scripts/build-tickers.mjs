/* ============================================================================
   build-tickers.mjs — 상장 종목 이름 색인 만들기 (GitHub Actions 전용)
   ----------------------------------------------------------------------------
   보유 종목을 등록할 때 이름을 자동완성해주려면 "어떤 종목이 있는지" 목록이
   있어야 한다. 브라우저가 검색 API를 직접 부르면 CORS에 막히므로, 시세와
   똑같이 **러너가 받아와 저장소에 커밋**하고 앱은 같은 출처에서 읽는다.

   상장 목록은 하루에 몇 종목씩만 바뀌므로 자주 받을 필요가 없다. 그래도
   워크플로에 같이 두는 이유는 요청이 3개뿐이라 비용이 사실상 0이고,
   별도 일정을 관리하면 잊어버리기 때문이다. 내용이 안 바뀌면 커밋도 안 된다.

   출력 형식은 용량을 줄이려고 배열이다:  [티커, 이름, ETF여부(1|0)]
   앱이 필요할 때만(종목 추가 폼을 열 때) 내려받는다.

   ⚠️ 실패하면 기존 파일을 그대로 둔다. 자동완성이 조금 낡는 것보다
      목록이 비어 버리는 쪽이 나쁘다.
   ========================================================================== */

import { writeFileSync, existsSync, readFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (compatible; bluechip-compass/1.0)';
const OUT = 'tickers.json';

async function getBuffer(url, ms = 25000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  } finally { clearTimeout(t); }
}

function clean(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── 국내: KRX KIND 상장법인목록 ──────────────────────────────
   EUC-KR 로 인코딩된 HTML 표를 내려준다. Node 18+ 는 TextDecoder 로
   euc-kr 을 풀 수 있다(공식 빌드는 full ICU 포함).                */
async function fetchKR() {
  const buf = await getBuffer('https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13');
  let html;
  try { html = new TextDecoder('euc-kr').decode(buf); }
  catch { html = buf.toString('utf8'); }

  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const out = [];
  const seen = new Set();
  for (const tr of rows) {
    const tds = (tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
      .map(td => clean(td.replace(/<[^>]*>/g, '')));
    if (tds.length < 2) continue;
    const name = tds[0];
    const code = (tds[1] || '').replace(/\D/g, '').padStart(6, '0');
    if (!name || !/^\d{6}$/.test(code) || code === '000000') continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push([code, name, 0]);
  }
  if (out.length < 500) throw new Error('국내 목록이 너무 적다: ' + out.length);
  return out;
}

/* ── 미국: NASDAQ Trader 심볼 디렉터리 ────────────────────────
   파이프(|) 구분 텍스트. 마지막 줄은 파일 생성시각이라 건너뛴다.  */
function parsePipe(text, cols) {
  const lines = text.split(/\r?\n/).filter(l => l && !l.startsWith('File Creation Time'));
  if (!lines.length) return [];
  const head = lines[0].split('|').map(h => h.trim());
  const idx = {};
  for (const key in cols) {
    idx[key] = head.indexOf(cols[key]);
  }
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split('|');
    if (f.length < head.length) continue;
    out.push({
      sym: (f[idx.sym] || '').trim(),
      name: clean(f[idx.name]),
      etf: idx.etf >= 0 ? (f[idx.etf] || '').trim() === 'Y' : false,
      test: idx.test >= 0 ? (f[idx.test] || '').trim() === 'Y' : false
    });
  }
  return out;
}

function tidyUSName(n) {
  return n
    .replace(/\s*-\s*(Common Stock|Common Shares|Ordinary Shares|Class [A-Z] Common Stock|American Depositary Shares?.*)$/i, '')
    .replace(/\s*(Common Stock|Ordinary Shares)$/i, '')
    .replace(/,?\s*(Inc\.?|Corp\.?|Corporation|Company|Ltd\.?|plc|N\.V\.|S\.A\.)$/i, m => m)
    .trim();
}

async function fetchUS() {
  const [a, b] = await Promise.all([
    getBuffer('https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt').then(x => x.toString('utf8')),
    getBuffer('https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt').then(x => x.toString('utf8'))
  ]);
  const rows = [
    ...parsePipe(a, { sym: 'Symbol', name: 'Security Name', etf: 'ETF', test: 'Test Issue' }),
    ...parsePipe(b, { sym: 'ACT Symbol', name: 'Security Name', etf: 'ETF', test: 'Test Issue' })
  ];
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r.sym || r.test) continue;
    /* 보통주·클래스주만 남긴다. 워런트/유닛/권리는 기호가 지저분하고
       개인이 들고 있을 일이 거의 없다. */
    if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(r.sym)) continue;
    if (seen.has(r.sym)) continue;
    seen.add(r.sym);
    out.push([r.sym, tidyUSName(r.name), r.etf ? 1 : 0]);
  }
  if (out.length < 1000) throw new Error('미국 목록이 너무 적다: ' + out.length);
  return out;
}

const failed = [];
let kr = null, us = null;
try { kr = await fetchKR(); } catch (e) { failed.push('kr: ' + e.message); }
try { us = await fetchUS(); } catch (e) { failed.push('us: ' + e.message); }

/* 실패한 쪽은 기존 값을 유지한다 — 낡은 목록이 빈 목록보다 낫다 */
if (existsSync(OUT)) {
  try {
    const old = JSON.parse(readFileSync(OUT, 'utf8'));
    if (!kr && old.kr) kr = old.kr;
    if (!us && old.us) us = old.us;
  } catch { /* 깨진 파일은 무시 */ }
}

if (!kr && !us) {
  console.error('양쪽 다 실패 — tickers.json 을 건드리지 않는다:', failed.join(' | '));
  process.exit(1);
}

if (failed.length) console.error('일부 실패:', failed.join(' | '));

kr = kr || [];
us = us || [];
kr.sort((a, b) => a[1].localeCompare(b[1], 'ko'));
us.sort((a, b) => a[0].localeCompare(b[0]));

writeFileSync(OUT, JSON.stringify({
  asOf: new Date().toISOString(),
  source: 'KRX KIND · NASDAQ Trader Symbol Directory',
  kr, us, failed
}) + '\n');

console.log('종목 색인: 국내 ' + kr.length + ' · 미국 ' + us.length);
