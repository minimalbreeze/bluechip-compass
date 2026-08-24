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

  function blank() {
    /* auto: 자동 운용 여부. lastAuto: 마지막으로 자동 조정한 날짜(하루 한 번) */
    return { started: null, style: null, seed: 0, cash: 0, pos: [], log: [], auto: true, lastAuto: null };
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
      st.pos.push({ t: m.t, n: m.n, qty: amt / p, cost: amt, w0: m.w });
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
    else st.pos.push({ t: o.ticker, n: o.name, qty: o.amount / p, cost: o.amount, w0: 0 });

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

    var ratio = amount / value;
    hit.qty -= hit.qty * ratio;
    hit.cost -= hit.cost * ratio;
    st.cash += amount;
    st.log.unshift({ ts: o.today, kind: 'sell', t: o.ticker, n: hit.n, amt: amount, price: p,
      why: o.why || null, auto: !!o.auto });
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
    var pl = total - st.seed;
    return {
      rows: rows,
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
      if (r.value - desired > band) {
        moves.push({ kind: 'sell', t: t, n: r.n, amt: r.value - desired, all: false,
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
      if (desired - cur > band) {
        moves.push({ kind: 'buy', t: t, n: (r ? r.n : names[t]), amt: desired - cur,
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
  function autoRun(st, o) {
    if (!st.started || !st.auto) return { ran: false };
    if (st.lastAuto === o.today) return { ran: false, reason: 'today' };

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
      if (res.ok) done.push({ kind: 'buy', t: m.t, n: m.n, amt: amt, why: m.why });
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
    autoRun: autoRun, drift: drift, band: BAND
  };
})();
