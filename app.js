/* ============================================================================
   app.js — 블루칩 나침반 화면 로직
   ----------------------------------------------------------------------------
   구조:
     state  ─ 시장(국내/미장), 국면 다이얼, 나의 성향, 필터. localStorage에 저장.
     render ─ 상태가 바뀌면 해당 뷰만 다시 그린다. 프레임워크 없음(빌드 도구 없음).

   저장은 전부 `bcc:` 접두사를 쓰고 이 브라우저에만 남는다. 서버로 보내지 않는다.
   ========================================================================== */

(function () {
  'use strict';

  var D = window.BCData;
  var M = window.BCMarket;
  var KEY = 'bcc:';

  /* ── 저장 ──────────────────────────────────────────────────────── */
  function load(k, fallback) {
    try {
      var raw = localStorage.getItem(KEY + k);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function save(k, v) {
    try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) {}
  }

  var state = {
    market:  load('market', 'kr'),
    regime:  load('regime', { kr: copy(M.defaults.kr), us: copy(M.defaults.us) }),
    profile: load('profile', { horizon: 1, drawdown: 1, monthly: 30, fx: 1350 }),
    filter:  'all'
  };
  function copy(o) { var r = {}; for (var k in o) r[k] = o[k]; return r; }

  /* 저장된 국면에 새 다이얼이 추가됐을 수 있으니 빠진 키를 기본값으로 메운다. */
  ['kr', 'us'].forEach(function (mk) {
    if (!state.regime[mk]) state.regime[mk] = copy(M.defaults[mk]);
    M.dials.forEach(function (d) {
      if (!state.regime[mk][d.key]) state.regime[mk][d.key] = M.defaults[mk][d.key];
    });
  });

  function market() { return D.markets[state.market]; }
  function regime() { return state.regime[state.market]; }

  /* ── 용어 자동 링크 ────────────────────────────────────────────
     본문에 나오는 어려운 단어에 점선 밑줄을 달아 탭하면 설명이 뜨게 한다.
     초보자가 모르는 단어에서 멈추고 나가버리는 걸 막는 장치.
     태그 안(<b class="...">)은 건드리면 안 되므로 태그와 텍스트를 나눠
     텍스트 조각에서만, 블록당 용어별 1회만 치환한다.                */
  var TERMS = Object.keys(D.glossary).sort(function (a, b) { return b.length - a.length; });
  function linkTerms(html) {
    if (!html) return '';
    var used = {};
    return html.split(/(<[^>]*>)/).map(function (part) {
      if (part.charAt(0) === '<') return part;          // 태그는 그대로
      TERMS.forEach(function (t) {
        if (used[t]) return;
        var i = part.indexOf(t);
        if (i < 0) return;
        used[t] = true;
        part = part.slice(0, i) +
               '<button class="term" data-term="' + t + '">' + t + '</button>' +
               part.slice(i + t.length);
      });
      return part;
    }).join('');
  }

  /* ── 숫자 표기 ─────────────────────────────────────────────────── */
  function won(manwon) {
    if (manwon >= 10000) return (manwon / 10000).toFixed(manwon % 10000 ? 1 : 0) + '억';
    return Math.round(manwon).toLocaleString('ko-KR') + '만원';
  }
  function slice(manwon, pct) { return manwon * pct / 100; }
  function usd(manwon) {
    var d = manwon * 10000 / state.profile.fx;
    /* 10달러 미만에서만 소수 한 자리. $20.0 같은 어색한 표기를 막는다. */
    return '$' + (d < 10 ? d.toFixed(1) : Math.round(d).toLocaleString('en-US'));
  }
  function money(manwon) {
    var t = won(manwon);
    return state.market === 'us' ? t + ' (≈' + usd(manwon) + ')' : t;
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

  /* ── 기준일 경과 ───────────────────────────────────────────────── */
  function daysSince(iso) {
    var then = new Date(iso + 'T00:00:00');
    return Math.max(0, Math.floor((Date.now() - then.getTime()) / 86400000));
  }
  function touched() { return load('touched', null); }

  /* ==========================================================================
     뷰 1 — 진단 (오늘의 시장 국면 + 나의 성향)
     ====================================================================== */
  function renderDiagnose() {
    var mk = market(), st = regime();
    var reg = M.labelRegime(st);
    var alloc = allocation();
    var h = [];

    /* 기준일 신선도 — 정적 사이트의 최대 약점을 숨기지 않고 크게 드러낸다. */
    var t = touched();
    var base = t || M.defaults.asOf;
    var age = daysSince(base);
    var cls = t ? (age <= 14 ? 'ok' : age <= 45 ? 'old' : 'stale-bad')
                : (age <= 14 ? 'old' : 'stale-bad');
    h.push('<div class="stale ' + cls + '">' +
      '<span>' + (cls === 'ok' ? '✅' : cls === 'old' ? '🕐' : '⚠️') + '</span><div>' +
      (t
        ? '<b>' + base + '</b>에 직접 맞춘 값입니다 (' + age + '일 전).' +
          (age > 14 ? ' 정세는 빨리 바뀝니다 — 아래 다이얼을 다시 확인해주세요.' : '')
        : '아직 <b>한 번도 확인하지 않았습니다.</b> 지금 보이는 값은 ' + M.defaults.asOf +
          ' 기준으로 미리 채워둔 출발점입니다(' + age + '일 전). ' +
          '<b>1분만 들여 오늘 값으로 맞추면</b> 아래 모든 결과가 오늘 기준으로 다시 계산됩니다.') +
      '</div></div>');

    /* 국면 카드 */
    h.push('<div class="regime">' +
      '<div class="regime-eyebrow">' + mk.flag + ' ' + mk.full + ' · 지금의 국면</div>' +
      '<div class="regime-name">' + reg.emoji + ' ' + reg.name + '</div>' +
      '<div class="regime-full">' + reg.full + '</div>' +
      '<div class="regime-mix">' +
        '<div><span>코어</span><b>' + alloc.core + '%</b></div>' +
        '<div><span>위성</span><b>' + alloc.sat + '%</b></div>' +
        '<div><span>현금</span><b>' + alloc.cash + '%</b></div>' +
      '</div></div>');

    /* 다이얼 */
    h.push('<div class="sec" style="margin-top:20px">' +
      '<div class="sec-head"><h2>🎛️ 오늘의 시장을 5개만 확인하세요</h2>' +
      '<p>각 항목의 링크에서 30초면 확인됩니다. 바꾸는 즉시 위 국면과 배분이 다시 계산됩니다.</p></div>' +
      '<div class="card">');

    M.dials.forEach(function (d) {
      h.push('<div class="dial"><div class="dial-q"><span>' + d.icon + '</span><span>' + d.title + '</span></div>' +
        '<div class="dial-why">' + linkTerms(d.why) + '</div><div class="dial-opts">');
      d.options.forEach(function (o) {
        h.push('<button class="dial-opt' + (st[d.key] === o.v ? ' is-on' : '') +
          '" data-dial="' + d.key + '" data-val="' + o.v + '">' +
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

    /* 판정 근거 */
    h.push('<div class="sec"><div class="sec-head"><h2>🧠 이 국면이 뜻하는 것</h2>' +
      '<p>결론만 주지 않습니다. 각 선택이 왜 그런 결론으로 이어지는지 같이 봅니다.</p></div><div class="card">');
    M.readings(st).forEach(function (r) {
      h.push('<div class="read-item"><div class="read-ico">' + r.icon + '</div><div>' +
        '<div class="read-choice">' + r.title + ' → ' + r.choice + '</div>' +
        '<div class="read-text">' + linkTerms(r.read) + '</div></div></div>');
    });
    h.push('</div></div>');

    /* 이번 달 행동 */
    h.push('<div class="sec"><div class="sec-head"><h2>✅ 이번 달에 할 일</h2>' +
      '<p>수익률을 바꾸는 건 종목 선택보다 이런 행동들입니다.</p></div><div class="card">');
    M.actions(st, state.market).forEach(function (a) {
      h.push('<div class="act"><div class="act-ico">' + a.icon + '</div><div>' +
        '<div class="act-t">' + a.t + '</div><div class="act-d">' + linkTerms(a.d) + '</div></div></div>');
    });
    h.push('</div></div>');

    /* 나의 성향 3문항 */
    var p = state.profile;
    h.push('<div class="sec"><div class="sec-head"><h2>🙋 나는 어떤 투자자인가요</h2>' +
      '<p>3개만 답하면 됩니다. 시장 국면과 합쳐 비중을 계산합니다.</p></div><div class="card">');

    h.push(q('돈을 언제까지 안 써도 되나요?', '가장 중요한 질문입니다. 쓸 날이 정해진 돈은 투자금이 아닙니다.',
      'horizon', p.horizon, [
        { l: '3년 안', s: '주식 비중 최소' }, { l: '3~10년', s: '표준' }, { l: '10년 이상', s: '가장 유리' }
      ]));
    h.push(q('내 돈이 반토막 나면?', '실제로 겪었을 때를 상상해보세요. 설문보다 정직하게 답할수록 계획이 무너지지 않습니다.',
      'drawdown', p.drawdown, [
        { l: '못 견딤', s: '-10%도 불안' }, { l: '버팀', s: '-30%까지' }, { l: '더 삼', s: '-50%도 기회' }
      ]));

    h.push('<div class="q"><div class="q-t">매달 넣을 수 있는 금액</div>' +
      '<div class="q-h">비상금(3~6개월 생활비)을 뺀 뒤 남는 돈으로만 정하세요.</div>' +
      '<div class="money-row"><input type="range" id="monthly" min="5" max="300" step="5" value="' + p.monthly + '" />' +
      '<span class="money-val" id="monthly-v">' + money(p.monthly) + '</span></div>');
    if (state.market === 'us') {
      h.push('<div class="q-h" style="margin-top:8px">환율 <input type="number" id="fxrate" value="' + p.fx +
        '" min="800" max="2500" step="10" style="width:78px;padding:4px 6px;border:1px solid var(--line);border-radius:7px" /> 원/달러 기준으로 환산합니다.</div>');
    }
    h.push('</div>');

    if (p.horizon === 0) {
      h.push('<div class="note" style="background:#fdf2f1;color:#8d3f3c">⚠️ <b>3년 안에 쓸 돈이라면 주식 비중을 크게 두지 마세요.</b> ' +
        '하필 그때가 하락장이면 손실을 확정하고 팔아야 합니다. 이 경우 아래 계산은 참고만 하고, 예금·파킹 상품을 먼저 고려하세요.</div>');
    }
    h.push('</div></div>');

    h.push('<div class="sec"><button class="btn" data-go="plan">내 비중 계산 결과 보기 →</button></div>');

    return h.join('');
  }

  function q(title, hint, key, val, opts) {
    var h = '<div class="q"><div class="q-t">' + title + '</div><div class="q-h">' + hint + '</div>' +
            '<div class="q-opts c3">';
    opts.forEach(function (o, i) {
      h += '<button class="q-opt' + (val === i ? ' is-on' : '') + '" data-q="' + key + '" data-i="' + i + '">' +
           o.l + '<small>' + o.s + '</small></button>';
    });
    return h + '</div></div>';
  }

  /* ==========================================================================
     배분 계산 — 성향(기본값) + 국면(조정)
     ====================================================================== */
  function allocation() {
    var p = state.profile;
    var risk = p.horizon + p.drawdown;            // 0~4
    var BASE = [
      { core: 50, sat: 0,  cash: 50 },
      { core: 60, sat: 3,  cash: 37 },
      { core: 70, sat: 6,  cash: 24 },
      { core: 76, sat: 10, cash: 14 },
      { core: 78, sat: 14, cash: 8  }
    ];
    var b = BASE[Math.max(0, Math.min(4, risk))];
    var t = M.tilt(regime());

    var cash = Math.max(3, Math.min(60, b.cash + t.cash));
    var sat  = Math.max(0, Math.min(20, b.sat  + t.sat));
    var core = 100 - cash - sat;
    if (core < 35) { cash = Math.min(cash, 100 - 35 - sat); core = 100 - cash - sat; }

    return { core: Math.round(core), sat: Math.round(sat), cash: Math.round(cash), risk: risk, tilt: t };
  }

  /* ==========================================================================
     뷰 2 — 종목 (50년 생존 카드)
     ====================================================================== */
  var FILTERS = [
    { v: 'all',       l: '전체' },
    { v: 'core',      l: '코어 후보' },
    { v: 'income',    l: '배당 중심' },
    { v: 'satellite', l: '위성(변동 큼)' },
    { v: 'score',     l: '점수순' }
  ];

  function renderPicks() {
    var mk = market();
    var h = [];

    h.push('<div class="sec-head"><h2>' + mk.flag + ' ' + mk.full + ' · 50년 생존 카드</h2>' +
      '<p>“얼마나 오를까”가 아니라 <b>“50년 뒤에도 있을까”</b>만 봅니다. 6개 축을 0~5로 평가한 정성 점수입니다.</p></div>');

    h.push('<div class="card" style="padding:13px 15px"><div style="font-size:13.5px;color:var(--ink-mid)">' +
      D.axes.map(function (a) {
        return '<div style="padding:3px 0"><b>' + a.icon + ' ' + a.label + '</b> — ' + a.ask + '</div>';
      }).join('') + '</div></div>');

    h.push('<div class="filters">');
    FILTERS.forEach(function (f) {
      h.push('<button class="chip' + (state.filter === f.v ? ' is-on' : '') + '" data-filter="' + f.v + '">' + f.l + '</button>');
    });
    h.push('</div>');

    var list = mk.picks.slice();
    if (state.filter === 'score') list.sort(function (a, b) { return total(b.scores) - total(a.scores); });
    else if (state.filter !== 'all') list = list.filter(function (s) { return s.tag === state.filter; });

    if (!list.length) h.push('<div class="note">이 조건에 해당하는 종목이 없습니다.</div>');

    list.forEach(function (s, idx) {
      var pct = total(s.scores), g = grade(pct);
      var tagLabel = { core: '코어', income: '배당', satellite: '위성' }[s.tag];
      h.push('<div class="card stock" data-stock="' + idx + '">' +
        '<div class="stock-top">' +
          '<div class="grade"><span class="grade-c">' + g.code + '</span><span class="grade-s">' + pct + '</span></div>' +
          '<div class="stock-id"><div class="stock-name">' + s.name +
            '<span class="tagpill ' + s.tag + '">' + tagLabel + '</span></div>' +
            '<div class="stock-meta">' + s.ticker + (s.korName ? ' · ' + s.korName : '') + ' · ' + s.sector + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="stock-one">' + linkTerms(s.one) + '</div>' +
        '<div class="bars">' + D.axes.map(function (a) {
          var v = s.scores[a.key];
          return '<div class="bar"><span class="bar-l">' + a.icon + ' ' + a.label + '</span>' +
                 '<span class="bar-t"><span class="bar-f" style="width:' + (v / 5 * 100) + '%"></span></span>' +
                 '<span class="bar-v">' + v + '</span></div>';
        }).join('') + '</div>' +
        '<button class="stock-more">자세히 보기 ▾</button>' +
        '<div class="stock-body">' +
          '<div class="sb-h">등급 ' + g.code + ' · ' + g.label + '</div>' +
          '<div style="font-size:13.5px;color:var(--ink-mid)">' + g.desc + '</div>' +
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

    /* ETF */
    h.push('<div class="sec" style="margin-top:26px"><div class="sec-head"><h2>🧺 먼저 이걸로 시작해도 됩니다</h2>' +
      '<p>개별 종목을 고르는 건 나중 문제입니다. 지수 ETF 하나면 수백 개 회사에 자동으로 분산됩니다.</p></div><div class="card">');
    mk.etfs.forEach(function (e) {
      h.push('<div class="etf"><div class="etf-kind">' + e.kind + '</div><div>' +
        '<div class="etf-n">' + e.name + '</div><div class="etf-o">' + linkTerms(e.one) + '</div>' +
        '<div class="etf-note">' + linkTerms(e.note) + '</div></div></div>');
    });
    h.push('</div></div>');

    /* 원자료 출처 */
    h.push('<div class="sec"><div class="sec-head"><h2>🔎 숫자는 여기서 직접 확인하세요</h2>' +
      '<p>이 사이트는 <b>가격·실적 숫자를 담지 않습니다.</b> 정적 사이트라 넣는 순간 낡기 때문입니다.</p></div><div class="card">');
    mk.sources.forEach(function (s) {
      h.push('<div class="src"><a href="' + s.url + '" target="_blank" rel="noopener">' + s.name + ' ↗</a>' +
        '<span class="src-w">' + s.what + '</span></div>');
    });
    h.push('</div></div>');

    return h.join('');
  }

  /* ==========================================================================
     뷰 3 — 내 배분
     ====================================================================== */
  function renderPlan() {
    var mk = market(), a = allocation(), p = state.profile;
    var reg = M.labelRegime(regime());
    var h = [];

    h.push('<div class="sec-head"><h2>🥧 ' + mk.flag + ' ' + mk.full + ' 배분안</h2>' +
      '<p>성향(' + ['매우 보수', '보수', '중립', '적극', '매우 적극'][a.risk] + ') × 국면(' + reg.name + ')으로 계산했습니다.</p></div>');

    var c1 = 'var(--accent)', c2 = 'var(--coral)', c3 = '#c9d8d2';
    var e1 = a.core, e2 = a.core + a.sat;
    h.push('<div class="card"><div class="pie-wrap">' +
      '<div class="pie" style="background:conic-gradient(' + c1 + ' 0 ' + e1 + '%,' + c2 + ' ' + e1 + '% ' + e2 + '%,' + c3 + ' ' + e2 + '% 100%)"></div>' +
      '<div class="pie-legend">' +
        leg(c1, '코어', a.core, p.monthly) +
        leg(c2, '위성', a.sat, p.monthly) +
        leg(c3, '현금', a.cash, p.monthly) +
      '</div></div>' +
      '<div class="note" style="margin-top:14px">매달 <b>' + money(p.monthly) + '</b>을 위 비율로 나눠 넣는다는 뜻입니다. ' +
      '한 번에 몰아넣는 게 아니라 <b>매달 같은 날 반복</b>합니다.</div></div>');

    /* 국면 조정 설명 — 왜 이 숫자가 나왔는지 */
    if (a.tilt.cash !== 0 || a.tilt.sat !== 0) {
      h.push('<div class="card"><div class="sb-h">국면 조정</div><div style="font-size:13.5px;color:var(--ink-mid)">' +
        '내 성향만 봤다면 기본값이었을 배분에서, 오늘의 시장 국면 때문에 ' +
        '<b>현금 ' + (a.tilt.cash >= 0 ? '+' : '') + a.tilt.cash + '%p</b>, ' +
        '<b>위성 ' + (a.tilt.sat >= 0 ? '+' : '') + a.tilt.sat + '%p</b> 조정됐습니다. ' +
        '다이얼을 바꾸면 이 숫자도 바뀝니다.</div></div>');
    }

    /* 슬롯별 내용 */
    var isKR = state.market === 'kr';
    var coreEtf = isKR ? 'KODEX 200 / TIGER 200 (또는 국내상장 미국S&P500)' : 'VOO · VTI · VT 중 하나';
    var cashEtf = isKR ? 'KODEX 머니마켓액티브 / TIGER CD금리투자 / 파킹통장' : 'SGOV · BIL 또는 원화 파킹통장';
    var coreNames = mk.picks.filter(function (s) { return s.tag === 'core'; }).slice(0, 4).map(function (s) { return s.name; });
    var incNames  = mk.picks.filter(function (s) { return s.tag === 'income'; }).slice(0, 3).map(function (s) { return s.name; });
    var satNames  = mk.picks.filter(function (s) { return s.tag === 'satellite'; }).map(function (s) { return s.name; });

    h.push('<div class="sec"><div class="sec-head"><h2>📦 무엇으로 채우나</h2>' +
      '<p>같은 비중이라도 안을 무엇으로 채우는지가 결과를 가릅니다.</p></div>');

    h.push('<div class="card">' +
      slot('🧱 코어', a.core, p.monthly,
        '흔들려도 팔지 않을 뼈대. <b>이 안의 절반 이상을 지수 ETF로</b> 두면 개별 종목 판단이 틀려도 계획이 무너지지 않습니다.',
        ['지수 ETF (' + coreEtf + ') — 코어의 50~70%',
         '대형 우량주 2~4개 — ' + coreNames.join(', '),
         '배당 중심을 섞고 싶다면 — ' + incNames.join(', ')]) +
      slot('🚀 위성', a.sat, p.monthly,
        '전부 잃어도 계획이 안 무너질 만큼만. 여기서 재미를 보려다 코어를 건드리는 게 가장 흔한 사고입니다.',
        satNames.length ? ['변동이 큰 종목 1~2개 — ' + satNames.join(', '),
          '한 종목이 전체의 10%를 넘지 않게 유지']
          : ['위성 비중이 0%입니다 — 지금은 코어와 현금만으로 충분합니다.']) +
      slot('💰 현금·대기', a.cash, p.monthly,
        '“아무것도 안 하는 돈”이 아니라 <b>다음 급락에서 쓸 실탄</b>입니다. 그냥 두지 말고 이자가 붙는 곳에 둡니다.',
        [cashEtf, '급락(고점 대비 -20% 이상) 시 정해둔 규칙대로 코어에 투입']) +
      '</div></div>');

    /* 실행 규칙 */
    h.push('<div class="sec"><div class="sec-head"><h2>📏 지킬 규칙 4개</h2>' +
      '<p>규칙을 미리 정해두는 이유는 단 하나 — <b>급락장에서는 판단력이 남아 있지 않기 때문</b>입니다.</p></div><div class="card">' +
      rule('📅', '매달 같은 날 자동이체', '월급날 다음 날로 걸어두세요. 언제 살지 고민하는 순간부터 감정이 개입합니다.') +
      rule('🔕', '계좌 확인은 월 1회', '앱 알림을 끄고, 확인하는 날을 하루로 정합니다. 이것만으로 불필요한 매매가 크게 줍니다.') +
      rule('⚖️', '리밸런싱은 1년에 1~2회', '비중이 목표에서 <b>5%p 이상</b> 벌어졌을 때만 되돌립니다. 자동으로 “비싸게 팔고 싸게 사기”가 됩니다.') +
      rule('✍️', '살 때 이유를 세 문장으로', '메모해두면 나중에 팔지 말지를 그 메모가 대신 판단해줍니다. 못 적으면 안 사면 됩니다.') +
      '</div></div>');

    /* 3개월 로드맵 */
    h.push('<div class="sec"><div class="sec-head"><h2>🗓️ 처음 3개월 로드맵</h2>' +
      '<p>지금 당장 종목을 고르지 않아도 됩니다. 순서대로만 하세요.</p></div><div class="card">');
    D.roadmap.forEach(function (r) {
      h.push('<div class="road"><div class="road-w">' + r.when + '</div><div>' +
        '<div class="road-t">' + r.title + '</div>' +
        '<ul class="road-l">' + r.todo.map(function (t) { return '<li>' + linkTerms(t) + '</li>'; }).join('') + '</ul>' +
        '<div class="road-y">💡 ' + linkTerms(r.why) + '</div></div></div>');
    });
    h.push('</div></div>');

    h.push('<div class="note">이 배분은 <b>정해진 규칙에 따라 계산된 예시</b>이며, 특정 상품의 매수 권유가 아닙니다. ' +
      '같은 국면이어도 나이·직업 안정성·부채·기존 자산에 따라 답은 달라집니다.</div>');

    return h.join('');
  }

  function leg(color, name, pct, monthly) {
    return '<div class="leg"><i style="background:' + color + '"></i>' +
      '<span class="leg-n">' + name + '</span>' +
      '<span class="leg-p">' + pct + '%</span>' +
      '<span class="leg-m">' + won(slice(monthly, pct)) + '</span></div>';
  }
  function slot(title, pct, monthly, desc, items) {
    return '<div class="slot"><div class="slot-h"><b>' + title + '</b>' +
      '<span style="font-size:12px;color:var(--ink-dim)">' + money(slice(monthly, pct)) + ' / 월</span>' +
      '<span class="slot-p">' + pct + '%</span></div>' +
      '<div class="slot-d">' + linkTerms(desc) + '</div>' +
      '<ul class="slot-list">' + items.map(function (i) { return '<li>' + linkTerms(i) + '</li>'; }).join('') + '</ul></div>';
  }
  function rule(ico, t, d) {
    return '<div class="act"><div class="act-ico">' + ico + '</div><div>' +
      '<div class="act-t">' + t + '</div><div class="act-d">' + linkTerms(d) + '</div></div></div>';
  }

  /* ==========================================================================
     뷰 4 — 배우기
     ====================================================================== */
  function renderLearn() {
    var h = [];
    var tax = D.tax[state.market];

    h.push('<div class="sec"><div class="sec-head"><h2>🔭 향후 10년, 방향이 거의 정해진 흐름</h2>' +
      '<p>다음 분기에 뭐가 오를지는 아무도 모릅니다. 대신 10년 단위로 뒤집히기 어려운 흐름은 있습니다. ' +
      '<b>테마주 대신 블루칩으로 그 흐름을 타는 법</b>을 같이 적었습니다.</p></div>');
    M.themes.forEach(function (t) {
      h.push('<div class="card"><div class="theme-h">' + t.icon + ' ' + t.title + '</div>' +
        '<div class="theme-b">' + linkTerms(t.body) + '</div>' +
        '<div class="theme-blue">🏛️ <b>블루칩으로 타는 법</b> — ' + linkTerms(t.blue) + '</div>' +
        '<div class="theme-c">⚠️ ' + linkTerms(t.caution) + '</div></div>');
    });
    h.push('</div>');

    h.push('<div class="sec"><div class="sec-head"><h2>🗞️ 이 뉴스에 팔아야 하나요?</h2>' +
      '<p>초보자가 가장 자주 하는 질문입니다. 3개만 물어보면 대부분 답이 나옵니다.</p></div><div class="card">');
    D.newsRules.forEach(function (r, i) {
      h.push('<div class="newsq"><div class="newsq-q">' + (i + 1) + '. ' + r.q + '</div>' +
        '<div class="newsq-a y">예 — ' + linkTerms(r.yes) + '</div>' +
        '<div class="newsq-a n">아니오 — ' + linkTerms(r.no) + '</div></div>');
    });
    h.push('<div class="note" style="margin-top:12px">셋 다 “아니오”라면 <b>오늘 할 일은 없습니다.</b> ' +
      '대부분의 뉴스가 여기에 해당합니다.</div></div></div>');

    h.push('<div class="sec"><div class="sec-head"><h2>🕳️ 초보자가 가장 많이 빠지는 함정</h2>' +
      '<p>수익률을 깎는 건 종목 선택이 아니라 대부분 이 8가지입니다.</p></div>');
    D.mistakes.forEach(function (m) {
      h.push('<div class="card"><div class="mis-h">' + m.icon + ' ' + m.title + '</div>' +
        '<div class="mis-b">' + linkTerms(m.body) + '</div>' +
        '<div class="mis-f">→ ' + linkTerms(m.fix) + '</div></div>');
    });
    h.push('</div>');

    h.push('<div class="sec"><div class="sec-head"><h2>🧾 ' + market().flag + ' 세금과 계좌</h2>' +
      '<p>' + tax.headline + '</p></div>' +
      '<div class="card"><div class="sb-h">세금 구조</div>');
    tax.items.forEach(function (i) {
      h.push('<div class="tax-row"><div class="tax-t">' + i.t + '</div><div class="tax-d">' + linkTerms(i.d) + '</div></div>');
    });
    h.push('<div class="sb-h">어느 계좌에 담을까</div>');
    tax.accounts.forEach(function (i) {
      h.push('<div class="tax-row"><div class="tax-t">' + i.t + '</div><div class="tax-d">' + linkTerms(i.d) + '</div></div>');
    });
    h.push('<div class="note" style="margin-top:12px">💡 ' + linkTerms(tax.tip) + '</div>' +
      '<div class="note" style="margin-top:8px;background:#fdf2f1;color:#8d3f3c">⚠️ ' + D.tax.disclaimer + '</div>' +
      '</div></div>');

    h.push('<div class="sec"><div class="sec-head"><h2>📖 용어 사전</h2>' +
      '<p>본문에 점선 밑줄이 그어진 단어는 어디서든 눌러 볼 수 있습니다.</p></div><div class="card">');
    Object.keys(D.glossary).forEach(function (k) {
      h.push('<div class="tax-row"><div class="tax-t">' + k + '</div><div class="tax-d">' + D.glossary[k] + '</div></div>');
    });
    h.push('</div></div>');

    h.push('<div class="sec"><div class="sec-head"><h2>🔁 값을 되돌리기</h2></div><div class="card">' +
      '<div class="slot-d">국면 다이얼과 성향을 처음 상태로 되돌립니다. 이 브라우저에 저장된 ' +
      '<b>이 앱의 값만</b> 지웁니다.</div>' +
      '<button class="btn danger" id="reset" style="margin-top:12px">기록 초기화</button></div></div>');

    h.push('<div class="foot"><b>고지.</b> 이 사이트는 투자 교육 자료입니다. 특정 종목의 매수·매도를 권유하지 않으며 ' +
      '어떤 수익도 보장하지 않습니다. 종목 점수는 공개된 사업 구조를 바탕으로 한 정성 평가이고, 가격·실적 데이터가 아닙니다. ' +
      '세법과 제도는 수시로 바뀌므로 반드시 국세청·증권사에서 확인하세요. 투자 판단과 그 결과는 전적으로 본인의 책임입니다.<br><br>' +
      '기본 시장 스냅샷 기준일: <b>' + M.defaults.asOf + '</b> · 저장은 이 브라우저에만 남고 서버로 전송되지 않습니다.</div>');

    return h.join('');
  }

  /* ==========================================================================
     렌더 / 이벤트
     ====================================================================== */
  var VIEWS = { diagnose: renderDiagnose, picks: renderPicks, plan: renderPlan, learn: renderLearn };
  var current = 'diagnose';

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

    /* 시장 전환 — 모든 화면이 그 시장 기준으로 다시 그려진다.
       탭은 그대로 유지한다: "같은 화면을 다른 시장으로" 비교하는 게 목적이라
       전환할 때마다 첫 탭으로 돌아가면 비교가 끊긴다. */
    if ((el = ev.target.closest('.ms-btn'))) {
      state.market = el.dataset.market;
      save('market', state.market);
      /* 숨은 뷰에 이전 시장의 DOM이 남지 않게 비운다. 다시 열릴 때 새로 그려진다. */
      Object.keys(VIEWS).forEach(function (v) {
        if (v !== current) document.getElementById('view-' + v).innerHTML = '';
      });
      render();
      return;
    }
    if ((el = ev.target.closest('.tab')))     { go(el.dataset.view); return; }
    if ((el = ev.target.closest('[data-go]'))) { go(el.dataset.go); return; }

    if ((el = ev.target.closest('.dial-opt'))) {
      state.regime[state.market][el.dataset.dial] = el.dataset.val;
      save('regime', state.regime);
      save('touched', new Date().toISOString().slice(0, 10));
      render(); return;
    }
    if ((el = ev.target.closest('.q-opt'))) {
      state.profile[el.dataset.q] = parseInt(el.dataset.i, 10);
      save('profile', state.profile); render(); return;
    }
    if ((el = ev.target.closest('.chip'))) {
      state.filter = el.dataset.filter; render(); return;
    }
    if ((el = ev.target.closest('.stock-more'))) {
      var card = el.closest('.stock');
      var open = card.classList.toggle('is-open');
      el.textContent = open ? '접기 ▴' : '자세히 보기 ▾';
      return;
    }
    if ((el = ev.target.closest('.term'))) { openSheet(el.dataset.term); return; }
    if (ev.target.closest('[data-close]'))  { document.getElementById('sheet').hidden = true; return; }

    if (ev.target.id === 'disclaimer-ok') {
      save('agreed', 1);
      document.getElementById('disclaimer').hidden = true;
      return;
    }
    if (ev.target.id === 'reset') {
      ['market', 'regime', 'profile', 'touched'].forEach(function (k) {
        try { localStorage.removeItem(KEY + k); } catch (e) {}
      });
      state.market = 'kr';
      state.regime = { kr: copy(M.defaults.kr), us: copy(M.defaults.us) };
      state.profile = { horizon: 1, drawdown: 1, monthly: 30, fx: 1350 };
      go('diagnose');
      return;
    }
  });

  /* 슬라이더는 드래그 중 즉시 반응해야 해서 input 이벤트로 따로 받는다.
     드래그마다 전체를 다시 그리면 슬라이더가 손가락에서 떨어지므로
     숫자만 갱신하고, 손을 뗄 때(change) 전체를 다시 그린다. */
  document.addEventListener('input', function (ev) {
    if (ev.target.id === 'monthly') {
      state.profile.monthly = parseInt(ev.target.value, 10);
      var v = document.getElementById('monthly-v');
      if (v) v.textContent = money(state.profile.monthly);
    }
    if (ev.target.id === 'fxrate') {
      var n = parseInt(ev.target.value, 10);
      if (n >= 800 && n <= 2500) state.profile.fx = n;
    }
  });
  document.addEventListener('change', function (ev) {
    if (ev.target.id === 'monthly' || ev.target.id === 'fxrate') {
      save('profile', state.profile);
      var v = document.getElementById('monthly-v');
      if (v) v.textContent = money(state.profile.monthly);
    }
  });

  function openSheet(term) {
    var t = D.glossary[term];
    if (!t) return;
    document.getElementById('sheet-title').textContent = term;
    document.getElementById('sheet-text').innerHTML = t;
    document.getElementById('sheet').hidden = false;
  }

  if (!load('agreed', 0)) document.getElementById('disclaimer').hidden = false;
  render();
})();
