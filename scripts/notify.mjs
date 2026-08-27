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
import { kakaoReady, sendFeed } from './kakao.mjs';

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
      msgs.push({
        rank: 100,                 /* 국면 변화 — 목표 자체가 바뀐다 */
        kind: 'regime',
        title: `${flag} ${before.regime} → ${label.full}`,
        desc: [
          why ? `왜: ${cut(why, 110)}` : '',
          `현금 목표 ${before.cash ?? '–'}% → ${tilt.cash}%`
        ].filter(Boolean).join('\n')
      });
    }

    /* 2) 기준 계좌 매매 */
    let st = before.sim;
    const ctx = {
      live, market: mk, fx: prev.fx || 1350, today, model,
      /* 앱과 같은 주기를 쓴다. 한쪽만 다르게 돌면 알림과 앱 화면이 서로 다른
         계좌를 보게 된다. 조정은 계속 하고, 줄이는 건 알림 횟수다(아래 cap). */
      cadence: 'daily',
      regimeKey: label.full
    };
    if (!st || !st.started) {
      st = SIM.start({ live, market: mk, fx: ctx.fx, today,
        seed: prev.seed || 1000, style: prev.style || 'balanced', model });
    } else {
      const r = SIM.autoRun(st, ctx);
      const done = (r && r.done) || [];
      if (done.length) {
        const v = SIM.value(st, ctx);
        /* 이번 조정으로 계좌의 몇 %가 움직였나 */
        const traded = done.reduce((a, d) => a + Math.abs(Number(d.amt) || 0), 0);
        const moved = v.total > 0 ? traded / v.total * 100 : 0;
        /* ── 왜 금액이 아니라 비중인가 ─────────────────────────────
           기준 계좌는 시드가 1,000만원이다. 받는 사람 계좌는 크기가 다르다.
           "매수 KB금융 67만원"은 그 사람 계좌에 그대로 옮길 수가 없다.
           **비중**으로 적으면 계좌가 얼마든 그대로 쓸 수 있다 —
           "6% → 9%" 는 500만원 계좌에서도 5,000만원 계좌에서도 뜻이 같다.

           한 번의 재조정에서 나온 매매는 이유가 같다(목표에서 벌어져서).
           줄마다 반복하면 180자를 넘겨 정작 중요한 게 잘려 나간다.
           공통 이유는 맨 아래 한 번만 적는다.                            */
        const why = common(done.map(d => String(d.why || '')));
        const rows = done.slice(0, 3).map(d => {
          const arrow = (typeof d.w === 'number' && typeof d.wT === 'number')
            ? ` ${pct(d.w)} → ${pct(d.wT)}` : '';
          return `${d.kind === 'buy' ? '🔵 매수' : '🔴 매도'} ${d.n}${arrow}`;
        });
        if (done.length > 3) rows.push(`… 외 ${done.length - 3}곳`);
        msgs.push({
          /* 매매는 조정 규모에 따라 중요도가 다르다. 잔손질까지 알리면
             하루에도 몇 번씩 울린다 — 계좌의 5% 이상이 움직였을 때만
             '알릴 만한 조정'으로 친다. */
          rank: moved >= 5 ? 70 : 20,
          kind: 'trade',
          title: `${flag} 비중을 ${done.length}곳 조정했습니다`,
          desc: [
            rows.join('\n'),
            why ? `왜: ${cut(why, 46)}` : '',
            '👉 금액이 아니라 비중을 내 계좌에 맞춰 옮기세요.'
          ].filter(Boolean).join('\n')
        });
      }
    }

    /* 4) 전략 점검 — 목표 배분이 크게 달라졌을 때
       "시장이 좋아지면 공격적으로 바꿔야 하나?"에 대한 이 앱의 답이 여기다.
       **성향(공격/균형/방어)은 시장이 아니라 내 사정으로 바꾸는 것이다** —
       쓸 시점이 멀어졌거나, 견딜 수 있는 폭이 커졌거나. 시장이 좋아 보인다고
       공격적으로 옮기면 오른 뒤에 더 사고 빠진 뒤에 줄이게 된다.

       시장에 맞춰 움직이는 몫은 **현금 비중**이 맡는다. 그래서 알림도
       "공격적으로 바꾸세요"가 아니라 "목표가 이만큼 달라졌고 이유는 이것"
       까지만 말한다. 성향을 바꿀지는 회원님이 정한다. */
    const cashMoved = before.cash !== undefined && Math.abs(tilt.cash - before.cash) >= 5;
    if (cashMoved && before.regime === label.full) {
      const moved2 = DIALS.filter(k => before.dials && before.dials[k] !== dials[k]);
      const why2 = moved2.length && dials.why ? String(dials.why[moved2[0]] || '') : '';
      const dir = tilt.cash > before.cash ? '늘리는' : '줄이는';
      msgs.push({
        rank: 80,                  /* 목표 배분이 크게 달라짐 */
        kind: 'strategy',
        title: `${flag} 목표 배분이 달라졌습니다 · 현금 ${before.cash}% → ${tilt.cash}%`,
        desc: [
          `국면은 그대로(${label.full})인데 현금을 ${dir} 쪽으로 목표가 움직였습니다.`,
          why2 ? `왜: ${cut(why2, 90)}` : '',
          '성향은 시장이 아니라 내 사정으로 바꾸는 것입니다.'
        ].filter(Boolean).join('\n')
      });
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
      msgs.push({
        rank: 60,                  /* 근거를 다시 볼 기사 */
        kind: 'news',
        title: `${mk === 'kr' ? '🇰🇷 국내' : '🇺🇸 미국'} 기사 ${hot.length}건 — 근거 다시 확인`,
        desc: [
          hot.slice(0, 2).map(n => `• ${cut(n.ko || n.title, 46)}`).join('\n'),
          '팔라는 뜻이 아닙니다. 처음 산 이유가 아직 맞는지만 보세요.'
        ].join('\n')
      });
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

/* 비중 표기. 0.5%p 미만 차이는 소수점이 오히려 방해라 정수로 줄인다. */
function pct(v) {
  const n = Number(v) || 0;
  return (Math.abs(n - Math.round(n)) < 0.05 ? Math.round(n) : n.toFixed(1)) + '%';
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
  const today = ymd(new Date());
  const { msgs, next } = buildMessages({ prev, live, W, today });

  /* ── 하루에 몇 번까지 보낼 것인가 ─────────────────────────────
     시세도 기사도 계속 움직이고 계좌도 계속 따라간다. 그렇다고 그때마다
     카톡이 오면 이틀 만에 알림을 꺼 버린다. **조정은 계속하되 알림만
     고른다** — 중요한 것 위주로 하루 몇 번까지.

     중요도(rank)
       100 국면 변화        — 목표 자체가 바뀐다
        80 전략 점검        — 목표 배분이 크게 달라졌다
        70 큰 조정          — 계좌의 5% 이상이 움직였다
        60 근거 재확인 기사
        20 잔손질 조정      — 상한에 걸리면 이건 먼저 밀린다        */
  const CAP = Number(process.env.NOTIFY_CAP || 5);
  const sentToday = (prev.sent && prev.sent.date === today) ? (prev.sent.n || 0) : 0;
  const room = Math.max(0, CAP - sentToday);

  msgs.sort((a, b) => (b.rank || 0) - (a.rank || 0));
  const held = msgs.slice(room);
  const going = msgs.slice(0, room);

  next.sent = { date: today, n: sentToday + going.length };
  writeFileSync(STATE, JSON.stringify(next, null, 0));

  /* 연결 시험. 설정을 마쳐도 "바뀐 게 없으면" 아무것도 안 오니, 제대로
     연결됐는지 확인할 방법이 없다. 그래서 견본 카드를 한 장 보내는 길을 둔다.
     — 처음 설정할 때 이게 없으면 "안 오는 게 정상인지 고장인지"를 알 수 없다. */
  if (String(process.env.NOTIFY_TEST) === 'true') {
    msgs.length = 0;
    const kr = next.markets.kr || {};
    msgs.push({
      rank: 999,
      kind: 'regime',
      title: '🧭 연결 시험 — 이 카드가 보이면 성공입니다',
      desc: [
        '카카오톡 알림이 정상으로 연결됐습니다.',
        `지금 국내 국면은 "${kr.regime || '–'}", 현금 목표는 ${kr.cash ?? '–'}% 입니다.`,
        '앞으로는 바뀐 게 있을 때만 옵니다. 조용한 게 정상입니다.'
      ].join('\n')
    });
  }

  if (held.length) {
    console.log(`오늘 ${sentToday}건 보냈고 상한이 ${CAP}건이라 ${held.length}건은 미룹니다 ` +
      `(${held.map(m => m.kind).join(', ')}). 다음 회차에 다시 봅니다.`);
  }
  if (!going.length && msgs.length) {
    console.log(`오늘 상한(${CAP}건)을 다 썼습니다 — 보내지 않습니다.`);
    process.exit(0);
  }
  if (!msgs.length) {
    console.log('바뀐 게 없습니다 — 아무것도 보내지 않습니다.');
    console.log('(매일 "변화 없음"이 오면 이틀 만에 알림을 끄게 됩니다.)');
    console.log('');
    console.log('연결이 됐는지 확인하고 싶으면:');
    console.log('  Actions → kakao notify → Run workflow → "연결 시험" 체크 후 실행');
    process.exit(0);
  }
  console.log(`보낼 것 ${going.length}건 (오늘 누적 ${sentToday}/${CAP})`);
  for (const m of going) {
    console.log(`\n┌─ [${m.kind}] ${m.title}`);
    m.desc.split('\n').forEach(l => console.log('│  ' + l));
    console.log('└─');
  }

  if (!kakaoReady()) {
    console.log('\n📭 KAKAO_REST_KEY / KAKAO_REFRESH_TOKEN 시크릿이 없어 전송은 건너뜁니다.');
    console.log('   (내용은 위에 그대로 찍었습니다. 설정법은 README 의 카카오 알림 참고)');
    process.exit(0);
  }
  let sent = 0;
  for (const m of going) {
    try {
      const r = await sendFeed({ kind: m.kind, title: m.title, desc: m.desc, link: APP_URL });
      sent++; console.log(`✓ 보냄 [${r.kind}]`);
    } catch (e) {
      console.log(`✕ [${m.kind}] ${e.message}`);
      if (/토큰 갱신 실패/.test(e.message)) {
        console.log('   → KAKAO_REFRESH_TOKEN 이 틀렸거나 만료됐습니다.');
        console.log('     README 의 6~8번(인증 → kakao token 워크플로 → 시크릿 저장)을 다시 하세요.');
      } else if (/insufficient|scope/i.test(e.message)) {
        console.log('   → 카카오 개발자센터에서 talk_message 동의항목을 켜고 다시 인증하세요.');
      }
    }
  }
  console.log(`\n${sent}/${going.length}건 전송 (오늘 누적 ${sentToday + sent}/${CAP})`);
}
