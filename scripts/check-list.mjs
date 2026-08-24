/* price-list.mjs 의 모든 심볼이 실제 상장 종목인지 tickers.json 으로 대조한다.
   오타는 배포 전에 여기서 걸러야 한다 — 워크플로에 넣고 나면 매번 헛되이
   두드리면서 failed 만 쌓인다. */
import { readFileSync } from 'node:fs';
import { US, KR } from './price-list.mjs';

const tk = JSON.parse(readFileSync(new URL('../tickers.json', import.meta.url), 'utf8'));
const usMap = new Map(tk.us.map(r => [r[0], r]));
const krMap = new Map(tk.kr.map(r => [r[0], r]));

let bad = 0;
const badUS = US.filter(s => !usMap.has(s));
const badKR = KR.filter(s => !krMap.has(s));
const etf   = US.filter(s => usMap.get(s) && usMap.get(s)[2] === 1);

console.log('미국 ' + US.length + '건 · 국내 ' + KR.length + '건 대조');
if (badUS.length) { bad++; console.log('\n❌ 미국 색인에 없음 (' + badUS.length + '):'); badUS.forEach(s => console.log('   ', s)); }
if (badKR.length) { bad++; console.log('\n❌ 국내 색인에 없음 (' + badKR.length + '):'); badKR.forEach(s => console.log('   ', s)); }
if (etf.length)   { console.log('\n⚠️ ETF 로 표시된 항목 (' + etf.length + ') — 이 앱은 ETF 를 다루지 않는다:'); etf.forEach(s => console.log('   ', s, usMap.get(s)[1])); }

if (!bad && !etf.length) console.log('\n✅ 전부 실제 상장 종목입니다.');
process.exit(bad ? 1 : 0);
