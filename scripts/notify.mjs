/* ============================================================================
   notify.mjs — 바뀐 게 있으면 카카오톡으로 알린다
   ----------------------------------------------------------------------------
   왜 서버에서 도는가
     회원님 브라우저의 모의투자는 **앱을 열 때만** 하루치를 돌린다. 즉 앱을 안
     열면 매매 자체가 일어나지 않고, 알릴 것도 생기지 않는다. 그래서 알림을
     주려면 계좌를 굴리는 쪽이 서버여야 한다.

     여기서 굴리는 건 **앱이 굴리는 기준 계좌**다(sim-run.json). 회원님 개인
     계좌가 아니다 — 보유 종목과 개인 모의계좌는 기기 밖으로 나가지 않는다는
     원칙을 깨지 않으면서, "앱의 판단이 오늘 뭘 시켰는지"를 그대로 보여준다.
     따라 투자하려면 필요한 건 내 잔고가 아니라 **판단과 그 이유**다.

   무엇을 알리는가 — 셋 다 "왜"를 같이 보낸다
     1. 국면이 바뀌었을 때      → 판정 근거(실제 수치)와 현금 목표 변화
     2. 기준 계좌가 매매했을 때  → 종목·금액·이유
     3. 오늘 기사 판정이 셀 때   → 지켜보기·근거 재확인 건수

   보내지 않는 경우
     바뀐 게 없으면 **아무것도 보내지 않는다.** 매일 "변화 없음"이 오면
     이틀 만에 알림을 꺼 버린다. 알림의 값어치는 뜸한 데서 온다.
   ========================================================================== */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { kakaoReady, sendKakao } from './kakao.mjs';

const APP_URL = 'https://minimalbreeze.github.io/bluechip-compass/';
const STATE = 'sim-run.json';

/* 브라우저용 파일을 Node 에서 그대로 쓴다. window 전역에 실어 두는 구조라
   빌드 없이 이렇게 불러올 수 있다 — 로직을 두 벌로 만들지 않으려는 것이다.
   로직이 갈리면 알림 내용과 앱 화면이 서로 다른 말을 하게 된다. */
function loadBrowserGlobals() {
  const g = { window: {} };
  for (const f of ['data.js', 'market.js', 'portfolios.js', 'sim.js']) {
    new Function('window', readFileSync(f, 'utf8')).call(g, g.window);
  }
  return g.window;
}

const ymd = (d) => d.toISOString().slice(0, 10);

export function buildMessages({ prev, live, W, today }) {
  const msgs = [];
  const M = W.BCMarket, P = W.BCPortfolios, SIM = W.BCSim;
  const state = prev.markets || {};
  const out = { markets: {} };

  for (const mk of ['kr', 'us']) {
    /* 국기 이모지는 서로게이트 쌍 두 개라 slice 로 자르면 깨진다(실제로 깨졌다).
       이름은 따로 들고 다닌다. */
    const name = mk === 'kr' ? '국내' : '미국';
    const flag = (mk === 'kr' ? '🇰🇷 ' : '🇺🇸 ') + name;
    /* live.json 의 regime[mk] 가 곧 다이얼이다(rates/growth/... 가 최상위).
       why 는 다이얼별 설명이 담긴 객체다. */
    const dials = (live.regime && live.regime[mk]) || null;
    if (!dials || !dials.rates) continue;
    const label = M.labelRegime(dials);
    const tilt = M.tilt(dials);
    const model = P.build(mk, prev.style || 'balanced', tilt.cash).holdings;
    const before = state[mk] || {};

    /* 1) 국면 변화 — 근거를 반드시 같이 보낸다.
       어느 항목이 움직여서 국면이 바뀌었는지를 찍고, 그 항목의 판정 근거를
       그대로 인용한다. "국면이 바뀌었습니다"만 오면 알림이 아니라 소음이다. */
    if (before.regime && before.regime !== label.full) {
      const moved = DIALS.filter(k => before.dials && before.dials[k] !== dials[k]);
      const why = moved.length && dials.why ? String(dials.why[moved[0]] || '') : '';
      msgs.push([
        '🧭 국면이 바뀌었습니다',
        `${flag} ${before.regime} → ${label.full}`,
        why ? `이유: ${cut(why, 90)}` : '',
        `현금 목표 ${before.cash ?? '–'}% → ${tilt.cash}%`
      ].filter(Boolean));
    }

    /* 2) 기준 계좌 매매 */
    let st = before.sim;
    const ctx = { live, market: mk, fx: prev.fx || 1350, today, model };
    if (!st || !st.started) {
      st = SIM.start({ live, market: mk, fx: ctx.fx, today,
        seed: prev.seed || 1000, style: prev.style || 'balanced', model });
    } else {
      const r = SIM.autoRun(st, ctx);
      const done = (r && r.done) || [];
      if (done.length) {
        const v = SIM.value(st, ctx);
        /* 한 번의 재조정에서 나온 매매는 **이유가 같다**(목표에서 벌어져서).
           줄마다 그 긴 문장을 반복하면 200자를 넘겨 정작 중요한 평가액이
           잘려 나간다 — 실제로 그렇게 잘렸다. 공통 이유는 맨 아래 한 번만. */
        const why = common(done.map(d => String(d.why || '')));
        const lines = [`🧭 기준 계좌 조정 · ${name}`];
        for (const d of done.slice(0, 3)) {
          lines.push(`${d.kind === 'buy' ? '매수' : '매도'} ${d.n} ${won(d.amt)}`);
        }
        lines.push((done.length > 3 ? `외 ${done.length - 3}건 · ` : '') +
          `평가 ${won(v.total)} (${v.pl >= 0 ? '+' : '−'}${Math.abs(v.plPct).toFixed(1)}%)`);
        if (why) lines.push(`이유: ${cut(why, 60)}`);
        msgs.push(lines);
      }
    }

    out.markets[mk] = { regime: label.full, cash: tilt.cash, dials: pick(dials), sim: st };
  }

  /* 3) 오늘 기사 판정이 셀 때 — 매일이 아니라 셀 때만 */
  for (const mk of ['kr', 'us']) {
    const news = (live.news && live.news[mk]) || [];
    const hot = news.filter(n => n.act === 'review');
    const watch = news.filter(n => n.act === 'watch');
    const seen = (state[mk] || {}).newsKey;
    const key = hot.map(n => n.title).join('|').slice(0, 120);
    if (hot.length && key !== seen) {
      const lines = [`🗞️ ${mk === 'kr' ? '국내' : '미국'} 기사 ${hot.length}건이 "근거 다시 확인"입니다`];
      for (const n of hot.slice(0, 2)) lines.push(`· ${(n.ko || n.title).slice(0, 40)}`);
      lines.push('파라는 뜻이 아니라, 처음 산 이유가 아직 맞는지 보라는 뜻입니다.');
      msgs.push(lines);
    }
    if (out.markets[mk]) out.markets[mk].newsKey = key;
    if (out.markets[mk]) out.markets[mk].watch = watch.length;
  }

  out.style = prev.style || 'balanced';
  out.seed = prev.seed || 1000;
  out.fx = prev.fx || 1350;
  out.asOf = new Date().toISOString();
  return { msgs, next: out };
}

