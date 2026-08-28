/* ============================================================================
   ask.js — "AI에게 물어보기"
   ----------------------------------------------------------------------------
   이 앱은 빌드도 서버도 없는 정적 사이트다. 그래서 브라우저에서 AI 를 부를 수
   없다 — 키를 심으면 소스를 여는 사람 누구에게나 보인다. 대신 이렇게 돈다.

       앱에서 질문 작성 → GitHub 이슈로 열림 → 워크플로가 AI 로 답을 만들어
       댓글로 붙임 → 앱이 공개 GitHub API 로 그 댓글을 읽어 화면에 보여줌

   키는 GitHub 시크릿에만 있고 브라우저에는 없다.

   ⚠️ 이슈는 공개 저장소에 남는다. 그래서 **금액을 보내지 않는다.**
      보내는 건 시장·성향·(있으면) 종목·질문 글까지다. 답도 "전체 투자금의
      몇 %"로 오고, 원 단위 환산은 이 파일이 브라우저 안에서 한다.
      실제 투자금이 얼마인지는 저장소도, 답을 만든 AI 도 알지 못한다.

   ⚠️ 질문을 올리려면 GitHub 에 로그인돼 있어야 한다. 앱이 대신 올릴 수는
      없다 — 그러려면 쓰기 토큰을 브라우저에 둬야 하고, 그건 위의 이유로
      하지 않는다. 화면에도 그렇게 적는다.
   ========================================================================== */
