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

/* ── 국내 ─────────────────────────────────────────────────────
   두 곳을 순서대로 시도한다. 한 곳이 형식을 바꾸거나 막아도 다른 쪽으로
   메워지도록 — 첫 실행에서 KIND 가 0건을 내놓는 걸 겪었기 때문이다.
   실패하면 응답 앞부분을 로그에 남긴다. 다음 실행 로그만 보고도 원인을
   짚을 수 있어야 한다.                                                    */

/* A. KRX 정보데이터시스템 JSON — 형식이 단순해 우선 쓴다 */
async function fetchKR_krxJson() {
  const body = new URLSearchParams({
    bld: 'dbms/MDC/STAT/standard/MDCSTAT01901',
    locale: 'ko_KR',
    mktId: 'ALL',
    share: '1',
    csvxls_isNo: 'false'
  });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  let text;
  try {
    const r = await fetch('http://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd', {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Referer': 'http://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201020506',
        'Accept': 'application/json, text/javascript, */*'
      },
      body: body.toString()
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    text = await r.text();
  } finally { clearTimeout(t); }

  let j;
  try { j = JSON.parse(text); }
  catch { throw new Error('JSON 아님: ' + text.slice(0, 120)); }
  const rows = j.OutBlock_1 || j.output || j.block1 || [];
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const code = String(r.ISU_SRT_CD || r.isu_srt_cd || '').replace(/\D/g, '');
    const name = clean(r.ISU_ABBRV || r.ISU_NM || r.isu_abbrv || '');
    if (!/^\d{6}$/.test(code) || !name || seen.has(code)) continue;
    seen.add(code);
    out.push([code, name, 0]);
  }
  if (out.length < 500) throw new Error('행이 너무 적다: ' + out.length + ' (응답 ' + text.slice(0, 100) + ')');
  return out;
}

/* B. KRX KIND 상장법인목록 — EUC-KR HTML 표 */
async function fetchKR_kind() {
  const buf = await getBuffer('https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13');
  let html;
  try { html = new TextDecoder('euc-kr').decode(buf); }
  catch { html = buf.toString('utf8'); }

  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const out = [];
  const seen = new Set();
  for (const tr of rows) {
    /* KIND 의 출력은 </td> 를 닫지 않는 조잡한 HTML 이다. 여는 태그로 쪼개야
       셀이 잡힌다 — 닫는 태그를 기대하는 정규식은 0건을 낸다(실제로 겪었다). */
    const tds = tr.split(/<t[dh][^>]*>/i).slice(1)
      .map(c => clean(c.replace(/<[^>]*>/g, '')));
    if (tds.length < 2) continue;
    const name = tds[0];
    const code = (tds[1] || '').replace(/\D/g, '').padStart(6, '0');
    if (!name || !/^\d{6}$/.test(code) || code === '000000' || seen.has(code)) continue;
    seen.add(code);
    out.push([code, name, 0]);
  }
  if (out.length < 500) {
    throw new Error('행이 너무 적다: ' + out.length +
      ' (tr ' + rows.length + '개, 응답 앞부분: ' + html.slice(0, 120).replace(/\s+/g, ' ') + ')');
  }
  return out;
}

async function fetchKR() {
  /* KIND 가 실제로 데이터를 내려주는 게 확인됐으므로 1순위. KRX JSON 은 예비. */
  const tries = [['kind', fetchKR_kind], ['krx-json', fetchKR_krxJson]];
  const errs = [];
  for (const [name, fn] of tries) {
    try {
      const out = await fn();
      console.log('국내 목록 출처:', name, out.length + '건');
      return out;
    } catch (e) {
      errs.push(name + ': ' + e.message);
    }
  }
  throw new Error(errs.join(' || '));
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
