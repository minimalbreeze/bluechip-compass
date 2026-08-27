/* analyze-stocks.mjs 를 실제로 돌리는 진입점. 워크플로에서만 실행한다.
   대상은 시세를 받아오는 목록(price-list.mjs)과 같다 — 시세가 있는 종목만
   화면에서 의미가 있기 때문이다. */
import { KR, US } from './price-list.mjs';
import { run } from './analyze-stocks.mjs';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.log('ANTHROPIC_API_KEY 없음 — 종목 해설은 AI 없이 만들 수 없습니다.');
  console.log('규칙으로 대신할 수 있는 자료가 아닙니다(회사 설명이라). 그냥 건너뜁니다.');
  process.exit(0);
}

/* 한 번에 다 만들지 않는다. 회차마다 조금씩 채워 나간다 — 한 번에 몰면
   실패했을 때 통째로 날아가고, 비용도 한 번에 몰린다. */
const limit = Number(process.env.ANALYZE_LIMIT || 40);

const names = JSON.parse(
  (await import('node:fs')).readFileSync('tickers.json', 'utf8'));
const nameOf = {};
for (const [t, n] of names.kr) nameOf['kr:' + t] = n;
for (const [t, n] of names.us) nameOf['us:' + t] = n;

/* ── 국내·미국을 번갈아 넣는다 ────────────────────────────────
   예전에는 국내를 다 넣고 그 뒤에 미국을 붙였다. 한 회차에 40종목씩
   채우다 보니 국내 117종목이 끝날 때까지 미국은 **한 종목도** 안 만들어졌고,
   미국 주식을 들고 있는 사람에게는 며칠째 "아직 정리되지 않았습니다"만
   보였다(실제로 AMD 가 그랬다).

   양쪽을 번갈아 넣으면 첫 회차부터 두 시장이 같이 채워진다. 목록 앞쪽이
   시가총액 큰 종목이라, 많이들 들고 있는 종목이 먼저 나온다. */
const krList = KR.map(t => ({ ticker: t, market: 'kr', name: nameOf['kr:' + t] || t }));
const usList = US.map(t => ({ ticker: t, market: 'us', name: nameOf['us:' + t] || t }));
const want = [];
for (let i = 0; i < Math.max(krList.length, usList.length); i++) {
  if (krList[i]) want.push(krList[i]);
  if (usList[i]) want.push(usList[i]);
}

const r = await run({ want, apiKey, model: process.env.ANALYZE_MODEL, limit });
console.log(`진행률: ${r.total} / ${want.length}`);
