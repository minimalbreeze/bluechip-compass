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

  function blank() {
    return { started: null, style: null, seed: 0, cash: 0, pos: [], log: [] };
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
    st.log.unshift({ ts: o.today, kind: 'buy', t: o.ticker, n: o.name, amt: o.amount, price: p });
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
    st.log.unshift({ ts: o.today, kind: 'sell', t: o.ticker, n: hit.n, amt: amount, price: p });
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
    rows.forEach(function (r) {
      r.weight = total > 0 ? Math.round(r.value / total * 1000) / 10 : 0;
      r.dw = Math.round((r.weight - r.w0) * 10) / 10;
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
      missing: rows.filter(function (r) { return !r.known; }).length
    };
  }

  return { blank: blank, start: start, buy: buy, sell: sell, value: value, priceOf: priceOf };
})();