window.BCAsk = (function () {
  'use strict';

  var CFG = (window.BCConfig && window.BCConfig.ask) || {};
  var ON  = !!(CFG.enabled && CFG.owner && CFG.repo);
  var API = 'https://api.github.com/repos/' + CFG.owner + '/' + CFG.repo;
  var WEB = 'https://github.com/' + CFG.owner + '/' + CFG.repo;
  var TAG = '[물어보기]';
  var KEY = 'bcc:ask';

  /* 받아 둔 답. 이슈 번호 → {body, at}. GitHub 비로그인 API 는 시간당
     60번이라 한 번 받은 답은 다시 받지 않는다. */
  var cache = (function () {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  })();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) {} }

  var list = null;          /* 이슈 목록 */
  var st = 'idle';          /* idle | loading | ready | failed */
  var err = '';
  var onChange = function () {};

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── 아주 작은 마크다운 ─────────────────────────────────────
     AI 답은 마크다운으로 온다. 라이브러리를 넣을 만한 일이 아니라서
     쓰는 것만 만든다. **반드시 먼저 이스케이프하고** 그 위에 태그를
     붙인다 — 순서가 바뀌면 답 안의 글자가 태그로 해석된다. */
  function md(src) {
    var out = [], buf = [];
    function flush() {
      if (!buf.length) return;
      out.push('<p>' + buf.join('<br>') + '</p>');
      buf = [];
    }
    var li = false;
    String(src || '').split('\n').forEach(function (raw) {
      var t = raw.replace(/\s+$/, '');
      var line = esc(t)
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
        .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
          '<a href="$2" target="_blank" rel="noopener">$1 ↗</a>');
      var h = /^(#{1,6})\s+(.*)$/.exec(t);
      var b = /^\s*[-*]\s+(.*)$/.exec(t);
      if (h) { flush(); if (li) { out.push('</ul>'); li = false; }
        out.push('<div class="ask-h">' + line.replace(/^#+\s*/, '') + '</div>'); return; }
      if (b) { flush(); if (!li) { out.push('<ul class="ask-ul">'); li = true; }
        out.push('<li>' + line.replace(/^\s*[-*]\s+/, '') + '</li>'); return; }
      if (!t) { flush(); if (li) { out.push('</ul>'); li = false; } return; }
      if (li) { out.push('</ul>'); li = false; }
      buf.push(line);
    });
    flush(); if (li) out.push('</ul>');
    return out.join('');
  }

  /* 답 끝에 붙은 <!--bcc {...} --> 는 앱이 쓸 값이다. 사람 눈에는 안 보인다. */
  function metaOf(body) {
    var m = /<!--bcc\s+([\s\S]*?)-->/.exec(body || '');
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }
  function stripMeta(body) { return String(body || '').replace(/<!--bcc[\s\S]*?-->/g, '').trim(); }

  /* ── GitHub 공개 API ────────────────────────────────────────
     토큰 없이 읽기만 한다. 시간당 60번이라 아껴 쓴다. */
  function get(path) {
    return fetch(API + path, {
      headers: { 'Accept': 'application/vnd.github+json' }, cache: 'no-store'
    }).then(function (r) {
      if (r.status === 403) throw new Error('rate');
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });
  }

  function load(force) {
    if (!ON) return;
    /* 한 번 부르고 나면 다시 부르지 않는다. 실패했을 때도 마찬가지다 —
       화면을 다시 그릴 때마다 재시도하면 GitHub 의 시간당 한도(비로그인
       60번)를 금방 다 쓴다. 다시 받는 건 "새로 확인"을 눌렀을 때와
       질문을 새로 올린 직후뿐이다. */
    if (st !== 'idle' && !force) return;
    st = 'loading'; err = ''; onChange();
    get('/issues?state=all&per_page=15&sort=created&direction=desc')
      .then(function (arr) {
        list = (arr || []).filter(function (i) {
          return !i.pull_request && String(i.title || '').indexOf(TAG) === 0;
        });
        /* 닫힌 이슈 = 답이 붙은 이슈. 아직 안 받아 둔 것만 받는다. */
        var need = list.filter(function (i) {
          return i.state === 'closed' && !cache[i.number];
        }).slice(0, 5);
        return Promise.all(need.map(function (i) {
          return get('/issues/' + i.number + '/comments?per_page=10')
            .then(function (cs) {
              var last = (cs || [])[cs.length - 1];
              if (last && last.body) {
                cache[i.number] = { body: last.body, at: last.created_at };
              }
            })
            .catch(function () {});
        }));
      })
      .then(function () { save(); st = 'ready'; onChange(); })
      .catch(function (e) {
        st = 'failed';
        err = e.message === 'rate'
          ? 'GitHub 가 잠시 요청을 막았습니다(시간당 한도). 조금 뒤 다시 눌러 보세요.'
          : '지난 질문을 불러오지 못했습니다.';
        onChange();
      });
  }

  /* ── 보낸 직후 자동 재확인 ──────────────────────────────────
     GitHub 비로그인 API 는 시간당 60번이다. 그래서 "계속 확인"이 아니라
     **횟수를 정해 놓고** 돈다: 20초 간격으로 최대 12번(약 4분). 답은 보통
     1~3분이면 온다. 그 안에 안 오면 멈추고 "새로 확인" 단추로 넘긴다 —
     사용자가 앱을 열어 둔 채 잊어버려도 요청이 계속 나가지 않게. */
  var timer = null, left = 0;
  var AUTO_EVERY = 20000, AUTO_MAX = 12;

  function autoWaiting() { return left > 0; }

  function autoCheck() {
    if (timer) return;
    left = AUTO_MAX;
    tick();
  }
  function stopAuto() { if (timer) { clearTimeout(timer); timer = null; } left = 0; }

  function tick() {
    timer = setTimeout(function () {
      timer = null;
      if (left <= 0) return;
      left--;
      /* 화면을 안 보고 있으면 세지 않는다 — 주머니 속에서 요청을 태우지 않는다 */
      if (document.hidden) { tick(); return; }
      var before = answered();
      load(true);
      /* load 가 끝나면 onChange 가 불린다. 거기서 새 답이 생겼는지 본다. */
      var check = setInterval(function () {
        if (st === 'loading') return;
        clearInterval(check);
        if (answered() > before) { stopAuto(); onChange(); return; }
        if (left > 0) tick(); else onChange();
      }, 500);
    }, AUTO_EVERY);
    onChange();
  }
  function answered() {
    return (list || []).filter(function (i) { return !!cache[i.number]; }).length;
  }

  /* ── 질문 보내기 ────────────────────────────────────────────
     앱이 대신 올릴 수 없다(위 주석 참고). GitHub 의 새 이슈 화면을
     **미리 채워서** 열어 준다. 사용자는 초록 버튼 한 번만 누르면 된다. */
  function issueUrl(q, ctx) {
    var title = TAG + ' ' + String(q).replace(/\s+/g, ' ').trim().slice(0, 60);
    var body = [
      '시장: ' + (ctx.mk === 'us' ? '미국(나스닥·S&P 500)' : '한국(코스피)'),
      '성향: ' + (ctx.style || '알 수 없음')
    ];
    if (ctx.stock && ctx.stock.t) body.push('종목: ' + ctx.stock.n + ' (' + ctx.stock.t + ')');
    body.push('', '질문:', String(q).trim(), '',
      '---', '블루칩 나침반 앱에서 보낸 질문입니다. 금액은 담기지 않습니다.');
    return WEB + '/issues/new?title=' + encodeURIComponent(title) +
      '&body=' + encodeURIComponent(body.join('\n'));
  }

  /* ── 화면 ───────────────────────────────────────────────────
     ctx = { mk, style, seed, stock:{n,t}|null, won:fn }
     seed 는 화면에 원 단위로 적기 위해서만 쓴다. 밖으로 나가지 않는다. */
  function html(ctx) {
    if (!ON) return '';
    /* 제목은 화면 쪽 sec-head 가 단다. 여기서 또 달면 같은 말이 두 번 나온다. */
    var h = '<div class="card ask">' +
      '<div class="ask-lead"><b>노후자금 기준</b>으로만 답합니다. ' +
      '단타(며칠 안의 등락·매수 타이밍) 질문에는 그렇게 말하고 답하지 않습니다.' +
      '</div>' +
      (ctx.stock && ctx.stock.n
        ? '<div class="ask-with">함께 보내는 종목 · <b>' + esc(ctx.stock.n) + '</b></div>' : '') +
      '<textarea id="askq" rows="4" placeholder="' +
      esc(ctx.stock && ctx.stock.n
        ? ctx.stock.n + ' 어떤가요? 좀 살까 하는데 요즘 상황이 어떤지, 노후자금으로는 어떤 자리이고 얼마나 담으면 될지 알려주세요'
        : '예) LG헬로비전 어떤가요? 좀 살까 하는데 요즘 상황이 어떤지, 노후자금으로는 어떤 자리이고 얼마나 담으면 될지 알려주세요') +
      '">' + esc(cache.draft || '') + '</textarea>' +
      '<button class="btn" id="asksend">질문 보내기 →</button>' +
      '<div class="ask-warn">질문은 <b>공개 저장소에 이슈로 남습니다.</b> ' +
      '금액·계좌번호처럼 남에게 보이면 안 되는 건 적지 마세요. ' +
      '답은 <b>“전체 투자금의 몇 %”</b>로 오고, 금액 환산은 이 기기 안에서만 합니다.</div>' +
      /* 예전엔 "GitHub 화면이 열립니다"라고만 적었다. 그랬더니 영어 화면이
         떠서 "이게 맞나" 하고 멈추셨다. **무엇을 누르면 되는지**를 적는다. */
      '<div class="ask-how"><div class="ask-how-h">보내기를 누르면 이렇게 됩니다</div>' +
        '<div class="ask-step"><b>1</b><span>GitHub 라는 <b>영어 화면</b>이 열립니다. ' +
          '제목과 내용은 <b>이미 채워져 있습니다</b> — 고치실 필요 없습니다.</span></div>' +
        '<div class="ask-step"><b>2</b><span>맨 아래 <b class="ask-green">초록색 Create</b> 단추를 ' +
          '한 번 누르세요. 그게 전부입니다.</span></div>' +
        '<div class="ask-step"><b>3</b><span>이 앱으로 돌아오시면 ' +
          '<b>답이 올 때까지 알아서 확인합니다.</b> 보통 1~3분 걸립니다.</span></div>' +
      '</div>';

    if (autoWaiting()) {
      h += '<div class="ask-wait">⏳ <b>답을 기다리는 중입니다.</b> ' +
        '앱이 알아서 확인하고 있으니 이 화면을 그냥 두세요. ' +
        '(보통 1~3분, 남은 확인 ' + left + '회)</div>';
    }

    h += '<div class="ask-listh"><span>지난 질문과 답</span>' +
      '<button class="quietbtn" id="askre">' +
      (st === 'loading' ? '불러오는 중…' : '새로 확인') + '</button></div>';

    if (st === 'failed') {
      h += '<div class="ask-note">' + esc(err) + '</div>';
    } else if (!list) {
      h += '<div class="ask-note">' + (st === 'loading' ? '불러오는 중…' : '아직 확인하지 않았습니다.') + '</div>';
    } else if (!list.length) {
      h += '<div class="ask-note">아직 물어본 게 없습니다.</div>';
    } else {
      h += list.map(function (i) { return rowHtml(i, ctx); }).join('');
    }
    return h + '</div>';
  }

  function rowHtml(i, ctx) {
    var q = String(i.title || '').replace(TAG, '').trim();
    var got = cache[i.number];
    var open = !!cache['o' + i.number];
    var h = '<div class="ask-item' + (open ? ' is-open' : '') + '">' +
      '<button class="ask-q" data-askq="' + i.number + '">' +
      '<span class="ask-qt">' + esc(q) + '</span>' +
      '<span class="ask-st ' + (got ? 'done' : 'wait') + '">' +
      (got ? '답 도착' : i.state === 'closed' ? '답 확인 중' : '기다리는 중') + '</span></button>';
    if (open && got) {
      var m = metaOf(got.body);
      h += '<div class="ask-a">' + md(stripMeta(got.body));
      /* 비율로 온 답을 이 기기에서만 금액으로 바꿔 준다.
         이 계산의 입력(시드)은 브라우저 밖으로 나간 적이 없다. */
      if (m && m.pct && ctx.seed && (m.pct[1] > 0)) {
        var lo = Math.round(ctx.seed * m.pct[0] / 100);
        var hi = Math.round(ctx.seed * m.pct[1] / 100);
        h += '<div class="ask-amt"><div class="ask-amt-h">🧮 회원님 시드로 바꾸면</div>' +
          '<div class="ask-amt-v">' + (lo > 0 && lo !== hi ? ctx.won(lo) + ' ~ ' : '') +
          ctx.won(hi) + (lo > 0 && lo !== hi ? '' : '까지') + '</div>' +
          '<div class="ask-amt-n">전체 투자금의 ' +
          (m.pct[0] !== m.pct[1] ? m.pct[0] + '~' + m.pct[1] : m.pct[1]) + '% 입니다. ' +
          '이 계산은 <b>회원님 기기 안에서만</b> 했습니다 — 금액은 어디에도 보내지 않았습니다.</div></div>';
      }
      h += '<div class="ask-foot">이 답은 <b>참고 자료</b>이지 매수·매도 권유가 아닙니다. ' +
        '손실이 날 수 있고, 판단과 그 결과는 본인에게 있습니다.</div></div>';
    } else if (open) {
      h += '<div class="ask-a"><div class="ask-note">아직 답이 붙지 않았습니다. ' +
        '보통 1~3분 걸립니다. 위 <b>새로 확인</b>을 눌러 보세요.</div></div>';
    }
    return h + '</div>';
  }

  /* ── 이 카드 안에서 일어난 클릭 처리. 처리했으면 true. ────────── */
  function click(t, ctx) {
    if (!ON) return false;
    if (t.id === 'asksend' || (t.closest && t.closest('#asksend'))) {
      var ta = document.getElementById('askq');
      var q = ta ? ta.value.trim() : '';
      if (!q) { if (ta) ta.focus(); return true; }
      cache.draft = ''; save();
      /* 보낸 시각을 적어 둔다. 돌아오셨을 때 앱이 알아서 답을 확인하는
         근거가 된다 — 직접 "새로 확인"을 누르게 두면, 답이 왔는데도
         안 온 줄 알고 앱을 닫으신다. */
      cache.sentAt = Date.now(); save();
      window.open(issueUrl(q, ctx), '_blank', 'noopener');
      st = 'idle';
      onChange();
      autoCheck();
      return true;
    }
    if (t.id === 'askre' || (t.closest && t.closest('#askre'))) { load(true); return true; }
    var qb = t.closest && t.closest('[data-askq]');
    if (qb) {
      var n = qb.getAttribute('data-askq');
      cache['o' + n] = !cache['o' + n];
      if (cache['o' + n] && !cache[n]) load(true);
      save(); onChange();
      return true;
    }
    return false;
  }

  /* 입력 중인 글은 다시 그려도 날아가지 않게 담아 둔다 */
  function input(t) {
    if (t && t.id === 'askq') { cache.draft = t.value; save(); return true; }
    return false;
  }

  return {
    on: ON, html: html, load: load, click: click, input: input, stopAuto: stopAuto,
    onChange: function (f) { onChange = f; }
  };
})();
