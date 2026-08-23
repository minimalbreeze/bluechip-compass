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
    /* 시장마다 따로 센다 — 국내를 확인했다고 미장까지 최신인 건 아니다. */
    touched: (function () {
      var t = load('touched', null);
      if (typeof t === 'string') return { kr: t, us: t };   // 예전 단일 값 형식 이관
      return t && typeof t === 'object' ? t : { kr: null, us: null };
    })(),
    style:   load('style', 'balanced'),
    regime:  load('regime', { kr: copy(M.defaults.kr), us: copy(M.defaults.us) }),
    profile: load('profile', { seed: 1000, fx: 1350 }),
    filter:  'all'
  };

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
     뷰 1 — 오늘 (홈): 그래서 뭘 얼마나 사면 되나
     ══════════════════════════════════════════════════════════════ */
  function renderToday() {
    var mk = market(), st = regime(), p = state.profile;
    var reg = M.labelRegime(st);
    var tilt = M.tilt(st);
    var pf = P.build(state.market, state.style, tilt.cash);
    var style = null;
    P.styles.forEach(function (s) { if (s.key === state.style) style = s; });

    var now = today();
    var touched = state.touched[state.market];
    var age = touched ? daysSince(touched) : null;
    var h = [];

    /* ── 오늘 헤더 ── */
    h.push('<div class="todaybar">' +
      '<div class="todaybar-d">' + (now.getMonth() + 1) + '월 ' + now.getDate() + '일 ' + WEEK[now.getDay()] + '요일</div>' +
      '<div class="todaybar-r">' + reg.emoji + ' ' + reg.name + '</div>' +
    '</div>');

    /* 시장 확인 신선도 — 이 앱에서 "매일 달라지는" 근거는 이것뿐이다.
       며칠 지났는지 숨기지 않는다. */
    if (age === null) {
      h.push('<button class="freshcta" data-go="market">⚠️ ' + mk.flag + ' <b>' + mk.label + ' — 아직 확인하지 않았습니다.</b> 1분이면 오늘 기준으로 다시 계산됩니다 →</button>');
    } else if (age >= 3) {
      h.push('<button class="freshcta" data-go="market">🕐 ' + mk.flag + ' ' + mk.label + ' — 확인한 지 <b>' + age + '일</b> 지났습니다. 다시 맞추기 →</button>');
    } else {
      h.push('<div class="freshok">✅ ' + mk.flag + ' ' + mk.label + ' — ' + (age === 0 ? '오늘' : age + '일 전') + ' 확인한 값 기준</div>');
    }

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
            (hd.t ? '<span class="al-t">' + hd.t + '</span>' : '<span class="al-k">' + (hd.k === 'etf' ? 'ETF' : '현금') + '</span>') +
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

    /* ── 오늘의 점검 ── */
    var chk = DAILY[dayOfYear(now) % DAILY.length];
    h.push('<div class="daily"><div class="daily-h">🗓️ 오늘의 점검 한 가지</div>' +
      '<div class="daily-t">' + chk.i + ' ' + chk.t + '</div>' +
      '<div class="daily-d">' + linkTerms(chk.d) + '</div></div>');

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

    h.push('<div class="sec" style="margin-top:22px"><div class="sec-head"><h2>🧺 지수 ETF</h2>' +
      '<p>개별 종목을 고르는 건 나중 문제입니다. 하나로 수백 개 회사에 분산됩니다.</p></div><div class="card">');
    mk.etfs.forEach(function (e) {
      h.push('<div class="etf"><div class="etf-kind">' + e.kind + '</div><div>' +
        '<div class="etf-n">' + e.name + '</div><div class="etf-o">' + linkTerms(e.one) + '</div>' +
        '<div class="etf-note">' + linkTerms(e.note) + '</div></div></div>');
    });
    h.push('</div></div>');

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
      h.push('</div><div class="dial-where">');
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

    h.push('<div class="sec"><button class="btn" data-go="today">홈에서 제안 다시 보기 →</button></div>');
    return h.join('');
  }

  /* ══════════════════════════════════════════════════════════════════
     뷰 4 — 배우기
     ══════════════════════════════════════════════════════════════ */
  function renderLearn() {
    var h = [];
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
  var VIEWS = { today: renderToday, picks: renderPicks, market: renderMarket, learn: renderLearn };
  var current = 'today';

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
    if ((el = ev.target.closest('.dial-opt'))) {
      state.regime[state.market][el.dataset.dial] = el.dataset.val;
      save('regime', state.regime);
      state.touched[state.market] = ymd(today());
      save('touched', state.touched);
      render(); return;
    }
    if ((el = ev.target.closest('.chip'))) { state.filter = el.dataset.filter; render(); return; }
    if ((el = ev.target.closest('.stock-head'))) {
      el.closest('.stock').classList.toggle('is-open'); return;
    }
    if ((el = ev.target.closest('.term'))) { openSheet(el.dataset.term); return; }
    if (ev.target.closest('[data-close]'))  { document.getElementById('sheet').hidden = true; return; }

    if (ev.target.id === 'reset') {
      ['market', 'style', 'regime', 'profile', 'touched'].forEach(function (k) {
        try { localStorage.removeItem(KEY + k); } catch (e) {}
      });
      state.market = 'kr';
      state.style = 'balanced';
      state.regime = { kr: copy(M.defaults.kr), us: copy(M.defaults.us) };
      state.touched = { kr: null, us: null };
      state.profile = { seed: 1000, fx: 1350 };
      Object.keys(VIEWS).forEach(function (v) { document.getElementById('view-' + v).innerHTML = ''; });
      go('today');
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
  });
  document.addEventListener('change', function (ev) {
    if (ev.target.id === 'seed' || ev.target.id === 'fxrate') render();
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

  initGate();
})();