/* 여러 문장의 공통 앞부분. 재조정 매매는 같은 까닭에서 나오므로
   그 공통 부분만 뽑아 한 번 적는다. */
function common(list) {
  if (!list.length) return '';
  let head = list[0];
  for (const s of list.slice(1)) {
    let i = 0;
    while (i < head.length && i < s.length && head[i] === s[i]) i++;
    head = head.slice(0, i);
  }
  /* 공통 부분이 "… · 목표" 처럼 토막에서 끊기면 읽다 만 문장이 된다.
     구분자(·) 단위로만 남긴다. */
  const parts = head.split('·');
  head = (parts.length > 1 ? parts.slice(0, -1).join('·') : parts[0])
    .replace(/[\s·,]+$/, '').trim();
  return head.length >= 6 ? head : '';
}

const DIALS = ['rates', 'growth', 'valuation', 'fx', 'geo'];
function pick(d) {
  const o = {};
  for (const k of DIALS) o[k] = d[k];
  return o;
}
/* 문장 한가운데서 자르지 않는다 — 마침표나 쉼표에서 끊는다 */
function cut(s, n) {
  s = String(s).trim();
  if (s.length <= n) return s;
  const head = s.slice(0, n);
  const at = Math.max(head.lastIndexOf('. '), head.lastIndexOf(', '), head.lastIndexOf(' '));
  return (at > n * 0.5 ? head.slice(0, at) : head) + '…';
}

function won(manwon) {
  const v = Number(manwon) || 0;
  if (Math.abs(v) >= 10000) return (v / 10000).toFixed(1) + '억';
  return Math.round(v).toLocaleString('ko-KR') + '만원';
}

/* ── 실행 ─────────────────────────────────────────────────── */
if (import.meta.url === `file://${process.argv[1]}`) {
  const live = JSON.parse(readFileSync('live.json', 'utf8'));
  const prev = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
  const W = loadBrowserGlobals();
  const { msgs, next } = buildMessages({ prev, live, W, today: ymd(new Date()) });

  writeFileSync(STATE, JSON.stringify(next, null, 0));

  if (!msgs.length) {
    console.log('바뀐 게 없습니다 — 아무것도 보내지 않습니다.');
    console.log('(매일 "변화 없음"이 오면 이틀 만에 알림을 끄게 됩니다.)');
    process.exit(0);
  }
  console.log(`보낼 것 ${msgs.length}건`);
  for (const m of msgs) console.log('---\n' + m.join('\n'));

  if (!kakaoReady()) {
    console.log('\n📭 KAKAO_REST_KEY / KAKAO_REFRESH_TOKEN 시크릿이 없어 전송은 건너뜁니다.');
    console.log('   (내용은 위에 그대로 찍었습니다. 설정법은 README 의 카카오 알림 참고)');
    process.exit(0);
  }
  let sent = 0;
  for (const m of msgs) {
    try { const r = await sendKakao(m, APP_URL); sent++; console.log(`✓ 보냄 (${r.chars}자)`); }
    catch (e) { console.log(`✕ ${e.message}`); }
  }
  console.log(`\n${sent}/${msgs.length}건 전송`);
}
