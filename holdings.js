/* ============================================================================
   holdings.js — 내가 지금 들고 있는 것에 대한 계산과 판단
   ----------------------------------------------------------------------------
   입력은 **주당 매수단가 + 수량**이다. 예전에는 "매수금액 + 수익률"을 받았는데,
   그러면 사용자가 증권사 앱을 열어 수익률을 읽어와야 하고 그 값이 언제 기준인지
   알 수 없었다. 단가와 수량은 한 번 적으면 안 바뀌는 사실이고, 수익률은 이 앱이
   받아온 시세로 직접 계산하면 된다.

   금액은 **그 시장의 통화 기본 단위**로 다룬다.
     · 국내: 원      (사용자 입력 단가도 원)
     · 미국: 달러    (사용자 입력 단가도 달러)
   원화로 합칠 때만 환율을 곱한다. 이렇게 두면 "달러로 보기 / 원화로 보기"를
   화면에서 자유롭게 오갈 수 있다.

   미국 종목은 **매수 시점 환율(fxAt)** 을 같이 저장한다. 그래야 원화 손익을
   주가 기여분과 환율 기여분으로 나눠 보여줄 수 있다. 이걸 안 나누면 "주가는
   올랐는데 왜 원화로는 손해지?" 하는 순간을 설명할 수 없다.

   ⚠️ 판단 규칙에는 여전히 손익이 들어가지 않는다.
      "많이 떨어졌으니 팔아라"도 "많이 올랐으니 팔아라"도 둘 다 틀렸다.
      팔지 말지를 정하는 건 처음 산 이유가 아직 유효한가이지 지금 손익이 아니다.
   ========================================================================== */

