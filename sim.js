/* ============================================================================
   sim.js — 모의투자 (연습 계좌)
   ----------------------------------------------------------------------------
   실제 돈을 넣기 전에 "내가 이 성향을 견딜 수 있는가"를 겪어보게 하는 기능이다.
   수익률을 자랑하라고 만든 게 아니라, **하락을 보고도 안 팔 수 있는지**를
   자기 눈으로 확인하게 하는 게 목적이다.

   ⚠️ 이건 실제 거래가 아니다. 화면에서 이 사실을 숨기지 않는다.
      · 체결가는 30분마다 갱신되는 **스냅샷 가격**이다. 실제 체결가가 아니다.
      · 수수료·세금·슬리피지를 계산하지 않는다. 실제로는 그만큼 덜 남는다.
      · 배당을 반영하지 않는다.
      · 미국 종목은 달러 시세를 그때그때 환율로 환산한다 — 주가가 그대로여도
        환율이 움직이면 평가액이 바뀐다. 한국에서 미국 주식을 사면 실제로
        그렇게 되므로 일부러 그대로 둔다.

   금액 단위는 앱 전체와 같이 **만원**이다. 미국 종목은 달러 시세를 환율로
   환산해 만원으로 맞춘다. 보유는 주수(소수 허용)로 들고 있어서, 나중에 값이
   바뀌면 평가액이 따라 움직인다.
   ========================================================================== */

