/* ============================================================================
   holdings.js — 내가 지금 들고 있는 것에 대한 판단
   ----------------------------------------------------------------------------
   가장 조심해야 하는 파일이다. "팔아라 / 사라"를 말하는 것처럼 보이기 쉬운데,
   이 앱은 그럴 근거를 갖고 있지 않다 — 주가도, 실적도, 그 사람의 사정도
   모른다. 그래서 여기서 하는 일은 딱 하나다:

     **지금 상태를 목표와 비교해서, 어긋난 자리를 짚어준다.**

   판단의 근거는 전부 사용자가 이미 확인해 준 것에서만 나온다.
     · 목표 비중  ← 사용자가 고른 성향 + 사용자가 맞춘 시장 국면
     · 50년 점수  ← 이 앱의 정성 평가 (공개된 사업 구조 기반)
     · 현재 비중  ← 사용자가 입력한 매수금액과 수익률

   ⚠️ 손익은 판단 근거로 쓰지 않는다.
      "많이 떨어졌으니 팔아라", "많이 올랐으니 팔아라" 둘 다 틀렸다.
      팔지 말지를 정하는 건 **처음 산 이유가 아직 유효한가**이지 지금 손익이
      아니다. 그래서 아래 규칙 어디에도 `ret`(수익률)이 들어가지 않는다.
      수익률은 화면에 보여주기만 하고 판단에는 쓰지 않는다.
   ========================================================================== */

window.BCHoldings = (function () {
  'use strict';

  /* 판정 종류. 위에 있을수록 우선한다(먼저 걸리는 것 하나만 보여준다 —
     한 종목에 경고를 여러 개 달면 무엇부터 볼지 알 수 없다). */
  var VERDICTS = {
    unknown: { code: 'unknown', mark: '🔴', label: '다시 생각', tone: 'bad',
      say: '이 앱이 평가하지 않은 종목입니다. <b>왜 샀는지 세 문장으로 적을 수 있나요?</b> 못 적으면 비중을 줄이는 걸 검토하세요.' },
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

  /* 목표 비중 찾기. 티커가 있으면 티커로, 없으면 이름으로 느슨하게 맞춘다
     (사용자가 "KODEX 200"이라고만 적을 수 있다). */
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

  /* 규칙은 위에서부터 순서대로 본다. 먼저 걸리는 하나만 쓴다. */
  function judge(row, known) {
    if (!known)                      return VERDICTS.unknown;
    if (row.score !== null && row.score < 62) return VERDICTS.weak;
    if (row.weight > 25)             return VERDICTS.concent;
    if (row.target === 0)            return VERDICTS.offplan;
    if (row.weight - row.target > 5) return VERDICTS.trim;
    if (row.target - row.weight > 5) return VERDICTS.add;
    return VERDICTS.hold;
  }

  /* opts: { items, cash, model, scoreOf }
       items   [{ id, name, ticker, cost(만원), ret(%) }]
       cash    만원 (예수금·파킹)
       model   BCPortfolios.build(...).holdings
       scoreOf function(item) -> 0~100 | null  (평가 대상이 아니면 null)  */
  function analyze(opts) {
    var items = opts.items || [];
    var cash = Math.max(0, Number(opts.cash) || 0);

    var totalCost = 0, totalValue = 0;
    var rows = items.map(function (it) {
      var cost = Math.max(0, Number(it.cost) || 0);
      var ret = Number(it.ret) || 0;
      var value = cost * (1 + ret / 100);
      totalCost += cost; totalValue += value;
      return { id: it.id, name: it.name, ticker: it.ticker || '', cost: cost, ret: ret, value: value };
    });

    var grand = totalValue + cash;

    /* 현금 목표는 모델의 현금 항목에서 가져온다. */
    var cashTarget = 0;
    (opts.model || []).forEach(function (m) { if (m.k === 'cash') cashTarget = m.w; });

    rows.forEach(function (r) {
      r.weight = grand > 0 ? Math.round(r.value / grand * 1000) / 10 : 0;
      var s = opts.scoreOf ? opts.scoreOf(r) : null;
      r.known = s !== undefined && s !== null ? true : false;
      r.score = r.known ? s : null;
      r.target = targetOf(opts.model || [], r);
      /* 유니버스에 없어도 모델에 있으면 아는 것으로 본다. */
      if (!r.known && r.target > 0) r.known = true;
      r.gap = Math.round((r.weight - r.target) * 10) / 10;
      r.verdict = judge(r, r.known);
    });

    /* 비중이 큰 순서로 — 문제가 큰 자리가 위로 온다. */
    rows.sort(function (a, b) { return b.weight - a.weight; });

    var cashWeight = grand > 0 ? Math.round(cash / grand * 1000) / 10 : 0;
    var pl = totalValue - totalCost;

    return {
      rows: rows,
      totalCost: totalCost,
      totalValue: totalValue,
      pl: pl,
      plPct: totalCost > 0 ? Math.round(pl / totalCost * 1000) / 10 : 0,
      cash: cash,
      cashWeight: cashWeight,
      cashTarget: cashTarget,
      cashGap: Math.round((cashWeight - cashTarget) * 10) / 10,
      grand: grand,
      alerts: rows.filter(function (r) {
        return r.verdict.tone === 'bad' || r.verdict.tone === 'warn';
      }).length
    };
  }

  return { verdicts: VERDICTS, analyze: analyze };
})();