window.BCHoldings = (function () {
  'use strict';

  var VERDICTS = {
    /* ⚠️ "평가하지 않았다"는 **이 앱이 아직 못 본 것**이지 나쁜 종목이라는
       뜻이 아니다. 예전 문구는 빨간 표시에 "다시 생각"이라 적어 놓아서,
       해설 차례가 아직 안 온 멀쩡한 종목까지 문제 있는 것처럼 보였다.
       판단을 미루는 것과 나쁘다고 말하는 것은 다르다. */
    unknown: { code: 'unknown', mark: '⚪', label: '아직 판단 없음', tone: 'soft',
      say: '이 앱이 <b>아직 살펴보지 않은</b> 종목입니다 — 나쁘다는 뜻이 아닙니다. ' +
           '해설은 하루에 몇 종목씩 채워지니 곧 차례가 옵니다. ' +
           '그동안은 <b>왜 샀는지 아래에 세 문장으로 적어두세요.</b> ' +
           '못 적는다면 그건 종목 문제가 아니라 근거 문제입니다.' },
    weak:    { code: 'weak',    mark: '🟠', label: '근거 점검', tone: 'warn',
      say: '50년 존속 근거가 약한 편입니다. 지금 당장 팔 이유는 아니지만, <b>코어가 아니라 위성</b>으로 다뤄야 하는 자리입니다.' },
    concent: { code: 'concent', mark: '🟠', label: '한 종목 집중', tone: 'warn',
      say: '한 종목이 전체의 4분의 1을 넘습니다. 이 회사에 무슨 일이 생기면 <b>계획 전체가 흔들립니다.</b> 나눠 담는 걸 검토하세요.' },
    offplan: { code: 'offplan', mark: '🟡', label: '목표 밖',   tone: 'soft',
      say: '나쁜 종목이라는 뜻이 아니라, <b>지금 고른 성향의 목표 구성에 없는</b> 자리입니다. 남길지 정리할지 정해두세요.' },
    trim:    { code: 'trim',    mark: '🟡', label: '비중 초과', tone: 'soft',
      say: '목표보다 많이 담겨 있습니다. 일부를 덜어 목표에 맞추면 <b>자동으로 비싸게 판 셈</b>이 됩니다.' },
    add:     { code: 'add',     mark: '🔵', label: '채울 자리', tone: 'info',
      say: '목표보다 적습니다. 이번 달 넣을 돈이 있다면 <b>여기부터</b> 채우세요.' },
    hold:    { code: 'hold',    mark: '🟢', label: '그대로',    tone: 'ok',
      say: '목표 비중과 크게 다르지 않습니다. <b>아무것도 하지 않는 게 정답</b>인 자리입니다.' }
  };

  function norm(s) { return String(s || '').replace(/\s|·|\(|\)/g, '').toLowerCase(); }

  function targetOf(model, item) {
    var hit = null;
    model.forEach(function (m) {
      if (hit) return;
      if (item.ticker && m.t && item.ticker.toUpperCase() === m.t.toUpperCase()) { hit = m; return; }
      var a = norm(item.name), b = norm(m.n);
      if (a && b && (a === b || b.indexOf(a) === 0 || a.indexOf(b) === 0)) hit = m;
    });
    return hit ? hit.w : 0;
  }

  /* 한 종목이 넘어서면 안 되는 상한. judge() 의 concent 기준과 같은 값이다. */
  var CAP = 25;

  function judge(row, known) {
    if (!known)                      return VERDICTS.unknown;
    if (row.score !== null && row.score < 62) return VERDICTS.weak;
    if (row.weight > CAP)            return VERDICTS.concent;
    if (row.target === 0)            return VERDICTS.offplan;
    if (row.weight - row.target > 5) return VERDICTS.trim;
    if (row.target - row.weight > 5) return VERDICTS.add;
    return VERDICTS.hold;
  }

  /* ── 얼마나 어긋났는지를 금액으로 ────────────────────────────
     판정은 여태 말로만 했다 — "일부를 덜어 목표에 맞추면". 그러면 사용자는
     "그래서 얼마?"를 스스로 계산해야 하고, 아무도 하지 않는다.

     여기서 내는 숫자는 **예측이 아니라 산수**다. 사용자가 고른 목표 비중과
     지금 비중의 차이를 금액으로 바꾼 것뿐이다. 그래서 "오를 것 같으니 사라"는
     말은 못 해도 "목표보다 6,400만원어치 많다"는 말은 할 수 있다.

     judge() 와 달리 **평가 못 한 종목에도 계산한다.** 한 종목이 98%인 것은
     그 회사를 이 앱이 아는지와 무관한 사실이기 때문이다. 여태 이런 종목은
     "왜 샀는지 적어보세요"만 나오고 숫자가 한 개도 없었다.                */
  function actionOf(row, grand) {
    var over = null;
    if (row.weight > CAP) {
      /* 목표가 있으면 목표까지, 없으면 집중 상한까지 */
      over = { kind: 'cut', to: row.target > 0 ? Math.min(row.target, CAP) : CAP };
    } else if (row.target > 0 && row.weight - row.target > 5) {
      over = { kind: 'trim', to: row.target };
    } else if (row.target > 0 && row.target - row.weight > 5) {
      over = { kind: 'add', to: row.target };
    }
    if (!over || !(grand > 0)) return null;

    var diff = Math.abs(row.weight - over.to);          /* %p */
    var amount = diff / 100 * grand;                    /* 그 시장 통화 */
    var qty = (row.hasPrice && row.price > 0) ? Math.floor(amount / row.price) : null;
    /* 덜어내는 쪽은 가진 것보다 많이 팔 수 없다 */
    if (qty !== null && over.kind !== 'add' && row.qty) qty = Math.min(qty, row.qty);
    return {
      kind: over.kind, from: row.weight, to: over.to,
      diff: Math.round(diff * 10) / 10, amount: amount, qty: qty
    };
  }

  /* ── 물타기: 넣으면 평단이 어떻게 되는지 ─────────────────────
     ⚠️ 이 앱은 물타기를 권하지 않는다. 실수 목록에 "손실 난 종목을 물타기로
        키운다"가 그대로 들어 있다 — 가장 틀린 판단에 가장 큰 돈을 넣게 된다.

     그래도 계산은 준다. "평단을 낮추고 싶다"고 생각할 때 실제로 얼마가 드는지
     모르면 막연히 "조금 더 사면 되겠지" 하고 넣는다. 숫자를 보면 대부분 그
     생각이 사라진다. 권유가 아니라 **비용 청구서**로 쓰라고 만든 계산이다.

     처음엔 반대로 계산했다 — "평단을 5% 낮추려면 얼마?". 그런데 현재가가
     평단보다 2.9%밖에 안 낮으면 5%는 아예 불가능해서(현재가 밑으로는 못
     내려간다) 대부분 "계산 불가"만 나왔다. 그래서 방향을 뒤집었다.
     **얼마를 넣으면 평단이 어디까지 내려가는가.** 이건 항상 답이 있고,
     "원금만큼 더 넣어도 평단은 2%밖에 안 내려간다"는 사실이 그대로 보인다. */
  function avgDownBy(row, addAmount, grand) {
    if (!row || row.legacy || !row.hasPrice) return null;
    if (!(row.qty > 0) || !(row.avg > 0) || !(row.price > 0)) return null;
    if (!(addAmount > 0)) return null;
    var n = Math.floor(addAmount / row.price);
    if (!(n > 0)) return null;
    var spend = n * row.price;
    var newAvg = (row.qty * row.avg + n * row.price) / (row.qty + n);
    return {
      qty: n, amount: spend,
      newAvg: newAvg,
      dropPct: Math.round((row.avg - newAvg) / row.avg * 1000) / 10,
      newWeight: grand > 0
        ? Math.round((row.value + spend) / (grand + spend) * 1000) / 10 : null,
      ofCost: row.cost > 0 ? Math.round(spend / row.cost * 1000) / 10 : null
    };
  }

  /* opts: { items, cash, model, market, priceOf, scoreOf, fx }
       items    [{ id, name, ticker, qty, avg, fxAt?,   // 새 방식
                   cost?, ret? }]                       // 예전 방식(호환)
       cash     그 시장 통화의 기본 단위 (국내: 원, 미국: 달러)
       priceOf  function(ticker) -> 현재가(그 시장 통화) | null
       fx       원/달러 (미국 시장에서만 쓴다)                                */
  function analyze(opts) {
    var items = opts.items || [];
    var isUS = opts.market === 'us';
    var fx = opts.fx || 1350;
    var cash = Math.max(0, Number(opts.cash) || 0);

    var totalCost = 0, totalValue = 0;
    var krwCost = 0, krwValue = 0;

    var rows = items.map(function (it) {
      var r = { id: it.id, name: it.name, ticker: it.ticker || '' };
      var price = opts.priceOf ? opts.priceOf(r.ticker) : null;
      /* 시세를 못 받아오는 종목은 사용자가 적어둔 현재가를 쓴다.
         자동 시세가 있으면 그쪽이 항상 이긴다 — 사람이 적은 값은 낡기 때문이다. */
      if (!(price > 0) && typeof it.cur === 'number' && it.cur > 0) price = it.cur;

      if (typeof it.qty === 'number' && typeof it.avg === 'number') {
        /* 새 방식: 단가 × 수량 */
        r.qty = it.qty;
        r.avg = it.avg;
        r.price = price;
        r.cost = it.qty * it.avg;
        r.hasPrice = price !== null && price > 0;
        r.value = r.hasPrice ? it.qty * price : r.cost;
        r.legacy = false;
        /* 원화 환산 — 미국은 매수 시점 환율로 원가를, 지금 환율로 평가액을 잡는다 */
        var fxAt = isUS ? (it.fxAt || fx) : 1;
        r.krwCost  = isUS ? r.cost * fxAt : r.cost;
        r.krwValue = isUS ? r.value * fx : r.value;
        r.fxAt = isUS ? fxAt : null;
      } else {
        /* 예전 방식: 매수금액(만원) + 수익률(%). 값을 버리지 않고 그대로 쓴다.
           예전 입력은 늘 원화였으므로, 미국 시장에서는 지금 환율로 달러 환산해
           나머지와 단위를 맞춘다. 안 맞추면 원화 금액이 달러 합계에 그대로
           섞여 총액이 수백 배로 부풀어 오른다. */
        var cKrw = Math.max(0, Number(it.cost) || 0) * 10000;   // 만원 → 원
        var ret = Number(it.ret) || 0;
        r.legacy = true;
        r.qty = null; r.avg = null; r.price = null; r.hasPrice = false;
        r.krwCost = cKrw;
        r.krwValue = cKrw * (1 + ret / 100);
        r.cost  = isUS ? r.krwCost / fx : r.krwCost;
        r.value = isUS ? r.krwValue / fx : r.krwValue;
      }

      r.pl = r.value - r.cost;
      r.plPct = r.cost > 0 ? r.pl / r.cost * 100 : 0;
      r.krwPl = r.krwValue - r.krwCost;
      r.krwPlPct = r.krwCost > 0 ? r.krwPl / r.krwCost * 100 : 0;
      /* 원화 손익을 주가 기여분과 환율 기여분으로 쪼갠다.
         주가 기여 = 달러 손익을 매수 시점 환율로 환산한 값
         환율 기여 = 나머지                                        */
      if (isUS && !r.legacy) {
        r.plByPrice = r.pl * r.fxAt;
        r.plByFx = r.krwPl - r.plByPrice;
      } else {
        r.plByPrice = r.krwPl; r.plByFx = 0;
      }

      totalCost += r.cost; totalValue += r.value;
      krwCost += r.krwCost; krwValue += r.krwValue;
      return r;
    });

    var grand = totalValue + cash;
    var krwCash = isUS ? cash * fx : cash;
    var krwGrand = krwValue + krwCash;

    var cashTarget = 0;
    (opts.model || []).forEach(function (m) { if (m.k === 'cash') cashTarget = m.w; });

    rows.forEach(function (r) {
      r.weight = grand > 0 ? Math.round(r.value / grand * 1000) / 10 : 0;
      var s = opts.scoreOf ? opts.scoreOf(r) : null;
      r.known = (s !== undefined && s !== null);
      r.score = r.known ? s : null;
      r.target = targetOf(opts.model || [], r);
      if (!r.known && r.target > 0) r.known = true;
      r.gap = Math.round((r.weight - r.target) * 10) / 10;
      r.verdict = judge(r, r.known);
      r.action = actionOf(r, grand);
    });
    rows.sort(function (a, b) { return b.value - a.value; });

    return {
      rows: rows,
      market: opts.market,
      totalCost: totalCost, totalValue: totalValue,
      pl: totalValue - totalCost,
      plPct: totalCost > 0 ? (totalValue - totalCost) / totalCost * 100 : 0,
      cash: cash,
      /* 원화 환산 묶음 — 국내·미국을 한 화면에서 합칠 때 쓴다 */
      krwCost: krwCost, krwValue: krwValue, krwCash: krwCash, krwGrand: krwGrand,
      krwPl: krwValue - krwCost,
      krwPlPct: krwCost > 0 ? (krwValue - krwCost) / krwCost * 100 : 0,
      cashWeight: grand > 0 ? Math.round(cash / grand * 1000) / 10 : 0,
      cashTarget: cashTarget,
      cashGap: grand > 0 ? Math.round((cash / grand * 100 - cashTarget) * 10) / 10 : 0,
      grand: grand,
      legacyCount: rows.filter(function (r) { return r.legacy; }).length,
      noPrice: rows.filter(function (r) { return !r.legacy && !r.hasPrice; }).length,
      alerts: rows.filter(function (r) {
        return r.verdict.tone === 'bad' || r.verdict.tone === 'warn';
      }).length
    };
  }

  return { verdicts: VERDICTS, analyze: analyze, avgDownBy: avgDownBy, cap: CAP };
})();
