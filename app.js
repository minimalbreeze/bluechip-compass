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
    profile: load('profile', { seed: 1000, fx: 1350 }),
    /* 보유 종목은 시장별로 따로 둔다 — 국내 계좌와 해외 계좌는 다른 지갑이다. */
    holdings: load('holdings', { kr: [], us: [] }),
    cash:     load('cash', { kr: 0, us: 0 }),
    filter:  'all',
    learnTab: 'picks'
  };
  ['kr', 'us'].forEach(function (mk) {
    if (!state.holdings[mk]) state.holdings[mk] = [];
    if (typeof state.cash[mk] !== 'number') state.cash[mk] = 0;
  });

  /* 저장본에 새 다이얼이 빠져 있을 수 있으니 기본값으로 메운다. */
  ['kr', 'us'].forEach(function (mk) {
    if (!state.regime[mk]) state.regime[mk] = copy(M.defaults[mk]);
    M.dials.forEach(function (d) {
      if (!state.regime[mk][d.key]) state.regime[mk][d.key] = M.defaults[mk][d.key];
    });
  });

  function market() { return D.markets[state.market]; }
  function regime() { return state.regime[state.market]; }

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
    var d = manwon * 10000 / state.profile.fx;
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
  function findPick(name) {
    var n = norm(name), hit = null;
    market().picks.forEach(function (p) {
      if (hit) return;
      if (norm(p.name) === n || norm(p.korName) === n || norm(p.ticker) === n) hit = p;
    });
    return hit;
  }
  function scoreOfItem(it) {
    var p = it.ticker ? null : findPick(it.name);
    if (it.ticker) {
      market().picks.forEach(function (q) { if (q.ticker === it.ticker) p = q; });
    }
    return p ? total(p.scores) : null;
  }

  /* 지금 성향·국면에서의 목표 구성 */
  function modelNow() {
    return P.build(state.market, state.style, M.tilt(regime()).cash).holdings;
  }
  function analyzeNow() {
    return H.analyze({
      items: state.holdings[state.market],
      cash: state.cash[state.market],
      model: modelNow(),
      scoreOf: scoreOfItem
    });
  }

  /* 손익 표기. 부호와 절제된 색까지만 쓴다 — 배경색·큰 강조는 쓰지 않는다.
     화면이 등락에 반응하기 시작하면 이 앱의 목적(감정 매매 줄이기)과 충돌한다. */
  function plClass(v) { return v > 0 ? 'pl-up' : v < 0 ? 'pl-dn' : 'pl-flat'; }
  function signPct(v) { return (v > 0 ? '+' : '') + v.toFixed(1) + '%'; }
  function signWon(manwon) {
    return (manwon > 0 ? '+' : manwon < 0 ? '−' : '') + won(Math.abs(manwon));
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

  function loadLive() {
    if (!window.fetch) return;
    /* 캐시를 우회해야 갱신된 스냅샷이 바로 보인다. */
    fetch('live.json?t=' + Math.floor(Date.now() / 60000), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.quotes) return;
        LIVE = j;
        /* 이미 그려진 화면이 있으면 다시 그린다 */
        if (document.getElementById('view-' + current) &&
            document.getElementById('view-' + current).innerHTML) render();
      })
      .catch(function () { /* 없으면 없는 대로 — 링크만 보여준다 */ });
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
    { i: '📝', t: '보유 종목 하나를 골라 "왜 샀는지" 세 문장으로 적어보세요', d: '적어두면 나중에 팔지 말지를 그 메모가 대신 판단해줍니다.' },
    { i: '🔕', t: '증권사 앱 푸시 알림을 꺼보세요', d: '확인 빈도를 줄이는 것만으로 불필요한 매매가 크게 줍니다.' },
    { i: '🏦', t: '비상금이 생활비 3~6개월치 있는지 확인하세요', d: '이게 없으면 하락장에서 주식을 팔아 생활비를 만들게 됩니다.' },
    { i: '🧾', t: '지금 쓰는 계좌가 ISA·연금저축인지 일반계좌인지 확인하세요', d: '같은 종목이라도 어느 계좌에 담느냐로 실수령액이 달라집니다.' },
    { i: '📉', t: '내 포트폴리오가 반토막 났다고 상상해보세요', d: '그때 팔 것 같으면 지금 성향을 한 단계 낮추는 게 맞습니다.' },
    { i: '🧺', t: '보유 종목들이 같이 빠지는 종목인지 확인하세요', d: '종목 수가 많아도 같은 업종이면 분산이 아닙니다.' },
    { i: '💱', t: '증권사 환전 우대율을 한 번 비교해보세요', d: '장기 적립이면 우대율이 매매 수수료보다 크게 작용합니다.' },
    { i: '📅', t: '자동이체 날짜가 월급날 다음 날로 걸려 있는지 보세요', d: '의지력을 쓰지 않게 만드는 게 핵심입니다.' },
    { i: '🗞️', t: '오늘 본 뉴스가 10년 뒤 이익을 바꾸는지 자문해보세요', d: '아니라면 오늘 할 일은 없습니다. 대부분의 뉴스가 그렇습니다.' },
    { i: '⚖️', t: '목표 비중에서 5%p 이상 벌어진 종목이 있는지 확인하세요', d: '있으면 되돌리고, 없으면 아무것도 하지 않습니다.' },
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
    var f = M.forces(st, state.market);
    var now = today();
    var touched = state.touched[state.market];
    var age = touched ? daysSince(touched) : null;
    var h = [];

    h.push('<div class="todaybar">' +
      '<div class="todaybar-d">' + (now.getMonth() + 1) + '월 ' + now.getDate() + '일 ' + WEEK[now.getDay()] + '요일</div>' +
      '<div class="todaybar-r">' + reg.emoji + ' ' + reg.name + '</div></div>');

    if (age === null) {
      h.push('<button class="freshcta" data-go="market">⚠️ ' + mk.flag + ' <b>' + mk.label + ' — 아직 확인하지 않았습니다.</b> 1분이면 아래 내용이 오늘 기준이 됩니다 →</button>');
    } else if (age >= 3) {
      h.push('<button class="freshcta" data-go="market">🕐 ' + mk.flag + ' ' + mk.label + ' — 확인한 지 <b>' + age + '일</b> 지났습니다. 다시 맞추기 →</button>');
    } else {
      h.push('<div class="freshok">✅ ' + mk.flag + ' ' + mk.label + ' — ' + (age === 0 ? '오늘' : age + '일 전') + ' 확인한 값 기준</div>');
    }

    /* ── 시장 ── */
    h.push('<div class="sec-head"><h2>📊 ' + mk.full + '</h2></div>');
    h.push('<div class="card"><div class="idxrow">');
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
    if (hasQuote && LIVE.asOf) {
      h.push('<div class="idxnote">🕒 <b>' + agoText(LIVE.asOf) + '</b> 받아온 값입니다. ' +
        '실시간이 아니라 <b>30분마다 갱신되는 스냅샷</b>이고, 장 마감 뒤에는 마지막 종가가 그대로 유지됩니다. ' +
        '정확한 값은 지수를 눌러 확인하세요.</div>');
    } else {
      h.push('<div class="idxnote">시세를 아직 못 받아왔습니다. 지수를 누르면 바로 확인할 수 있습니다.</div>');
    }
    h.push('</div>');

    h.push('<div class="forces">');
    h.push('<div class="fcol up"><div class="fcol-h">▲ 밀어올리는 힘</div>' +
      (f.up.length
        ? f.up.map(function (x) { return '<div class="fitem">' + x.icon + ' ' + x.text + '</div>'; }).join('')
        : '<div class="fitem none">지금 확인한 값에서는 없습니다</div>') + '</div>');
    h.push('<div class="fcol down"><div class="fcol-h">▼ 눌러내리는 힘</div>' +
      (f.down.length
        ? f.down.map(function (x) { return '<div class="fitem">' + x.icon + ' ' + x.text + '</div>'; }).join('')
        : '<div class="fitem none">지금 확인한 값에서는 없습니다</div>') + '</div>');
    h.push('</div>');
    h.push('<div class="stepnote">이 요인들은 <b>' + mk.label + ' 시장 다이얼에서 도출</b>한 것입니다. 다이얼을 오늘 값으로 바꾸면 여기도 바뀝니다.</div>');

    /* ── 내 투자 현황 ── */
    var list = state.holdings[state.market];
    h.push('<div class="sec-head" style="margin-top:24px"><h2>💼 내 투자 현황</h2></div>');

    if (!list.length && !state.cash[state.market]) {
      h.push('<button class="emptycard" data-go="my">' +
        '<div class="empty-i">＋</div>' +
        '<div><div class="empty-t">보유 종목을 등록해보세요</div>' +
        '<div class="empty-d">증권사 앱에 있는 <b>매수금액</b>과 <b>수익률</b>만 옮겨 적으면 됩니다. ' +
        '팔지·둘지·더 살지 판단을 자리마다 붙여드립니다.</div></div></button>');
    } else {
      var a = analyzeNow();
      h.push('<div class="card sum">' +
        '<div class="sum-top"><span class="sum-l">총 평가금액</span>' +
        '<span class="sum-v">' + money(a.grand) + '</span></div>' +
        '<div class="sum-grid">' +
          '<div><span>투자 원금</span><b>' + won(a.totalCost) + '</b></div>' +
          '<div><span>평가 손익</span><b class="' + plClass(a.pl) + '">' + signWon(a.pl) + '</b></div>' +
          '<div><span>수익률</span><b class="' + plClass(a.pl) + '">' + signPct(a.plPct) + '</b></div>' +
        '</div>' +
        '<div class="sum-cash">현금 ' + a.cashWeight + '% <span>(목표 ' + a.cashTarget + '%)</span>' +
          (Math.abs(a.cashGap) > 5 ? ' · <b>' + (a.cashGap > 0 ? '목표보다 많습니다' : '목표보다 적습니다') + '</b>' : '') +
        '</div></div>');

      if (a.rows.length) {
        h.push('<div class="minilist">');
        a.rows.slice(0, 4).forEach(function (r) {
          h.push('<div class="mini"><span class="mini-m">' + r.verdict.mark + '</span>' +
            '<span class="mini-n">' + r.name + '</span>' +
            '<span class="mini-w">' + r.weight + '%</span>' +
            '<span class="mini-r ' + plClass(r.ret) + '">' + signPct(r.ret) + '</span></div>');
        });
        if (a.rows.length > 4) h.push('<div class="mini more">외 ' + (a.rows.length - 4) + '종목</div>');
        h.push('</div>');
      }
      h.push('<button class="btn" data-go="my" style="margin-top:10px">' +
        (a.alerts ? '⚠️ 점검할 자리 ' + a.alerts + '건 — 자세히 보기 →' : '종목별 판단 보기 →') + '</button>');
    }

    /* ── 오늘의 점검 ── */
    var chk = DAILY[dayOfYear(now) % DAILY.length];
    h.push('<div class="daily" style="margin-top:22px"><div class="daily-h">🗓️ 오늘의 점검 한 가지</div>' +
      '<div class="daily-t">' + chk.i + ' ' + chk.t + '</div>' +
      '<div class="daily-d">' + linkTerms(chk.d) + '</div></div>');

    h.push('<button class="btn ghost" data-go="plan">🎯 시드로 배분안 만들기 →</button>');

    h.push('<div class="foot"><b>고지.</b> 이 앱은 투자 교육 자료입니다. 특정 종목의 매수·매도를 권유하지 않으며 ' +
      '어떤 수익도 보장하지 않습니다. 손익은 사용자가 입력한 값으로 계산한 것이고, 이 앱은 시세를 조회하지 않습니다.</div>');

    return h.join('');
  }

  /* ══════════════════════════════════════════════════════════════════
     뷰 2 — 내 주식: 팔까 / 둘까 / 더 살까
     ------------------------------------------------------------------
     판단 근거는 "목표 비중 대비 어긋난 정도"와 "50년 점수"뿐이다.
     손익은 보여주기만 하고 판단에 쓰지 않는다 — 이유는 holdings.js 참고.
     ══════════════════════════════════════════════════════════════ */
  function renderMy() {
    var mk = market();
    var list = state.holdings[state.market];
    var a = analyzeNow();
    var h = [];

    h.push('<div class="sec-head"><h2>💼 ' + mk.flag + ' ' + mk.label + ' 보유 현황</h2>' +
      '<p>증권사 앱에 이미 보이는 <b>매수금액</b>과 <b>수익률</b>만 옮겨 적으면 됩니다. ' +
      '이 앱은 시세를 조회하지 않습니다.</p></div>');

    /* 입력 폼 */
    h.push('<div class="card addform">' +
      '<input id="h-name" list="bc-picks" placeholder="종목명 (예: 삼성전자)" autocomplete="off" />' +
      '<datalist id="bc-picks">' +
        mk.picks.map(function (p) { return '<option value="' + p.name + '"></option>'; }).join('') +
      '</datalist>' +
      '<div class="addrow">' +
        '<label>매수금액<input id="h-cost" type="number" inputmode="numeric" placeholder="만원" min="0" step="10" /></label>' +
        '<label>수익률<input id="h-ret" type="number" inputmode="decimal" placeholder="%" step="0.1" /></label>' +
      '</div>' +
      '<button class="btn" id="h-add">추가하기</button>' +
      '<div class="addnote">수익률은 부호까지 그대로 적으세요 (예: <b>-12.4</b>). 목록에 없는 종목도 직접 입력할 수 있습니다.</div>' +
    '</div>');

    h.push('<div class="card cashcard"><label>예수금·파킹<input id="h-cash" type="number" inputmode="numeric" ' +
      'value="' + state.cash[state.market] + '" min="0" step="10" /><span>만원</span></label>' +
      '<div class="addnote">현금도 배분의 한 자리입니다. 빼놓으면 비중이 전부 실제보다 커 보입니다.</div></div>');

    if (!list.length) {
      h.push('<div class="note" style="margin-top:14px">아직 등록된 종목이 없습니다. 위에서 하나만 넣어보세요.</div>');
      return h.join('');
    }

    /* 요약 */
    h.push('<div class="card sum" style="margin-top:16px">' +
      '<div class="sum-top"><span class="sum-l">총 평가금액</span><span class="sum-v">' + money(a.grand) + '</span></div>' +
      '<div class="sum-grid">' +
        '<div><span>투자 원금</span><b>' + won(a.totalCost) + '</b></div>' +
        '<div><span>평가 손익</span><b class="' + plClass(a.pl) + '">' + signWon(a.pl) + '</b></div>' +
        '<div><span>수익률</span><b class="' + plClass(a.pl) + '">' + signPct(a.plPct) + '</b></div>' +
      '</div>' +
      '<div class="sum-cash">현금 ' + a.cashWeight + '% <span>(목표 ' + a.cashTarget + '%)</span></div></div>');

    /* 종목별 판단 */
    h.push('<div class="sec-head" style="margin-top:20px"><h2>🔍 자리마다 판단</h2>' +
      '<p>지금 성향(<b>' + styleLabel() + '</b>)과 오늘 국면 기준입니다. 성향이나 다이얼을 바꾸면 판단도 바뀝니다.</p></div>');

    a.rows.forEach(function (r) {
      h.push('<div class="card hrow tone-' + r.verdict.tone + '">' +
        '<div class="hrow-top">' +
          '<span class="hrow-m">' + r.verdict.mark + '</span>' +
          '<span class="hrow-n">' + r.name + (r.ticker ? '<span class="hrow-t">' + r.ticker + '</span>' : '') + '</span>' +
          '<span class="hrow-v">' + r.verdict.label + '</span>' +
        '</div>' +
        '<div class="hrow-nums">' +
          '<span>평가 <b>' + won(r.value) + '</b></span>' +
          '<span>수익률 <b class="' + plClass(r.ret) + '">' + signPct(r.ret) + '</b></span>' +
        '</div>' +
        '<div class="wbar"><span class="wbar-t" style="width:' + Math.min(100, r.weight) + '%"></span>' +
          (r.target ? '<span class="wbar-goal" style="left:' + Math.min(100, r.target) + '%"></span>' : '') + '</div>' +
        '<div class="wlab">현재 <b>' + r.weight + '%</b>' + (r.target ? ' · 목표 <b>' + r.target + '%</b>' : ' · 목표 없음') +
          (r.score !== null ? ' · 50년 점수 <b>' + r.score + '</b>' : '') + '</div>' +
        '<div class="hrow-say">' + linkTerms(r.verdict.say) + '</div>' +
        '<button class="hrow-del" data-del="' + r.id + '">삭제</button>' +
      '</div>');
    });

    /* 손익으로 판단하지 않게 붙잡아 두는 자리 */
    h.push('<div class="card" style="margin-top:16px"><div class="sb-h">팔지 말지 헷갈릴 때</div>' +
      '<div class="slot-d"><b>지금 손익은 판단 근거가 아닙니다.</b> 많이 떨어졌으니 팔아야 한다도, 많이 올랐으니 팔아야 한다도 둘 다 틀렸습니다. ' +
      '기준은 하나입니다 — <b>처음 산 이유가 아직 유효한가.</b> 아래 3개로 확인하세요.</div>');
    D.newsRules.forEach(function (r, i) {
      h.push('<div class="newsq"><div class="newsq-q">' + (i + 1) + '. ' + r.q + '</div>' +
        '<div class="newsq-a y">예 — ' + linkTerms(r.yes) + '</div>' +
        '<div class="newsq-a n">아니오 — ' + linkTerms(r.no) + '</div></div>');
    });
    h.push('</div>');

    h.push('<div class="foot"><b>고지.</b> 위 판단은 <b>목표 비중과의 차이</b>와 이 앱의 <b>정성 평가 점수</b>만으로 기계적으로 계산한 것입니다. ' +
      '시세·실적·여러분의 사정을 알지 못하며, 특정 종목의 매수·매도 권유가 아닙니다.</div>');

    return h.join('');
  }

  function styleLabel() {
    var l = state.style;
    P.styles.forEach(function (s) { if (s.key === state.style) l = s.label; });
    return l;
  }

  /* ══════════════════════════════════════════════════════════════════
     뷰 — 제안: 시드를 넣으면 뭘 얼마나 살지
     ══════════════════════════════════════════════════════════════ */
  function renderPlan() {
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
      h.push('<div class="seedfx">환율 <input type="number" id="fxrate" value="' + p.fx + '" min="800" max="2500" step="10" inputmode="numeric" /> 원/달러로 환산</div>');
    }
    h.push('<div class="stepnote">3년 안에 쓸 돈과 비상금(생활비 3~6개월치)은 <b>빼고</b> 넣으세요.</div></div>');

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

    h.push('<div class="foot"><b>고지.</b> 이 앱은 투자 교육 자료입니다. 위 목록은 정해진 규칙으로 계산된 <b>예시 배분</b>이며 ' +
      '특정 종목의 매수 권유가 아닙니다. 어떤 수익도 보장하지 않습니다. 나이·직업 안정성·부채·기존 자산에 따라 답은 달라집니다.</div>');

    return h.join('');
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
     뷰 3 — 시장 (다이얼 5개 + 국면 + 이번 달 행동)
     ══════════════════════════════════════════════════════════════ */
  function renderMarket() {
    var mk = market(), st = regime();
    var reg = M.labelRegime(st);
    var tilt = M.tilt(st);
    var h = [];

    var touched = state.touched[state.market];
    var base = touched || M.defaults.asOf;
    var age = daysSince(base);
    var cls = touched ? (age <= 3 ? 'ok' : age <= 14 ? 'old' : 'stale-bad') : 'stale-bad';
    h.push('<div class="stale ' + cls + '"><span>' + (cls === 'ok' ? '✅' : cls === 'old' ? '🕐' : '⚠️') + '</span><div>' +
      (touched
        ? '<b>' + base + '</b>에 직접 맞춘 값입니다 (' + age + '일 전).' + (age > 3 ? ' 정세는 빨리 바뀝니다 — 다시 확인해주세요.' : '')
        : '아직 <b>한 번도 확인하지 않았습니다.</b> 지금 값은 ' + M.defaults.asOf + ' 기준으로 미리 채워둔 출발점입니다. ' +
          '<b>1분만 들이면</b> 홈의 제안이 오늘 기준으로 다시 계산됩니다.') +
      '</div></div>');

    h.push('<div class="regime">' +
      '<div class="regime-eyebrow">' + mk.flag + ' ' + mk.full + ' · 지금의 국면</div>' +
      '<div class="regime-name">' + reg.emoji + ' ' + reg.name + '</div>' +
      '<div class="regime-full">' + reg.full + '</div>' +
      '<div class="regime-tilt">현금 비중 <b>' + (tilt.cash >= 0 ? '+' : '') + tilt.cash + '%p</b> 조정 중</div>' +
    '</div>');

    h.push('<div class="sec" style="margin-top:18px"><div class="sec-head"><h2>🎛️ 5개만 확인하세요</h2>' +
      '<p>각 항목의 링크에서 30초면 됩니다. 바꾸는 즉시 홈의 제안이 다시 계산됩니다.</p></div><div class="card">');
    M.dials.forEach(function (d) {
      h.push('<div class="dial"><div class="dial-q"><span>' + d.icon + '</span><span>' + d.title + '</span></div>' +
        '<div class="dial-why">' + linkTerms(d.why) + '</div><div class="dial-opts">');
      d.options.forEach(function (o) {
        h.push('<button class="dial-opt' + (st[d.key] === o.v ? ' is-on' : '') + '" data-dial="' + d.key + '" data-val="' + o.v + '">' +
          '<span class="o-l">' + o.label + '</span><span class="o-h">' + o.hint + '</span></button>');
      });
      h.push('</div>');
      /* 환율은 실제 값과 1년 범위 위치를 알면 감이 아니라 근거로 고를 수 있다. */
      if (d.key === 'fx' && LIVE && LIVE.fx && LIVE.quotes && LIVE.quotes['KRW=X']) {
        var cur = LIVE.quotes['KRW=X'].price, fxr = LIVE.fx;
        var want = fxr.pct >= 0.66 ? 'weak' : fxr.pct <= 0.33 ? 'strong' : 'neutral';
        var wantLabel = { weak: '원화 약세', neutral: '보통', strong: '원화 강세' }[want];
        h.push('<div class="dialhint">지금 <b>' + fmtNum(cur, '원') + '</b> · 최근 1년 ' +
          fmtNum(fxr.low52, '') + '~' + fmtNum(fxr.high52, '') + ' 중 <b>' + Math.round(fxr.pct * 100) + '% 지점</b>' +
          (st[d.key] === want ? ' — 지금 선택과 맞습니다.'
            : ' → <button class="dialapply" data-dial="' + d.key + '" data-val="' + want + '">‘' + wantLabel + '’으로 맞추기</button>'));
        h.push('</div>');
      }
      if (d.key === 'geo' && LIVE && LIVE.quotes && LIVE.quotes['^VIX']) {
        var vix = LIVE.quotes['^VIX'].price;
        h.push('<div class="dialhint">지금 VIX <b>' + vix.toFixed(1) + '</b> — ' +
          (vix >= 30 ? '30 이상은 <b>충격 발생</b> 구간으로 봅니다.'
           : vix >= 20 ? '20~30은 <b>긴장</b> 구간으로 봅니다.'
           : '20 미만은 대체로 <b>평온</b> 구간입니다.') + ' 다만 숫자 하나로 정하지 말고 헤드라인도 같이 보세요.</div>');
      }
      h.push('<div class="dial-where">');
      d.where.forEach(function (w) {
        if (w.for !== 'both' && w.for !== state.market) return;
        h.push('<a href="' + w.url + '" target="_blank" rel="noopener">' + w.label + ' ↗</a>');
      });
      h.push('</div></div>');
    });
    h.push('</div><div class="note">' + M.defaults.note + '</div></div>');

    h.push('<div class="sec"><div class="sec-head"><h2>🧠 이 국면이 뜻하는 것</h2></div><div class="card">');
    M.readings(st).forEach(function (r) {
      h.push('<div class="read-item"><div class="read-ico">' + r.icon + '</div><div>' +
        '<div class="read-choice">' + r.title + ' → ' + r.choice + '</div>' +
        '<div class="read-text">' + linkTerms(r.read) + '</div></div></div>');
    });
    h.push('</div></div>');

    h.push('<div class="sec"><div class="sec-head"><h2>✅ 이번 달에 할 일</h2>' +
      '<p>수익률을 바꾸는 건 종목 선택보다 이런 행동들입니다.</p></div><div class="card">');
    M.actions(st, state.market).forEach(function (a) {
      h.push('<div class="act"><div class="act-ico">' + a.icon + '</div><div>' +
        '<div class="act-t">' + a.t + '</div><div class="act-d">' + linkTerms(a.d) + '</div></div></div>');
    });
    h.push('</div></div>');

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

    h.push('<div class="sec"><div class="sec-head"><h2>🔭 방향이 거의 정해진 흐름</h2>' +
      '<p>다음 분기에 뭐가 오를지는 아무도 모릅니다. 10년 단위로 뒤집히기 어려운 흐름만 다룹니다.</p></div>');
    M.themes.forEach(function (t) {
      h.push('<div class="card"><div class="theme-h">' + t.icon + ' ' + t.title + '</div>' +
        '<div class="theme-b">' + linkTerms(t.body) + '</div>' +
        '<div class="theme-blue">🏛️ <b>블루칩으로 타는 법</b> — ' + linkTerms(t.blue) + '</div>' +
        '<div class="theme-c">⚠️ ' + linkTerms(t.caution) + '</div></div>');
    });
    h.push('</div>');

    h.push('<div class="sec"><div class="sec-head"><h2>🗞️ 이 뉴스에 팔아야 하나요?</h2></div><div class="card">');
    D.newsRules.forEach(function (r, i) {
      h.push('<div class="newsq"><div class="newsq-q">' + (i + 1) + '. ' + r.q + '</div>' +
        '<div class="newsq-a y">예 — ' + linkTerms(r.yes) + '</div>' +
        '<div class="newsq-a n">아니오 — ' + linkTerms(r.no) + '</div></div>');
    });
    h.push('<div class="note" style="margin-top:12px">셋 다 “아니오”라면 <b>오늘 할 일은 없습니다.</b></div></div></div>');

    h.push('<div class="sec"><div class="sec-head"><h2>🕳️ 가장 많이 빠지는 함정</h2></div>');
    D.mistakes.forEach(function (m) {
      h.push('<div class="card"><div class="mis-h">' + m.icon + ' ' + m.title + '</div>' +
        '<div class="mis-b">' + linkTerms(m.body) + '</div>' +
        '<div class="mis-f">→ ' + linkTerms(m.fix) + '</div></div>');
    });
    h.push('</div>');

    h.push('<div class="sec"><div class="sec-head"><h2>🗓️ 처음 3개월 로드맵</h2></div><div class="card">');
    D.roadmap.forEach(function (r) {
      h.push('<div class="road"><div class="road-w">' + r.when + '</div><div>' +
        '<div class="road-t">' + r.title + '</div>' +
        '<ul class="road-l">' + r.todo.map(function (t) { return '<li>' + linkTerms(t) + '</li>'; }).join('') + '</ul>' +
        '<div class="road-y">💡 ' + linkTerms(r.why) + '</div></div></div>');
    });
    h.push('</div></div>');

    h.push('<div class="sec"><div class="sec-head"><h2>🧾 ' + market().flag + ' 세금과 계좌</h2>' +
      '<p>' + tax.headline + '</p></div><div class="card"><div class="sb-h">세금 구조</div>');
    tax.items.forEach(function (i) {
      h.push('<div class="tax-row"><div class="tax-t">' + i.t + '</div><div class="tax-d">' + linkTerms(i.d) + '</div></div>');
    });
    h.push('<div class="sb-h">어느 계좌에 담을까</div>');
    tax.accounts.forEach(function (i) {
      h.push('<div class="tax-row"><div class="tax-t">' + i.t + '</div><div class="tax-d">' + linkTerms(i.d) + '</div></div>');
    });
    h.push('<div class="note" style="margin-top:12px">💡 ' + linkTerms(tax.tip) + '</div>' +
      '<div class="note" style="margin-top:8px;background:#fdf1ef;color:#9a3a31">⚠️ ' + D.tax.disclaimer + '</div></div></div>');

    h.push('<div class="sec"><div class="sec-head"><h2>📖 용어 사전</h2></div><div class="card">');
    Object.keys(D.glossary).forEach(function (k) {
      h.push('<div class="tax-row"><div class="tax-t">' + k + '</div><div class="tax-d">' + D.glossary[k] + '</div></div>');
    });
    h.push('</div></div>');

    h.push('<div class="sec"><div class="sec-head"><h2>🔁 기록 초기화</h2></div><div class="card">' +
      '<div class="slot-d">시드·성향·시장 다이얼을 처음 상태로 되돌립니다. 이 브라우저에 저장된 <b>이 앱의 값만</b> 지웁니다.</div>' +
      '<button class="btn danger" id="reset" style="margin-top:12px">기록 초기화</button></div></div>');

    h.push('<div class="foot"><b>고지.</b> 이 앱은 투자 교육 자료입니다. 특정 종목의 매수·매도를 권유하지 않으며 어떤 수익도 보장하지 않습니다. ' +
      '종목 점수는 공개된 사업 구조를 바탕으로 한 정성 평가이고 가격·실적 데이터가 아닙니다. 세법과 제도는 수시로 바뀌므로 반드시 ' +
      '국세청·증권사에서 확인하세요. 투자 판단과 그 결과는 전적으로 본인의 책임입니다.<br><br>' +
      '기본 시장 스냅샷 기준일: <b>' + M.defaults.asOf + '</b> · 저장은 이 브라우저에만 남고 서버로 전송되지 않습니다.</div>');

    return h.join('');
  }

  /* ══════════════════════════════════════════════════════════════════
     렌더 / 이벤트
     ══════════════════════════════════════════════════════════════ */
  var VIEWS = {
    home:   renderHome,
    my:     renderMy,
    plan:   renderPlan,
    market: renderMarket,
    learn:  renderLearn
  };
  var current = 'home';

  function render() {
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
    if ((el = ev.target.closest('[data-go]'))) { go(el.dataset.go); return; }

    if ((el = ev.target.closest('.seedchip'))) {
      state.profile.seed = parseInt(el.dataset.seed, 10);
      save('profile', state.profile); render(); return;
    }
    if ((el = ev.target.closest('.stylebtn'))) {
      state.style = el.dataset.style; save('style', state.style); render(); return;
    }
    if ((el = ev.target.closest('.dialapply'))) {
      state.regime[state.market][el.dataset.dial] = el.dataset.val;
      save('regime', state.regime);
      state.touched[state.market] = ymd(today());
      save('touched', state.touched);
      render();
      return;
    }
    if ((el = ev.target.closest('.dial-opt'))) {
      state.regime[state.market][el.dataset.dial] = el.dataset.val;
      save('regime', state.regime);
      state.touched[state.market] = ymd(today());
      save('touched', state.touched);
      render(); return;
    }
    if ((el = ev.target.closest('.subbtn'))) { state.learnTab = el.dataset.sub; render(); return; }
    if ((el = ev.target.closest('.chip'))) { state.filter = el.dataset.filter; render(); return; }
    if ((el = ev.target.closest('.stock-head'))) {
      el.closest('.stock').classList.toggle('is-open'); return;
    }
    if ((el = ev.target.closest('.term'))) { openSheet(el.dataset.term); return; }
    if (ev.target.closest('[data-close]'))  { document.getElementById('sheet').hidden = true; return; }

    if (ev.target.id === 'h-add') {
      var nameEl = document.getElementById('h-name');
      var costEl = document.getElementById('h-cost');
      var retEl  = document.getElementById('h-ret');
      var name = (nameEl.value || '').trim();
      var cost = parseFloat(costEl.value);
      if (!name)              { nameEl.focus(); return; }
      if (!(cost > 0))        { costEl.focus(); return; }
      var pick = findPick(name);
      state.holdings[state.market].push({
        id: Date.now() + Math.floor(Math.random() * 1000),
        name: pick ? pick.name : name,
        ticker: pick ? pick.ticker : '',
        cost: cost,
        ret: parseFloat(retEl.value) || 0
      });
      save('holdings', state.holdings);
      render();
      return;
    }
    if ((el = ev.target.closest('[data-del]'))) {
      var id = parseInt(el.dataset.del, 10);
      state.holdings[state.market] = state.holdings[state.market].filter(function (x) { return x.id !== id; });
      save('holdings', state.holdings);
      render();
      return;
    }

    if (ev.target.id === 'reset') {
      ['market', 'style', 'regime', 'profile', 'touched', 'holdings', 'cash'].forEach(function (k) {
        try { localStorage.removeItem(KEY + k); } catch (e) {}
      });
      state.market = 'kr';
      state.style = 'balanced';
      state.regime = { kr: copy(M.defaults.kr), us: copy(M.defaults.us) };
      state.touched = { kr: null, us: null };
      state.holdings = { kr: [], us: [] };
      state.cash = { kr: 0, us: 0 };
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
      if (f >= 800 && f <= 2500) { state.profile.fx = f; save('profile', state.profile); }
    }
    if (ev.target.id === 'h-cash') {
      var c = parseFloat(ev.target.value);
      state.cash[state.market] = c >= 0 ? c : 0;
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
    if (id === 'h-name' || id === 'h-cost' || id === 'h-ret') {
      ev.preventDefault();
      var btn = document.getElementById('h-add');
      if (btn) btn.click();
    }
  });

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
  initGate();
})();