window.BCSim = (function () {
  'use strict';

  /* 목표 비중에서 이만큼 벌어지면 조정한다(%p).
     너무 작게 잡으면 매일 잔손질을 하게 되고, 그건 이 앱이 줄이려는 바로
     그 행동이다. 3%p 는 "그냥 두면 포트폴리오가 다른 물건이 되는" 선이다. */
  var BAND = 3;
  /* ── 왜 상대 기준이 필요한가 ────────────────────────────────────
     밴드를 3%p 하나로만 쓰면 **작은 자리가 사실상 얼어붙는다.**
     목표 9%인 종목이 3%p 를 벗어나려면 6% 나 12% 가 되어야 하는데,
     그건 그 종목만 33% 움직여야 한다는 뜻이다. 실제로 계좌가 나흘 동안
     한 건도 안 움직였고, 화면은 고장난 것처럼 보였다.

     그래서 **목표의 20%** 와 3%p 중 더 좁은 쪽을 쓴다. 목표 9% 자리는
     1.8%p(= 그 종목 20% 변동)에서 걸리고, 목표 18% 자리는 여전히 3%p 에서
     걸린다. 자산배분에서 오래 쓰는 "5/25 규칙"과 같은 얼개다.
     (수치를 낮춘다고 수익이 늘지는 않는다. 얼어붙은 걸 푸는 것뿐이다.) */
  var REL = 20;
  function bandFor(wantW, total) {
    return total * Math.min(BAND, wantW * REL / 100) / 100;
  }

  function blank() {
    /* auto: 자동 운용 여부.
       lastAuto: 마지막으로 자동 조정한 날짜(화면 표시용).
       lastSnap: 마지막으로 확인한 시세 스냅샷(live.json 의 asOf). 자동 운용을
             날짜가 아니라 이 값으로 끊는다 — 그래야 장중에 값이 움직일 때마다
             계좌가 따라간다(autoRun 주석 참고).
       seen: 사용자가 마지막으로 본 시점의 거래 건수. 자동 운용은 사용자가
             없는 사이에 사고파는데, 그걸 알려줄 방법이 없으면 장부가 있어도
             "언제 뭐가 늘었는지"를 알 수 없다. 로그는 줄어들지 않으므로
             건수만 기억하면 새 거래를 정확히 집어낼 수 있다(날짜는 하루
             단위라 같은 날 여러 건이면 구분이 안 된다). */
    return { started: null, style: null, seed: 0, cash: 0, pos: [], log: [], auto: true,
             lastAuto: null, lastSnap: null, seen: 0 };
  }

  /* 시세 한 종목의 "만원 단위 가격". 없으면 null. */
  function priceOf(live, marketKey, ticker, fxRate) {
    var s = live && live.stocks ? live.stocks[marketKey] : null;
    var q = s ? s[ticker] : null;
    if (!q || typeof q.price !== 'number' || !(q.price > 0)) return null;
    /* 국내는 원 → 만원, 미국은 달러 → 원 → 만원 */
    return marketKey === 'kr' ? q.price / 10000 : q.price * fxRate / 10000;
  }

  /* 성향별 모델 구성 그대로 시드를 나눠 담는다.
     시세가 없는 종목은 건너뛰고 그 몫은 현금으로 남긴다 — 없는 가격을
     지어내는 것보다 "못 샀다"고 말하는 편이 정직하다. */
  function start(opts) {
    var st = blank();
    st.started = opts.today;
    st.style = opts.style;
    st.seed = opts.seed;
    st.cash = opts.seed;

    opts.model.forEach(function (m) {
      if (m.k === 'cash' || !m.t) return;
      var amt = opts.seed * m.w / 100;
      var p = priceOf(opts.live, opts.market, m.t, opts.fx);
      if (!p || amt <= 0) return;
      /* 시작 비중을 같이 남긴다 — 나중에 "얼마나 벌어졌나"를 보려면 기준이 필요하다 */
      st.pos.push({ t: m.t, n: m.n, qty: amt / p, cost: amt, w0: m.w, first: opts.today });
      st.cash -= amt;
      st.log.push({ ts: opts.today, kind: 'buy', t: m.t, n: m.n, amt: amt, price: p, why: '시작 배분' });
    });
    st.cash = Math.max(0, st.cash);
    return st;
  }

  function buy(st, o) {
    var p = priceOf(o.live, o.market, o.ticker, o.fx);
    if (!p) return { ok: false, msg: '이 종목의 시세를 아직 못 받아왔습니다.' };
    if (!(o.amount > 0)) return { ok: false, msg: '금액을 입력하세요.' };
    if (o.amount > st.cash + 1e-9) return { ok: false, msg: '현금이 부족합니다. (보유 현금 ' + Math.floor(st.cash) + '만원)' };

    var hit = null;
    st.pos.forEach(function (x) { if (x.t === o.ticker) hit = x; });
    if (hit) { hit.qty += o.amount / p; hit.cost += o.amount; }
    else st.pos.push({ t: o.ticker, n: o.name, qty: o.amount / p, cost: o.amount, w0: 0, first: o.today });

    st.cash -= o.amount;
    st.log.unshift({ ts: o.today, kind: 'buy', t: o.ticker, n: o.name, amt: o.amount, price: p,
      why: o.why || null, auto: !!o.auto });
    return { ok: true };
  }

  function sell(st, o) {
    /* 보유 여부를 먼저 본다. 시세부터 확인하면 안 가진 종목에도
       "시세를 못 받아왔다"는 엉뚱한 안내가 나간다. */
    var hit = null, idx = -1;
    st.pos.forEach(function (x, i) { if (x.t === o.ticker) { hit = x; idx = i; } });
    if (!hit) return { ok: false, msg: '보유하지 않은 종목입니다.' };
    var p = priceOf(o.live, o.market, o.ticker, o.fx);
    if (!p) return { ok: false, msg: '이 종목의 시세를 아직 못 받아왔습니다.' };

    var value = hit.qty * p;
    var amount = o.all ? value : o.amount;
    if (!(amount > 0)) return { ok: false, msg: '금액을 입력하세요.' };
    if (amount > value + 1e-9) return { ok: false, msg: '보유 평가액보다 많이 팔 수 없습니다. (평가 ' + Math.floor(value) + '만원)' };

    /* 실현 손익 — 판 만큼의 원가를 빼서 남는 차액이다.
       평균 매수 단가로 계산한다(선입선출이 아니라). 국내 증권사 표기와 같고,
       무엇보다 "이 종목에 넣은 돈 대비 얼마 건졌나"가 초보자에게 읽히는 셈법이다. */
    var ratio = amount / value;
    var costOut = hit.cost * ratio;         // 이번에 빠져나간 원가
    var avgIn = hit.qty > 0 ? hit.cost / hit.qty : 0;   // 팔기 전 평단(만원/주)
    var qtyOut = hit.qty * ratio;

    hit.qty -= qtyOut;
    hit.cost -= costOut;
    st.cash += amount;
    st.log.unshift({
      ts: o.today, kind: 'sell', t: o.ticker, n: hit.n, amt: amount, price: p,
      why: o.why || null, auto: !!o.auto,
      /* 장부에 쓸 값들 */
      cost: costOut,                        // 판 만큼의 원가
      real: amount - costOut,               // 실현 손익
      avg: avgIn,                           // 그때의 평단
      qty: qtyOut,
      since: hit.first || null              // 언제부터 들고 있던 것인지
    });
    if (hit.qty <= 1e-9 || o.all) st.pos.splice(idx, 1);
    return { ok: true };
  }

  /* 지금 값어치. 시세가 빠진 종목은 마지막 매수 원가로 잡고 표시해 둔다 —
     0으로 처리하면 손실이 난 것처럼 보인다. */
  function value(st, o) {
    var rows = st.pos.map(function (x) {
      var p = priceOf(o.live, o.market, x.t, o.fx);
      var known = p !== null;
      var v = known ? x.qty * p : x.cost;
      return {
        t: x.t, n: x.n, qty: x.qty, cost: x.cost, price: p, value: v, known: known,
        w0: typeof x.w0 === 'number' ? x.w0 : 0,
        pl: v - x.cost,
        plPct: x.cost > 0 ? (v - x.cost) / x.cost * 100 : 0
      };
    });
    rows.sort(function (a, b) { return b.value - a.value; });

    var invested = rows.reduce(function (a, r) { return a + r.value; }, 0);
    var total = invested + st.cash;

    /* 지금 비중과 시작 비중의 차이. 오른 종목은 저절로 비중이 커지고 내린
       종목은 작아진다 — 그 벌어짐이 곧 리밸런싱이 필요한 정도다. */
    /* 목표 비중 — 지금 국면으로 다시 계산한 모델 배분. 자동 운용이 여기로
       끌고 간다. 모델을 안 넘겨주면(비교용 호출 등) 목표는 비워 둔다. */
    var want = {};
    (o.model || []).forEach(function (m) {
      if (m.k === 'cash' || !m.t) return;
      want[m.t] = (want[m.t] || 0) + m.w;
    });
    var hasModel = !!(o.model && o.model.length);

    rows.forEach(function (r) {
      r.weight = total > 0 ? Math.round(r.value / total * 1000) / 10 : 0;
      r.dw = Math.round((r.weight - r.w0) * 10) / 10;
      r.wT = hasModel ? (want[r.t] || 0) : null;
      r.dT = r.wT === null ? null : Math.round((r.weight - r.wT) * 10) / 10;
    });
    /* 지금까지 팔아서 확정된 손익. 평가손익과 성격이 다르니 따로 낸다 —
       평가손익은 아직 되돌릴 수 있고, 실현손익은 되돌릴 수 없다. */
    var realized = st.log.reduce(function (a, l) {
      return a + (l.kind === 'sell' && typeof l.real === 'number' ? l.real : 0);
    }, 0);

    var pl = total - st.seed;
    return {
      rows: rows,
      realized: realized,
      /* 아직 안 판 것의 손익. 실현 + 평가 = 총 손익이 되도록 뺀다. */
      unrealized: pl - realized,
      invested: invested,
      cash: st.cash,
      total: total,
      pl: pl,
      plPct: st.seed > 0 ? pl / st.seed * 100 : 0,
      cashWeight: total > 0 ? Math.round(st.cash / total * 1000) / 10 : 0,
      cashW0: (function () {
        var used = rows.reduce(function (a, r) { return a + r.w0; }, 0);
        return Math.round((100 - used) * 10) / 10;
      })(),
      cashWT: hasModel ? (function () {
        var used = 0;
        for (var k in want) used += want[k];
        return Math.round((100 - used) * 10) / 10;
      })() : null,
      missing: rows.filter(function (r) { return !r.known; }).length
    };
  }

  /* ── 자동 운용 ────────────────────────────────────────────────
     사용자가 매일 들어와 사고팔지 않아도, 앱의 판단이 바뀌면 계좌가 따라
     움직이게 한다. 그래야 "앱의 판단 vs 내 투자" 비교가 성립한다 —
     한 번 담아놓고 방치한 계좌는 앱의 판단이 아니라 과거의 판단이다.

     무엇을 목표로 삼나
       지금 국면으로 다시 계산한 모델 배분(P.build)이 목표다. 국면이 바뀌면
       현금 비중이 움직이고, 그만큼 종목 비중도 비례로 바뀐다.

     언제 움직이나
       · 하루 한 번까지만. 잔손질을 반복하면 이 앱이 줄이려는 행동을 앱이 한다.
       · 목표에서 BAND(%p) 이상 벌어진 자리만. 그 안이면 그냥 둔다.

     왜 그렇게 했는지를 거래마다 남긴다. 근거 없이 잔고가 바뀌면
     사용자는 그 계좌를 이해할 수 없다.                                    */
  function plan(st, o) {
    var v = value(st, o);
    var total = v.total;
    if (!(total > 0)) return [];

    /* 목표 비중 표 */
    var want = {}, names = {}, wantSum = 0;
    o.model.forEach(function (m) {
      if (m.k === 'cash' || !m.t) return;
      want[m.t] = (want[m.t] || 0) + m.w;
      names[m.t] = m.n;
    });
    for (var k in want) wantSum += want[k];
    var cashWant = 100 - wantSum;

    var moves = [];
    /* 자리마다 기준이 다르다 — bandFor 참고. cashOff 인 날은 아래에서 푼다. */
    var band = total * BAND / 100;

    /* ⚠️ 자리마다 밴드를 걸면 현금이 조용히 어긋난다.
       종목 일곱 자리가 각각 밴드 안(2.9%p씩)이면 아무것도 안 하는데,
       모이면 현금이 목표에서 20%p 벗어나 있다. 그런데 국면이 실제로 움직이는
       값은 바로 그 현금 비중이다 — 여기가 어긋나면 자동 운용이 하는 일이 없다.
       그래서 현금이 밴드를 벗어난 날은 밴드를 풀고 전 자리를 목표로 맞춘다.
       대신 아주 작은 거래는 걸러 잔손질을 막는다.                          */
    var cashNow = total > 0 ? st.cash / total * 100 : 0;
    var cashOff = Math.abs(cashNow - cashWant) > BAND;
    if (cashOff) band = total * 0.2 / 100;

    /* 1) 목표에서 빠진 종목은 전량 정리한다 */
    v.rows.forEach(function (r) {
      if (want[r.t] === undefined && r.value > 0 && r.known) {
        moves.push({ kind: 'sell', t: r.t, n: r.n, amt: r.value, all: true,
          w: r.weight, wT: 0,
          why: '목표 배분에서 빠진 자리' });
      }
    });

    /* 2) 목표보다 많이 가진 자리를 먼저 줄인다 — 현금을 만들어야 살 수 있다 */
    var held = {};
    v.rows.forEach(function (r) { held[r.t] = r; });
    Object.keys(want).forEach(function (t) {
      var r = held[t];
      if (!r || !r.known) return;
      var desired = total * want[t] / 100;
      var bd = cashOff ? band : bandFor(want[t], total);
      if (r.value - desired > bd) {
        moves.push({ kind: 'sell', t: t, n: r.n, amt: r.value - desired, all: false,
          w: r.weight, wT: want[t],
          why: (cashOff ? '현금을 목표 ' + cashWant + '%로 되돌리며 · ' : '') +
               '목표 ' + want[t] + '% 보다 ' + pp(r.weight - want[t]) + ' 많아짐' });
      }
    });

    /* 3) 모자란 자리를 채운다 */
    Object.keys(want).forEach(function (t) {
      var r = held[t];
      var cur = r && r.known ? r.value : (r ? r.value : 0);
      var desired = total * want[t] / 100;
      if (r && !r.known) return;                 // 시세를 모르면 손대지 않는다
      var bd2 = cashOff ? band : bandFor(want[t], total);
      if (desired - cur > bd2) {
        moves.push({ kind: 'buy', t: t, n: (r ? r.n : names[t]), amt: desired - cur,
          /* 비중을 값으로도 담는다. 알림에서 "18% → 12%" 로 보여주려면
             문자열(why) 안에 묻혀 있으면 안 된다. 계좌 크기가 저마다 달라서
             금액보다 비중이 옮기기 쉽다 — 직장인이 실제 계좌에 반영할 때
             필요한 건 "얼마"가 아니라 "몇 %"다. */
          w: r ? r.weight : 0, wT: want[t],
          why: r ? (cashOff ? '현금을 목표 ' + cashWant + '%로 되돌리며 · ' : '') +
                   '목표 ' + want[t] + '% 보다 ' + pp(want[t] - r.weight) + ' 모자람'
                 : '목표 배분에 새로 들어온 자리' });
      }
    });

    return moves;
  }

  /* 목표에서 벗어난 정도를 사람이 읽는 말로 */
  function pp(x) {
    var v = Math.round(Math.abs(x) * 10) / 10;
    return v + '%p';
  }

  /* 계획을 실제로 실행한다. 매도를 먼저 끝내고 매수로 넘어간다. */
  /* ── 투자 금액 바꾸기 ────────────────────────────────────────
     실제로 넣을 수 있는 돈은 달라진다. 상여가 들어오기도 하고, 목돈이
     필요해 빼기도 한다. 그때 **뭘 팔고 뭘 남기고 뭘 더 살지**가 가장
     궁금한 대목인데, 여태 모의투자는 시작할 때 정한 시드로 고정이었다.

     회계
       입금·출금은 **손익이 아니다.** cash 와 함께 seed 도 같이 움직여야
       수익률이 거짓말을 하지 않는다. (pl = total − seed 이므로, 돈만
       넣고 seed 를 그대로 두면 넣은 돈이 수익으로 잡힌다.)

     뺄 때 무엇을 파는가
       목표 비중에서 **가장 많이 벗어난 자리부터** 판다. 오른 종목은
       저절로 비중이 커져 있으므로, 자연히 "비싸진 것부터 덜어내는" 순서가
       된다. 균등하게 나눠 파는 것보다 목표에 가까워진다.                */
  function raiseCash(st, o, want) {
    if (!(want > 0)) return [];
    var v = value(st, o);
    var sold = [];
    /* 목표 초과분이 큰 순서. 목표를 모르면(모델 없음) 평가액 큰 순서. */
    var order = v.rows.filter(function (r) { return r.known && r.value > 0; })
      .sort(function (a, b) {
        var da = a.dT === null ? a.weight : a.dT;
        var db = b.dT === null ? b.weight : b.dT;
        return db - da;
      });
    for (var i = 0; i < order.length && want > 0.01; i++) {
      var r = order[i];
      var take = Math.min(r.value, want);
      var res = sell(st, { live: o.live, market: o.market, fx: o.fx, today: o.today,
        ticker: r.t, amount: take, all: take >= r.value - 0.01,
        why: '투자 금액을 줄이며 · 목표보다 많던 자리부터', auto: true });
      if (res.ok) { want -= take; sold.push({ t: r.t, n: r.n, amt: take }); }
    }
    return sold;
  }

  /* amount: 만원. 양수면 입금, 음수면 출금. */
  function resize(st, o) {
    var amt = Math.round((Number(o.amount) || 0) * 100) / 100;
    if (!st.started) return { ok: false, why: '아직 시작하지 않았습니다' };
    if (!amt) return { ok: false, why: '금액이 0입니다' };

    var sold = [];
    if (amt > 0) {
      st.cash += amt;
      st.seed += amt;
    } else {
      var need = -amt;
      var v = value(st, o);
      if (need > v.total + 0.01) {
        return { ok: false, why: '전체 평가금액(' + Math.round(v.total) + '만원)보다 많이 뺄 수는 없습니다' };
      }
      if (st.cash < need) sold = raiseCash(st, o, need - st.cash);
      /* 시세를 못 받아온 종목이 섞여 있으면 다 못 팔 수도 있다 */
      if (st.cash < need - 0.01) {
        return { ok: false, why: '현금을 다 만들지 못했습니다(시세 없는 종목이 있습니다)' };
      }
      st.cash -= need;
      st.seed -= need;
    }

    st.log.unshift({
      ts: o.today, kind: 'cash', n: amt > 0 ? '투자 금액 추가' : '투자 금액 회수',
      amt: Math.abs(amt), seed: st.seed,
      why: (amt > 0 ? '시드 ' : '시드 ') + Math.round(st.seed - amt) + '만원 → ' +
           Math.round(st.seed) + '만원' +
           (sold.length ? ' · ' + sold.length + '곳에서 마련' : '')
    });
    /* 바뀐 금액에 맞춰 곧바로 목표 비중으로 맞춘다. 다음 회차까지
       기다리면 "돈을 넣었는데 아무 일도 안 일어나는" 상태가 된다.
       스냅샷 표시도 같이 비운다 — 안 그러면 지금 스냅샷으로는 이미 봤다고
       판단해서, 넣은 돈이 다음 시세가 올 때까지 현금으로 남는다. */
    st.lastAuto = null;
    st.lastSnap = null;
    return { ok: true, added: amt, sold: sold, seed: st.seed };
  }

  /* 조정할 날인가.
     기본은 **'daily'** 다. 시세도 기사도 계속 움직이므로 계좌도 계속 따라가야
     한다. 한때 기본을 'weekly' 로 두었는데, 그건 "카톡이 너무 자주 온다"는
     문제를 엉뚱한 곳에서 푼 것이었다 — 줄여야 하는 건 조정이 아니라 **알림
     횟수**이고, 그건 scripts/notify.mjs 의 중요도·상한이 맡는다.
     기본값을 'daily' 로 둔 이유도 같다. 부르는 쪽이 cadence 를 빠뜨렸을 때
     조용히 주 1회로 돌아가 버리면 같은 실수가 되풀이된다.
       o.cadence: 'daily'(기본) | 'weekly'
       o.regimeKey: 국면 이름 같은 문자열. 바뀌면 즉시 조정한다.            */
  function dueToday(st, o) {
    if (o.cadence !== 'weekly') return true;
    if (o.regimeKey && st.lastRegime && st.lastRegime !== o.regimeKey) return true;
    if (!st.lastAuto) return true;                    /* 시작 직후 한 번 */
    var d = new Date(o.today + 'T00:00:00');
    if (d.getDay() === 5) return true;                /* 금요일 */
    /* 금요일을 건너뛴 채 일주일이 지났으면(장 안 열린 날 등) 그때 한다 */
    return (d - new Date(st.lastAuto + 'T00:00:00')) / 86400000 >= 7;
  }

  /* 다음 자동 조정이 언제인지. 화면에서 "언제 저절로 하나"를 알려주려고 쓴다.
     주 1회로 모아 두면 오늘 아무 일도 안 일어나는 게 정상인데, 그 사실을
     말해주지 않으면 고장으로 보인다. */
  function nextDue(st, o) {
    if (!st.started) return null;
    if (o.cadence !== 'weekly') return o.today;
    var d = new Date(o.today + 'T00:00:00');
    for (var i = 0; i <= 7; i++) {
      var t = new Date(d.getTime() + i * 86400000);
      var iso = t.toISOString().slice(0, 10);
      if (iso === st.lastAuto) continue;
      if (dueToday(st, { today: iso, cadence: o.cadence, regimeKey: o.regimeKey })) return iso;
    }
    return null;
  }

  /* o.force 를 주면 주기·자동 스위치·"이미 봤음"을 모두 건너뛴다.

     ── 무엇이 "한 번"인가 ────────────────────────────────────────
     예전엔 **하루에 한 번**만 자동으로 돌았다(st.lastAuto === today 면 중단).
     주 1회로 조정하던 시절의 잔재인데, 그대로 두니 "계좌가 시세를 계속
     따라간다"는 말과 실제가 어긋났다 — 아침 9시에 앱을 열면 그날 몫이
     끝나 버려서, 장중에 값이 아무리 움직여도 오후에는 자동으로 아무 일도
     일어나지 않았다.

     그래서 기준을 **날짜가 아니라 시세 스냅샷(o.snap = live.json 의 asOf)**
     으로 바꿨다. 새 스냅샷이 오면 다시 보고, 같은 스냅샷으로는 두 번 돌지
     않는다. 값이 그대로인데 다시 계산해 봐야 결론은 같고 기록만 늘어난다.
     스냅샷을 모르는 호출(오래된 파일 등)은 예전처럼 하루 한 번으로 돌아간다.

     눌러서 할 일이 없으면 "벌어진 자리가 없다"고 말해준다. 막는 것보다
     그게 정직하다.                                                       */
  function autoRun(st, o) {
    if (!st.started) return { ran: false };
    if (!o.force) {
      if (!st.auto) return { ran: false };
      if (o.snap) {
        if (st.lastSnap === o.snap) return { ran: false, reason: 'same-snapshot' };
      } else if (st.lastAuto === o.today) {
        return { ran: false, reason: 'today' };
      }
      if (!dueToday(st, o)) return { ran: false, reason: 'not-due' };
    }
    if (o.snap) st.lastSnap = o.snap;
    if (o.regimeKey) st.lastRegime = o.regimeKey;

    var moves = plan(st, o);
    if (!moves.length) {
      /* 조정할 게 없었던 날도 기록해 둔다 — 안 그러면 매 렌더마다 다시 계산한다 */
      st.lastAuto = o.today;
      return { ran: true, done: [] };
    }

    var done = [];
    moves.filter(function (m) { return m.kind === 'sell'; }).forEach(function (m) {
      var res = sell(st, { live: o.live, market: o.market, fx: o.fx, today: o.today,
        ticker: m.t, amount: m.amt, all: m.all, why: m.why, auto: true });
      if (res.ok) done.push(m);
    });
    moves.filter(function (m) { return m.kind === 'buy'; }).forEach(function (m) {
      /* 현금이 모자라면 있는 만큼만 산다. 계획대로 못 샀다고 아무것도 안
         하는 것보다, 갈 수 있는 데까지 가는 편이 목표에 가깝다. */
      var amt = Math.min(m.amt, st.cash);
      if (!(amt > 0.01)) return;
      var res = buy(st, { live: o.live, market: o.market, fx: o.fx, today: o.today,
        ticker: m.t, name: m.n, amount: amt, why: m.why, auto: true });
      /* 계획(m)을 그대로 넘기고 실제 체결 금액만 덮어쓴다. 예전에는 객체를
         새로 만들면서 w·wT 를 흘렸고, 알림의 매수 줄에서만 비중이 사라졌다. */
      if (res.ok) done.push(Object.assign({}, m, { amt: amt }));
    });

    st.lastAuto = o.today;
    return { ran: true, done: done };
  }

  /* 지금 목표에서 얼마나 벗어나 있는지 — 화면에서 "다음에 뭘 할 예정인지"를
     미리 보여주는 데 쓴다. 자동 운용을 껐을 때도 이건 보여준다. */
  function drift(st, o) {
    return plan(st, o);
  }

  return {
    blank: blank, start: start, buy: buy, sell: sell, value: value, priceOf: priceOf,
    autoRun: autoRun, drift: drift, band: BAND, dueToday: dueToday, nextDue: nextDue, resize: resize
  };
})();
