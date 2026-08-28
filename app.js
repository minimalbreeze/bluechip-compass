/* ============================================================================
   app.js — 블루칩 나침반 화면 로직
   ----------------------------------------------------------------------------
   화면 순서가 곧 제품의 주장이다.

     오늘 → 종목 → 시장 → 배우기

   첫 화면은 "그래서 뭘 얼마나 사면 되나"에 바로 답한다. 공부는 뒤에 있다.
   초보자는 공부하다가 지쳐서 아무것도 못 사거나, 아무거나 사거나 둘 중
   하나가 되는데 — 이 앱은 전자를 막는 쪽을 택했다.

   상태(state)는 전부 localStorage에 `bcc:` 접두사로 남고 서버로 가지 않는다.
   ========================================================================== */

(function () {
  'use strict';

  var D = window.BCData;
  var M = window.BCMarket;
  var P = window.BCPortfolios;
  var H = window.BCHoldings;
  var SIM = window.BCSim;
  var CFG = window.BCConfig;
  var KEY = 'bcc:';

  /* ── 저장 ──────────────────────────────────────────────────────── */
  function load(k, fb) {
    try { var r = localStorage.getItem(KEY + k); return r === null ? fb : JSON.parse(r); }
    catch (e) { return fb; }
  }
  function save(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) {} }
  function copy(o) { var r = {}; for (var k in o) r[k] = o[k]; return r; }

  var state = {
    market:  load('market', 'kr'),
    /* 시장마다 따로 센다 — 국내를 확인했다고 미국까지 최신인 건 아니다. */
    touched: (function () {
      var t = load('touched', null);
      if (typeof t === 'string') return { kr: t, us: t };   // 예전 단일 값 형식 이관
      return t && typeof t === 'object' ? t : { kr: null, us: null };
    })(),
    style:   load('style', 'balanced'),
    regime:  load('regime', { kr: copy(M.defaults.kr), us: copy(M.defaults.us) }),
    /* 'auto' = 서버가 실제 수치로 판정한 값을 쓴다(기본).
       'manual' = 사용자가 직접 고친 값을 쓴다. 고치는 순간 manual 이 된다. */
    regimeMode: load('regimeMode', 'auto'),
    /* horizon(언제 쓸 돈인가)은 시장이 아니라 사용자의 돈 사정이 정한다.
       이 앱에서 유일하게 자동 판정하지 않고 물어보는 값이다. */
    profile: load('profile', { seed: 1000, fx: 1350, horizon: 10, startedAt: null }),
    /* 보유 종목은 시장별로 따로 둔다 — 국내 계좌와 해외 계좌는 다른 지갑이다. */
    holdings: load('holdings', { kr: [], us: [] }),
    cash:     load('cash', { kr: 0, us: 0 }),
    filter:  'all',
    /* 하위 탭도 기억한다 — 모의투자는 매일 들여다보는 화면이라
       열 때마다 배분안으로 되돌아가면 매번 두 번 눌러야 한다. */
    learnTab: load('learnTab', 'picks'),
    /* 홈에 어떤 위젯을 올릴지 (사용자가 켜고 끈다) */
    widgets: load('widgets', null),
    /* 접었다 폈다 하는 영역의 상태. 키 → true(펼침)/false(접힘) */
    folds:   load('folds', {}),
    /* 종목 추가 폼은 기본으로 숨긴다 — 매일 쓰는 기능이 아니다 */
    addOpen: false,
    q: '',            // 종목 검색어
    pickSel: null,    // 자동완성에서 고른 종목
    editWidgets: false,
    planTab: load('planTab', 'plan'),
    /* 미국 시장 금액을 달러로 볼지 원화로 볼지 */
    cur: load('cur', 'krw'),
    /* 모의투자는 시장별로 따로 굴린다 */
    sim: load('sim', { kr: SIM.blank(), us: SIM.blank() }),
    simMsg: '',
    /* 알아보기 탭: sq 검색어, sSel 고른 종목 */
    sq: '',
    sSel: null,
    /* 기록을 '지난 것까지' 펴 놨는지 (기록별로 따로) */
    logMore: {},
    /* 성향 바꾸기 칸을 폈는지 */
    styleOpen: false,
    /* 투자 금액 바꾸기 */
    seedOpen: false,
    seedAmt: ''
  };
  ['kr', 'us'].forEach(function (mk) {
    if (!state.sim[mk] || !state.sim[mk].pos) state.sim[mk] = SIM.blank();
    /* 자동 운용이 생기기 전에 시작한 계좌에는 auto 가 없다. 켜서 이관한다 —
       기존 계좌도 오늘부터 앱의 판단을 따라가야 비교가 성립한다. */
    if (typeof state.sim[mk].auto !== 'boolean') state.sim[mk].auto = true;
    if (state.sim[mk].lastAuto === undefined) state.sim[mk].lastAuto = null;
    /* 예전 저장분에는 없던 칸이다. 없으면 null 로 둔다 — 그러면 다음 스냅샷을
       "새 것"으로 보고 한 번 맞춘 뒤 정상 흐름으로 들어간다. */
    if (state.sim[mk].lastSnap === undefined) state.sim[mk].lastSnap = null;
  });
  /* 예전에는 현금을 두 시장 모두 '만원'으로 저장했다. 이제는 그 시장 통화의
     기본 단위(국내: 원, 미국: 달러)로 저장하므로 한 번만 이관한다. */
  if (!load('cashUnit2', 0)) {
    ['kr', 'us'].forEach(function (mk) {
      var v = Number(state.cash[mk]) || 0;
      state.cash[mk] = mk === 'kr' ? v * 10000 : v * 10000 / fxNow();
    });
    save('cash', state.cash);
    save('cashUnit2', 1);
  }
  ['kr', 'us'].forEach(function (mk) {
    if (!state.holdings[mk]) state.holdings[mk] = [];
    if (typeof state.cash[mk] !== 'number') state.cash[mk] = 0;
  });
  /* 기간이 생기기 전 저장본 이관 — 10년(이 앱이 가정하는 기간)으로 둔다 */
  if (typeof state.profile.horizon !== 'number') state.profile.horizon = 10;
  if (state.profile.startedAt === undefined) state.profile.startedAt = null;

  /* 저장본에 새 다이얼이 빠져 있을 수 있으니 기본값으로 메운다. */
  ['kr', 'us'].forEach(function (mk) {
    if (!state.regime[mk]) state.regime[mk] = copy(M.defaults[mk]);
    M.dials.forEach(function (d) {
      if (!state.regime[mk][d.key]) state.regime[mk][d.key] = M.defaults[mk][d.key];
    });
  });

  function market() { return D.markets[state.market]; }

  /* 지금 고른 투자 기간. 저장본이 이상해도 10년으로 떨어지게 둔다. */
  function horizonOf() {
    var y = state.profile.horizon, hit = null;
    D.horizons.forEach(function (x) { if (x.y === y) hit = x; });
    return hit || D.horizons[2];
  }

  /* 시작일부터 얼마나 왔고 얼마나 남았나. 시작일은 처음 종목을 등록한 날로
     잡는다 — 이것 하나 더 묻는 것도 부담이라(원칙 15) 따로 묻지 않는다. */
  function horizonProgress() {
    var start = state.profile.startedAt;
    if (!start) return null;
    var days = daysSince(start);
    var total = horizonOf().y * 365;
    return {
      start: start,
      years: Math.floor(days / 365),
      months: Math.floor((days % 365) / 30),
      leftY: Math.max(0, Math.round((total - days) / 365 * 10) / 10),
      pct: Math.max(0, Math.min(100, Math.round(days / total * 1000) / 10)),
      near: (total - days) <= 730      /* 쓸 때가 2년 안 — 현금으로 옮기기 시작할 때 */
    };
  }

  /* ── 지금 쓰이는 국면 ──────────────────────────────────────────
     예전에는 사용자가 다이얼 5개를 매일 맞춰야 했다. 배우는 효과는 있었지만
     "매일 확인하세요"라는 요구 자체가 부담이라 결국 낡은 값으로 앱을 쓰게 됐다.
     이제는 서버(GitHub Actions)가 실제 수치를 받아 판정해 live.json 에 넣어두고,
     앱은 그 값을 읽어 쓴다. 사용자가 직접 고치면 그 순간부터 그 값이 우선한다 —
     자동 판정은 출발점이지 결론이 아니다.                                  */
  function autoRegime(mk) {
    return (LIVE && LIVE.regime && LIVE.regime[mk]) ? LIVE.regime[mk] : null;
  }
  function regimeOf(mk) {
    if (state.regimeMode !== 'manual') {
      var a = autoRegime(mk);
      if (a) return a;
    }
    return state.regime[mk];
  }
  function regime() { return regimeOf(state.market); }
  /* 이 판정을 만든 주체. 화면에 항상 밝힌다 — 근거 없이 바뀌는 값은
     "그냥 믿으세요"와 같고, 이 앱은 그걸 하지 않는다. */
  function regimeBy() {
    if (state.regimeMode === 'manual') return 'manual';
    if (!autoRegime(state.market)) return 'default';
    return (LIVE.regime && LIVE.regime.by) === 'ai' ? 'ai' : 'rules';
  }
  /* 자동 판정에는 항목마다 한국어 근거가 붙어 온다. 직접 고친 값에는 없다. */
  function regimeWhy() {
    if (state.regimeMode === 'manual') return null;
    var a = autoRegime(state.market);
    return a && a.why ? a.why : null;
  }
  /* 다이얼을 하나라도 건드리면 직접 고치기 모드로 넘어간다.
     이때 나머지 항목은 지금 화면에 보이던 자동 판정 값을 그대로 물려받는다 —
     하나 고쳤다고 나머지가 옛 기본값으로 돌아가면 사용자가 놀란다. */
  function setDial(key, val) {
    var mk = state.market;
    if (state.regimeMode !== 'manual') {
      state.regime[mk] = copy(regimeOf(mk));
      state.regimeMode = 'manual';
      save('regimeMode', state.regimeMode);
    }
    state.regime[mk][key] = val;
    save('regime', state.regime);
    state.touched[mk] = ymd(today());
    save('touched', state.touched);
  }

  /* ── 용어 자동 링크 ────────────────────────────────────────────
     태그 안(<b class="…">)을 건드리면 마크업이 깨지므로 태그와 텍스트를
     나눠 텍스트 조각에서만, 블록당 용어별 1회만 치환한다.            */
  var TERMS = Object.keys(D.glossary).sort(function (a, b) { return b.length - a.length; });
  function linkTerms(html) {
    if (!html) return '';
    var used = {};
    return html.split(/(<[^>]*>)/).map(function (part) {
      if (part.charAt(0) === '<') return part;
      TERMS.forEach(function (t) {
        if (used[t]) return;
        var i = part.indexOf(t);
        if (i < 0) return;
        used[t] = true;
        part = part.slice(0, i) + '<button class="term" data-term="' + t + '">' + t + '</button>' + part.slice(i + t.length);
      });
      return part;
    }).join('');
  }

  /* ── 금액 표기 ─────────────────────────────────────────────────── */
  function won(manwon) {
    if (manwon >= 10000) {
      var eok = manwon / 10000;
      return (eok % 1 ? eok.toFixed(1) : eok) + '억';
    }
    if (manwon >= 1) return Math.round(manwon).toLocaleString('ko-KR') + '만원';
    return Math.round(manwon * 10000).toLocaleString('ko-KR') + '원';
  }
  function usd(manwon) {
    var d = manwon * 10000 / fxNow();
    return '$' + (d < 10 ? d.toFixed(1) : Math.round(d).toLocaleString('en-US'));
  }
  function money(manwon) {
    return state.market === 'us' ? won(manwon) + ' (≈' + usd(manwon) + ')' : won(manwon);
  }

  /* ── 점수 → 등급 ───────────────────────────────────────────────── */
  function total(s) {
    var sum = 0;
    D.axes.forEach(function (a) { sum += s[a.key]; });
    return Math.round(sum / (D.axes.length * 5) * 100);
  }
  function grade(pct) {
    for (var i = 0; i < D.grades.length; i++) if (pct >= D.grades[i].min) return D.grades[i];
    return D.grades[D.grades.length - 1];
  }

  /* 사용자가 적은 종목명을 이 앱의 유니버스와 맞춰본다.
     티커가 잡히면 50년 점수를 쓸 수 있고, 못 잡으면 "평가하지 않은 종목"이 된다. */
  function norm(x) { return String(x || '').replace(/\s|·|\(|\)/g, '').toLowerCase(); }
  /* ── 점수는 두 군데서 온다 ─────────────────────────────────────
     ① 이 앱이 직접 뜯어본 13종목(유니버스)
     ② AI 가 정리해 둔 해설(analysis.json) — 같은 여섯 축, 같은 잣대다.

     예전에는 ①만 봤다. 그래서 AMD 처럼 유니버스 밖의 종목을 들고 있으면
     해설이 이미 만들어져 있어도 "이 앱이 평가하지 않은 종목"으로 떴다.
     같은 잣대로 매긴 점수를 옆에 두고도 안 쓴 셈이라 고친다. */
  function scoreOfIn(mk, it) {
    var picks = D.markets[mk].picks;
    var p = null;
    if (it.ticker) picks.forEach(function (q) { if (q.ticker === it.ticker) p = q; });
    else picks.forEach(function (q) { if (!p && norm(q.name) === norm(it.name)) p = q; });
    if (p) return total(p.scores);
    var a = it.ticker ? analysisOf(it.ticker) : null;
    return a && a.scores ? total(a.scores) : null;
  }

  /* 그 점수가 어디서 왔는지. 화면에 출처를 밝히려고 쓴다 —
     직접 뜯어본 것과 AI 가 정리한 것을 같은 것처럼 보이게 하지 않는다. */


  /* 그 시장 통화의 현재가. 국내는 원, 미국은 달러. */
  /* 유니버스(live.json)를 먼저 보고, 없으면 넓은 목록(prices.json)을 본다.
     유니버스 쪽이 30분마다 갱신돼 더 신선하므로 순서를 바꾸지 않는다. */
  function priceIn(mk, ticker) {
    if (!ticker) return null;
    var q = LIVE && LIVE.stocks && LIVE.stocks[mk] ? LIVE.stocks[mk][ticker] : null;
    if (!(q && typeof q.price === 'number' && q.price > 0)) {
      q = PRICES && PRICES.stocks && PRICES.stocks[mk] ? PRICES.stocks[mk][ticker] : null;
    }
    return q && typeof q.price === 'number' && q.price > 0 ? q.price : null;
  }

  /* 금액 표기. 국내는 원(만원 단위), 미국은 표시 통화에 따라 달러/원화. */
  function nMoney(v, mk) {
    if (mk === 'kr') return won(v / 10000);
    if (state.cur === 'usd') {
      return '$' + (Math.abs(v) < 10 ? v.toFixed(2) : Math.round(v).toLocaleString('en-US'));
    }
    return won(v * fxNow() / 10000);
  }
  function nSign(v, mk) {
    return (v > 0 ? '+' : v < 0 ? '−' : '') + nMoney(Math.abs(v), mk);
  }
  /* 주당 가격은 언제나 그 시장 통화로 보여준다 — 주당 원화 환산은 의미가 없다. */
  /* 모의투자 내부 가격은 만원/주 단위다(sim.js priceOf 참고).
     화면에는 그 시장이 쓰는 단위로 되돌린다 — 장부에 "0.0257만원"이 찍히면
     아무도 못 읽는다. */
  function simPerShare(v) {
    if (typeof v !== 'number' || !(v > 0)) return '–';
    return state.market === 'kr'
      ? perShare(v * 10000, 'kr')
      : perShare(v * 10000 / fxNow(), 'us');
  }

  function perShare(v, mk) {
    if (v === null || v === undefined) return '–';
    return mk === 'kr'
      ? Math.round(v).toLocaleString('ko-KR') + '원'
      : '$' + v.toFixed(2);
  }

  /* 지금 성향·국면에서의 목표 구성 */
  function modelNow(mk) {
    mk = mk || state.market;
    return P.build(mk, state.style, M.tilt(regimeOf(mk)).cash).holdings;
  }
  /* 시장을 인자로 받는다 — 홈에서 국내·미국을 동시에 보여줘야 하기 때문이다. */
  function analyzeMarket(mk) {
    return H.analyze({
      items: state.holdings[mk],
      cash: state.cash[mk],
      model: modelNow(mk),
      market: mk,
      fx: fxNow(),
      priceOf: function (t) { return priceIn(mk, t); },
      scoreOf: function (r) { return scoreOfIn(mk, r); }
    });
  }
  function analyzeNow() { return analyzeMarket(state.market); }

  /* ══════════════════════════════════════════════════════════════════
     환율 — 살아 있는 값을 쓴다
     ------------------------------------------------------------------
     예전에는 profile.fx(기본 1350원)를 그대로 썼고, 실제 환율을 반영하려면
     사용자가 "지금 N원 적용"을 눌러야 했다. 누를 이유를 모르는 사람은 영영
     안 누른다 — 실제로 실제 환율이 1,381원인데 앱은 1,350원으로 계산하고
     있었다. 미국 주식 평가액이 통째로 2.3% 어긋난다.

     환율은 시세와 똑같은 성격의 값이다. live.json 의 KRW=X 가 20분마다
     갱신되므로 그걸 기준으로 삼는다. 직접 정하고 싶은 사람을 위해 잠금
     (fxLock)을 두되, 기본은 자동이다.
     ══════════════════════════════════════════════════════════════ */
  function fxNow() {
    if (!state.profile.fxLock) {
      var q = LIVE && LIVE.quotes ? LIVE.quotes['KRW=X'] : null;
      if (q && typeof q.price === 'number' && q.price > 0) return Math.round(q.price);
    }
    return state.profile.fx || 1350;
  }
  /* 이 환율이 언제 값인지. 화면에 같이 적는다 — 숫자만 두면 언제 것인지
     알 수 없고, 그러면 "안 변한다"는 오해가 다시 생긴다. */
  function fxLive() {
    var q = LIVE && LIVE.quotes ? LIVE.quotes['KRW=X'] : null;
    return (q && q.price > 0) ? Math.round(q.price) : null;
  }

  /* 손익 표기. 부호와 절제된 색까지만 쓴다 — 배경색·큰 강조는 쓰지 않는다.
     화면이 등락에 반응하기 시작하면 이 앱의 목적(감정 매매 줄이기)과 충돌한다. */
  function plClass(v) { return v > 0 ? 'pl-up' : v < 0 ? 'pl-dn' : 'pl-flat'; }
  function signPct(v) { return (v > 0 ? '+' : '') + v.toFixed(1) + '%'; }
  function signWon(manwon) {
    return (manwon > 0 ? '+' : manwon < 0 ? '−' : '') + won(Math.abs(manwon));
  }

  /* 모의투자 계산에 쓰는 값 묶음 — live·시장·환율을 매번 넘겨야 해서 모아둔다 */
  /* 모의투자의 목표는 "지금 국면으로 다시 계산한 배분"이다.
     국면이 바뀌면 목표가 바뀌고, 자동 운용이 계좌를 그쪽으로 끌고 간다. */
  function simModel(mk) {
    return P.build(mk, state.sim[mk].style || state.style, M.tilt(regimeOf(mk)).cash).holdings;
  }
  function simCtx(mk) {
    var m = mk || state.market;
    return {
      live: LIVE, market: m, fx: fxNow(), today: ymd(today()), model: simModel(m),
      /* 조정은 계속 돈다. 한때 주 1회로 묶었는데, 그건 "카톡이 자주 오는"
         문제를 엉뚱한 곳에서 푼 것이었다 — 시세와 기사는 계속 움직이므로
         계좌도 계속 따라가야 하고, 줄여야 하는 건 **알림 횟수**다.
         알림 쪽에서 중요도로 거르고 하루 상한을 둔다(scripts/notify.mjs). */
      cadence: 'daily',
      /* 자동 조정을 끊는 기준. 날짜가 아니라 **시세 스냅샷**이다 —
         날짜로 끊으면 아침에 앱을 연 순간 그날 몫이 끝나 버려서, 장중에
         값이 아무리 움직여도 오후에는 아무 일도 일어나지 않는다(sim.js). */
      snap: LIVE && LIVE.asOf ? LIVE.asOf : null,
      regimeKey: M.labelRegime(regimeOf(m)).full
    };
  }
  function simState() { return state.sim[state.market]; }
  function simSave() { save('sim', state.sim); }

  /* ── 지난번 본 뒤로 늘어난 거래 ──────────────────────────────
     자동 운용은 사용자가 없는 사이에 사고판다. 장부는 진작 있었지만 접혀
     있어서, 열어보기 전에는 무슨 일이 있었는지 알 수 없었다. "따라서 투자하려면
     기록이 보여야 한다"는 게 이 화면의 목적이라, 새로 생긴 거래는 먼저 보여준다.

     날짜가 아니라 **건수**로 센다. ts 는 하루 단위라 같은 날 두 건이 생기면
     날짜로는 구분되지 않는다. 로그는 줄어들지 않으므로 건수 차이가 곧 새 거래다.

     한 번 계산하면 그 방문 동안은 유지한다(state.simFresh). 안 그러면 접기
     하나만 눌러도 다시 그려지면서 "바뀐 것" 칸이 사라진다. */
  var simFresh = { kr: null, us: null };
  /* 계산해 둔 "새 거래" 목록을 버린다. 방금 화면에서 조정을 돌렸을 때처럼
     로그가 늘어난 직후에 부른다 — 안 버리면 그 방문에 이미 계산해 둔 빈
     목록이 남아서, 눌러서 일곱 곳을 조정하고도 🆕 칸에 아무것도 안 뜬다. */
  function simFreshReset(mk) { simFresh[mk] = null; }
  function simNew(mk) {
    var st = state.sim[mk];
    if (simFresh[mk]) return simFresh[mk];
    var seen = Math.max(0, Math.min(st.seen || 0, st.log.length));   /* 초기화 뒤 대비 */
    var n = st.log.length - seen;
    /* 로그는 새 것이 앞(unshift)이므로 앞에서 n개가 새 거래다 */
    simFresh[mk] = n > 0 ? st.log.slice(0, n) : [];
    if (st.seen !== st.log.length) { st.seen = st.log.length; simSave(); }
    return simFresh[mk];
  }
  /* 아직 안 본 거래가 몇 건인지 — 화면을 그리지 않고 세기만 한다(뱃지용) */
  function simUnseen(mk) {
    var st = state.sim[mk];
    if (!st.started) return 0;
    if (simFresh[mk]) return simFresh[mk].length;
    return Math.max(0, st.log.length - Math.max(0, Math.min(st.seen || 0, st.log.length)));
  }

  /* ── 자동 운용을 돌린다 ────────────────────────────────────────
     화면을 그리기 전에 두 시장 모두 한 번씩 확인한다. 사용자가 국내 탭만
     보고 있어도 미국 계좌가 방치되면 안 된다 — 그러면 나중에 "앱의 판단"이
     아니라 "그날의 판단"이 남는다. 같은 시세 스냅샷으로는 두 번 돌지
     않는다 — 새 스냅샷이 올 때마다 한 번씩이다(sim.js).                   */
  function simAutoTick() {
    if (!LIVE || !LIVE.stocks) return;
    var moved = false;
    ['kr', 'us'].forEach(function (mk) {
      var st = state.sim[mk];
      if (!st || !st.started || !st.auto) return;
      var res = SIM.autoRun(st, simCtx(mk));
      if (res.ran) moved = true;
    });
    if (moved) simSave();
  }

  /* ══════════════════════════════════════════════════════════════════
     홈 위젯 + 접이식 영역
     ------------------------------------------------------------------
     홈에 뭘 올릴지는 사람마다 다르다. 보유 종목이 없는 사람에게 "내 투자
     현황"은 빈칸이고, 뉴스를 안 보고 싶은 사람에게 뉴스는 소음이다.
     그래서 위젯 단위로 켜고 끄게 하고, 각 영역은 접을 수 있게 한다.
     선택은 전부 저장되므로 한 번 정리해두면 계속 그 모습으로 열린다.
     ══════════════════════════════════════════════════════════════ */
  var WIDGETS = [
    { key: 'portfolio', icon: '💼', title: '내 투자 현황',          on: true },
    { key: 'sim',       icon: '🎮', title: '모의투자 현황',        on: true },
    { key: 'market',    icon: '📊', title: '시장 지수와 등락 요인', on: true },
    { key: 'news',      icon: '📰', title: '오늘의 증권 뉴스',      on: true },
    { key: 'daily',     icon: '🗓️', title: '오늘의 점검 한 가지',   on: true }
  ];

  function widgetOn(key) {
    if (!state.widgets) return true;                 // 한 번도 안 건드렸으면 전부 켜짐
    return state.widgets[key] !== false;
  }
  function setWidget(key, on) {
    if (!state.widgets) {
      state.widgets = {};
      WIDGETS.forEach(function (w) { state.widgets[w.key] = true; });
    }
    state.widgets[key] = on;
    save('widgets', state.widgets);
  }

  /* 접이식 영역. 기본은 펼침이고, 사용자가 접으면 그 상태가 저장된다. */
  function isOpen(key, dflt) {
    if (state.folds[key] === undefined) return dflt !== false;
    return !!state.folds[key];
  }
  function fold(key, icon, title, body, opts) {
    opts = opts || {};
    var open = isOpen(key, opts.open);
    return '<section class="fold' + (open ? ' is-open' : '') + '">' +
      /* 자기 기본값을 같이 싣는다. 핸들러가 이걸 모르면 "기본 접힘"인 영역을
         눌렀을 때 다시 접기로 계산해 영영 열리지 않는다. */
      '<button class="fold-h" data-fold="' + key + '" data-open="' + (opts.open === false ? '0' : '1') + '" aria-expanded="' + open + '">' +
        '<span class="fold-i">' + icon + '</span>' +
        '<span class="fold-t">' + title + '</span>' +
        (opts.badge ? '<span class="fold-b">' + opts.badge + '</span>' : '') +
        '<span class="fold-c" aria-hidden="true">▾</span>' +
      '</button>' +
      '<div class="fold-body">' + (open ? body : '') + '</div>' +
    '</section>';
  }

  /* 외부에서 온 문자열(뉴스 제목 등)은 반드시 이걸 거쳐 넣는다. */
  function esc(x) {
    return String(x == null ? '' : x)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  /* 링크도 스킴을 확인한다 — http(s) 가 아니면 링크로 만들지 않는다. */
  function safeUrl(u) {
    return /^https?:\/\//i.test(String(u || '')) ? String(u) : '';
  }

  /* ══════════════════════════════════════════════════════════════════
     시세 스냅샷 (live.json)
     ------------------------------------------------------------------
     GitHub Actions 가 주기적으로 받아 저장소에 커밋한 파일을 읽는다.
     같은 출처라 CORS 문제가 없고, 외부 인프라도 필요 없다.
     (받아오는 쪽은 scripts/fetch-live.mjs, 일정은 .github/workflows/live.yml)

     "실시간"이 아니라 **주기적 스냅샷**이다. 그래서 asOf 를 같이 읽어
     화면에 "몇 분 전 값"인지 항상 표시한다 — 실시간인 척하지 않는다.
     파일이 없거나 실패해도 앱은 그대로 돌아간다(링크만 보여준다).
     ══════════════════════════════════════════════════════════════ */
  var LIVE = null;
  var liveAt = 0;          /* 마지막으로 스냅샷을 **받아온** 시각 (ms) */
  var liveBusy = false;

  /* ── 켜 둔 채로도 계속 받아온다 ────────────────────────────────
     예전에는 앱을 켤 때 딱 한 번만 받았다. 그래서 앱을 열어 둔 채 한 시간이
     지나면 화면은 한 시간 전 값을 붙들고 있었고, 모의투자도 그 값으로
     계산했다. "시세를 계속 따라간다"는 말과 실제가 어긋나 있었던 것이다.

     그래서 세 가지 계기에 다시 받는다.
       1. 켜 둔 동안 주기적으로 (POLL_MS)
       2. 다른 앱을 보다 돌아왔을 때 (visibilitychange / pageshow / focus)
       3. "지금 점검하기"를 눌렀을 때 (아래 refreshNow)

     받을 때마다 다시 그리지는 않는다. asOf 가 그대로면 화면도 그대로다 —
     읽던 자리가 이유 없이 새로 그려지면 그게 더 나쁘다.                */
  var POLL_MS  = 5 * 60 * 1000;   /* 켜 둔 동안: 5분마다 */
  var STALE_MS = 60 * 1000;       /* 돌아왔을 때: 1분 넘었으면 다시 */

  /* opts.quiet 를 주면 값이 그대로일 때 아무것도 하지 않는다.
     받아온 뒤에 무엇이 달라졌는지 알아야 하는 쪽이 있어서 Promise 를 준다. */
  function loadLive(opts) {
    opts = opts || {};
    /* 미리보기(단일 파일 번들)에서는 fetch 로 live.json 을 가져올 수 없어
       스냅샷을 인라인으로 심어둔다. 실제 배포본에는 이 변수가 없다. */
    if (window.BC_LIVE_INLINE && !LIVE) LIVE = window.BC_LIVE_INLINE;
    if (!window.fetch) return Promise.resolve(false);
    if (liveBusy) return Promise.resolve(false);
    liveBusy = true;
    /* 캐시를 우회해야 갱신된 스냅샷이 바로 보인다. */
    return fetch('live.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        liveBusy = false;
        if (!j || !j.quotes) return false;
        var was = LIVE && LIVE.asOf;
        /* 직접 받아 둔 값이 있으면 스냅샷 위에 다시 얹는다 — 스냅샷은
           보통 더 낡았으므로, 덮이면 방금 받은 값을 잃는다. */
        var kept = LIVE && LIVE.stocks ? LIVE.stocks : null;
        LIVE = j;
        if (kept) ['kr', 'us'].forEach(function (m) {
          if (!kept[m] || !LIVE.stocks || !LIVE.stocks[m]) return;
          Object.keys(kept[m]).forEach(function (t) {
            if (kept[m][t] && kept[m][t].direct) LIVE.stocks[m][t] = kept[m][t];
          });
        });
        liveAt = Date.now();
        var fresh = was !== j.asOf;
        /* 값이 그대로면 다시 그리지 않는다. 다만 화면의 "몇 분 전"은
           시간이 갈수록 틀려지므로, 눈에 보이는 그 문구만 갈아 끼운다. */
        if (!fresh) { touchAgo(); return false; }
        if (document.getElementById('view-' + current) &&
            document.getElementById('view-' + current).innerHTML) render();
        return true;
      })
      .catch(function () { liveBusy = false; return false; });
  }

  /* 새 스냅샷이 아니어도 "3분 전"은 계속 늙는다. 통째로 다시 그리는 대신
     그 문구가 든 자리만 바꾼다 — 스크롤과 접힘 상태를 건드리지 않으려고. */
  function touchAgo() {
    if (!LIVE || !LIVE.asOf) return;
    var t = agoText(LIVE.asOf);
    ['.idxnote b', '.sdet-ago'].forEach(function (sel) {
      Array.prototype.forEach.call(document.querySelectorAll(sel), function (el) {
        if (/(전|방금)/.test(el.textContent)) {
          el.textContent = el.className === 'sdet-ago' ? t + ' 기준' : t;
        }
      });
    });
  }

  /* 앱을 켜 둔 동안 주기적으로. 화면이 안 보일 때는 받지 않는다 —
     주머니 속에서 5분마다 두드릴 이유가 없다. */
  function startLivePolling() {
    setInterval(function () {
      if (document.hidden) return;
      loadLive().then(function () { return directQuotes(state.market); })
        .then(function (moved) { if (moved) render(); });
    }, POLL_MS);
    var back = function () {
      if (document.hidden) return;
      if (Date.now() - liveAt < STALE_MS) return;
      loadLive();
    };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('pageshow', back);
    window.addEventListener('focus', back);
  }

  /* ══════════════════════════════════════════════════════════════════
     브라우저가 직접 받아오는 시세 (선택 경로)
     ------------------------------------------------------------------
     원래 구조는 "증권 API 는 CORS 를 안 주니 러너가 대신 받아 커밋한다"
     였다(scripts/fetch-live.mjs). 그런데 GitHub 크론이 예약을 안 잡아 주는
     날이 생기면서 그 대가가 드러났다 — 미국장이 열려 있는데 여덟 시간 넘게
     시세가 그대로인 날이 나왔다.

     그래서 **브라우저에서 직접 받아보고, 되면 그걸 쓴다.** 안 되면 지금까지
     하던 대로 live.json 을 쓴다. 손해 볼 게 없는 구조다.

     되는지 안 되는지는 여기서 단정할 수 없다. 러너에서 확인해 봤더니 야후가
     429(요청 과다)로 답했는데, 그건 GitHub 아이피가 많이 두드려서일 뿐
     브라우저가 막힌다는 뜻은 아니다. 확실한 건 실제 기기에서만 알 수 있다.
     그래서 **시도해 보고 결과로 판단한다** — 한 번 실패하면 그 방문 동안은
     다시 시도하지 않는다(콘솔만 시끄러워진다).

     ⚠️ 받아온 값은 live.json 을 덮지 않고 **위에 얹기만** 한다. 직접 받기가
        반쯤 실패해도 나머지는 스냅샷 값이 그대로 남아야 한다.
     ══════════════════════════════════════════════════════════════ */
  var DIRECT = { ok: null, at: 0 };   /* ok: null 아직 모름 · true 됨 · false 막힘 */

  /* 야후 표기. 국내는 .KS 접미사, 미국은 점 대신 하이픈(BRK.B → BRK-B).
     러너 쪽(scripts/fetch-prices.mjs)과 같은 규칙을 쓴다. */
  function ySym(mk, t) {
    return mk === 'kr' ? t + '.KS' : String(t).replace(/\./g, '-');
  }

  /* 지금 화면에 값이 필요한 종목만 고른다. 유니버스 전체를 매번 두드릴
     이유가 없다 — 내 보유와 모의계좌가 실제로 쓰는 자리다. */
  function directWanted(mk) {
    var out = {}, add = function (t) { if (t) out[t] = 1; };
    (state.holdings[mk] || []).forEach(function (h) { add(h.ticker); });
    var st = state.sim[mk];
    if (st && st.pos) st.pos.forEach(function (p) { add(p.t); });
    return Object.keys(out).slice(0, 24);
  }

  function oneQuote(mk, t) {
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
      encodeURIComponent(ySym(mk, t)) + '?range=1d&interval=1d';
    return fetch(url, { mode: 'cors', credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var m = j && j.chart && j.chart.result && j.chart.result[0] &&
                j.chart.result[0].meta;
        var px = m && (m.regularMarketPrice || m.previousClose);
        return (typeof px === 'number' && px > 0) ? { t: t, price: px } : null;
      })
      .catch(function () { return null; });
  }

  /* 몇 개씩 나눠 두드린다. 한꺼번에 스무 개를 던지면 상대 쪽에서 막는다. */
  function directQuotes(mk) {
    if (DIRECT.ok === false) return Promise.resolve(false);
    if (!window.fetch || !window.Promise) return Promise.resolve(false);
    var list = directWanted(mk);
    if (!list.length) return Promise.resolve(false);

    /* ── 한 개로 먼저 떠본다 ────────────────────────────────────
       막혀 있는 환경(CORS 차단, 사내망 등)에서 스무 개를 한꺼번에 던지면
       스무 개의 오류가 콘솔에 쌓인다. 실패의 대가가 그만큼 클 이유가 없다.
       한 종목으로 먼저 확인하고, 되는 게 확인된 뒤에 나머지를 받는다. */
    var probe = DIRECT.ok === true
      ? Promise.resolve(true)
      : oneQuote(mk, list[0]).then(function (r) {
          DIRECT.ok = !!r;
          return !!r;
        });

    return probe.then(function (alive) {
      if (!alive) return false;
      return fetchRest(mk, list);
    });
  }

  function fetchRest(mk, list) {
      var i = 0, got = [];
      function worker() {
        if (i >= list.length) return Promise.resolve();
        var t = list[i++];
        return oneQuote(mk, t).then(function (r) { if (r) got.push(r); return worker(); });
      }
      return Promise.all([worker(), worker(), worker()]).then(function () {
      if (!got.length) return false;
      DIRECT.ok = true; DIRECT.at = Date.now();
      if (!LIVE) LIVE = { quotes: {}, stocks: { kr: {}, us: {} } };
      if (!LIVE.stocks) LIVE.stocks = { kr: {}, us: {} };
      if (!LIVE.stocks[mk]) LIVE.stocks[mk] = {};
      got.forEach(function (r) {
        var was = LIVE.stocks[mk][r.t] || {};
        LIVE.stocks[mk][r.t] = { price: r.price, chg: was.chg, direct: true };
      });
      return true;
    });
  }

  /* 사용자가 직접 "지금 다시 보라"고 했을 때. 캐시도 주기도 무시하고 받는다. */
  function refreshNow() {
    liveBusy = false;
    return Promise.all([
      loadLive({ quiet: true }),
      loadPrices({ force: true })
    ]).then(function () {
      /* 스냅샷을 먼저 깔고, 그 위에 직접 받은 값을 얹는다. 순서가 중요하다 —
         반대로 하면 방금 직접 받은 값이 낡은 스냅샷에 덮인다. */
      return directQuotes(state.market);
    });
  }

  /* ── 보유 종목 시세 (prices.json) ──────────────────────────────
     유니버스 26종목 밖의 종목은 live.json 에 없어서 손익이 0원에 멈춘다.
     그래서 넓은 시세 목록을 따로 받아둔다(scripts/fetch-prices.mjs).

     이 파일은 **보유 종목이나 모의투자 계좌가 있을 때만** 내려받는다.
     아무것도 등록하지 않은 사람까지 매번 그 무게를 질 이유가 없다. */
  var PRICES = null, pricesTried = false;

  function needPrices() {
    return ['kr', 'us'].some(function (mk) {
      return (state.holdings[mk] && state.holdings[mk].length) ||
             (state.sim[mk] && state.sim[mk].pos && state.sim[mk].pos.length);
    });
  }

  /* opts.force 를 주면 이미 받아왔더라도 다시 받는다("지금 점검하기"). */
  function loadPrices(opts) {
    opts = opts || {};
    if (!needPrices()) return Promise.resolve(false);
    if (pricesTried && !opts.force) return Promise.resolve(false);
    pricesTried = true;
    if (window.BC_PRICES_INLINE) { PRICES = window.BC_PRICES_INLINE; return Promise.resolve(false); }
    if (!window.fetch) return Promise.resolve(false);
    return fetch('prices.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.stocks) return false;
        var was = PRICES && PRICES.asOf;
        PRICES = j;
        if (was === j.asOf) return false;
        if (document.getElementById('view-' + current) &&
            document.getElementById('view-' + current).innerHTML) render();
        return true;
      })
      .catch(function () { return false; /* 없으면 없는 대로 — 직접 적은 현재가를 쓴다 */ });
  }

  /* ══════════════════════════════════════════════════════════════════
     종목 해설 (analysis.json)
     ------------------------------------------------------------------
     "궁금한 주식을 치면 답을 받는" 화면의 자료다. 브라우저에서 AI 를 부를
     수는 없다 — 정적 사이트라 키를 심으면 소스에 그대로 노출된다. 그래서
     워크플로가 미리 만들어 두고(scripts/analyze-stocks.mjs) 앱은 읽기만 한다.

     파일이 크므로 **알아보기 탭을 열 때만** 받는다. 다른 탭만 쓰는 사람은
     한 번도 받지 않는다.
     ══════════════════════════════════════════════════════════════════ */
  var ANALYSIS = null, anaTried = false, anaFailed = false;
  function loadAnalysis() {
    if (anaTried) return;
    anaTried = true;
    if (window.BC_ANALYSIS_INLINE) { ANALYSIS = window.BC_ANALYSIS_INLINE; return; }
    if (!window.fetch) { anaFailed = true; return; }
    fetch('analysis.json?t=' + Math.floor(Date.now() / 86400000), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.items) { anaFailed = true; }
        else ANALYSIS = j;
        /* 알아보기 탭만이 아니라 내 주식 판정에도 쓰인다(scoreOfIn).
           도착하면 지금 보고 있는 화면을 다시 그린다. */
        if (document.getElementById('view-' + current) &&
            document.getElementById('view-' + current).innerHTML) render();
      })
      .catch(function () {
        anaFailed = true;
        if (document.getElementById('view-' + current) &&
            document.getElementById('view-' + current).innerHTML) render();
      });
  }
  function analysisOf(ticker) {
    if (!ANALYSIS || !ANALYSIS.items || !ticker) return null;
    return ANALYSIS.items[ticker] || ANALYSIS.items[String(ticker).toUpperCase()] || null;
  }

  /* ══════════════════════════════════════════════════════════════════
     종목 이름 색인 (tickers.json)
     ------------------------------------------------------------------
     국내·미국 상장 종목 전체 목록이라 수백 KB쯤 된다. 홈을 열 때마다 받으면
     낭비라서 **종목 추가 폼을 처음 열 때만** 내려받는다.
     형식은 용량을 줄인 배열: [티커, 이름, ETF여부]
     ══════════════════════════════════════════════════════════════ */
  var TICKERS = null;
  var tickersState = 'idle';   // idle | loading | ready | failed

  function loadTickers() {
    if (tickersState === 'loading' || tickersState === 'ready') return;
    if (!window.fetch) { tickersState = 'failed'; return; }
    tickersState = 'loading';
    fetch('tickers.json', { cache: 'default' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && (j.kr || j.us)) { TICKERS = j; tickersState = 'ready'; }
        else tickersState = 'failed';
        if (state.addOpen) render();
      })
      .catch(function () { tickersState = 'failed'; if (state.addOpen) render(); });
  }

  /* 검색. 유니버스(50년 카드에 있는 종목)를 먼저 올린다 — 이 앱이 실제로
     평가하고 시세도 갖고 있는 종목이라 사용자에게 가장 쓸모 있다. */
  /* KRX 공식 약칭이 영문인 종목이 있다. "네이버"를 쳐도 안 나오면 사용자는
     그 종목이 없다고 생각하고 이름을 직접 적어버린다 — 그러면 티커가 안 붙어
     시세도 판정도 못 붙는다. 실제로 검색되던 자리를 막지 않으려고, 원래
     질의와 치환한 질의를 **둘 다** 본다. */
  var KOR_ALIAS = {
    '네이버': 'naver', '엘지': 'lg', '포스코': 'posco', '케이비': 'kb',
    '신한': 'shinhan', '하나': 'hana', '우리': 'woori', '기업은행': 'ibk',
    '에스케이': 'sk', '지에스': 'gs', '씨제이': 'cj', '한국전력': '한국전력',
    '케이티': 'kt', '엘엑스': 'lx', '에이치디': 'hd', '디비': 'db'
  };

  /* 미국에 ADR 로 상장된 한국 기업. 이름이 영문뿐이라 "하이닉스"로는
     한 줄도 안 나왔다. 그러면 사용자는 이름을 직접 적어버리고, 티커가 안 붙어
     시세도 손익도 멈춘다(§18). 티커별로 한글 표기를 적어 둔다. */
  var US_KOR = {
    SKHY: '에스케이하이닉스 sk하이닉스 하이닉스',
    SKM: '에스케이텔레콤 sk텔레콤',
    KB: '케이비금융 kb금융',
    SHG: '신한지주 신한금융',
    WF: '우리금융',
    KEP: '한국전력 한전',
    PKX: '포스코홀딩스 포스코',
    LPL: '엘지디스플레이 lg디스플레이',
    CPNG: '쿠팡',
    GRVY: '그라비티'
  };

  /* 배율·인버스 상품. "SK"를 치면 'Corgi SK hynix 2x Daily ETF'가
     티커 정확 일치로 1등이었다 — 그걸 고르면 원주 대신 2배 ETF 가 등록된다.
     ETF 로 표시된 줄에만 적용한다(Ultra Clean 같은 실제 기업은 건드리지 않음). */
  var LEV = /(\b[123]x\b|ultra|inverse|leverage|\bbull\b|\bbear\b)/i;

  function searchTickers(q, mk) {
    var query = String(q || '').trim();
    if (!query) return [];
    var lq = query.toLowerCase();
    /* 별칭이 있으면 그것도 후보 질의로 함께 쓴다 */
    var alt = null;
    for (var k in KOR_ALIAS) {
      if (lq.indexOf(k) === 0) { alt = KOR_ALIAS[k] + lq.slice(k.length); break; }
    }
    var isCode = /^[0-9]{2,6}$/.test(query);
    var out = [], seen = {};

    function push(t, n, etf, inUni) {
      /* 티커가 있으면 티커로만 중복을 판단한다. 같은 종목이라도 유니버스와
         상장 목록의 표기가 달라서("Microsoft" vs "Microsoft Corporation")
         이름까지 키에 넣으면 같은 회사가 두 줄로 나온다. */
      var key = t ? 't:' + t.toUpperCase() : 'n:' + n;
      if (seen[key]) return;
      seen[key] = 1;
      out.push({ t: t, n: n, etf: etf, uni: inUni, price: priceIn(mk, t) });
    }

    D.markets[mk].picks.forEach(function (p) {
      var hay = (p.name + ' ' + (p.korName || '') + ' ' + p.ticker).toLowerCase();
      if (hay.indexOf(lq) >= 0 || (alt && hay.indexOf(alt) >= 0)) push(p.ticker, p.name, 0, true);
    });

    if (TICKERS && TICKERS[mk]) {
      /* ── 순위 ──
         예전에는 "이름이 질의로 시작하면" 전부 한 묶음에 넣고 색인 순서(=알파벳
         티커 순) 그대로 보여줬다. 그래서 "Intel"을 치면 Intel Corporation 이
         아니라 Intelligent Alpha Atlas ETF(GPT)가 첫 줄에 왔다. 실제로 그걸
         고르면 엉뚱한 종목이 등록된다.

         이제 점수로 정렬한다. 낮을수록 먼저다. 핵심은 "Intel " 처럼 낱말이
         거기서 끝나는 경우를, "Intelligent" 처럼 이어지는 경우보다 위에 두는
         것이다. ETF 는 같은 점수대에서 뒤로 민다 — 이 앱이 다루는 대상이
         아니지만 들고 있을 수는 있어서 지우지는 않는다. */
      var list = TICKERS[mk];
      var hits = [];
      for (var i = 0; i < list.length; i++) {
        var t = list[i][0], n = list[i][1];
        var lt = t.toLowerCase(), ln = n.toLowerCase();
        var rank = -1;

        if (isCode) {
          if (t.indexOf(query) === 0) rank = t === query ? 0 : 2;
        } else if (lt === lq) {
          rank = 0;                                   /* 티커가 정확히 일치 */
        } else if (ln === lq) {
          rank = 1;                                   /* 이름이 정확히 일치 */
        } else if (ln.indexOf(lq) === 0) {
          /* 이름이 질의로 시작 — 바로 뒤가 낱말 끝이면 훨씬 좋은 매치다 */
          rank = /[a-z0-9]/.test(ln.charAt(lq.length) || ' ') ? 4 : 2;
        } else if (US_KOR[t] && mk === 'us' && US_KOR[t].indexOf(lq) >= 0) {
          rank = 2;                                   /* 한글 표기로 찾은 ADR */
        } else if (lt.indexOf(lq) === 0) {
          rank = 3;                                   /* 티커가 질의로 시작 */
        } else if (ln.indexOf(lq) > 0) {
          rank = 5;                                   /* 이름 중간에 포함 */
        } else if (alt && ln.indexOf(alt) === 0) {
          rank = 4.2;                                 /* 별칭으로 찾음 */
        } else if (alt && ln.indexOf(alt) > 0) {
          rank = 5.2;
        }
        if (rank < 0) continue;
        /* ETF 는 반 칸 뒤로, 배율·인버스 상품은 두 칸 뒤로 */
        if (list[i][2]) rank += LEV.test(n) ? 2 : 0.5;
        hits.push({ r: rank, len: n.length, row: list[i] });
      }
      /* 같은 점수면 이름이 짧은 쪽 — "Intel Corporation"이
         "Intel Corporation Warrant"보다 먼저 나오게 한다. */
      hits.sort(function (a, b) { return a.r - b.r || a.len - b.len; });
      hits.slice(0, 40).forEach(function (x) { push(x.row[0], x.row[1], x.row[2], false); });
    }
    return out.slice(0, 8);
  }

  /* ── 지금 장이 열려 있나 ────────────────────────────────────────
     UTC 로 따진다. 기기 시간대가 무엇이든 같은 답이 나와야 하기 때문이다.
       국내 09:00~15:30 KST = 00:00~06:30 UTC
       미국 09:30~16:00 ET  = 13:30~20:00 UTC (서머타임 기준, 겨울엔 한 시간 뒤)
     경계는 넉넉하게 잡는다 — 여기서 하는 일은 "낡았다"고 알려줄지 말지를
     정하는 것뿐이라, 조금 넓게 봐서 손해 볼 게 없다. */
  function marketOpenNow(mk) {
    var d = new Date(), wd = d.getUTCDay();
    if (wd === 0 || wd === 6) return false;
    var m = d.getUTCHours() * 60 + d.getUTCMinutes();
    return mk === 'kr' ? (m >= 0 && m <= 400)      /* 00:00~06:40 UTC */
                       : (m >= 800 && m <= 1260);  /* 13:20~21:00 UTC */
  }

  /* 장중인데 스냅샷이 이만큼 낡았으면 그 사실을 눈에 보이게 말한다.
     크론이 밀리는 일이 실제로 있었다(다섯 시간 동안 한 번도 안 돈 날). 그때
     화면은 아무 일 없다는 듯 옛 숫자를 보여줬다 — 그게 제일 나쁘다. */
  var STALE_WARN_MIN = 45;
  function liveStale() {
    if (!LIVE || !LIVE.asOf) return null;
    if (!marketOpenNow('kr') && !marketOpenNow('us')) return null;
    var m = minutesAgo(LIVE.asOf);
    return (m !== null && m >= STALE_WARN_MIN) ? m : null;
  }

  function minutesAgo(iso) {
    var t = new Date(iso).getTime();
    if (!t) return null;
    return Math.max(0, Math.round((Date.now() - t) / 60000));
  }
  function agoText(iso) {
    var m = minutesAgo(iso);
    if (m === null) return '';
    if (m < 1) return '방금';
    if (m < 60) return m + '분 전';
    var hr = Math.round(m / 60);
    if (hr < 24) return hr + '시간 전';
    return Math.round(hr / 24) + '일 전';
  }
  /* 한국어 조사 '으로/로'. 받침이 없거나 'ㄹ' 받침이면 '로'.
     "원화 강세으로" 같은 문장이 나오면 앱이 대충 만들어졌다는 신호로 읽힌다. */
  function ro(word) {
    var last = String(word).charCodeAt(String(word).length - 1);
    if (last < 0xac00 || last > 0xd7a3) return '로';
    var jong = (last - 0xac00) % 28;
    return (jong === 0 || jong === 8) ? '로' : '으로';
  }

  function fmtNum(v, unit) {
    var d = Math.abs(v) >= 1000 ? 0 : 2;
    return v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d }) + (unit || '');
  }

  /* ── 날짜 ──────────────────────────────────────────────────────── */
  function today() { return new Date(); }
  function ymd(d) {
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function daysSince(iso) {
    var t = new Date(iso + 'T00:00:00');
    return Math.max(0, Math.floor((Date.now() - t.getTime()) / 86400000));
  }
  function dayOfYear(d) {
    return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
  }
  var WEEK = ['일', '월', '화', '수', '목', '금', '토'];

  /* ── 오늘의 점검 한 가지 ───────────────────────────────────────
     이건 진짜로 매일 바뀐다 — 날짜에서 나오니까. 시장 데이터인 척하지
     않고, 그날 해볼 만한 행동 하나만 준다.                          */
  var DAILY = [
    /* cta: 시키기만 하고 갈 곳이 없으면 그 점검은 아무도 못 한다.
       할 자리가 앱 안에 있는 항목만 남기고, 그런 항목은 거기로 데려간다. */
    { i: '🔍', t: '보유 종목 중 목표 비중에서 가장 많이 벗어난 자리를 확인하세요',
      d: '벌어진 자리를 되돌리는 것만으로 "비싸게 팔고 싸게 사기"가 자동으로 됩니다.', cta: 'my' },
    { i: '🔕', t: '증권사 앱 푸시 알림을 꺼보세요', d: '확인 빈도를 줄이는 것만으로 불필요한 매매가 크게 줍니다.' },
    { i: '🏦', t: '비상금이 생활비 3~6개월치 있는지 확인하세요', d: '이게 없으면 하락장에서 주식을 팔아 생활비를 만들게 됩니다.' },
    { i: '🧾', t: '지금 쓰는 계좌가 ISA·연금저축인지 일반계좌인지 확인하세요', d: '같은 종목이라도 어느 계좌에 담느냐로 실수령액이 달라집니다.' },
    { i: '📉', t: '내 포트폴리오가 반토막 났다고 상상해보세요', d: '그때 팔 것 같으면 지금 성향을 한 단계 낮추는 게 맞습니다.' },
    { i: '🧺', t: '보유 종목들이 같이 빠지는 종목인지 확인하세요', d: '종목 수가 많아도 같은 업종이면 분산이 아닙니다.' },
    { i: '💱', t: '증권사 환전 우대율을 한 번 비교해보세요', d: '장기 적립이면 우대율이 매매 수수료보다 크게 작용합니다.' },
    { i: '📅', t: '자동이체 날짜가 월급날 다음 날로 걸려 있는지 보세요', d: '의지력을 쓰지 않게 만드는 게 핵심입니다.' },
    { i: '🗞️', t: '오늘 기사 판정이 전부 “할 일 없음”이면 계좌를 열지 마세요', d: '판정을 보고 안심한 뒤 굳이 계좌를 확인하면, 결국 아무 이유 없이 매매하게 됩니다.' },
    { i: '⚖️', t: '실제 계좌의 비중을 모의투자의 목표 비중과 비교해보세요', d: '모의투자는 국면이 바뀔 때마다 자동으로 맞춰집니다. 내 계좌는 얼마나 벌어져 있나요.', cta: 'sim' },
    { i: '💸', t: '고배당 종목의 배당성향이 무리하지 않은지 확인하세요', d: '수익률이 높은 게 아니라 주가가 빠져서 높아 보이는 경우가 많습니다.' },
    { i: '🎯', t: '이번 달 넣을 금액을 몇 번에 나눌지 정해두세요', d: '정해두면 급등·급락에 계획이 흔들리지 않습니다.' }
  ];

  /* ══════════════════════════════════════════════════════════════════
     뷰 1 — 홈: 지금 시장은 어떤가 + 내 돈은 지금 어떤가
     ------------------------------------------------------------------
     지수 "수치"는 담지 않는다. 정적 앱이라 못 가져오고, 넣는 순간 낡는다.
     대신 확인 링크를 주고, **왜 오르고 왜 내리는지**는 사용자가 맞춘
     다이얼에서 도출해 보여준다. 초보자에게는 숫자보다 이쪽이 쓸모 있다.
     ══════════════════════════════════════════════════════════════ */
  function renderHome() {
    var mk = market(), st = regime();
    var reg = M.labelRegime(st);
    var now = today();
    var h = [];

    h.push('<div class="todaybar">' +
      '<div class="todaybar-d">' + (now.getMonth() + 1) + '월 ' + now.getDate() + '일 ' + WEEK[now.getDay()] + '요일</div>' +
      '<div class="todaybar-r">' + reg.emoji + ' ' + reg.name + '</div>' +
      '<button class="wgt-edit' + (state.editWidgets ? ' is-on' : '') + '" id="wgt-toggle" title="홈에 올릴 내용 고르기">⚙️</button></div>');

    /* 위젯 편집 패널 */
    if (state.editWidgets) {
      h.push('<div class="wgt-panel"><div class="wgt-panel-h">홈에 올릴 내용</div>');
      WIDGETS.forEach(function (w) {
        var on = widgetOn(w.key);
        h.push('<label class="wgt-row"><span>' + w.icon + ' ' + w.title + '</span>' +
          '<input type="checkbox" class="wgt-chk" data-widget="' + w.key + '"' + (on ? ' checked' : '') + ' /></label>');
      });
      h.push('<div class="wgt-note">끈 내용은 해당 탭에서 그대로 볼 수 있습니다. 선택은 이 브라우저에 저장됩니다.</div></div>');
    }

    /* 아래 모든 계산이 어떤 판정에 기대고 있는지는 위젯과 무관하게 항상
       보여준다. 판정 주체를 숨기면 사용자가 결과를 검증할 수 없다. */
    var by = regimeBy();
    if (by === 'manual') {
      var mage = state.touched[state.market] ? daysSince(state.touched[state.market]) : null;
      h.push('<button class="freshcta" data-go="market">✍️ ' + mk.flag + ' ' + mk.label +
        ' — <b>직접 고친 값</b>으로 계산 중입니다' +
        (mage === null ? '' : ' (' + (mage === 0 ? '오늘' : mage + '일 전') + ' 수정)') +
        '. 자동 판정 보기 →</button>');
    } else if (by === 'default') {
      h.push('<button class="freshcta" data-go="market">⚠️ ' + mk.flag + ' ' + mk.label +
        ' — <b>자동 판정을 아직 못 받아왔습니다.</b> 지금은 미리 채워둔 출발값 기준입니다 →</button>');
    } else {
      h.push('<div class="freshok">' + (by === 'ai' ? '🤖 AI' : '📐 규칙') + ' 자동 판정 · ' +
        mk.flag + ' ' + mk.label + ' — ' + agoText(LIVE.regime.asOf) + ' 갱신된 값 기준</div>');
    }

    /* ── 홈의 순서 ────────────────────────────────────────────────
       이 앱의 목적은 "AI 가 굴리는 계좌를 보고 내 계좌를 맞춘다"이다.
       그러면 홈에서 제일 먼저 보여야 하는 건 **내 계좌와 AI 계좌**다.

       예전 순서는 지수 → 뉴스 → 내 투자 → 모의투자였다. 그런데 뉴스가
       여섯 건씩 펼쳐져 홈의 절반을 먹었고(게다가 여섯 건 모두 "오늘 할 일
       없음"이라 같은 문장이 여섯 번 반복됐다), 정작 목적에 해당하는 두
       칸은 세 화면쯤 스크롤해야 나왔다. 순서를 뒤집는다.

       지수와 뉴스는 참고 자료다. 접어 두고, 필요할 때 편다. */
    if (widgetOn('portfolio')) h.push(fold('w-portfolio', '💼', '내 투자 현황', portfolioWidget(), { badge: portfolioBadge() }));
    if (widgetOn('sim')) {
      /* 안 본 거래가 있으면 건수를 먼저 알린다 — 접힌 채로도 보인다.
         뱃지도 두 시장을 합쳐서 본다 — 홈은 전체를 보는 자리다. */
      var un = simUnseen('kr') + simUnseen('us');
      var anyRun = !!(state.sim.kr.started || state.sim.us.started);
      h.push(fold('w-sim', '🎮', '모의투자 현황', simWidget(),
        { badge: un ? '🆕 ' + un + '건' : (anyRun ? '진행 중' : '') }));
    }
    if (widgetOn('market'))    h.push(fold('w-market', '📊', mk.full, marketWidget()));
    if (widgetOn('news'))      h.push(fold('w-news', '📰', '오늘의 증권 뉴스', newsWidget(),
      { open: false, badge: newsBadge() }));
    if (widgetOn('daily'))     h.push(fold('w-daily', '🗓️', '오늘의 점검 한 가지', dailyWidget(), { open: false }));

    if (!WIDGETS.some(function (w) { return widgetOn(w.key); })) {
      h.push('<div class="note">홈에 올린 내용이 없습니다. 오른쪽 위 ⚙️ 로 다시 켤 수 있습니다.</div>');
    }

    h.push('<button class="btn ghost" data-go="plan">🎯 시드로 배분안 만들기 →</button>');
    h.push('<div class="foot"><b>고지.</b> 이 앱은 투자 교육 자료입니다. 특정 종목의 매수·매도를 권유하지 않으며 ' +
      '어떤 수익도 보장하지 않습니다. 손익은 사용자가 입력한 값으로 계산한 것입니다.</div>');

    return h.join('');
  }

  /* ── 위젯: 시장 지수 + 등락 요인 ── */
  function marketWidget() {
    var mk = market();
    var h = [];

    h.push('<div class="idxrow">');
    mk.indices.forEach(function (i) {
      var q = LIVE && LIVE.quotes ? LIVE.quotes[i.sym] : null;
      if (q) {
        h.push('<a class="idxtile" href="' + i.url + '" target="_blank" rel="noopener">' +
          '<span class="idx-n">' + i.name + '</span>' +
          '<span class="idx-v">' + fmtNum(q.price, i.unit) + '</span>' +
          '<span class="idx-c ' + plClass(q.chg) + '">' + (q.chg > 0 ? '▲' : q.chg < 0 ? '▼' : '–') + ' ' +
            Math.abs(q.chg).toFixed(2) + '%</span></a>');
      } else {
        h.push('<a class="idxtile empty" href="' + i.url + '" target="_blank" rel="noopener">' +
          '<span class="idx-n">' + i.name + '</span><span class="idx-v">–</span>' +
          '<span class="idx-c">확인 ↗</span></a>');
      }
    });
    h.push('</div>');

    var hasQuote = LIVE && LIVE.quotes && Object.keys(LIVE.quotes).length > 0;
    /* ── 시세가 언제 것인지 ────────────────────────────────────
       ⚠️ 클래스 이름은 반드시 새로 짓는다. 처음엔 여기에 `.stale` 을 썼는데
          그 이름은 이미 국면 진단 배지가 쓰고 있었고(display:flex), 그래서
          글자 조각이 전부 flex 칸이 되어 세로로 쪼개졌다. 이름을 겹쳐 쓰면
          남의 레이아웃을 그대로 물려받는다. */
    var stale = liveStale();
    var body = hasQuote && LIVE.asOf
      ? (stale
          ? '<b>장중인데 시세가 ' + agoText(LIVE.asOf) + ' 값입니다</b>' +
            '<span>아래 숫자는 그때 기준입니다. 판단 전에 다시 받아 주세요.</span>'
          /* 평상시에는 한 줄로 끝낸다. 매번 세 줄짜리 설명을 읽히면
             정작 중요한 "언제 값인가"가 묻힌다. 자세한 사정은 낡았을 때만
             말한다 — 그때가 실제로 알아야 하는 순간이다. */
          : '<span><b>' + agoText(LIVE.asOf) + '</b> 받아온 값</span>')
      : '<span>시세를 아직 못 받아왔습니다.</span>';

    h.push('<div class="freshbar' + (stale ? ' is-old' : '') + '">' +
      '<span class="fresh-i">' + (stale ? '⚠️' : '🕒') + '</span>' +
      '<div class="fresh-t">' + body + '</div>' +
      '<button class="fresh-b" id="live-refresh">다시 받기</button>' +
    '</div>');

    return h.join('');
  }

  /* ── 기사 판정 표시 ────────────────────────────────────────────
     예전에는 뉴스 밑에 3문항 자가점검을 두고 사용자가 스스로 답하게 했다.
     좋은 질문이었지만 헤드라인마다 세 번씩 자문하는 사람은 없었고, 결국
     헤드라인만 읽고 불안해지는 화면이 됐다. 지금은 판정기가 대신 답한다.

     판정값은 셋뿐이다. 어느 것도 매매 지시가 아니다 — 이 앱은 추천하지 않는다. */
  var ACTS = {
    none:   { i: '✅', l: '오늘 할 일 없음', c: 'act-none' },
    watch:  { i: '👀', l: '지켜보기',        c: 'act-watch' },
    review: { i: '🔍', l: '근거 다시 확인',  c: 'act-review' }
  };
  var SCOPES = { market: '시장 전체', sector: '업종', company: '개별 회사' };

  /* ── 기사가 내 종목 이야기인가 ────────────────────────────────
     판정이 온통 "오늘 할 일 없음"으로 보였던 진짜 이유는 판정이 짜서가 아니라,
     **기사와 보유 종목이 아예 연결돼 있지 않아서**였다. SK하이닉스를 98%
     들고 있는 사람과 한 주도 없는 사람에게 같은 기사가 같은 무게일 수 없다.

     대조는 브라우저에서 한다. 보유 종목은 기기 밖으로 나가지 않으므로
     워크플로는 이 대조를 대신 해 줄 수 없다(설계상 그렇다).             */
  var NAME_TAIL = /[,\s]*(inc|corp|corporation|co|company|ltd|limited|holdings|group|plc|sa|ag|nv)\.?$/i;
  function aliasesOf(it, mk) {
    var out = [];
    if (it.ticker) out.push(it.ticker);
    if (it.name) {
      var n = String(it.name).trim();
      out.push(n);
      /* "SK hynix Inc." → "SK hynix" — 기사 제목은 법인 접미어를 안 쓴다 */
      var short = n.replace(NAME_TAIL, '').replace(NAME_TAIL, '').trim();
      if (short && short !== n) out.push(short);
    }
    D.markets[mk].picks.forEach(function (p) {
      if (!it.ticker || p.ticker.toUpperCase() !== String(it.ticker).toUpperCase()) return;
      out.push(p.name);
      if (p.korName) out.push(p.korName);
    });
    if (mk === 'us' && US_KOR[String(it.ticker || '').toUpperCase()]) {
      out = out.concat(US_KOR[String(it.ticker).toUpperCase()].split(' '));
    }
    /* 너무 짧은 조각은 버린다. "SK" 두 글자로 대조하면 관계없는 기사가
       죄다 걸린다 — 잘못 걸린 경고는 안 하느니만 못하다. */
    var seen = {}, keep = [];
    out.forEach(function (a) {
      a = String(a || '').trim().toLowerCase();
      var min = /[가-힣]/.test(a) ? 3 : 4;
      if (a.length < min || seen[a]) return;
      seen[a] = 1; keep.push(a);
    });
    return keep;
  }

  /* 별칭 하나가 제목에 나오는지.
     영문은 **낱말 경계**를 본다. 그냥 포함으로 보면 "Intelligent Alpha Atlas
     ETF"가 'intel'에 걸려서 인텔 기사로 둔갑한다(자동완성에서 똑같은 걸
     겪었다 — §18). 한글은 조사가 붙어 다녀서("삼성전자가") 포함으로 본다. */
  function aliasHit(hay, a) {
    if (/[가-힣]/.test(a)) return hay.indexOf(a) >= 0;
    var esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^a-z0-9])' + esc + '($|[^a-z0-9])', 'i').test(hay);
  }

  /* 기사 하나가 어떤 보유 종목을 가리키는지. 없으면 빈 배열. */
  function newsHits(n, rows, mk) {
    var hay = [(n.ko || ''), (n.title || '')].join(' ').toLowerCase();
    if (!hay.trim()) return [];
    return (rows || []).filter(function (r) {
      return aliasesOf(r, mk).some(function (a) { return aliasHit(hay, a); });
    });
  }

  /* 그 기사 밑에 붙는 줄. 여기서만 금액이 나온다 — 기사 때문이 아니라
     "지금 내 자리가 이렇다"는 사실을 같은 자리에서 보여주는 것이다. */
  function newsHoldHtml(hits, mk) {
    if (!hits.length) return '';
    return '<div class="nv-hold">' + hits.map(function (r) {
      var x = r.action;
      var line = '<b>' + esc(r.name) + '</b> 비중 <b>' + r.weight + '%</b>';
      if (x && x.kind !== 'add') {
        line += ' · ' + (x.to === H.cap ? '집중 상한 ' + H.cap + '%' : '목표 ' + x.to + '%') +
          ' 초과분 <b>' + nMoney(x.amount, mk) + '</b>' +
          (x.qty !== null ? '(' + x.qty.toLocaleString('ko-KR') + '주)' : '');
      } else if (x && x.kind === 'add') {
        line += ' · 목표 ' + x.to + '% 까지 <b>' + nMoney(x.amount, mk) + '</b> 여유';
      } else {
        line += ' · 목표와 크게 다르지 않습니다';
      }
      return '<span class="nvh-row">📌 보유 중 — ' + line + '</span>';
    }).join('') +
    '<button class="linkbtn" data-go="my">내 주식에서 보기 →</button></div>';
  }

  /* 오늘 기사 전체를 한 줄로 요약한다. 여섯 건을 다 읽지 않아도
     "오늘은 할 일이 없다"를 먼저 알 수 있어야 한다. */
  function newsRollup(list, mine) {
    var n = { none: 0, watch: 0, review: 0 };
    list.forEach(function (x) { if (n[x.act] !== undefined) n[x.act]++; else n.none++; });
    var by = LIVE && LIVE.newsBy === 'ai' ? '🤖 AI' : '📐 규칙';
    /* 보유 종목이 걸린 기사는 맨 앞에 세운다. 여섯 건 중 내 이야기가 몇 건인지가
       "오늘 할 일 없음"보다 먼저 알아야 할 사실이다. */
    var mineLine = mine && mine.n
      ? '<div class="rollup-mine">📌 이 중 <b>' + mine.n + '건</b>이 회원님이 들고 있는 ' +
        '<b>' + esc(mine.names.join(', ')) + '</b> 이야기입니다.</div>'
      : '';
    if (!n.watch && !n.review) {
      return '<div class="rollup ' + (mine && mine.n ? 'warn' : 'ok') + '"><b>오늘 할 일은 없습니다.</b> 기사 ' + list.length +
        '건 모두 이미 가격에 반영됐을 이야기로 봤습니다. <span class="rollup-by">' + by + ' 판정</span>' +
        mineLine + '</div>';
    }
    var parts = [];
    if (n.review) parts.push('<b>' + n.review + '건</b>은 투자 근거를 다시 확인');
    if (n.watch) parts.push('<b>' + n.watch + '건</b>은 지켜보기');
    return '<div class="rollup warn">기사 ' + list.length + '건 중 ' + parts.join(', ') +
      ', 나머지 ' + n.none + '건은 할 일 없음. <b>오늘 매매하라는 뜻이 아닙니다.</b>' +
      ' <span class="rollup-by">' + by + ' 판정</span>' + mineLine + '</div>';
  }

  /* 접힌 채로도 "오늘 볼 게 있나"만은 알 수 있어야 한다.
     펴야만 알 수 있으면 결국 매일 펴게 되고, 접어 둔 뜻이 없어진다. */
  function newsBadge() {
    var list = (LIVE && LIVE.news && LIVE.news[state.market]) || [];
    if (!list.length) return '';
    var n = 0;
    list.forEach(function (x) { if (x.act === 'review' || x.act === 'watch') n++; });
    return n ? '🔎 ' + n + '건' : '할 일 없음';
  }

  /* ── 위젯: 뉴스 ──
     뉴스는 이 앱의 목적(감정 매매 줄이기)과 부딪히기 쉬운 콘텐츠다.
     그래서 헤드라인마다 판정 한 줄을 붙이고, 위에 오늘 전체 요약을 둔다. */
  function newsWidget() {
    var list = LIVE && LIVE.news ? LIVE.news[state.market] : null;
    var h = [];
    if (!list || !list.length) {
      h.push('<div class="note">아직 받아온 기사가 없습니다. ' +
        (state.market === 'kr'
          ? '<a href="https://finance.naver.com/news/mainnews.naver" target="_blank" rel="noopener">네이버 금융 뉴스 ↗</a>'
          : '<a href="https://finance.yahoo.com/topic/stock-market-news/" target="_blank" rel="noopener">Yahoo Finance ↗</a>') +
        '에서 확인하세요.</div>');
      return h.join('');
    }
    var translated = 0;
    /* 보유 분석을 한 번만 돌려서 기사마다 대조한다 */
    var mk = state.market;
    var rows = [];
    if (state.holdings[mk] && state.holdings[mk].length) {
      rows = analyzeMarket(mk).rows;
    }
    var mineNames = {}, mineCount = 0;
    var hitsBy = list.map(function (n) {
      var hh = rows.length ? newsHits(n, rows, mk) : [];
      if (hh.length) { mineCount++; hh.forEach(function (r) { mineNames[r.name] = 1; }); }
      return hh;
    });
    h.push(newsRollup(list, { n: mineCount, names: Object.keys(mineNames) }));
    h.push('<div class="newslist">');
    list.forEach(function (n, ni) {
      var u = safeUrl(n.link);
      if (!u) return;
      /* 번역이 있으면 한국어를 앞에 세우고 원문을 아래에 남긴다.
         기계 번역은 금융 헤드라인의 뜻을 뒤집을 때가 있어서, 원문을 감추면
         사용자가 확인할 방법이 없어진다. */
      var hasKo = !!n.ko;
      if (hasKo) translated++;
      var act = ACTS[n.act] || ACTS.none;
      h.push('<div class="newsitem">' +
        '<a class="news-hd" href="' + esc(u) + '" target="_blank" rel="noopener">' +
          '<span class="news-body">' +
            '<span class="news-t">' + esc(hasKo ? n.ko : n.title) + '</span>' +
            (hasKo ? '<span class="news-o">' + esc(n.title) + '</span>' : '') +
          '</span>' +
          '<span class="news-s">' + esc(n.source) + '</span></a>' +
        '<div class="news-v ' + act.c + '">' +
          '<span class="nv-tag">' + act.i + ' ' + act.l + '</span>' +
          (n.scope && SCOPES[n.scope] ? '<span class="nv-scope">' + SCOPES[n.scope] + '</span>' : '') +
          (n.lasting === 'structural' ? '<span class="nv-scope">구조 변화 가능성</span>' : '') +
          '<span class="nv-why">' + esc(n.why || '') + '</span>' +
          newsHoldHtml(hitsBy[ni] || [], mk) +
        '</div></div>');
    });
    h.push('</div>');
    if (translated) {
      h.push('<div class="newstr">🌐 미국 기사는 <b>기계 번역</b>입니다 (' + translated + '/' + list.length + '건). ' +
        '뜻이 뒤집히는 경우가 있어 원문을 함께 보여줍니다.</div>');
    }
    h.push('<div class="newsguard">📌 <b>판정은 매매 지시가 아닙니다.</b> “근거 다시 확인”도 파는 게 아니라 ' +
      '처음 산 이유가 아직 유효한지 보라는 뜻입니다. ' +
      '<button class="linkbtn" data-go="learn" data-sub="study">판정 기준 보기 →</button></div>');
    if (LIVE && LIVE.asOf) h.push('<div class="idxnote">🕒 ' + agoText(LIVE.asOf) + ' 받아온 목록입니다.</div>');
    return h.join('');
  }

  /* ── 얼마나 어긋났는지를 금액으로 ────────────────────────────
     판정은 여태 말로만 했다("일부를 덜어 목표에 맞추면"). 그러면 사용자는
     "그래서 얼마?"를 스스로 계산해야 하고, 아무도 하지 않는다. 그래서 화면이
     늘 "확인하세요"로 끝나 보였다.

     여기 나오는 숫자는 **예측이 아니라 산수**다. 사용자가 고른 목표 비중과
     지금 비중의 차이를 금액과 주수로 바꾼 것뿐이다. "오를 것 같으니 사라"는
     못 해도 "목표보다 6,400만원어치 많다"는 사실은 말할 수 있다.        */
  var ACTLAB = {
    cut:  { i: '✂️', t: '덜어낼 자리', c: 'ax-cut' },
    trim: { i: '✂️', t: '덜어낼 자리', c: 'ax-cut' },
    add:  { i: '➕', t: '채울 자리',   c: 'ax-add' }
  };
  function actionHtml(r, mk) {
    var x = r.action;
    if (!x) return '';
    var lab = ACTLAB[x.kind];
    var qty = x.qty !== null ? ' <span class="ax-q">(' + x.qty.toLocaleString('ko-KR') + '주)</span>' : '';
    var head, tail;
    if (x.kind === 'add') {
      head = '목표 ' + x.to + '% 까지 <b>' + x.diff + '%p 모자랍니다.</b>';
      tail = '이번에 넣을 돈이 있다면 <b>' + nMoney(x.amount, mk) + '</b>' + qty + ' 까지가 이 자리입니다.';
    } else {
      head = (r.weight > H.cap && x.to === H.cap)
        ? '한 종목이 <b>' + r.weight + '%</b> 입니다. 집중 상한 ' + H.cap + '% 까지 <b>' + x.diff + '%p 초과</b>'
        : '목표 ' + x.to + '% 보다 <b>' + x.diff + '%p 많습니다.</b>';
      tail = '여기에 해당하는 금액은 <b>' + nMoney(x.amount, mk) + '</b>' + qty + ' 입니다.';
    }
    return '<div class="axline ' + lab.c + '">' +
      '<span class="ax-h">' + lab.i + ' ' + lab.t + '</span>' +
      '<span class="ax-b">' + head + ' ' + tail + '</span>' +
      '<span class="ax-n">숫자는 <b>지금 비중과 목표의 차이</b>일 뿐, 오늘 매매하라는 뜻이 아닙니다.</span>' +
      '</div>';
  }

  /* ── 물타기: 넣으면 평단이 어디까지 ──────────────────────────
     이 앱은 물타기를 권하지 않는다 — 실수 목록에 그대로 들어 있다. 그런데
     "권하지 않는다"만 적어두면 사용자는 그냥 감으로 넣는다. 그래서 금액을
     보여준다. 대부분 여기서 생각이 바뀐다: 원금만큼 더 넣어도 평단은 1.5%
     내려가고 비중은 99.4%가 된다. 권유가 아니라 **비용 청구서**다.       */
  function avgDownHtml(r, grand, mk) {
    if (!r.hasPrice || r.legacy || !(r.price < r.avg)) return '';
    var rows = [0.25, 0.5, 1].map(function (f) {
      return H.avgDownBy(r, r.cost * f, grand);
    }).filter(Boolean);
    if (!rows.length) return '';
    var body = rows.map(function (x) {
      return '<tr><td>' + nMoney(x.amount, mk) + '<span class="ad-q">' + x.qty.toLocaleString('ko-KR') + '주</span></td>' +
        '<td>' + perShare(x.newAvg, mk) + '<span class="ad-d">−' + x.dropPct + '%</span></td>' +
        '<td class="' + (x.newWeight > r.weight ? 'ad-up' : '') + '">' + x.newWeight + '%</td></tr>';
    }).join('');
    return fold('ad-' + r.id, '🔁', '평단을 낮추려면 얼마가 드나',
      '<div class="ad-note">지금 <b>' + perShare(r.avg, mk) + '</b> 평단이 ' +
        '<b>' + perShare(r.price, mk) + '</b> 아래에 있습니다. 더 사면 평단은 내려갑니다 — ' +
        '얼마나 내려가는지 먼저 보세요.</div>' +
      '<table class="adtab"><thead><tr><th>추가로 넣는 돈</th><th>새 평단</th><th>비중</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table>' +
      '<div class="ad-warn">⚠️ <b>이 앱은 물타기를 권하지 않습니다.</b> 평단이 내려가도 ' +
        '<b>비중은 올라갑니다</b> — 가장 틀린 판단에 가장 큰 돈이 들어가는 길입니다. ' +
        '추가 매수는 “가격이 내려서”가 아니라 <b>“회사에 대한 판단이 여전히 맞아서”</b>일 때만 하세요.</div>',
      { open: false });
  }

  /* ── 위젯: 내 투자 현황 ── */
  function hasAny(mk) {
    return state.holdings[mk].length > 0 || state.cash[mk] > 0;
  }
  function portfolioBadge() {
    if (!hasAny('kr') && !hasAny('us')) return '';
    var n = (hasAny('kr') ? analyzeMarket('kr').alerts : 0) + (hasAny('us') ? analyzeMarket('us').alerts : 0);
    return n ? '⚠️ ' + n : '';
  }

  /* 홈에서는 국내와 미국을 같이 보여준다. 계좌는 나뉘어 있어도
     "내 돈이 지금 얼마인가"는 하나의 질문이기 때문이다.
     합계는 원화로만 낸다 — 서로 다른 통화를 그냥 더할 수는 없다. */
  function portfolioWidget() {
    var h = [];
    if (!hasAny('kr') && !hasAny('us')) {
      return '<button class="emptycard" data-go="my">' +
        '<div class="empty-i">＋</div>' +
        '<div><div class="empty-t">보유 종목을 등록해보세요</div>' +
        '<div class="empty-d"><b>주당 매수단가</b>와 <b>수량</b>만 적으면 ' +
        '수익률은 시세로 자동 계산됩니다.</div></div></button>';
    }

    var A = { kr: hasAny('kr') ? analyzeMarket('kr') : null, us: hasAny('us') ? analyzeMarket('us') : null };
    var krwCost = 0, krwGrand = 0;
    ['kr', 'us'].forEach(function (mk) {
      if (!A[mk]) return;
      krwCost += A[mk].krwCost + A[mk].krwCash;
      krwGrand += A[mk].krwGrand;
    });
    var krwPl = krwGrand - krwCost;
    var krwPlPct = krwCost > 0 ? krwPl / krwCost * 100 : 0;

    h.push('<div class="sum">' +
      '<div class="sum-top"><span class="sum-l">국내+미국 합계</span>' +
      '<span class="sum-v">' + won(krwGrand / 10000) + '</span></div>' +
      '<div class="sum-grid">' +
        '<div><span>투입 원금</span><b>' + won(krwCost / 10000) + '</b></div>' +
        '<div><span>평가 손익</span><b class="' + plClass(krwPl) + '">' + signWon(krwPl / 10000) + '</b></div>' +
        '<div><span>수익률</span><b class="' + plClass(krwPl) + '">' + signPct(krwPlPct) + '</b></div>' +
      '</div>' +
      '<div class="sum-cash">환율 <b>' + fxNow() + '원</b>' +
        (state.profile.fxLock ? ' (직접 정하신 값)'
          : (LIVE && LIVE.asOf ? ' · ' + agoText(LIVE.asOf) + ' 값' : '')) +
        ' 기준으로 합쳤습니다. 미국 원금은 <b>매수 시점 환율</b>로 잡습니다.</div></div>');

    ['kr', 'us'].forEach(function (mk) {
      var a = A[mk];
      var m = D.markets[mk];
      if (!a) {
        h.push('<div class="mkblock empty"><div class="mkblock-h">' + m.flag + ' ' + m.label +
          '<span class="mkblock-v">등록 없음</span></div></div>');
        return;
      }
      h.push('<div class="mkblock"><div class="mkblock-h">' + m.flag + ' ' + m.label +
        '<span class="mkblock-v">' + won(a.krwGrand / 10000) + '</span>' +
        '<span class="mkblock-p ' + plClass(a.krwPl) + '">' + signPct(a.krwPlPct) + '</span></div>');
      a.rows.slice(0, 3).forEach(function (r) {
        h.push('<div class="mini"><span class="mini-m">' + r.verdict.mark + '</span>' +
          '<span class="mini-n">' + esc(r.name) + '</span>' +
          '<span class="mini-w">' + r.weight + '%</span>' +
          '<span class="mini-r ' + plClass(r.pl) + '">' + signPct(r.plPct) + '</span></div>');
      });
      if (a.rows.length > 3) h.push('<div class="mini more">외 ' + (a.rows.length - 3) + '종목</div>');
      h.push('</div>');
    });

    var alerts = (A.kr ? A.kr.alerts : 0) + (A.us ? A.us.alerts : 0);
    h.push('<button class="btn" data-go="my" style="margin-top:10px">' +
      (alerts ? '⚠️ 점검할 자리 ' + alerts + '건 — 자세히 보기 →' : '종목별 판단 보기 →') + '</button>');
    return h.join('');
  }

  /* ── 위젯: 모의투자 ── */
  /* 모의투자 종목의 표시등. 목표 비중에서 얼마나 벗어났는지를 말한다.
     자동 운용이 SIM.band(%p) 넘게 벌어진 자리만 조정하므로, 그 기준을
     그대로 쓴다 — 화면과 실제 동작이 다른 말을 하지 않게. */
  function simMark(r) {
    if (!r.known) return '⚠️';
    if (r.dT === null || r.dT === undefined) return '·';
    if (r.dT > SIM.band) return '🔴';
    if (r.dT < -SIM.band) return '🔵';
    return '🟢';
  }

  /* 홈은 **전체 금액**을 보는 자리다. 시장을 고르는 화면이 아니다.
     예전에는 지금 고른 시장 하나만 보여줘서, 국내를 보는 동안 미국 계좌가
     어떻게 됐는지 알 수 없었다. 두 계좌는 자동 운용으로 각자 굴러가는데
     한쪽만 보이면 "내 모의투자 전체가 얼마"인지를 홈에서 알 수가 없다.

     이제 합계를 위에 두고 시장별로 한 줄씩 잇는다. 종목별 상세는 모의투자
     탭에서 본다 — 홈에 다 펼치면 스크롤만 길어지고 결론이 안 보인다.

     두 시장 값을 그냥 더해도 되는 이유: sim.js 의 priceOf 가 국내는 원→만원,
     미국은 달러→원→만원으로 바꿔 담는다. 둘 다 이미 원화(만원) 기준이다. */
  function simWidget() {
    var runs = ['kr', 'us'].filter(function (mk) { return !!state.sim[mk].started; });
    if (!runs.length) {
      return '<button class="emptycard" data-go="plan" data-psub="sim">' +
        '<div class="empty-i">🎮</div>' +
        '<div><div class="empty-t">모의투자로 먼저 겪어보세요</div>' +
        '<div class="empty-d">시드와 성향만 고르면 그 배분대로 담아 굴려봅니다. ' +
        '실제 돈이 아니니 <b>하락을 견딜 수 있는지</b>를 안전하게 시험할 수 있습니다.</div></div></button>';
    }

    var tot = 0, cost = 0, unseen = 0, rows = '';
    ['kr', 'us'].forEach(function (mk) {
      var st = state.sim[mk];
      var m = D.markets[mk];
      if (!st.started) {
        rows += '<div class="mkblock empty"><div class="mkblock-h">' + m.flag + ' ' + m.label +
          '<span class="mkblock-v">시작 안 함</span></div></div>';
        return;
      }
      var v = SIM.value(st, simCtx(mk));
      tot += v.total;
      cost += st.seed;
      unseen += simUnseen(mk);
      rows += '<div class="mkblock"><div class="mkblock-h">' + m.flag + ' ' + m.label +
        '<span class="mkblock-v">' + won(v.total) + '</span>' +
        '<span class="mkblock-p ' + plClass(v.pl) + '">' + signPct(v.plPct) + '</span></div>' +
        '<div class="simline">' +
          '<span class="simline-d">' + (st.auto ? '🤖 자동' : '✋ 수동') +
            ' · ' + styleLabelOf(st.style) +
            ' · 보유 ' + v.rows.length + '종목 · 현금 ' + v.cashWeight + '%</span>' +
          '<span class="simline-pl ' + plClass(v.pl) + '">' + signWon(v.pl) + '</span>' +
        '</div>' +
        /* 종목도 내 주식 위젯과 같은 줄 모양(.mini)으로 보여준다. 홈에서 두
           위젯이 같은 말투로 읽혀야 "내 투자 vs 앱의 판단"을 나란히 볼 수 있다.
           표시등은 목표 비중과의 차이다 — 자동 운용이 다음에 무엇을 건드릴지
           미리 보여준다(내 주식의 판정 마크와 같은 자리, 같은 역할). */
        v.rows.slice(0, 3).map(function (r) {
          return '<div class="mini"><span class="mini-m">' + simMark(r) + '</span>' +
            '<span class="mini-n">' + esc(r.n) + '</span>' +
            '<span class="mini-w">' + r.weight + '%</span>' +
            '<span class="mini-r ' + plClass(r.pl) + '">' + signPct(r.plPct) + '</span></div>';
        }).join('') +
        (v.rows.length > 3
          ? '<div class="mini more">외 ' + (v.rows.length - 3) + '종목</div>' : '') +
        (v.rows.length ? '' : '<div class="mini more">아직 담은 종목이 없습니다</div>') +
      '</div>';
    });

    var pl = tot - cost;
    var plPct = cost > 0 ? pl / cost * 100 : 0;
    var both = runs.length > 1;

    return '<div class="sum">' +
      '<div class="sum-top"><span class="sum-l">모의 평가금액' +
        (both ? ' <small class="sum-note">국내+미국</small>' : '') + '</span>' +
        '<span class="sum-v">' + won(tot) + '</span></div>' +
      '<div class="simpl ' + plClass(pl) + '">' + signWon(pl) + ' <span>' + signPct(plPct) + '</span></div>' +
      '<div class="sum-grid">' +
        '<div><span>시드 합계</span><b>' + won(cost) + '</b></div>' +
        '<div><span>총 손익</span><b class="' + plClass(pl) + '">' + signWon(pl) + '</b></div>' +
        '<div><span>수익률</span><b class="' + plClass(pl) + '">' + signPct(plPct) + '</b></div>' +
      '</div></div>' +
      rows +
      (unseen
        ? '<div class="simnew-tip">🆕 지난번 본 뒤로 <b>' + unseen + '건</b>이 오갔습니다. ' +
          '무엇을 언제 얼마에 사고팔았는지 안에서 볼 수 있습니다.</div>'
        : '<div class="simnew-tip quiet">📒 사고판 기록은 <b>매매 장부</b>에 모두 남습니다.</div>') +
      '<button class="btn" data-go="plan" data-psub="sim" style="margin-top:10px">모의투자 · 매매 장부 열기 →</button>';
  }

  /* ── 위젯: 오늘의 점검 ── */
  function dailyWidget() {
    var chk = DAILY[dayOfYear(today()) % DAILY.length];
    var h = '<div class="daily-t">' + chk.i + ' ' + chk.t + '</div>' +
            '<div class="daily-d">' + linkTerms(chk.d) + '</div>';

    /* ⚠️ 시키는 것과 할 수 있게 하는 것은 다르다. 예전에는 "왜 샀는지 세
       문장으로 적어보세요"라고만 하고 적을 곳을 주지 않았다 — 게다가 "그
       메모가 대신 판단해준다"고까지 했는데 메모 기능 자체가 없었다.
       하라는 대로 하려던 사람은 거기서 막힌다. */
    if (chk.cta === 'my') {
      h += '<button class="daily-cta" data-go="my">💼 내 주식에서 종목별 판단 보기 →</button>';
    } else if (chk.cta === 'sim') {
      h += '<button class="daily-cta" data-go="plan">🎮 모의투자 목표 비중 보러가기 →</button>';
    }
    return h;
  }

  /* ══════════════════════════════════════════════════════════════════
     뷰 2 — 내 주식: 팔까 / 둘까 / 더 살까
     ------------------------------------------------------------------
     판단 근거는 "목표 비중 대비 어긋난 정도"와 "50년 점수"뿐이다.
     손익은 보여주기만 하고 판단에 쓰지 않는다 — 이유는 holdings.js 참고.
     ══════════════════════════════════════════════════════════════ */
  /* ── 언제까지 · 언제 파나 ────────────────────────────────────
     "언제 팔아야 하나"에 날짜로 답하지 않는다. 아무도 모르고, 안다고 말하는
     순간 이 앱은 거짓말을 시작한다(원칙 5).

     대신 답할 수 있는 둘을 준다.
       · 남은 기간 — 시장이 아니라 사용자의 돈 사정이 정한다.
       · 매도 조건 — 날짜가 아니라 미리 정해둔 규칙. 급락장에서는 판단력이
         남아 있지 않아서, 평온할 때 적어둔 것만 그때 작동한다.

     보유 종목이 없어도 보여준다 — 사기 전에 정해두는 쪽이 낫다. */
  function whenFold() {
    var hz = horizonOf(), pr = horizonProgress();

    var html = '<div class="hzcard">' +
      '<div class="hzcard-h">📅 언제까지</div>' +
      (pr
        ? '<div class="hzbar"><span style="width:' + pr.pct + '%"></span></div>' +
          '<div class="hzcard-d"><b>' + pr.start + '</b>에 시작해 ' +
            (pr.years ? pr.years + '년 ' : '') + pr.months + '개월 지났습니다. ' +
            '목표 ' + hz.label + ' 기준으로 <b>' + pr.leftY + '년</b> 남았습니다.</div>' +
          (pr.near
            ? '<div class="hznear">⏳ <b>쓸 때가 2년 안으로 들어왔습니다.</b> 지금부터는 나눠서 ' +
              '현금으로 옮길 때입니다 — 하루아침에 전부 파는 것보다 최악의 날을 피합니다.</div>'
            : '')
        : '<div class="hzcard-d">보유 종목을 등록하면 그날을 시작일로 잡고 남은 기간을 세어 드립니다. ' +
          '지금 목표 기간은 <b>' + hz.label + '</b>으로 잡혀 있습니다.</div>') +
      '<button class="linkbtn" data-go="plan" data-psub="plan">기간 바꾸기 →</button>' +
    '</div>';

    html += '<div class="stepnote">파는 이유는 셋뿐입니다. ' +
      '<b>주가가 얼마가 됐는지는 여기 없습니다</b> — 일부러 없습니다.</div>';

    D.sellRules.forEach(function (r, i) {
      html += '<div class="card srule">' +
        '<div class="sr-h"><span class="sr-n">' + (i + 1) + '</span>' + r.icon + ' ' + r.t + '</div>' +
        '<div class="sr-d">' + linkTerms(r.d) + '</div>' +
        '<div class="sr-how">확인하는 법 — ' + linkTerms(r.how) + '</div>' +
      '</div>';
    });

    html += '<div class="note">⚠️ <b>“몇 월에 파세요”는 알려드리지 않습니다.</b> ' +
      '아무도 모르고, 안다고 말하는 순간 이 앱은 거짓말을 시작합니다. ' +
      '대신 위 세 가지를 <b>평온할 때 미리 정해두는 것</b>이 이 화면의 목적입니다.</div>';

    return fold('my-when', '📅', '언제까지 · 언제 팔까', html,
      { open: false, badge: pr && pr.near ? '⏳' : '' });
  }

  function renderMy() {
    var mk = market();
    var mkey = state.market;
    var isUS = mkey === 'us';
    var list = state.holdings[mkey];
    var a = analyzeNow();
    var h = [];

    h.push('<div class="sec-head"><h2>💼 ' + mk.flag + ' ' + mk.label + ' 보유 현황</h2>' +
      '<p><b>주당 매수단가</b>와 <b>수량</b>만 적으면 수익률은 시세로 자동 계산됩니다.</p></div>');

    /* 미국은 달러/원화를 오갈 수 있게 한다. 주가는 달러로 움직이고
       내 통장은 원화라, 둘 다 봐야 무슨 일이 일어났는지 알 수 있다. */
    if (isUS) {
      h.push('<div class="curtoggle">' +
        '<button class="curbtn' + (state.cur === 'krw' ? ' is-on' : '') + '" data-cur="krw">₩ 원화</button>' +
        '<button class="curbtn' + (state.cur === 'usd' ? ' is-on' : '') + '" data-cur="usd">$ 달러</button>' +
        /* 기본은 자동이다. 눌러야만 반영되는 값으로 두면 아무도 안 누른다. */
        '<span class="curfx">' + (state.profile.fxLock
          ? '환율 <input id="fxrate" type="number" value="' + state.profile.fx +
            '" min="800" max="2500" step="1" inputmode="numeric" />원' +
            ' <button class="curnow" id="fx-auto">자동으로</button>'
          : '환율 <b>' + fxNow() + '원</b>' +
            (LIVE && LIVE.asOf ? ' <small>' + agoText(LIVE.asOf) + '</small>' : '') +
            ' <button class="curnow" id="fx-lock">직접 정하기</button>') +
        '</span></div>');
    }

    h.push('<button class="addtoggle' + (state.addOpen ? ' is-on' : '') + '" id="add-toggle">' +
      (state.addOpen ? '✕ 닫기' : '＋ 종목 추가') + '</button>');

    if (state.addOpen) {
      var unit = isUS ? '달러' : '원';
      var sel = state.pickSel;
      var results = sel ? [] : searchTickers(state.q, mkey);

      h.push('<div class="card addform">');

      /* 고른 종목이 있으면 확정 카드로 보여준다 — 무엇을 넣는 중인지가
         금액을 적는 동안에도 계속 보여야 한다. */
      if (sel) {
        h.push('<div class="picked"><span class="picked-n">' + esc(sel.n) + '</span>' +
          (sel.t ? '<span class="picked-t">' + esc(sel.t) + '</span>' : '') +
          (sel.uni ? '<span class="picked-b uni">50년 카드</span>' : '') +
          (sel.etf ? '<span class="picked-b etf">ETF</span>' : '') +
          '<button class="picked-x" id="pick-clear">✕</button></div>');
        h.push(sel.price !== null && sel.price !== undefined
          ? '<div class="pickednote">현재가 <b>' + perShare(sel.price, mkey) + '</b> — 평가액이 자동으로 계산됩니다.</div>'
          : '<div class="pickednote warn">이 종목은 <b>시세를 받아오지 않습니다.</b> 아래에 현재가를 직접 적으면 평가액이 계산됩니다(비워두면 매수 원가로 표시).</div>');
      } else {
        h.push('<input id="h-name" type="text" autocomplete="off" value="' + esc(state.q) + '" ' +
          'placeholder="종목명이나 ' + (isUS ? '티커 (예: Microsoft, MSFT)' : '종목코드 (예: 삼성전자, 005930)') + '" />');
        if (state.q) {
          if (results.length) {
            h.push('<div class="acbox">');
            results.forEach(function (r, i) {
              h.push('<button class="acitem" data-ac="' + i + '">' +
                '<span class="ac-n">' + esc(r.n) + '</span>' +
                (r.t ? '<span class="ac-t">' + esc(r.t) + '</span>' : '') +
                (r.uni ? '<span class="ac-b uni">50년 카드</span>' : '') +
                (r.etf ? '<span class="ac-b etf">ETF</span>' : '') +
                (r.price !== null && r.price !== undefined ? '<span class="ac-p">' + perShare(r.price, mkey) + '</span>' : '') +
              '</button>');
            });
            h.push('</div>');
          } else if (tickersState === 'loading') {
            h.push('<div class="acbox"><div class="acmsg">종목 목록을 불러오는 중…</div></div>');
          } else if (tickersState === 'failed') {
            h.push('<div class="acbox"><div class="acmsg">종목 목록을 못 불러왔습니다. 이름을 직접 적어도 됩니다.</div></div>');
          } else {
            h.push('<div class="acbox"><div class="acmsg">일치하는 종목이 없습니다. ' +
              '<button class="linkbtn" id="pick-free">‘' + esc(state.q) + '’ 그대로 쓰기</button></div></div>');
          }
        }
      }

      h.push('<div class="addrow">' +
          '<label>주당 매수단가<input id="h-avg" type="number" inputmode="decimal" placeholder="' + unit + '" min="0" step="any" /></label>' +
          '<label>수량<input id="h-qty" type="number" inputmode="decimal" placeholder="주" min="0" step="any" /></label>' +
        '</div>');

      /* 시세를 못 받아오는 종목만 현재가를 직접 받는다. 유니버스 종목까지
         물어보면 자동 계산이라는 장점이 사라진다. */
      if (sel && (sel.price === null || sel.price === undefined)) {
        h.push('<label class="cashline">현재가(선택)<input id="h-cur" type="number" inputmode="decimal" placeholder="' + unit + '" min="0" step="any" /><span>' + unit + '</span></label>');
      }

      if (isUS) {
        h.push('<label class="cashline">매수 시점 환율<input id="h-fxat" type="number" inputmode="numeric" ' +
          'value="' + fxNow() + '" min="800" max="2500" step="1" /><span>원</span></label>' +
          '<div class="addnote">이 값이 있어야 원화 손익을 <b>주가 때문인지 환율 때문인지</b> 나눠 볼 수 있습니다. 모르면 그대로 두세요.</div>');
      }

      h.push('<button class="btn" id="h-add">추가하기</button>' +
        '<label class="cashline">' + (isUS ? '예수금(달러)' : '예수금·파킹(만원)') +
          '<input id="h-cash" type="number" inputmode="decimal" value="' +
          (isUS ? state.cash[mkey] : state.cash[mkey] / 10000) + '" min="0" step="any" /><span>' +
          (isUS ? '$' : '만원') + '</span></label>' +
        '<div class="addnote">현금도 배분의 한 자리입니다. 빼놓으면 비중이 전부 실제보다 커 보입니다.</div>' +
      '</div>');
    }

    if (!list.length) {
      h.push('<div class="note" style="margin-top:14px">아직 등록된 종목이 없습니다. 위 <b>＋ 종목 추가</b>로 하나만 넣어보세요.</div>');
      h.push(whenFold());
      return h.join('');
    }

    if (a.legacyCount) {
      h.push('<div class="note" style="background:#fff4e6;color:#8a5a12">' + a.legacyCount +
        '개는 <b>예전 방식(매수금액+수익률)</b>으로 입력된 값입니다. 시세로 자동 계산되지 않으니, ' +
        '지우고 <b>단가·수량</b>으로 다시 넣으면 더 정확해집니다.</div>');
    }
    if (a.noPrice) {
      /* 예전에는 "매수 원가로 표시했습니다"라고만 적었다. 그게 곧
         "이 종목의 손익은 영원히 0원"이라는 뜻인데 아무도 그렇게 못 읽었다.
         실제로 "미국 보유 종목 변화가 안 보인다"는 말을 듣고서야 알았다. */
      h.push('<div class="note" style="background:#fff4e6;color:#8a5a12">⚠️ <b>' + a.noPrice +
        '개는 시세를 못 받아옵니다.</b> 그 종목은 매수 원가가 그대로 찍혀 ' +
        '<b>손익이 움직이지 않습니다.</b> 아래에서 ⚠️ 표시된 종목의 ' +
        '<b>현재가를 직접 적으면</b> 그때부터 계산됩니다.</div>');
    }

    /* 요약 */
    var sumHtml = '<div class="sum">' +
      '<div class="sum-top"><span class="sum-l">총 평가금액</span><span class="sum-v">' + nMoney(a.grand, mkey) + '</span></div>' +
      '<div class="sum-grid">' +
        '<div><span>투입 원금</span><b>' + nMoney(a.totalCost + a.cash, mkey) + '</b></div>' +
        '<div><span>평가 손익</span><b class="' + plClass(a.pl) + '">' + nSign(a.pl, mkey) + '</b></div>' +
        '<div><span>수익률</span><b class="' + plClass(a.pl) + '">' + signPct(a.plPct) + '</b></div>' +
      '</div>';
    if (isUS) {
      sumHtml += '<div class="fxsplit">원화로 보면 <b>' + won(a.krwGrand / 10000) + '</b> · ' +
        '손익 <b class="' + plClass(a.krwPl) + '">' + signWon(a.krwPl / 10000) + '</b> (' + signPct(a.krwPlPct) + ')' +
        '<span>달러 손익과 다른 건 환율이 움직였기 때문입니다.</span></div>';
    }
    sumHtml += '<div class="sum-cash">현금 ' + a.cashWeight + '% <span>(목표 ' + a.cashTarget + '%)</span></div></div>';
    h.push(fold('my-sum', '📊', '전체 요약', sumHtml));

    /* 종목별 */
    var rowsHtml = '<div class="stepnote" style="margin-top:0">지금 성향(<b>' + styleLabelOf(state.style) + '</b>)과 오늘 국면 기준입니다.</div>';
    a.rows.forEach(function (r) {
      rowsHtml += '<div class="card hrow tone-' + r.verdict.tone + '">' +
        '<div class="hrow-top">' +
          '<span class="hrow-m">' + r.verdict.mark + '</span>' +
          '<span class="hrow-n">' + esc(r.name) + (r.ticker ? '<span class="hrow-t">' + esc(r.ticker) + '</span>' : '') + '</span>' +
          '<span class="hrow-v">' + r.verdict.label + '</span>' +
        '</div>' +
        (r.legacy
          ? '<div class="hrow-nums"><span>평가 <b>' + nMoney(r.value, mkey) + '</b></span><span>예전 방식 입력</span></div>'
          : '<div class="hrow-nums">' +
              '<span>' + r.qty + '주 · 평단 <b>' + perShare(r.avg, mkey) + '</b></span>' +
              '<span>' + (r.hasPrice
                ? '현재 <b>' + perShare(r.price, mkey) + '</b>'
                : '<b class="nop">⚠️ 시세 없음</b>') + '</span>' +
            '</div>' +
            (r.hasPrice ? '' :
              '<div class="nopline">이 종목은 시세를 받아오지 않아 <b>손익이 움직이지 않습니다.</b> ' +
              '삭제 후 다시 등록하면서 <b>현재가</b>를 적어주세요.</div>') +
            '<div class="hrow-nums">' +
              '<span>평가 <b>' + nMoney(r.value, mkey) + '</b></span>' +
              '<span>손익 <b class="' + plClass(r.pl) + '">' + nSign(r.pl, mkey) + ' (' + signPct(r.plPct) + ')</b></span>' +
            '</div>' +
            (isUS && (r.plByFx > 1 || r.plByFx < -1)
              ? '<div class="fxline">원화 손익 <b class="' + plClass(r.krwPl) + '">' + signWon(r.krwPl / 10000) + '</b> = ' +
                '주가 ' + signWon(r.plByPrice / 10000) + ' + 환율 ' + signWon(r.plByFx / 10000) +
                ' <span>(매수 시점 ' + r.fxAt + '원 → 지금 ' + fxNow() + '원)</span></div>'
              : '')
        ) +
        '<div class="wbar"><span class="wbar-t" style="width:' + Math.min(100, r.weight) + '%"></span>' +
          (r.target ? '<span class="wbar-goal" style="left:' + Math.min(100, r.target) + '%"></span>' : '') + '</div>' +
        '<div class="wlab">현재 <b>' + r.weight + '%</b>' + (r.target ? ' · 목표 <b>' + r.target + '%</b>' : ' · 목표 없음') +
          (r.score !== null ? ' · 50년 점수 <b>' + r.score + '</b>' : '') + '</div>' +
        '<div class="hrow-say">' + linkTerms(r.verdict.say) + '</div>' +
        actionHtml(r, mkey) +
        avgDownHtml(r, a.grand, mkey) +
        '<button class="hrow-del" data-del="' + r.id + '">삭제</button>' +
      '</div>';
    });
    /* "자리마다 판단"은 위아래(전체 요약·보유 종목)와 말투가 달라 혼자 겉돌았다 */
    h.push(fold('my-rows', '🔍', '종목별 판단', rowsHtml, { badge: a.alerts ? '⚠️ ' + a.alerts : '' }));

    var newsHtml = '<div class="slot-d"><b>지금 손익은 판단 근거가 아닙니다.</b> 많이 떨어졌으니 팔아야 한다도, 많이 올랐으니 팔아야 한다도 둘 다 틀렸습니다. ' +
      '기준은 하나입니다 — <b>처음 산 이유가 아직 유효한가.</b></div>';

    D.newsRules.forEach(function (r, i) {
      newsHtml += '<div class="newsq"><div class="newsq-q">' + (i + 1) + '. ' + r.q + '</div>' +
        '<div class="newsq-a y">예 — ' + linkTerms(r.yes) + '</div>' +
        '<div class="newsq-a n">아니오 — ' + linkTerms(r.no) + '</div></div>';
    });
    h.push(fold('my-news', '🗞️', '팔지 말지 헷갈릴 때', newsHtml, { open: false }));
    h.push(whenFold());


    h.push('<div class="foot"><b>고지.</b> 위 판단은 <b>목표 비중과의 차이</b>와 이 앱의 <b>정성 평가 점수</b>만으로 기계적으로 계산한 것입니다. ' +
      '시세는 30분마다 갱신되는 스냅샷이며, 특정 종목의 매수·매도 권유가 아닙니다.</div>');

    return h.join('');
  }

  function renderPlan() {
    var head = '<div class="subnav">' +
      '<button class="subbtn' + (state.planTab === 'plan' ? ' is-on' : '') + '" data-psub="plan">🎯 배분안</button>' +
      '<button class="subbtn' + (state.planTab === 'sim' ? ' is-on' : '') + '" data-psub="sim">🎮 모의투자</button>' +
    '</div>';
    return head + (state.planTab === 'sim' ? renderSim() : renderAllocation());
  }

  function renderAllocation() {
    var mk = market(), st = regime(), p = state.profile;
    var reg = M.labelRegime(st);
    var tilt = M.tilt(st);
    var pf = P.build(state.market, state.style, tilt.cash);
    var style = null;
    P.styles.forEach(function (s) { if (s.key === state.style) style = s; });

    var h = [];

    /* ── 1단계: 시드 ── */
    h.push('<div class="step"><div class="step-h"><span class="step-n">1</span>얼마를 넣을 건가요</div>' +
      '<div class="seedrow">' +
        '<input type="number" id="seed" value="' + p.seed + '" min="10" max="1000000" step="10" inputmode="numeric" />' +
        '<span class="seedunit">만원</span>' +
      '</div>' +
      '<div class="seedchips">' +
        [100, 500, 1000, 3000, 10000].map(function (v) {
          return '<button class="seedchip' + (p.seed === v ? ' is-on' : '') + '" data-seed="' + v + '">' + won(v) + '</button>';
        }).join('') +
      '</div>');
    if (state.market === 'us') {
      h.push('<div class="seedfx">환율 <input type="number" id="fxrate" value="' + fxNow() + '" min="800" max="2500" step="10" inputmode="numeric" /> 원/달러로 환산</div>');
    }
    h.push('<div class="stepnote">3년 안에 쓸 돈과 비상금(생활비 3~6개월치)은 <b>빼고</b> 넣으세요.</div>');

    /* 언제 쓸 돈인가 — 이게 곧 투자 기간이고, 매도 규칙 셋 중 하나의 근거가 된다 */
    h.push('<div class="hzrow">' + D.horizons.map(function (x) {
      return '<button class="hzchip' + (p.horizon === x.y ? ' is-on' : '') + '" data-hz="' + x.y + '">' +
        '<span class="hz-l">' + x.label + '</span><span class="hz-d">' + x.d + '</span></button>';
    }).join('') + '</div>');
    h.push('<div class="hzwarn' + (p.horizon <= 3 ? ' bad' : '') + '">' +
      (p.horizon <= 3 ? '⚠️ ' : '📅 ') + linkTerms(horizonOf().warn) + '</div></div>');

    /* ── 2단계: 성향 ── */
    h.push('<div class="step"><div class="step-h"><span class="step-n">2</span>어떤 성향으로 갈까요</div>' +
      '<div class="styles">');
    P.styles.forEach(function (s) {
      h.push('<button class="stylebtn' + (state.style === s.key ? ' is-on' : '') + '" data-style="' + s.key + '">' +
        '<span class="style-i">' + s.icon + '</span>' +
        '<span class="style-l">' + s.label + '</span>' +
        '<span class="style-m">' + s.mdd + '</span></button>');
    });
    h.push('</div>' +
      '<div class="stylecard"><b>' + style.icon + ' ' + style.label + '</b> — ' + style.one + '<br>' +
      '<span class="stylecard-who">이런 사람에게: ' + style.who + '</span></div>' +
      '<div class="stepnote">' + linkTerms(style.warn) + '</div></div>');

    /* ── 3단계: 제안 ── */
    h.push('<div class="step"><div class="step-h"><span class="step-n">3</span>이렇게 나눠 담으세요</div>');

    if (pf.shift !== 0) {
      h.push('<div class="tiltnote">오늘 국면(' + reg.full + ') 때문에 현금 비중을 ' +
        '<b>' + pf.baseCash + '% → ' + pf.cash + '%</b>로 ' + (pf.shift > 0 ? '올렸' : '내렸') + '습니다. ' +
        '나머지는 그만큼 비례로 ' + (pf.shift > 0 ? '줄었' : '늘었') + '습니다.</div>');
    }
    if (state.style === 'aggressive' && tilt.sat <= -6) {
      h.push('<div class="tiltwarn">⚠️ 지금 국면은 <b>변동 큰 종목에 특히 불리합니다.</b> 한 단계 낮춰 “안정적”으로 가는 것도 방법입니다.</div>');
    }

    h.push('<div class="alloc">');
    pf.holdings.forEach(function (hd) {
      var amt = p.seed * hd.w / 100;
      h.push('<div class="alrow' + (hd.k === 'cash' ? ' is-cash' : '') + '">' +
        '<div class="al-w">' + hd.w + '<small>%</small></div>' +
        '<div class="al-body">' +
          '<div class="al-top"><span class="al-n">' + hd.n + '</span>' +
            (hd.t ? '<span class="al-t">' + hd.t + '</span>' : '<span class="al-k">현금</span>') +
          '</div>' +
          '<div class="al-amt">' + money(amt) + '</div>' +
          '<div class="al-why">' + hd.why + '</div>' +
        '</div></div>');
    });
    h.push('</div>');

    /* 분할 매수 개월 수 — 비싼 국면일수록 길게 */
    var months = st.valuation === 'rich' ? 6 : st.valuation === 'cheap' ? 3 : 4;
    if (st.geo === 'shock') months += 2;
    h.push('<div class="splitbuy">🪓 <b>한 번에 다 넣지 마세요.</b> 지금 국면이면 ' +
      '<b>' + months + '개월</b>에 나눠, 매달 <b>' + won(p.seed / months) + '</b>씩 같은 날에 넣는 걸 권합니다. ' +
      '<span class="splitbuy-why">오늘이 고점인지는 아무도 모릅니다. 나눠 넣으면 최악의 경우를 구조적으로 피합니다.</span></div>');

    h.push('<div class="stepnote">주수는 계산하지 않습니다 — 이 앱은 주가를 받아오지 않기 때문입니다. ' +
      '증권사 앱에서 <b>금액으로 주문</b>하거나 소수점 매수를 쓰세요.</div></div>');

    h.push('<button class="btn ghost" data-psub="sim">🎮 이 배분으로 모의투자 해보기 →</button>');

    h.push('<div class="foot"><b>고지.</b> 이 앱은 투자 교육 자료입니다. 위 목록은 정해진 규칙으로 계산된 <b>예시 배분</b>이며 ' +
      '특정 종목의 매수 권유가 아닙니다. 어떤 수익도 보장하지 않습니다. 나이·직업 안정성·부채·기존 자산에 따라 답은 달라집니다.</div>');

    return h.join('');
  }

  /* ══════════════════════════════════════════════════════════════════
     모의투자
     ------------------------------------------------------------------
     수익률 자랑용이 아니라 "하락을 보고도 안 팔 수 있는가"를 자기 눈으로
     확인하게 하는 화면이다. 그래서 손익만큼이나 시작일·성향·거래 내역을
     같이 보여준다 — 내가 언제 무엇을 왜 팔았는지가 남아야 배운다.
     ══════════════════════════════════════════════════════════════ */
  function styleLabelOf(key) {
    var l = key || '';
    P.styles.forEach(function (s) { if (s.key === key) l = s.label; });
    return l;
  }

  /* ── 투자 금액 바꾸기 ────────────────────────────────────────
     실제로 넣을 수 있는 돈은 달라진다 — 상여가 들어오기도 하고 목돈이
     필요해 빼기도 한다. 그때 **뭘 팔고 뭘 남기고 뭘 더 살지**가 가장
     궁금한데, 여태 시드는 시작할 때 정하면 끝이었다.

     넣으면 목표 비중에 맞춰 나눠 담고, 빼면 목표보다 많던 자리부터 판다.
     그 결과가 곧 "이럴 때 무엇을 파는가"에 대한 이 앱의 답이다.         */
  function seedBoxHtml(st, v) {
    var open = state.seedOpen;
    var mk = state.market;
    var chips = [100, 300, 500, 1000].map(function (n) {
      return '<button class="seedq" data-seedadd="' + n + '">+' + won(n) + '</button>';
    }).join('') +
    [100, 300, 500].map(function (n) {
      return '<button class="seedq minus" data-seedadd="-' + n + '">−' + won(n) + '</button>';
    }).join('');

    return '<div class="stybox">' +
      '<button class="styhead" id="seed-toggle">' +
        '<span>💰 투자 금액 <b>' + won(st.seed) + '</b></span>' +
        '<span class="styhead-a">' + (open ? '닫기' : '바꾸기') + '</span>' +
      '</button>' +
      (open
        ? '<div class="stybody">' +
          '<div class="seedq-row">' + chips + '</div>' +
          '<div class="seedin">' +
            '<input id="seed-amt" type="number" inputmode="numeric" step="10" ' +
              'placeholder="직접 입력" value="' + esc(state.seedAmt || '') + '" />' +
            '<span class="seedunit">만원</span>' +
            '<button class="seedgo" data-seedadd="in">넣기</button>' +
            '<button class="seedgo minus" data-seedadd="out">빼기</button>' +
          '</div>' +
          '<div class="stynote">' +
            '<b>넣으면</b> 목표 비중에 맞춰 나눠 담습니다.<br>' +
            '<b>빼면</b> 현금이 모자란 만큼 <b>목표보다 많던 자리부터</b> 팝니다 — ' +
            '오른 종목은 저절로 비중이 커져 있으니 자연히 비싸진 것부터 덜어냅니다.<br>' +
            '넣고 뺀 돈은 <b>손익이 아닙니다.</b> 수익률은 그대로 유지됩니다.' +
          '</div>' +
          '<div class="stynote">지금 현금 <b>' + won(v.cash) + '</b> · ' +
            '평가금액 <b>' + won(v.total) + '</b> (여기까지 뺄 수 있습니다)</div>' +
          '</div>'
        : '') +
    '</div>';
  }

  /* ── 성향 바꾸기 ─────────────────────────────────────────────
     여태 성향은 시작할 때 한 번 정하면 초기화 말고는 못 바꿨다. 그런데
     성향을 바꿔야 할 일은 실제로 생긴다 — 쓸 시점이 멀어졌다거나, 소득이
     늘어 견딜 수 있는 폭이 커졌다거나.

     ⚠️ 다만 **시장이 좋아 보인다고 공격적으로 옮기는 건 이 앱이 권하지
     않는다.** 그건 오른 뒤에 더 사고 빠진 뒤에 줄이는, 정확히 반대로 하는
     길이다. 시장에 맞춰 움직이는 몫은 이미 **현금 비중**이 맡고 있다
     (국면이 바뀌면 현금 목표가 자동으로 바뀐다). 그래서 고르는 자리에
     그 말을 같이 붙인다 — 막지는 않되, 무엇을 하는 것인지는 알린다. */
  function styleSwitchHtml(st, mk) {
    var open = state.styleOpen;
    var cur = st.style;
    var body = P.styles.map(function (o) {
      var on = o.key === cur;
      var cash = P.build(mk, o.key, M.tilt(regimeOf(mk)).cash).holdings
        .filter(function (x) { return x.k === 'cash'; })[0];
      return '<button class="stopt' + (on ? ' is-on' : '') + '" data-style="' + o.key + '">' +
        '<span class="stopt-h">' + o.icon + ' <b>' + o.label + '</b>' +
          (on ? '<span class="stopt-now">지금</span>' : '') + '</span>' +
        '<span class="stopt-o">' + esc(o.one) + '</span>' +
        '<span class="stopt-m">견딜 폭 ' + esc(o.mdd) + ' · 현금 목표 ' + (cash ? cash.w : 0) + '%</span>' +
      '</button>';
    }).join('');
    return '<div class="stybox">' +
      '<button class="styhead" id="sty-toggle">' +
        '<span>🎚️ 성향 <b>' + styleLabelOf(cur) + '</b></span>' +
        '<span class="styhead-a">' + (open ? '닫기' : '바꾸기') + '</span>' +
      '</button>' +
      (open
        ? '<div class="stybody">' + body +
          '<div class="stywarn">⚠️ <b>시장이 좋아 보여서 공격적으로 옮기는 것은 권하지 않습니다.</b> ' +
            '오른 뒤에 더 사고 빠진 뒤에 줄이는, 정확히 반대로 가는 길입니다. ' +
            '시장에 맞추는 몫은 <b>현금 비중</b>이 이미 맡고 있습니다 — 국면이 바뀌면 자동으로 바뀝니다.<br>' +
            '성향은 <b>시장이 아니라 내 사정</b>으로 바꾸는 것입니다: 쓸 시점이 멀어졌거나, ' +
            '반토막을 견딜 수 있게 됐거나.</div>' +
          '<div class="stynote">바꾸면 다음 조정 때 새 목표에 맞춰 사고팝니다. ' +
            '지금까지의 기록은 그대로 남습니다.</div>' +
          '</div>'
        : '') +
    '</div>';
  }

  /* ── 기록을 날짜로 묶어 최근 것부터 ──────────────────────────
     장부가 길어지면 오래된 것까지 한 번에 쏟아져 읽을 수가 없다. 그래서
     **가장 최근 날짜만 펴 두고** 나머지는 버튼 뒤에 둔다.

     정렬을 배열 순서에 맡기지 않는다. 시작 배분은 push, 그 뒤 매매는
     unshift 로 들어가서 순서가 한결같지 않다. 날짜로 내림차순 정렬하되,
     같은 날이면 원래 자리(작을수록 최근)로 가른다 — ts 가 하루 단위라
     같은 날 여러 건은 날짜만으로 못 가린다. */
  function logSorted(list) {
    return list.map(function (l, i) { return { l: l, i: i }; })
      .sort(function (a, b) {
        if (a.l.ts !== b.l.ts) return a.l.ts < b.l.ts ? 1 : -1;
        return a.i - b.i;
      })
      .map(function (x) { return x.l; });
  }
  /* [{ ts, label, rows }] — 최근 날짜가 앞 */
  function logGroups(list) {
    var out = [], by = {};
    logSorted(list).forEach(function (l) {
      if (!by[l.ts]) { by[l.ts] = { ts: l.ts, label: dayLabel(l.ts), rows: [] }; out.push(by[l.ts]); }
      by[l.ts].rows.push(l);
    });
    return out;
  }
  /* 날짜를 사람 말로. "2026-08-25"보다 "오늘"이 먼저 읽힌다. */
  function dayLabel(ts) {
    var t = ymd(today());
    if (ts === t) return '오늘';
    var d0 = new Date(ts + 'T00:00:00'), d1 = new Date(t + 'T00:00:00');
    var diff = Math.round((d1 - d0) / 86400000);
    if (diff === 1) return '어제';
    if (diff > 1 && diff < 7) return diff + '일 전';
    return ts.slice(5).replace('-', '월 ') + '일';
  }

  /* 날짜 묶음을 화면에 편다. 최근 한 날만 보이고 나머지는 버튼 뒤에 있다.
       key   접기 상태를 기억할 이름
       rowFn 한 건을 그리는 함수                                        */
  function logFoldHtml(list, key, rowFn, emptyMsg) {
    if (!list.length) return '<div class="slot-d">' + emptyMsg + '</div>';
    var gs = logGroups(list);
    var open = !!state.logMore[key];
    var show = open ? gs : gs.slice(0, 1);
    var restDays = gs.length - show.length;
    var restRows = gs.slice(show.length).reduce(function (a, g) { return a + g.rows.length; }, 0);

    var h = show.map(function (g) {
      return '<div class="lgrp">' +
        '<div class="lgrp-h"><span class="lgrp-d">' + g.label + '</span>' +
          '<span class="lgrp-t">' + g.ts + '</span>' +
          '<span class="lgrp-c">' + g.rows.length + '건</span></div>' +
        g.rows.map(rowFn).join('') +
      '</div>';
    }).join('');

    if (restDays > 0) {
      h += '<button class="logmore" data-logmore="' + key + '">' +
        '📂 지난 기록 더 보기 <span>' + restDays + '일 · ' + restRows + '건</span></button>';
    } else if (open && gs.length > 1) {
      h += '<button class="logmore" data-logmore="' + key + '">▴ 최근 것만 보기</button>';
    }
    return h;
  }

  /* ── 지난번 본 뒤로 바뀐 것 ──────────────────────────────────
     "어디에 사고팔고 기록이 남아서 볼 수 있냐"는 물음에 대한 답이 이 칸이다.
     장부(📒)와 전체 내역(🧾)은 진작 있었지만 **접혀 있어서**, 열어보기 전에는
     자동 운용이 무슨 일을 했는지 알 수 없었다. 기록이 없던 게 아니라 보이지
     않았던 것이다.

     따라 투자하려면 "무엇을 언제 얼마에"가 한눈에 보여야 하므로, 새 거래는
     접지 않고 위에 편다. 본 뒤에는 사라진다 — 매번 같은 걸 보여주면 그것도
     금방 배경이 된다. */
  /* ── 지난번 본 뒤로 뭐가 있었나 ────────────────────────────────
     예전에는 여기서 새 거래를 **줄줄이 다 적었다.** 그런데 바로 아래
     'AI 매매 내역'이 같은 목록을 날짜별로 다시 보여준다 — 한 화면에 같은
     일곱 줄이 두 번 있었다. 여기서는 **몇 건인지와 무엇이 움직였는지**만
     한 줄로 말하고, 자세한 건 아래 한 곳에서 본다. */
  function simNewHtml(mk) {
    var fresh = simNew(mk);
    if (!fresh.length) return '';
    var buys = 0, sells = 0, other = 0, names = [];
    fresh.forEach(function (l) {
      if (l.kind === 'buy') buys++;
      else if (l.kind === 'sell') sells++;
      else other++;
      if (l.n && names.indexOf(l.n) < 0 && names.length < 3) names.push(l.n);
    });
    var what = [];
    if (buys) what.push('매수 ' + buys + '건');
    if (sells) what.push('매도 ' + sells + '건');
    if (other) what.push('그 밖 ' + other + '건');
    return '<div class="simnew">' +
      '<div class="simnew-h">🆕 지난번 본 뒤로 <b>' + fresh.length + '건</b>이 오갔습니다</div>' +
      '<div class="simnew-s">' + what.join(' · ') +
        (names.length ? ' — ' + esc(names.join(', ')) + (fresh.length > names.length ? ' 외' : '') : '') +
      '</div>' +
      '<button class="linkbtn" data-openfold="sim-log">아래 <b>AI 매매 내역</b>에서 하나씩 보기 →</button>' +
      '</div>';
  }

  function renderSim() {
    var st = simState();
    var p = state.profile;
    var mk = market();
    var h = [];

    if (state.simMsg) {
      h.push('<div class="simmsg">' + esc(state.simMsg) + '</div>');
      state.simMsg = '';
    }

    var priced = LIVE && LIVE.stocks && LIVE.stocks[state.market]
      ? Object.keys(LIVE.stocks[state.market]).length : 0;

    /* ── 시작 전 ── */
    if (!st.started) {
      h.push('<div class="sec-head"><h2>🎮 모의투자</h2>' +
        '<p>이 앱이 제안한 배분을 <b>앱이 알아서 굴립니다.</b> ' +
        '국면이 바뀌면 자동으로 조정되므로, <b>앱의 판단과 실제 내 투자를 나란히 비교</b>할 수 있습니다.</p></div>');

      if (!priced) {
        h.push('<div class="note" style="background:#fdf1ef;color:#9a3a31">⚠️ 아직 종목 시세를 받아오지 못해 시작할 수 없습니다. 잠시 뒤 다시 열어보세요.</div>');
        return h.join('');
      }

      h.push('<div class="step"><div class="step-h"><span class="step-n">1</span>시드</div>' +
        '<div class="seedrow"><input type="number" id="seed" value="' + p.seed + '" min="10" max="1000000" step="10" inputmode="numeric" />' +
        '<span class="seedunit">만원</span></div>' +
        '<div class="seedchips">' + [100, 500, 1000, 3000, 10000].map(function (v) {
          return '<button class="seedchip' + (p.seed === v ? ' is-on' : '') + '" data-seed="' + v + '">' + won(v) + '</button>';
        }).join('') + '</div></div>');

      h.push('<div class="step"><div class="step-h"><span class="step-n">2</span>투자 방식</div><div class="styles">');
      P.styles.forEach(function (s) {
        h.push('<button class="stylebtn' + (state.style === s.key ? ' is-on' : '') + '" data-style="' + s.key + '">' +
          '<span class="style-i">' + s.icon + '</span><span class="style-l">' + s.label + '</span>' +
          '<span class="style-m">' + s.mdd + '</span></button>');
      });
      h.push('</div><div class="stepnote">고른 방식의 모델 구성 그대로 담습니다. ' +
        '그 뒤로는 <b>앱이 알아서 굴립니다</b> — 국면이 바뀌어 목표 배분이 달라지면 ' +
        '하루 한 번 사고팔아 맞춥니다. 직접 사고팔거나 자동을 끌 수도 있습니다.</div></div>');

      h.push('<button class="btn" id="sim-start">🎮 ' + won(p.seed) + '으로 시작하기</button>');
      h.push(simDisclaimer());
      return h.join('');
    }

    /* ── 진행 중 ── */
    var v = SIM.value(st, simCtx());
    h.push('<div class="sec-head"><h2>🎮 모의투자</h2>' +
      '<p>' + st.started + ' 시작 · <b>' + styleLabelOf(st.style) + '</b> · 시드 ' + won(st.seed) + '</p></div>');

    /* ── 자동 운용 ──
       사용자가 매일 들어와 사고팔지 않아도 앱의 판단대로 계좌가 움직인다.
       무엇을 향해 가는지(목표)와 다음에 뭘 할 예정인지를 먼저 보여준다. */
    /* 지금 목표에서 얼마나 벌어져 있는지. 자동이든 수동이든 보여준다 —
       "지금 눌러도 할 일이 있나"를 알고 눌러야 헛걸음하지 않는다. */
    var pending = SIM.drift(st, simCtx());
    var doneToday = st.lastAuto === ymd(today());
    h.push('<div class="autobox' + (st.auto ? ' on' : '') + '">' +
      '<div class="autobox-h">' +
        '<span>' + (st.auto ? '🤖 자동 운용 중' : '✋ 수동 운용') + '</span>' +
        '<button class="autotgl" id="sim-auto">' + (st.auto ? '끄기' : '켜기') + '</button>' +
      '</div>' +
      '<div class="autobox-d">' + (st.auto
        ? '오늘 국면(<b>' + M.labelRegime(regime()).full + '</b>)으로 다시 계산한 배분을 목표로 삼고, ' +
          '목표에서 <b>' + SIM.band + '%p</b> 넘게 벌어진 자리를 조정합니다. ' +
          '<b>새 시세가 들어올 때마다</b> 다시 보므로, 앱을 켜 둔 동안에도 계좌는 계속 따라갑니다. ' +
          '사고파는 이유는 아래 거래 내역에 남습니다. ' +
          '<b>카카오톡 알림은 중요한 것만</b> 골라 보냅니다 — 조정이 잦아도 알림이 잦지는 않습니다.'
        : '자동 조정을 멈췄습니다. 계좌는 지금 상태 그대로 두고, 사고파는 건 직접 하시면 됩니다.') +
      '</div>' +
      /* ── 지금 점검하기 ──
         저절로도 돌지만, 들어온 김에 바로 확인하고 싶은 사람이 있다.
         (1) 지금 벌어진 자리가 몇 곳인지 적고, (2) 새 시세를 받아온 뒤
         조정하는 단추를 준다. 눌러서 할 일이 없으면 없다고 말한다 —
         아무 반응이 없으면 고장으로 읽히기 때문이다. */
      '<div class="autonow">' +
        '<div class="autonow-s">' + (pending.length
            ? '지금 목표와 <b>' + pending.length + '자리</b>가 벌어져 있습니다.'
            : '지금은 목표와 크게 벌어진 자리가 없습니다.') +
          (doneToday ? ' 오늘 한 번 점검했습니다.' : '') +
          ' 누르면 <b>새 시세를 받아온 뒤</b> 다시 봅니다.' +
        '</div>' +
        '<button class="btn ghost" id="sim-now">⚡ 지금 점검하기</button>' +
      '</div>' +
      (st.lastAuto ? '<div class="autobox-t">마지막 조정 확인: ' + st.lastAuto + '</div>' : '') +
    '</div>');

    h.push(simNewHtml(state.market));
    h.push(styleSwitchHtml(st, state.market));
    h.push(seedBoxHtml(st, v));

    h.push('<div class="card sum simsum">' +
      '<div class="sum-top"><span class="sum-l">모의 평가금액</span><span class="sum-v">' + money(v.total) + '</span></div>' +
      '<div class="simpl ' + plClass(v.pl) + '">' + signWon(v.pl) + ' <span>' + signPct(v.plPct) + '</span></div>' +
      '<div class="sum-grid">' +
        '<div><span>실현 손익</span><b class="' + plClass(v.realized) + '">' + signWon(v.realized) + '</b>' +
          '<small class="wsub">판 것 확정</small></div>' +
        '<div><span>평가 손익</span><b class="' + plClass(v.unrealized) + '">' + signWon(v.unrealized) + '</b>' +
          '<small class="wsub">아직 안 판 것</small></div>' +
        '<div><span>현금</span><b>' + won(v.cash) + '</b></div>' +
        '<div><span>현금 비중</span><b>' + v.cashWeight + '%</b><small class="wsub">' +
          (v.cashWT === null ? '시작 ' + v.cashW0 + '%' : '목표 ' + v.cashWT + '%') + '</small></div>' +
      '</div>' +
      (LIVE && LIVE.asOf ? '<div class="sum-cash">🕒 ' + agoText(LIVE.asOf) + ' 시세 기준' +
        (state.market === 'us' ? ' · 환율 ' + p.fx + '원 적용' : '') + '</div>' : '') +
    '</div>');

    if (v.missing) {
      h.push('<div class="note" style="background:#fff4e6;color:#8a5a12">' + v.missing +
        '개 종목은 시세를 못 받아와 <b>매수 원가로 표시</b>했습니다. 0으로 처리하면 손실이 난 것처럼 보이기 때문입니다.</div>');
    }

    var rowsHtml = '';
    v.rows.forEach(function (r) {
      rowsHtml += '<div class="simrow">' +
        '<div class="simrow-top"><span class="simrow-n">' + esc(r.n) + '</span>' +
          '<span class="simrow-pl ' + plClass(r.pl) + '">' + signPct(r.plPct) + '</span></div>' +
        '<div class="simrow-num">평가 <b>' + won(r.value) + '</b> · 원가 ' + won(r.cost) +
          ' · 손익 <b class="' + plClass(r.pl) + '">' + signWon(r.pl) + '</b>' +
          (r.known ? '' : ' · <b>시세 없음</b>') + '</div>' +
        /* 지금 비중이 목표에서 얼마나 벌어졌는지. 자동 운용이 끌고 가는 값이
           목표이므로 눈금은 목표에 둔다. 시작 비중은 참고로 함께 적는다. */
        '<div class="wbar"><span class="wbar-t" style="width:' + Math.min(100, r.weight) + '%"></span>' +
          '<span class="wbar-goal" style="left:' + Math.min(100, r.wT === null ? r.w0 : r.wT) + '%"></span></div>' +
        '<div class="wlab">비중 <b>' + r.weight + '%</b>' +
          (r.wT === null ? '' : ' · 목표 ' + r.wT + '%') +
          (r.dT !== null && Math.abs(r.dT) >= 0.1
            ? ' · <b class="' + (r.dT > 0 ? 'pl-up' : 'pl-dn') + '">' + (r.dT > 0 ? '+' : '') + r.dT + '%p</b>'
            : ' · 목표대로') +
          '<span class="wsub2">시작 ' + r.w0 + '%' +
            (Math.abs(r.dw) >= 0.1 ? ' (' + (r.dw > 0 ? '+' : '') + r.dw + '%p)' : '') + '</span></div>' +
        '</div>';
    });
    if (!v.rows.length) rowsHtml = '<div class="slot-d">보유 종목이 없습니다. 아래에서 사보세요.</div>';
    h.push(fold('sim-pos', '📦', '보유 종목', rowsHtml, { badge: v.rows.length || '' }));

    /* ⚠️ 여기에 있던 "새로 사기" 폼과 종목별 추가매수·매도·전량 단추를 뺐다.
       이 계좌는 **AI 가 굴리는 기준 계좌**다. 사용자가 할 일은 여기서 손으로
       사고파는 게 아니라, 여기서 일어난 일을 보고 **자기 계좌를 맞추는 것**이다.
       손으로 사는 칸을 두면 "내 두 번째 계좌"가 되어 버려서, 따라 할 기준이
       사라진다. 손대고 싶으면 성향·금액을 바꾸면 되고, 그건 위에 있다. */

    /* ── 매매 장부 ──
       "무엇을 언제 얼마에 사서, 언제 얼마에 팔아 얼마 남았나."
       모의투자를 중단할 때까지 한 줄도 지우지 않는다 — 지나고 나서 읽는 게
       이 화면의 목적이라, 최근 몇 건만 남기면 쓸모가 없다. */
    var sells = st.log.filter(function (l) { return l.kind === 'sell'; });
    var ledgerHtml = logFoldHtml(sells, 'ledger', function (l) {
      var real = typeof l.real === 'number' ? l.real : null;
      var pct = (real !== null && l.cost > 0) ? real / l.cost * 100 : null;
      return '<div class="ldg">' +
        '<div class="ldg-top"><span class="ldg-n">' + esc(l.n) +
          (l.auto ? '<span class="log-auto">자동</span>' : '') + '</span>' +
          (real === null ? '' : '<span class="ldg-r ' + plClass(real) + '">' + signWon(real) +
            (pct === null ? '' : ' <small>' + signPct(pct) + '</small>') + '</span>') +
        '</div>' +
        '<div class="ldg-line"><span class="ldg-k">샀을 때</span><span>' +
          (l.since ? l.since + ' 부터 · ' : '') + '평단 ' + simPerShare(l.avg) +
          (typeof l.cost === 'number' ? ' · 원가 ' + won(l.cost) : '') +
        '</span></div>' +
        '<div class="ldg-line"><span class="ldg-k">팔았을 때</span><span>' +
          l.ts + ' · ' + simPerShare(l.price) + ' · 받은 돈 ' + won(l.amt) +
        '</span></div>' +
        (l.why ? '<div class="ldg-why">' + esc(l.why) + '</div>' : '') +
      '</div>';
    }, '아직 판 종목이 없습니다. 팔고 나면 <b>언제 얼마에 사서 언제 얼마에 팔았는지</b>와 ' +
       '그때 확정된 손익이 여기 쌓입니다.');
    if (sells.length) {
      ledgerHtml += '<div class="note">평단은 <b>평균 매수 단가</b> 기준입니다. ' +
        '같은 종목을 여러 번 나눠 샀으면 그 평균으로 계산합니다 — 증권사 앱과 같은 방식입니다.</div>';
    }
    /* 판 것만 모은 칸. 확정 손익을 보려는 자리라 부차적이다 — 접어 둔다.
       따라 하려는 사람에게 먼저 필요한 건 "언제 뭘 왜 샀나"이고 그건 아래
       'AI 매매 내역'이다. 예전에는 이 둘이 나란히 펼쳐져 있어서 무엇을
       봐야 하는지가 흐려졌다. */
    var ledgerFold = fold('sim-ledger', '💰', '판 종목 손익', ledgerHtml,
      { open: false, badge: sells.length || '' });

    var logHtml = logFoldHtml(st.log, 'log', function (l) {
      /* 성향 변경 같은 '거래가 아닌 기록'도 같은 줄에 남긴다. 계좌가 왜
         달라졌는지는 매매만으로는 설명되지 않는다. */
      var kindLab = l.kind === 'buy' ? '매수' : l.kind === 'sell' ? '매도'
        : l.kind === 'cash' ? (l.n === '투자 금액 추가' ? '입금' : '출금') : '변경';
      return '<div class="logrow"><span class="log-k ' + l.kind + '">' + kindLab + '</span>' +
        '<span class="log-n">' + esc(l.n) + (l.auto ? '<span class="log-auto">자동</span>' : '') + '</span>' +
        '<span class="log-a">' + (l.kind === 'note' ? '' : won(l.amt)) + '</span>' +
        /* 왜 사고팔았는지를 남긴다. 근거 없이 잔고가 바뀌면 사용자는 그
           계좌를 이해할 수 없고, 그러면 비교할 것도 없어진다. */
        (l.why ? '<span class="log-w">' + esc(l.why) + '</span>' : '') + '</div>';
    }, '아직 없습니다.');
    /* 이 화면의 주인공. AI 가 무엇을 언제 왜 사고팔았는지가 여기 있고,
       따라 하려는 사람이 실제로 읽는 건 이 칸이다. 기본으로 펴 둔다. */
    /* ── 마지막에 언제 보고, 뭐라고 판단했나 ──────────────────────
       내역만 보여주면 "4일 전"이 맨 위에 떠 있고, 그건 **멈춘 것처럼**
       읽힌다. 실제로는 새 시세가 올 때마다 보고 있고 다만 손댈 자리가
       없었을 뿐인데, 그 사실이 화면 어디에도 없었다.

       거래가 없는 날에도 "봤다"는 사실과 "왜 안 했나"를 적는다.
       조용한 것과 고장난 것은 다르다. */
    var pend = SIM.drift(st, simCtx());
    var seenAt = st.lastSnap ? agoText(st.lastSnap) : (st.lastAuto || null);
    var checkLine = '<div class="lastchk' + (pend.length ? ' has' : '') + '">' +
      '<b>🕒 ' + (seenAt ? seenAt + ' 확인' : '아직 확인 전') + '</b>' +
      (pend.length
        ? '<span>목표와 벌어진 자리 <b>' + pend.length + '곳</b> — 다음 시세에 조정합니다.</span>'
        : '<span>모든 자리가 목표 안에 있어 <b>사고팔지 않았습니다.</b> ' +
          '조정은 한 종목이 목표에서 20% 넘게 벌어졌을 때만 합니다 — ' +
          '자주 사고판다고 수익이 늘지는 않습니다.</span>') +
      '</div>';

    h.push(fold('sim-log', '🧾', 'AI 매매 내역', checkLine + logHtml,
      { open: true, badge: st.log.length }));
    h.push(ledgerFold);

    h.push(compareBlock(v));
    h.push(simDisclaimer());
    /* 초기화는 되돌릴 수 없는 동작이다. 눈에 띄는 빨간 단추로 두면 손이
       먼저 간다 — 맨 아래, 고지 뒤에, 조용한 모양으로 둔다. */
    h.push('<button class="quietbtn" id="sim-reset">모의투자 초기화하고 다시 설정</button>');
    return h.join('');
  }

  /* 앱의 판단(모의투자) vs 실제 내 투자.
     기간이 다르면 단순 비교가 어렵다는 점을 같이 적는다 — 안 적으면
     "앱이 더 잘했다/못했다"는 결론만 남는다. */
  function compareBlock(v) {
    var mkey = state.market;
    if (!hasAny(mkey)) {
      return '<div class="cmp none">실제 보유 종목을 등록하면 <b>앱의 판단과 내 투자를 나란히</b> 볼 수 있습니다. ' +
        '<button class="linkbtn" data-go="my">내 주식에 등록하기 →</button></div>';
    }
    var a = analyzeMarket(mkey);
    var simPct = v.plPct;
    var myPct = a.plPct;
    var diff = Math.round((myPct - simPct) * 10) / 10;
    return '<div class="cmp">' +
      '<div class="cmp-h">⚖️ 앱의 판단 vs 내 투자</div>' +
      '<div class="cmp-row"><span class="cmp-l">🎮 모의투자</span>' +
        '<span class="cmp-v ' + plClass(v.pl) + '">' + signPct(simPct) + '</span></div>' +
      '<div class="cmp-row"><span class="cmp-l">💼 실제 보유</span>' +
        '<span class="cmp-v ' + plClass(a.pl) + '">' + signPct(myPct) + '</span></div>' +
      '<div class="cmp-diff">차이 <b class="' + plClass(diff) + '">' + (diff > 0 ? '+' : '') + diff + '%p</b>' +
        (diff > 0 ? ' — 실제 투자가 앞서 있습니다.' : diff < 0 ? ' — 모의투자가 앞서 있습니다.' : ' — 같습니다.') + '</div>' +
      '<div class="cmp-note">⚠️ <b>단순 비교가 아닙니다.</b> 모의투자는 ' + simState().started +
        '에 담아 ' + (simState().auto ? '국면에 따라 자동으로 조정해온' : '그 뒤로는 직접 굴린') +
        ' 결과이고, 실제 보유는 종목마다 산 시점이 다릅니다. ' +
        '기간이 다르면 수익률은 원래 다르게 나옵니다. 숫자보다 <b>어느 쪽이 덜 흔들렸는지</b>를 보세요.</div>' +
    '</div>';
  }

  function simDisclaimer() {
    return '<div class="foot"><b>이건 연습입니다.</b> 실제 거래가 아니며 아래를 반영하지 않습니다 — ' +
      '① 체결가는 30분 스냅샷 가격이라 <b>실제 체결가와 다릅니다</b> ' +
      '② <b>수수료·세금·슬리피지가 없습니다</b>(실제로는 그만큼 덜 남습니다) ' +
      '③ 배당이 없습니다' +
      (state.market === 'us' ? ' ④ 달러 시세를 그때그때 환율로 환산하므로 <b>주가가 그대로여도 환율로 평가액이 바뀝니다</b>(한국에서 미국 주식을 사면 실제로 그렇습니다)' : '') +
      '.<br><br>여기서 난 수익률은 앞으로의 성과를 뜻하지 않습니다.</div>';
  }

  /* ══════════════════════════════════════════════════════════════════
     뷰 2 — 종목 (50년 생존 카드). 기본은 접힘, 필요할 때만 펼친다.
     ══════════════════════════════════════════════════════════════ */
  var FILTERS = [
    { v: 'all', l: '전체' }, { v: 'core', l: '코어' },
    { v: 'income', l: '배당' }, { v: 'satellite', l: '위성' }, { v: 'score', l: '점수순' }
  ];

  function renderPicks() {
    var mk = market();
    var h = [];

    h.push('<div class="sec-head"><h2>' + mk.flag + ' ' + mk.full + '</h2>' +
      '<p>“얼마나 오를까”가 아니라 <b>“50년 뒤에도 있을까”</b>만 채점했습니다. 정성 평가이며 추천이 아닙니다.</p></div>');

    h.push('<div class="filters">');
    FILTERS.forEach(function (f) {
      h.push('<button class="chip' + (state.filter === f.v ? ' is-on' : '') + '" data-filter="' + f.v + '">' + f.l + '</button>');
    });
    h.push('</div>');

    var list = mk.picks.slice();
    if (state.filter === 'score') list.sort(function (a, b) { return total(b.scores) - total(a.scores); });
    else if (state.filter !== 'all') list = list.filter(function (s) { return s.tag === state.filter; });

    list.forEach(function (s, idx) {
      var pct = total(s.scores), g = grade(pct);
      var tagLabel = { core: '코어', income: '배당', satellite: '위성' }[s.tag];
      h.push('<div class="card stock" data-stock="' + idx + '">' +
        '<button class="stock-head" type="button">' +
          '<span class="grade"><b>' + g.code + '</b><small>' + pct + '</small></span>' +
          '<span class="stock-id">' +
            '<span class="stock-name">' + s.name + '<span class="tagpill ' + s.tag + '">' + tagLabel + '</span></span>' +
            '<span class="stock-meta">' + s.ticker + (s.korName ? ' · ' + s.korName : '') + ' · ' + s.sector + '</span>' +
            '<span class="stock-one">' + s.one + '</span>' +
          '</span>' +
          '<span class="stock-caret">▾</span>' +
        '</button>' +
        '<div class="stock-body">' +
          '<div class="bars">' + D.axes.map(function (a) {
            var v = s.scores[a.key];
            return '<div class="bar"><span class="bar-l">' + a.icon + ' ' + a.label + '</span>' +
              '<span class="bar-t"><span class="bar-f" style="width:' + (v / 5 * 100) + '%"></span></span>' +
              '<span class="bar-v">' + v + '</span></div>';
          }).join('') + '</div>' +
          '<div class="sb-h">왜 오래 갈 것 같은가</div>' +
          '<ul class="sb-list">' + s.why.map(function (w) { return '<li>' + linkTerms(w) + '</li>'; }).join('') + '</ul>' +
          '<div class="sb-h">무엇이 이 판단을 깨뜨리나</div>' +
          '<div class="sb-risk">' + linkTerms(s.risk) + '</div>' +
          '<div class="sb-h">초보자에게 한마디</div>' +
          '<div class="sb-beg">' + linkTerms(s.beginner) + '</div>' +
          '<div class="sb-h">직접 확인할 지표</div>' +
          '<div class="sb-check">' + s.check.map(function (c) { return '<span>' + c + '</span>'; }).join('') + '</div>' +
        '</div></div>');
    });

    h.push('<div class="sec"><div class="sec-head"><h2>🔎 숫자는 직접 확인하세요</h2>' +
      '<p>이 앱은 <b>가격·실적 숫자를 담지 않습니다.</b> 넣는 순간 낡기 때문입니다.</p></div><div class="card">');
    mk.sources.forEach(function (s) {
      h.push('<div class="src"><a href="' + s.url + '" target="_blank" rel="noopener">' + s.name + ' ↗</a>' +
        '<span class="src-w">' + s.what + '</span></div>');
    });
    h.push('</div></div>');

    return h.join('');
  }

  /* ══════════════════════════════════════════════════════════════════
     뷰 — 알아보기 (종목 하나를 검색해서 읽는다)
     ------------------------------------------------------------------
     "궁금한 주식을 치면 뭐하는 회사인지, 어떤 상태인지 알려달라"는 요청에서
     나온 화면이다. 답할 수 있는 것과 없는 것을 갈라 두었다.

       답한다  뭐하는 회사인가 / 돈을 어떻게 버는가 / 50년 존속 가능성 6축과
               등급 / 무엇이 이 판단을 깨뜨리나 / 직접 확인할 지표의 이름
       안 한다 매수·매도 의견, PER 같은 수치, 주가 예측

     "미래에 어떨 것인가"에는 주가가 아니라 **50년 뒤에도 이 회사가 있을까**로
     답한다. 그게 이 앱이 답할 수 있는 유일한 미래다(최상위 원칙 5).

     유니버스 13종목은 사람이 쓴 카드가 더 정확하므로 그쪽을 먼저 쓴다.
     어느 쪽인지 화면에 표시한다 — 출처를 감추지 않는다.               */
  function stockCardOf(mk, ticker) {
    var hit = null;
    D.markets[mk].picks.forEach(function (p) {
      if (p.ticker.toUpperCase() === String(ticker).toUpperCase()) hit = p;
    });
    if (hit) return { src: 'pick', d: hit };
    var a = analysisOf(ticker);
    return a ? { src: 'ai', d: a } : null;
  }

  function renderStock() {
    loadAnalysis();
    /* 검색하려면 종목 색인이 있어야 한다. 이 탭을 열 때 받는다. */
    loadTickers();
    var mk = state.market;
    var h = [];
    h.push('<div class="sec-head"><h2>🔎 종목 알아보기</h2>' +
      '<p>궁금한 종목을 찾아보세요. <b>뭐하는 회사인지, 50년 뒤에도 있을 회사인지</b>를 정리해 둡니다.</p></div>');

    h.push('<div class="card sform">' +
      '<input id="sq" type="text" autocomplete="off" placeholder="' +
        (mk === 'kr' ? '삼성전자, 005930…' : 'Microsoft, MSFT, 하이닉스…') +
      '" value="' + esc(state.sq || '') + '" />' +
      (state.sq ? '<button class="sq-x" id="sq-clear">✕</button>' : '') +
    '</div>');

    /* 결과는 이 칸만 갈아 끼운다 — 전체를 다시 그리면 입력 포커스가 날아간다 */
    h.push('<div class="sqres">' + stockResultHtml(mk) + '</div>');

    h.push('<div class="foot"><b>고지.</b> 이 화면은 <b>회사에 대한 설명</b>이지 ' +
      '특정 종목의 매수·매도 권유가 아닙니다. 어떤 수익도 보장하지 않습니다. ' +
      '투자 판단과 그 결과는 본인에게 있습니다.</div>');
    return h.join('');
  }

  /* 검색창 아래 칸. 고르기 전에는 후보 목록, 고른 뒤에는 해설. */
  function stockResultHtml(mk) {
    if (state.sSel) return stockDetailHtml(mk, state.sSel);
    if (!state.sq) return stockEmptyHtml(mk);
    var res = searchTickers(state.sq, mk);
    if (!res.length) {
      return '<div class="note">‘' + esc(state.sq) + '’과 맞는 종목이 없습니다. ' +
        (tickersState === 'loading' ? '종목 목록을 불러오는 중입니다…'
         : tickersState === 'failed' ? '종목 목록을 못 불러왔습니다.'
         : '이름 일부나 티커로 다시 찾아보세요.') + '</div>';
    }
    return '<div class="acbox open">' + res.map(function (r, i) {
      return '<button class="acitem" data-sac="' + i + '">' +
        '<span class="ac-n">' + esc(r.n) + '</span>' +
        (r.t ? '<span class="ac-t">' + esc(r.t) + '</span>' : '') +
        (r.uni ? '<span class="ac-b uni">50년 카드</span>' : '') +
        (r.etf ? '<span class="ac-b etf">ETF</span>' : '') +
        (r.price !== null && r.price !== undefined ? '<span class="ac-p">' + perShare(r.price, mk) + '</span>' : '') +
      '</button>';
    }).join('') + '</div>';
  }

  /* 아직 아무것도 안 친 상태 — 빈 화면 대신 뭘 할 수 있는지 보여준다 */
  function stockEmptyHtml(mk) {
    var picks = D.markets[mk].picks.slice(0, 6);
    return '<div class="sec-head" style="margin-top:14px"><h3 class="sub-h">이 앱이 직접 뜯어본 ' +
      D.markets[mk].picks.length + '종목</h3></div>' +
      '<div class="chips">' + picks.map(function (p) {
        return '<button class="chip" data-spick="' + esc(p.ticker) + '">' + esc(p.name) + '</button>';
      }).join('') + '</div>' +
      '<div class="note">그 밖의 종목도 찾아볼 수 있습니다. ' +
      '해설이 아직 없는 종목은 <b>없다고 말합니다</b> — 지어내지 않습니다.</div>';
  }

  /* 오늘 이 종목을 가리키는 기사 + 지금 시장 국면.
     기사 대조는 보유 종목에 쓰던 것(aliasesOf/aliasHit)을 그대로 쓴다 —
     같은 일을 두 벌로 만들면 한쪽만 고쳐져서 서로 다른 말을 하게 된다. */
  function stockNowHtml(mk, sel) {
    var list = (LIVE && LIVE.news && LIVE.news[mk]) || [];
    var al = aliasesOf({ ticker: sel.t, name: sel.n }, mk);
    var hits = list.filter(function (n) {
      var hay = [(n.ko || ''), (n.title || '')].join(' ').toLowerCase();
      return al.some(function (a) { return aliasHit(hay, a); });
    });
    var rg = M.labelRegime(regimeOf(mk));
    var h = '<div class="card snow">' +
      '<div class="sd-h" style="margin-top:0">📡 지금은</div>' +
      '<div class="snow-rg">시장 국면 <b>' + esc(rg.full) + '</b>' +
        (LIVE && LIVE.regime && LIVE.regime.asOf
          ? ' <span class="sdet-ago">' + agoText(LIVE.regime.asOf) + ' 판정</span>' : '') +
      '</div>';
    if (!list.length) {
      h += '<div class="snow-none">오늘 기사를 아직 받아오지 못했습니다.</div>';
    } else if (!hits.length) {
      h += '<div class="snow-none">오늘 받아온 기사 ' + list.length +
        '건 중 이 종목을 가리키는 것은 <b>없습니다.</b> ' +
        '조용한 게 나쁜 소식은 아닙니다.</div>';
    } else {
      h += hits.slice(0, 3).map(function (n) {
        /* 판정 표기는 뉴스 화면과 같은 것을 쓴다 — 같은 판정이 화면마다
           다른 말로 보이면 그게 제일 헷갈린다. */
        var act = ACTS[n.act] || ACTS.none;
        var url = safeUrl(n.link);
        return '<div class="snow-n">' +
          '<span class="snow-a ' + act.c + '">' + act.i + ' ' + act.l + '</span>' +
          (url ? '<a href="' + url + '" target="_blank" rel="noopener">' + esc(n.ko || n.title) + ' ↗</a>'
               : '<span>' + esc(n.ko || n.title) + '</span>') +
          (n.why ? '<small>' + esc(n.why) + '</small>' : '') +
        '</div>';
      }).join('');
      if (hits.length > 3) h += '<div class="snow-none">… 외 ' + (hits.length - 3) + '건</div>';
      h += '<div class="snow-warn">기사가 났다고 사고팔라는 뜻이 아닙니다. ' +
        '<b>처음 산 이유가 아직 맞는지</b>만 보세요.</div>';
    }
    return h + '</div>';
  }

  function stockDetailHtml(mk, sel) {
    var card = stockCardOf(mk, sel.t);
    var price = priceIn(mk, sel.t);
    var h = [];

    h.push('<div class="card sdet">' +
      '<div class="sdet-top">' +
        '<span class="sdet-n">' + esc(sel.n) + '</span>' +
        (sel.t ? '<span class="sdet-t">' + esc(sel.t) + '</span>' : '') +
      '</div>' +
      (price !== null
        ? '<div class="sdet-p">현재 <b>' + perShare(price, mk) + '</b>' +
          (LIVE && LIVE.asOf ? ' <span class="sdet-ago">' + agoText(LIVE.asOf) + ' 기준</span>' : '') + '</div>'
        : '<div class="sdet-p muted">시세를 받아오지 않는 종목입니다.</div>') +
    '</div>');

    /* ── 오늘 이 종목 이야기 ──────────────────────────────────
       아래 해설은 **일부러 낡지 않게** 썼다 — 수치도 예측도 없고, 50년
       존속 가능성만 본다. 그래서 다시 만들 필요가 없다. 대신 "그래서 지금은
       어떤가"가 빠지는데, 그 자리를 오늘 기사와 시장 국면이 메운다.
       해설(안 변하는 것)과 오늘(변하는 것)을 같은 화면에서 나란히 본다. */
    h.push(stockNowHtml(mk, sel));

    if (!card) {
      /* 없으면 없다고 한다. 지어내지 않는 게 이 앱의 기본이다. */
      h.push('<div class="card nodata">' +
        '<div class="nd-h">📭 아직 이 종목 해설이 없습니다</div>' +
        (anaFailed
          ? '<div class="nd-b">해설 자료를 불러오지 못했습니다. 잠시 뒤 다시 열어보세요.</div>'
          : '<div class="nd-b">해설은 <b>하루에 몇 종목씩</b> 채워집니다. 아직 차례가 오지 않았습니다. ' +
            '없는 내용을 지어내느니 <b>없다고 말하는 쪽</b>을 골랐습니다.</div>') +
        '<div class="nd-b">그동안은 원자료를 직접 보시는 게 가장 정확합니다.</div>' +
        '<div class="srcrow">' + D.markets[mk].sources.map(function (s) {
          return '<a href="' + s.url + '" target="_blank" rel="noopener">' + esc(s.name) + ' ↗</a>';
        }).join('') + '</div>' +
      '</div>');
      return h.join('');
    }

    var d = card.d;
    var pct = total(d.scores), g = grade(pct);
    h.push('<div class="card sdet-body">' +
      '<div class="sd-src">' + (card.src === 'pick'
        ? '✍️ 이 앱이 직접 뜯어본 종목입니다'
        /* 언제 정리한 것인지 적는다. 아래 내용은 수치도 예측도 없어서 잘
           낡지 않지만, 그 판단은 읽는 사람이 하는 게 맞다. */
        : '🤖 AI 가 정리했습니다' + (d.at ? ' · ' + esc(d.at) : '') +
          ' · 매매 의견이 아닙니다') + '</div>' +

      '<div class="sd-h">🏢 뭐하는 회사인가</div>' +
      '<div class="sd-one">' + linkTerms(d.one) + '</div>' +
      (d.how ? '<div class="sd-how">' + linkTerms(d.how) + '</div>' : '') +

      '<div class="sd-h">📊 50년 뒤에도 있을 회사인가</div>' +
      '<div class="sd-grade"><span class="grade"><b>' + g.code + '</b><small>' + pct + '</small></span>' +
        '<span class="sd-gl"><b>' + g.label + '</b><small>' + esc(g.desc) + '</small></span></div>' +
      '<div class="bars">' + D.axes.map(function (a) {
        var v = d.scores[a.key];
        return '<div class="bar"><span class="bar-l">' + a.icon + ' ' + a.label + '</span>' +
          '<span class="bar-t"><span class="bar-f" style="width:' + (v / 5 * 100) + '%"></span></span>' +
          '<span class="bar-v">' + v + '</span></div>';
      }).join('') + '</div>' +

      '<div class="sd-h">💡 왜 그렇게 봤나</div>' +
      '<ul class="sb-list">' + d.why.map(function (w) { return '<li>' + linkTerms(w) + '</li>'; }).join('') + '</ul>' +

      '<div class="sd-h">⚠️ 무엇이 이 판단을 깨뜨리나</div>' +
      '<div class="sb-risk">' + linkTerms(d.risk) + '</div>' +

      '<div class="sd-h">🌱 초보자에게 한마디</div>' +
      '<div class="sb-beg">' + linkTerms(d.beginner) + '</div>' +

      '<div class="sd-h">🔍 직접 확인할 지표</div>' +
      '<div class="sb-check">' + d.check.map(function (c) { return '<span>' + esc(c) + '</span>'; }).join('') + '</div>' +
      '<div class="sd-note">이 앱은 <b>PER·부채비율 같은 수치를 담지 않습니다.</b> ' +
        '넣는 순간 낡고, 낡은 숫자를 믿는 게 안 보는 것보다 위험하기 때문입니다. ' +
        '위 지표는 아래 원자료에서 직접 확인하세요.</div>' +
      '<div class="srcrow">' + D.markets[mk].sources.map(function (s) {
        return '<a href="' + s.url + '" target="_blank" rel="noopener">' + esc(s.name) + ' ↗</a>';
      }).join('') + '</div>' +
    '</div>');

    /* 읽고 끝나는 화면을 만들지 않는다 — 다음 걸음을 붙인다 */
    h.push('<div class="sd-cta">' +
      '<button class="btn ghost" data-go="my">💼 내 주식에 등록하기 →</button>' +
      '<button class="btn ghost" data-go="plan">🎯 얼마나 담을지 보기 →</button>' +
    '</div>');
    return h.join('');
  }

  /* ══════════════════════════════════════════════════════════════════
     뷰 3 — 시장 (자동 판정 + 근거 + 이번 달 행동)
     ------------------------------------------------------------------
     예전 이 화면의 첫 요구는 "5개만 확인하세요"였다. 부담이 커서 결국
     아무도 확인하지 않았고, 앱 전체가 낡은 값으로 굴러갔다. 지금은 서버가
     실제 수치로 판정해 두고 이 화면은 **그 결론과 근거를 읽어준다.**
     직접 고치는 길은 남겨 두되(자동 판정은 결론이 아니다), 기본은 자동이다.
     ══════════════════════════════════════════════════════════════ */
  function renderMarket() {
    var mk = market(), st = regime();
    var reg = M.labelRegime(st);
    var tilt = M.tilt(st);
    var h = [];

    var by = regimeBy(), why = regimeWhy();
    var BY = {
      ai:      { i: '🤖', c: 'ok',        t: 'AI 자동 판정',
                 d: '지수·환율·VIX·미국 10년물 금리의 실제 수치와 오늘 헤드라인을 함께 읽고 판정했습니다.' },
      rules:   { i: '📐', c: 'ok',        t: '규칙 자동 판정',
                 d: '실제 수치에서 규칙으로 도출했습니다. 금리·경기·밸류에이션은 <b>대용 지표</b>라 한계가 있습니다.' },
      manual:  { i: '✍️', c: 'old',       t: '직접 고친 값',
                 d: '자동 판정 대신 직접 맞춘 값으로 계산 중입니다. 아래에서 자동으로 되돌릴 수 있습니다.' },
      'default': { i: '⚠️', c: 'stale-bad', t: '자동 판정을 아직 못 받아왔습니다',
                 d: '판정 파일을 못 읽어 ' + M.defaults.asOf + ' 기준 출발값을 쓰고 있습니다. 잠시 뒤 다시 열거나, 아래에서 직접 맞추세요.' }
    }[by];
    var stampedAt = (by === 'ai' || by === 'rules') && LIVE.regime && LIVE.regime.asOf
      ? ' · ' + agoText(LIVE.regime.asOf) + ' 갱신' : '';
    h.push('<div class="stale ' + BY.c + '"><span>' + BY.i + '</span><div>' +
      '<b>' + BY.t + '</b>' + stampedAt + '<br>' + BY.d + '</div></div>');

    h.push('<div class="regime">' +
      '<div class="regime-eyebrow">' + mk.flag + ' ' + mk.full + ' · 지금의 국면</div>' +
      '<div class="regime-name">' + reg.emoji + ' ' + reg.name + '</div>' +
      (reg.full !== reg.name ? '<div class="regime-full">' + reg.full + '</div>' : '') +
      '<div class="regime-tilt">현금 비중 <b>' + (tilt.cash >= 0 ? '+' : '') + tilt.cash + '%p</b> 조정 중</div>' +
    '</div>');

    /* ── 5개 항목의 판정과 근거 ────────────────────────────────
       값만 보여주면 사용자가 검증할 수 없다. 판정마다 어떤 수치를 보고
       그렇게 정했는지 한 줄로 같이 낸다.                              */
    var judgeHtml = '<div class="card">';
    M.dials.forEach(function (d) {
      var chosen = null;
      d.options.forEach(function (o) { if (o.v === st[d.key]) chosen = o; });
      judgeHtml += '<div class="jrow"><div class="jico">' + d.icon + '</div><div class="jbody">' +
        '<div class="jq">' + d.title + '</div>' +
        '<div class="jv">' + esc(chosen ? chosen.label : st[d.key]) + '</div>' +
        '<div class="jwhy">' + (why && why[d.key] ? esc(why[d.key]) : linkTerms(chosen ? chosen.read : '')) + '</div>' +
      '</div></div>';
    });
    judgeHtml += '</div>';
    if (by === 'ai') {
      var a = autoRegime(state.market);
      if (a && a.summary) judgeHtml += '<div class="note">🧭 ' + esc(a.summary) + '</div>';
    }
    judgeHtml += '<div class="note">이 판정은 <b>지금 상태를 분류한 것</b>이지 앞날의 예측이 아닙니다. ' +
      '아래 링크로 직접 확인하고, 다르다고 생각되면 “직접 고치기”에서 바꾸세요 — 바꾸는 즉시 홈과 제안이 다시 계산됩니다.</div>';
    h.push(fold('mk-judge', '🧭', '이렇게 판정한 이유', judgeHtml));

    var dialsHtml = '<div class="stepnote" style="margin-top:0">자동 판정이 지금 시장과 다르다고 느껴질 때만 쓰세요. ' +
      '하나라도 고치면 그 시장은 <b>직접 고치기 모드</b>가 되고, 자동 판정이 갱신돼도 덮어쓰지 않습니다.</div>' +
      (by === 'manual' ? '<button class="btn ghost" id="regime-auto">↩️ 자동 판정으로 되돌리기</button>' : '') +
      '<div class="card">';
    M.dials.forEach(function (d) {
      dialsHtml += '<div class="dial"><div class="dial-q"><span>' + d.icon + '</span><span>' + d.title + '</span></div>' +
        '<div class="dial-why">' + linkTerms(d.why) + '</div><div class="dial-opts">';
      d.options.forEach(function (o) {
        dialsHtml += '<button class="dial-opt' + (st[d.key] === o.v ? ' is-on' : '') + '" data-dial="' + d.key + '" data-val="' + o.v + '">' +
          '<span class="o-l">' + o.label + '</span><span class="o-h">' + o.hint + '</span></button>';
      });
      dialsHtml += '</div>';
      /* 환율은 실제 값과 1년 범위 위치를 알면 감이 아니라 근거로 고를 수 있다. */
      if (d.key === 'fx' && LIVE && LIVE.fx && LIVE.quotes && LIVE.quotes['KRW=X']) {
        var cur = LIVE.quotes['KRW=X'].price, fxr = LIVE.fx;
        var want = fxr.pct >= 0.66 ? 'weak' : fxr.pct <= 0.33 ? 'strong' : 'neutral';
        var wantLabel = { weak: '원화 약세', neutral: '보통', strong: '원화 강세' }[want];
        dialsHtml += '<div class="dialhint">지금 <b>' + fmtNum(cur, '원') + '</b> · 최근 1년 ' +
          fmtNum(fxr.low52, '') + '~' + fmtNum(fxr.high52, '') + ' 중 <b>' + Math.round(fxr.pct * 100) + '% 지점</b>' +
          (st[d.key] === want ? ' — 지금 선택과 맞습니다.'
            : ' → <button class="dialapply" data-dial="' + d.key + '" data-val="' + want + '">‘' + wantLabel + '’' + ro(wantLabel) + ' 맞추기</button>') + '</div>';
      }
      if (d.key === 'geo' && LIVE && LIVE.quotes && LIVE.quotes['^VIX']) {
        var vix = LIVE.quotes['^VIX'].price;
        dialsHtml += '<div class="dialhint">지금 VIX <b>' + vix.toFixed(1) + '</b> — ' +
          (vix >= 30 ? '30 이상은 <b>충격 발생</b> 구간으로 봅니다.'
           : vix >= 20 ? '20~30은 <b>긴장</b> 구간으로 봅니다.'
           : '20 미만은 대체로 <b>평온</b> 구간입니다.') + ' 숫자 하나로 정하지 말고 헤드라인도 같이 보세요.</div>';
      }
      dialsHtml += '<div class="dial-where">';
      d.where.forEach(function (w) {
        if (w.for !== 'both' && w.for !== state.market) return;
        dialsHtml += '<a href="' + w.url + '" target="_blank" rel="noopener">' + w.label + ' ↗</a>';
      });
      dialsHtml += '</div></div>';
    });
    dialsHtml += '</div><div class="note">직접 고친 값은 이 브라우저에만 저장됩니다. ' +
      '자동 판정으로 되돌리면 다시 서버가 받아온 수치 기준으로 계산합니다.</div>';
    h.push(fold('mk-dials', '✍️', '직접 고치기', dialsHtml, { open: false }));

    var readHtml = '<div class="card">';
    M.readings(st).forEach(function (r) {
      readHtml += '<div class="read-item"><div class="read-ico">' + r.icon + '</div><div>' +
        '<div class="read-choice">' + r.title + ' → ' + r.choice + '</div>' +
        '<div class="read-text">' + linkTerms(r.read) + '</div></div></div>';
    });
    readHtml += '</div>';
    var f = M.forces(st, state.market);
    var forceHtml = '<div class="forces">' +
      '<div class="fcol up"><div class="fcol-h">▲ 밀어올리는 힘</div>' +
        (f.up.length ? f.up.map(function (x) { return '<div class="fitem">' + x.icon + ' ' + x.text + '</div>'; }).join('')
                     : '<div class="fitem none">지금 확인한 값에서는 없습니다</div>') + '</div>' +
      '<div class="fcol down"><div class="fcol-h">▼ 눌러내리는 힘</div>' +
        (f.down.length ? f.down.map(function (x) { return '<div class="fitem">' + x.icon + ' ' + x.text + '</div>'; }).join('')
                       : '<div class="fitem none">지금 확인한 값에서는 없습니다</div>') + '</div></div>' +
      readHtml;
    h.push(fold('mk-read', '🧠', '이 국면이 뜻하는 것', forceHtml, { open: false }));

    var actHtml = '<div class="card">';
    M.actions(st, state.market).forEach(function (a) {
      actHtml += '<div class="act"><div class="act-ico">' + a.icon + '</div><div>' +
        '<div class="act-t">' + a.t + '</div><div class="act-d">' + linkTerms(a.d) + '</div></div></div>';
    });
    actHtml += '</div>';
    h.push(fold('mk-act', '✅', '이번 달에 할 일', actHtml));

    h.push('<div class="sec"><button class="btn" data-go="home">홈으로 돌아가기 →</button></div>');
    return h.join('');
  }

  /* ══════════════════════════════════════════════════════════════════
     뷰 4 — 배우기
     ══════════════════════════════════════════════════════════════ */
  function renderLearn() {
    var h = ['<div class="subnav">' +
      '<button class="subbtn' + (state.learnTab === 'picks' ? ' is-on' : '') + '" data-sub="picks">🏛️ 종목</button>' +
      '<button class="subbtn' + (state.learnTab === 'study' ? ' is-on' : '') + '" data-sub="study">📚 배우기</button>' +
    '</div>'];
    if (state.learnTab === 'picks') return h.join('') + renderPicks();

    var tax = D.tax[state.market];

    var themeHtml = '<div class="stepnote" style="margin-top:0">다음 분기에 뭐가 오를지는 아무도 모릅니다. 10년 단위로 뒤집히기 어려운 흐름만 다룹니다.</div>';
    M.themes.forEach(function (t) {
      themeHtml += '<div class="card"><div class="theme-h">' + t.icon + ' ' + t.title + '</div>' +
        '<div class="theme-b">' + linkTerms(t.body) + '</div>' +
        '<div class="theme-blue">🏛️ <b>블루칩으로 타는 법</b> — ' + linkTerms(t.blue) + '</div>' +
        '<div class="theme-c">⚠️ ' + linkTerms(t.caution) + '</div></div>';
    });
    h.push(fold('lr-theme', '🔭', '방향이 거의 정해진 흐름', themeHtml, { open: false, badge: M.themes.length }));

    /* 예전에는 이 세 질문을 사용자가 직접 답했다. 지금은 판정기가 답하고
       기사 옆에 결과를 붙인다. 그래도 기준은 공개한다 — 어떤 잣대로 판정
       했는지 모르면 사용자가 그 판정을 검증할 수 없다. */
    var newsHtml = '<div class="slot-d">홈의 기사마다 붙는 판정은 아래 세 질문에 답한 결과입니다. ' +
      '<b>사용자가 직접 답하지 않아도 됩니다</b> — 다만 기준은 알고 계셔야 그 판정을 검증할 수 있습니다.</div><div class="card">';
    D.newsRules.forEach(function (r, i) {
      newsHtml += '<div class="newsq"><div class="newsq-q">' + (i + 1) + '. ' + r.q + '</div>' +
        '<div class="newsq-a y">예 — ' + linkTerms(r.yes) + '</div>' +
        '<div class="newsq-a n">아니오 — ' + linkTerms(r.no) + '</div></div>';
    });
    newsHtml += '</div><div class="card">';
    ['none', 'watch', 'review'].forEach(function (k) {
      newsHtml += '<div class="newsq"><div class="newsq-q">' + ACTS[k].i + ' ' + ACTS[k].l + '</div>' +
        '<div class="newsq-a n">' + {
          none:   '셋 다 “아니오”. 대부분의 기사가 여기입니다. <b>계좌를 열지 않는 게 정답</b>입니다.',
          watch:  '구조를 바꿀 수 있는 사건이지만 아직 내 종목의 이야기인지 불분명합니다. <b>기억만 해두고 오늘은 아무것도 하지 않습니다.</b>',
          review: '투자 근거 자체가 흔들릴 수 있습니다. <b>파는 게 아니라</b>, 처음 이 종목을 산 이유를 다시 읽어보라는 뜻입니다.'
        }[k] + '</div></div>';
    });
    newsHtml += '</div><div class="note" style="margin-top:12px">판정에 <b>“파세요·사세요”는 들어가지 않습니다.</b> ' +
      '들어간 문장은 걸러내고 기본 판정으로 되돌립니다 — 이 앱은 매매를 권하지 않습니다.</div>';
    h.push(fold('lr-news', '🗞️', '기사 판정은 무엇을 보나', newsHtml));

    var misHtml = '';
    D.mistakes.forEach(function (m) {
      misHtml += '<div class="card"><div class="mis-h">' + m.icon + ' ' + m.title + '</div>' +
        '<div class="mis-b">' + linkTerms(m.body) + '</div>' +
        '<div class="mis-f">→ ' + linkTerms(m.fix) + '</div></div>';
    });
    h.push(fold('lr-mis', '🕳️', '가장 많이 빠지는 함정', misHtml, { open: false, badge: D.mistakes.length }));

    var roadHtml = '<div class="card">';
    D.roadmap.forEach(function (r) {
      roadHtml += '<div class="road"><div class="road-w">' + r.when + '</div><div>' +
        '<div class="road-t">' + r.title + '</div>' +
        '<ul class="road-l">' + r.todo.map(function (t) { return '<li>' + linkTerms(t) + '</li>'; }).join('') + '</ul>' +
        '<div class="road-y">💡 ' + linkTerms(r.why) + '</div></div></div>';
    });
    roadHtml += '</div>';
    h.push(fold('lr-road', '🗓️', '처음 3개월 로드맵', roadHtml, { open: false }));

    var taxHtml = '<div class="card"><div class="stepnote" style="margin-top:0">' + tax.headline + '</div><div class="sb-h">세금 구조</div>';
    tax.items.forEach(function (i) {
      taxHtml += '<div class="tax-row"><div class="tax-t">' + i.t + '</div><div class="tax-d">' + linkTerms(i.d) + '</div></div>';
    });
    taxHtml += '<div class="sb-h">어느 계좌에 담을까</div>';
    tax.accounts.forEach(function (i) {
      taxHtml += '<div class="tax-row"><div class="tax-t">' + i.t + '</div><div class="tax-d">' + linkTerms(i.d) + '</div></div>';
    });
    taxHtml += '<div class="note" style="margin-top:12px">💡 ' + linkTerms(tax.tip) + '</div>' +
      '<div class="note" style="margin-top:8px;background:#fdf1ef;color:#9a3a31">⚠️ ' + D.tax.disclaimer + '</div></div>';
    h.push(fold('lr-tax', '🧾', market().flag + ' 세금과 계좌', taxHtml, { open: false }));

    var gloHtml = '<div class="card">';
    Object.keys(D.glossary).forEach(function (k) {
      gloHtml += '<div class="tax-row"><div class="tax-t">' + k + '</div><div class="tax-d">' + D.glossary[k] + '</div></div>';
    });
    gloHtml += '</div>';
    h.push(fold('lr-glo', '📖', '용어 사전', gloHtml, { open: false, badge: Object.keys(D.glossary).length }));

    h.push(fold('lr-reset', '🔁', '기록 초기화',
      '<div class="card"><div class="slot-d">시드·성향·시장 다이얼·보유 종목·홈 위젯 설정을 처음 상태로 되돌립니다. ' +
      '이 브라우저에 저장된 <b>이 앱의 값만</b> 지웁니다.</div>' +
      '<button class="btn danger" id="reset" style="margin-top:12px">기록 초기화</button></div>', { open: false }));

    h.push('<div class="foot"><b>고지.</b> 이 앱은 투자 교육 자료입니다. 특정 종목의 매수·매도를 권유하지 않으며 어떤 수익도 보장하지 않습니다. ' +
      '종목 점수는 공개된 사업 구조를 바탕으로 한 정성 평가이고 가격·실적 데이터가 아닙니다. 세법과 제도는 수시로 바뀌므로 반드시 ' +
      '국세청·증권사에서 확인하세요. 투자 판단과 그 결과는 전적으로 본인의 책임입니다.<br><br>' +
      '시장 국면은 30분마다 받아오는 실제 수치로 <b>자동 판정</b>합니다. 자동 판정을 못 받아오면 ' +
      M.defaults.asOf + ' 기준 출발값을 씁니다. 저장은 이 브라우저에만 남고 서버로 전송되지 않습니다.</div>');

    return h.join('');
  }

  /* ══════════════════════════════════════════════════════════════════
     렌더 / 이벤트
     ══════════════════════════════════════════════════════════════ */
  var VIEWS = {
    home:   renderHome,
    my:     renderMy,
    plan:   renderPlan,
    stock:  renderStock,
    market: renderMarket,
    learn:  renderLearn
  };
  var current = 'home';

  function render() {
    /* 그리기 전에 자동 운용을 한 번 확인한다 — 하루 한 번만 실제로 움직인다 */
    simAutoTick();
    document.body.setAttribute('data-market', state.market);
    document.getElementById('view-' + current).innerHTML = VIEWS[current]();

    Array.prototype.forEach.call(document.querySelectorAll('.ms-btn'), function (b) {
      var on = b.dataset.market === state.market;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      var on = b.dataset.view === current;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Array.prototype.forEach.call(document.querySelectorAll('.view'), function (v) {
      v.classList.toggle('is-on', v.id === 'view-' + current);
    });
  }

  function go(view) {
    if (!VIEWS[view]) return;
    current = view;
    render();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  document.addEventListener('click', function (ev) {
    var el;

    /* 시장 전환 — 탭은 유지한다. 같은 화면을 시장별로 비교하는 게 목적이라
       전환할 때마다 첫 탭으로 돌아가면 비교가 끊긴다. */
    if ((el = ev.target.closest('.ms-btn'))) {
      state.market = el.dataset.market;
      save('market', state.market);
      Object.keys(VIEWS).forEach(function (v) {
        if (v !== current) document.getElementById('view-' + v).innerHTML = '';
      });
      render();
      return;
    }
    if ((el = ev.target.closest('.tab')))      { go(el.dataset.view); return; }
    if ((el = ev.target.closest('[data-go]'))) {
      if (el.dataset.sub) { state.learnTab = el.dataset.sub; save('learnTab', state.learnTab); }
      go(el.dataset.go);
      return;
    }

    /* 접기/펴기 */
    if ((el = ev.target.closest('.fold-h'))) {
      var fk = el.dataset.fold;
      var dflt = el.dataset.open !== '0';
      state.folds[fk] = !isOpen(fk, dflt);
      save('folds', state.folds);
      render();
      return;
    }
    /* ── 환율 잠금 ──
       기본은 자동(살아 있는 값). 직접 정하고 싶을 때만 잠근다. */
    if (ev.target.id === 'fx-lock') {
      state.profile.fx = fxNow();
      state.profile.fxLock = true;
      save('profile', state.profile);
      render(); return;
    }
    if (ev.target.id === 'fx-auto') {
      state.profile.fxLock = false;
      save('profile', state.profile);
      render(); return;
    }
    /* 홈 위젯 편집 */
    if (ev.target.id === 'wgt-toggle') {
      state.editWidgets = !state.editWidgets; render(); return;
    }
    if ((el = ev.target.closest('.wgt-chk'))) {
      setWidget(el.dataset.widget, el.checked);
      render();
      return;
    }
    /* 종목 추가 폼 열고 닫기 */
    if ((el = ev.target.closest('[data-cur]'))) {
      state.cur = el.dataset.cur; save('cur', state.cur); render(); return;
    }
    if (ev.target.id === 'add-toggle') {
      state.addOpen = !state.addOpen;
      if (state.addOpen) loadTickers();
      else { state.q = ''; state.pickSel = null; }
      render();
      if (state.addOpen) {
        var n = document.getElementById('h-name');
        if (n) n.focus();
      }
      return;
    }

    if ((el = ev.target.closest('.hzchip'))) {
      state.profile.horizon = parseInt(el.dataset.hz, 10);
      save('profile', state.profile); render(); return;
    }
    if ((el = ev.target.closest('.seedchip'))) {
      state.profile.seed = parseInt(el.dataset.seed, 10);
      save('profile', state.profile); render(); return;
    }
    if ((el = ev.target.closest('.stylebtn'))) {
      state.style = el.dataset.style; save('style', state.style); render(); return;
    }
    if ((el = ev.target.closest('.dialapply')) || (el = ev.target.closest('.dial-opt'))) {
      setDial(el.dataset.dial, el.dataset.val);
      render(); return;
    }
    /* 자동으로 되돌리기 — 직접 고친 값은 지우지 않고 모드만 되돌린다.
       다시 "직접 고치기"로 왔을 때 예전에 맞춰둔 값이 그대로 있어야 한다. */
    if (ev.target.closest('#regime-auto')) {
      state.regimeMode = 'auto';
      save('regimeMode', state.regimeMode);
      render(); return;
    }
    if ((el = ev.target.closest('[data-psub]'))) {
      state.planTab = el.dataset.psub;
      save('planTab', state.planTab);
      if (current !== 'plan') { go('plan'); } else { render(); }
      return;
    }
    if ((el = ev.target.closest('.subbtn'))) { state.learnTab = el.dataset.sub; save('learnTab', state.learnTab); render(); return; }
    if ((el = ev.target.closest('.chip'))) { state.filter = el.dataset.filter; render(); return; }
    if ((el = ev.target.closest('.stock-head'))) {
      el.closest('.stock').classList.toggle('is-open'); return;
    }
    if ((el = ev.target.closest('.term'))) { openSheet(el.dataset.term); return; }
    if (ev.target.closest('[data-close]'))  { document.getElementById('sheet').hidden = true; return; }

    /* 알아보기 탭에서 고른 경우. data-ac 보다 먼저 본다. */
    if ((el = ev.target.closest('.acitem')) && el.dataset.sac !== undefined) {
      var sres = searchTickers(state.sq, state.market);
      var sgot = sres[parseInt(el.dataset.sac, 10)];
      if (sgot) { state.sSel = sgot; render(); }
      return;
    }
    if ((el = ev.target.closest('[data-spick]'))) {
      var pk = null;
      D.markets[state.market].picks.forEach(function (p) {
        if (p.ticker === el.dataset.spick) pk = p;
      });
      if (pk) { state.sq = pk.name; state.sSel = { t: pk.ticker, n: pk.name, etf: 0, uni: true }; render(); }
      return;
    }
    /* 요약 줄에서 "아래에서 하나씩 보기"를 누르면, 그 칸을 펴고 거기로 옮겨준다.
       펴 놓기만 하고 그대로 두면 사용자는 무엇이 달라졌는지 못 찾는다. */
    if ((el = ev.target.closest('[data-openfold]'))) {
      var fk = el.dataset.openfold;
      state.folds[fk] = true;
      save('folds', state.folds);
      render();
      var tgt = document.querySelector('[data-fold="' + fk + '"]');
      if (tgt && tgt.scrollIntoView) tgt.scrollIntoView({ block: 'start' });
      return;
    }
    if (ev.target.id === 'live-refresh') {
      var rb = ev.target;
      rb.disabled = true; rb.textContent = '⏳ 받는 중…';
      refreshNow().then(function () {
        /* 값이 그대로여도 다시 그린다 — 눌렀는데 아무 반응이 없으면
           고장으로 읽힌다. 바뀐 게 없으면 그렇다고 말해주는 편이 낫다. */
        render();
      });
      return;
    }
    if (ev.target.id === 'sim-now') {
      /* ── 누르면 **먼저 새 시세를 받아온다** ────────────────────
         예전에는 화면에 남아 있는 스냅샷으로 다시 계산만 했다. 그러면
         앱을 켜 둔 지 한 시간 지난 사람이 눌러도 한 시간 전 값으로
         판단하게 된다 — "들어갔을 때 바로 확인한다"는 이 단추의 목적과
         정반대다. 받아온 다음에 조정한다.                              */
      var btn = ev.target;
      btn.disabled = true;
      btn.textContent = '⏳ 새 시세를 받는 중…';
      refreshNow().then(function () {
        var stn = simState();
        var rn = SIM.autoRun(stn, Object.assign(simCtx(), { force: true }));
        var when = LIVE && LIVE.asOf ? agoText(LIVE.asOf) + ' 시세로 ' : '';
        if (!rn.ran) {
          state.simMsg = when + '점검했습니다. 지금은 조정할 게 없습니다.';
        } else if (!rn.done || !rn.done.length) {
          state.simMsg = when + '점검했습니다. 목표와 크게 벌어진 자리가 없어 그대로 뒀습니다.';
        } else {
          state.simMsg = when + rn.done.length + '곳을 조정했습니다. 아래에서 무엇을 왜 사고팔았는지 볼 수 있습니다.';
        }
        simFreshReset(state.market);
        simSave();
        render();
      });
      return;
    }
    if (ev.target.id === 'seed-toggle' || ev.target.closest('#seed-toggle')) {
      state.seedOpen = !state.seedOpen;
      render();
      return;
    }
    if ((el = ev.target.closest('[data-seedadd]'))) {
      var raw = el.dataset.seedadd;
      var amt;
      if (raw === 'in' || raw === 'out') {
        var box = document.getElementById('seed-amt');
        amt = Math.abs(parseFloat(box && box.value) || 0);
        if (raw === 'out') amt = -amt;
      } else {
        amt = parseFloat(raw) || 0;
      }
      if (!amt) { state.simMsg = '넣거나 뺄 금액을 적어주세요.'; render(); return; }
      var res = SIM.resize(simState(), Object.assign(simCtx(), { amount: amt }));
      if (!res.ok) {
        state.simMsg = '⚠️ ' + res.why;
      } else {
        var sold = (res.sold || []).length;
        state.simMsg = (amt > 0 ? won(amt) + '을 넣었습니다.' : won(-amt) + '을 뺐습니다.') +
          (sold ? ' ' + sold + '곳에서 마련했습니다.' : '') +
          ' 목표 비중에 맞춰 정리합니다.';
        state.seedAmt = '';
        simFreshReset(state.market);
        simSave();
      }
      state.seedOpen = false;
      render();
      return;
    }
    if (ev.target.id === 'sty-toggle' || ev.target.closest('#sty-toggle')) {
      state.styleOpen = !state.styleOpen;
      render();
      return;
    }
    if ((el = ev.target.closest('[data-style]'))) {
      var nk = el.dataset.style;
      var sst = simState();
      if (sst.started && nk && nk !== sst.style) {
        var before = styleLabelOf(sst.style);
        sst.style = nk;
        /* 이미 조정했더라도 성향이 바뀌었으면 다시 맞춘다 — 안 그러면
           다음 시세가 올 때까지 옛 목표로 남는다. 자동 운용을 끊는 기준이
           lastSnap 이므로 그쪽도 같이 비운다(lastAuto 만 비우면 "이 스냅샷은
           이미 봤다"에 걸려 아무 일도 안 일어난다). */
        sst.lastAuto = null;
        sst.lastSnap = null;
        sst.log.unshift({ ts: ymd(today()), kind: 'note', n: '성향 변경',
          amt: 0, why: before + ' → ' + styleLabelOf(nk) });
        simSave();
        simFreshReset(state.market);
        state.simMsg = '성향을 ' + styleLabelOf(nk) + '으로 바꿨습니다. 다음 조정 때 새 목표에 맞춥니다.';
      }
      state.styleOpen = false;
      render();
      return;
    }
    if ((el = ev.target.closest('[data-logmore]'))) {
      var lk = el.dataset.logmore;
      state.logMore[lk] = !state.logMore[lk];
      render();
      return;
    }
    if (ev.target.id === 'sq-clear') {
      state.sq = ''; state.sSel = null; render();
      var sqi = document.getElementById('sq');
      if (sqi) sqi.focus();
      return;
    }
    if ((el = ev.target.closest('.acitem'))) {
      var res2 = searchTickers(state.q, state.market);
      var got = res2[parseInt(el.dataset.ac, 10)];
      if (got) { state.pickSel = got; render(); focusAmount(); }
      return;
    }
    if (ev.target.id === 'pick-free') {
      state.pickSel = { t: '', n: state.q.trim(), etf: 0, uni: false, price: null };
      render(); focusAmount();
      return;
    }
    if (ev.target.id === 'pick-clear') {
      state.pickSel = null; state.q = ''; render();
      var qi = document.getElementById('h-name');
      if (qi) qi.focus();
      return;
    }

    if (ev.target.id === 'h-add') {
      var sel = state.pickSel;
      var avgEl = document.getElementById('h-avg');
      var qtyEl = document.getElementById('h-qty');
      var curEl = document.getElementById('h-cur');
      var fxAtEl = document.getElementById('h-fxat');
      if (!sel) {
        var qi2 = document.getElementById('h-name');
        if (qi2) qi2.focus();
        return;
      }
      var avg = parseFloat(avgEl && avgEl.value);
      var qty = parseFloat(qtyEl && qtyEl.value);
      if (!(avg > 0)) { if (avgEl) avgEl.focus(); return; }
      if (!(qty > 0)) { if (qtyEl) qtyEl.focus(); return; }

      var item = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        name: sel.n,
        ticker: sel.t || '',
        avg: avg,
        qty: qty
      };
      /* 시세를 못 받아오는 종목은 사용자가 적은 현재가를 쓴다 */
      var manual = parseFloat(curEl && curEl.value);
      if (manual > 0) item.cur = manual;
      if (state.market === 'us') item.fxAt = parseInt(fxAtEl && fxAtEl.value, 10) || fxNow();

      /* 처음 종목을 등록한 날을 투자 시작일로 잡는다 — 따로 묻지 않기 위해서다.
         한 번 잡히면 종목을 지웠다 다시 넣어도 바뀌지 않는다. */
      if (!state.profile.startedAt) {
        state.profile.startedAt = ymd(today());
        save('profile', state.profile);
      }
      state.holdings[state.market].push(item);
      /* 방금 등록한 종목이 유니버스 밖이면 이제 넓은 시세 목록이 필요하다 */
      loadPrices();
      save('holdings', state.holdings);
      state.pickSel = null;
      state.q = '';
      render();
      var again = document.getElementById('h-name');
      if (again) again.focus();
      return;
    }
    if ((el = ev.target.closest('[data-del]'))) {
      var id = parseInt(el.dataset.del, 10);
      state.holdings[state.market] = state.holdings[state.market].filter(function (x) { return x.id !== id; });
      save('holdings', state.holdings);
      render();
      return;
    }

    /* ── 모의투자 ── */
    if (ev.target.id === 'sim-start') {
      var model = P.build(state.market, state.style, M.tilt(regime()).cash).holdings;
      var ctx = simCtx();
      ctx.style = state.style;
      ctx.seed = state.profile.seed;
      ctx.model = model;
      state.sim[state.market] = SIM.start(ctx);
      /* 방금 목표대로 담았으므로 오늘은 더 조정하지 않는다 */
      state.sim[state.market].lastAuto = ymd(today());
      simSave();
      state.folds['sim-pos'] = true;
      save('folds', state.folds);
      render();
      return;
    }
    if (ev.target.id === 'sim-auto') {
      var sa = simState();
      sa.auto = !sa.auto;
      /* 켤 때는 바로 한 번 돌게 한다 — 켜놓고 아무 일도 안 일어나면
         무엇이 켜진 건지 알 수 없다. lastSnap 도 같이 비운다(위와 같은 이유). */
      if (sa.auto) { sa.lastAuto = null; sa.lastSnap = null; }
      simSave();
      state.simMsg = sa.auto ? '자동 운용을 켰습니다. 목표에서 벌어진 자리를 지금 조정합니다.'
                             : '자동 운용을 껐습니다. 계좌는 지금 상태로 둡니다.';
      state.folds['sim-log'] = true;
      render();
      return;
    }
    if (ev.target.id === 'sim-reset') {
      if (!window.confirm('모의투자 기록을 지우고 처음부터 다시 설정할까요? 되돌릴 수 없습니다.')) return;
      state.sim[state.market] = SIM.blank();
      simSave();
      render();
      return;
    }
    /* (여기 있던 sim-buy · data-trade 처리기를 뺐다 — 화면에서 손으로 사고파는
       칸을 없앴으므로 부를 곳이 없다. 엔진의 buy/sell 자체는 자동 운용이
       계속 쓴다.) */

    if (ev.target.id === 'reset') {
      ['market', 'style', 'regime', 'regimeMode', 'profile', 'touched', 'holdings', 'cash', 'widgets', 'folds', 'sim', 'planTab', 'learnTab', 'cur'].forEach(function (k) {
        try { localStorage.removeItem(KEY + k); } catch (e) {}
      });
      state.market = 'kr';
      state.style = 'balanced';
      state.regime = { kr: copy(M.defaults.kr), us: copy(M.defaults.us) };
      state.regimeMode = 'auto';
      state.touched = { kr: null, us: null };
      state.holdings = { kr: [], us: [] };
      state.cash = { kr: 0, us: 0 };
      state.widgets = null;
      state.folds = {};
      state.sim = { kr: SIM.blank(), us: SIM.blank() };
      state.planTab = 'plan';
      state.learnTab = 'picks';
      state.cur = 'krw';
      state.addOpen = false;
      state.editWidgets = false;
      state.profile = { seed: 1000, fx: 1350 };
      Object.keys(VIEWS).forEach(function (v) { document.getElementById('view-' + v).innerHTML = ''; });
      go('home');
      return;
    }
  });

  /* 숫자 입력은 타이핑 중 전체를 다시 그리면 커서가 튄다.
     입력 중에는 상태만 갱신하고, 포커스가 빠질 때(change) 다시 그린다. */
  document.addEventListener('input', function (ev) {
    if (ev.target.id === 'seed') {
      var n = parseInt(ev.target.value, 10);
      if (n >= 10 && n <= 1000000) { state.profile.seed = n; save('profile', state.profile); }
    }
    if (ev.target.id === 'fxrate') {
      var f = parseInt(ev.target.value, 10);
      if (f >= 800 && f <= 2500) {
        /* 손으로 적었다는 건 직접 정하겠다는 뜻이다 — 자동을 끈다. */
        state.profile.fx = f; state.profile.fxLock = true;
        save('profile', state.profile);
      }
    }
    if (ev.target.id === 'seed-amt') { state.seedAmt = ev.target.value; return; }
    if (ev.target.id === 'sq') {
      state.sq = ev.target.value;
      state.sSel = null;
      var host = document.querySelector('.view.is-on .sqres');
      if (host) host.innerHTML = stockResultHtml(state.market);
      return;
    }
    if (ev.target.id === 'h-name') {
      state.q = ev.target.value;
      state.pickSel = null;
      /* 전체를 다시 그리면 입력칸 포커스가 날아간다. 목록만 갈아 끼운다. */
      var box = document.querySelector('.view.is-on .acbox');
      var host = document.querySelector('.view.is-on .addform');
      if (!host) return;
      var html = '';
      var res = searchTickers(state.q, state.market);
      if (state.q) {
        if (res.length) {
          html = res.map(function (r, i) {
            return '<button class="acitem" data-ac="' + i + '">' +
              '<span class="ac-n">' + esc(r.n) + '</span>' +
              (r.t ? '<span class="ac-t">' + esc(r.t) + '</span>' : '') +
              (r.uni ? '<span class="ac-b uni">50년 카드</span>' : '') +
              (r.etf ? '<span class="ac-b etf">ETF</span>' : '') +
              (r.price !== null && r.price !== undefined ? '<span class="ac-p">' + perShare(r.price, state.market) + '</span>' : '') +
            '</button>';
          }).join('');
        } else if (tickersState === 'loading') {
          html = '<div class="acmsg">종목 목록을 불러오는 중…</div>';
        } else if (tickersState === 'failed') {
          html = '<div class="acmsg">종목 목록을 못 불러왔습니다. 이름을 직접 적어도 됩니다.</div>';
        } else {
          html = '<div class="acmsg">일치하는 종목이 없습니다. <button class="linkbtn" id="pick-free">‘' +
            esc(state.q) + '’ 그대로 쓰기</button></div>';
        }
      }
      if (box) { box.innerHTML = html; box.hidden = !html; }
      else if (html) {
        var el2 = document.createElement('div');
        el2.className = 'acbox';
        el2.innerHTML = html;
        ev.target.parentNode.insertBefore(el2, ev.target.nextSibling);
      }
      return;
    }
    if (ev.target.id === 'h-cash') {
      var c = parseFloat(ev.target.value);
      if (!(c >= 0)) c = 0;
      /* 저장은 그 시장 통화의 기본 단위로: 국내는 원, 미국은 달러 */
      state.cash[state.market] = state.market === 'us' ? c : c * 10000;
      save('cash', state.cash);
    }
  });
  document.addEventListener('change', function (ev) {
    if (ev.target.id === 'seed' || ev.target.id === 'fxrate' || ev.target.id === 'h-cash') render();
  });
  /* 종목 입력칸에서 엔터로 바로 추가 */
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    var id = ev.target.id;
    if (id === 'h-name') {
      ev.preventDefault();
      var first = document.querySelector('.view.is-on .acitem');
      if (first) first.click();
      return;
    }
    if (id === 'h-avg' || id === 'h-qty' || id === 'h-cur') {
      ev.preventDefault();
      var btn = document.getElementById('h-add');
      if (btn) btn.click();
    }
  });

  function focusAmount() {
    var a = document.getElementById('h-avg');
    if (a) a.focus();
  }

  function openSheet(term) {
    var t = D.glossary[term];
    if (!t) return;
    document.getElementById('sheet-title').textContent = term;
    document.getElementById('sheet-text').innerHTML = t;
    document.getElementById('sheet').hidden = false;
  }

  /* ══════════════════════════════════════════════════════════════════
     접근 코드 게이트
     ------------------------------------------------------------------
     보안이 아니라 문패다(config.js 설명 참고). 통과하면 이 브라우저에
     기억해서 다음부터 묻지 않는다.
     ══════════════════════════════════════════════════════════════ */
  function startApp() {
    document.getElementById('gate').hidden = true;
    document.getElementById('app').hidden = false;
    render();
  }

  function initGate() {
    var g = CFG && CFG.gate;
    if (!g || !g.enabled || load('pass', '') === g.hash) { startApp(); return; }

    var gate = document.getElementById('gate');
    var input = document.getElementById('gate-input');
    var err = document.getElementById('gate-err');
    document.getElementById('gate-hint').textContent = g.hint;
    gate.hidden = false;
    document.getElementById('app').hidden = true;
    setTimeout(function () { input.focus(); }, 100);

    function tryPass() {
      if (window.BCHash(input.value.trim()) === g.hash) {
        save('pass', g.hash);
        startApp();
      } else {
        err.hidden = false;
        input.value = '';
        input.focus();
      }
    }
    document.getElementById('gate-go').addEventListener('click', tryPass);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') tryPass(); });
    input.addEventListener('input', function () { err.hidden = true; });
  }

  loadLive();
  loadPrices();
  /* 브라우저가 직접 받을 수 있는지 한 번 해 본다. 되면 크론과 무관하게
     열 때마다 최신값이 되고, 안 되면 조용히 스냅샷만 쓴다(§33). */
  if (window.Promise) setTimeout(function () { directQuotes(state.market); }, 300);
  /* 들고 있는 종목이 있으면 해설도 받아 둔다 — 유니버스 밖 종목의 판정이
     여기서 나온다(scoreOfIn). 아무것도 등록 안 한 사람은 안 받는다. */
  if (needPrices()) loadAnalysis();
  /* 켜 둔 채로도 스냅샷이 계속 들어오게 한다. 새 스냅샷이 오면 render() 가
     다시 돌고, render() 는 simAutoTick() 으로 시작하므로 모의계좌도 같이
     따라 움직인다 — 앱을 열어 둔 동안에는 그게 "계속 거래한다"의 실체다. */
  startLivePolling();
  initGate();
})();
