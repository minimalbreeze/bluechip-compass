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


  /* ══════════════════════════════════════════════════════════════════
     앱에서 바로 묻기 — 회원님 열쇠로, GitHub 를 거치지 않고
     ------------------------------------------------------------------
     GitHub 를 오가는 길은 안전하지만 번거롭다(영어 화면이 뜨고, 한 번 더
     눌러야 하고, 돌아와서 기다려야 한다). 회원님이 **자기 API 열쇠**를
     넣어두면 브라우저가 Anthropic 을 직접 불러서 그 자리에 답이 흐른다.

     ⚠️ 열쇠는 **이 브라우저에만** 저장된다(localStorage).
        저장소에도, 서버에도, 다른 누구에게도 가지 않는다. 나가는 곳은
        api.anthropic.com 한 군데뿐이다.
     ⚠️ 그래도 열쇠를 기기에 두는 건 위험이 0 은 아니다. 그래서
        **넣을지 말지는 회원님이 정한다** — 안 넣으면 예전처럼 GitHub 길로
        간다. 화면에도 그렇게 적는다.
     ══════════════════════════════════════════════════════════════ */
  var KKEY = 'bcc:akey';
  function myKey() { try { return localStorage.getItem(KKEY) || ''; } catch (e) { return ''; } }
  function setKey(v) {
    try { v ? localStorage.setItem(KKEY, v) : localStorage.removeItem(KKEY); } catch (e) {}
  }
  function hasKey() { return /^sk-/.test(myKey()); }

  /* 앱에서 바로 물은 답은 이슈 번호가 없다. 음수 번호를 붙여 같은 목록에
     같이 세운다 — 어디로 물었든 사용자에겐 "내가 한 질문"일 뿐이다. */
  function localList() {
    return (cache.mine || []).slice().reverse();
  }
  function pushMine(row) {
    cache.mine = (cache.mine || []).concat([row]).slice(-20);
    save();
  }

  var HDR = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    /* 브라우저에서 직접 부르려면 이 헤더가 있어야 한다. 이름 그대로 "위험"
       하다고 붙어 있는 이유는 **여러 사람이 쓰는 앱에 열쇠 하나를 심는**
       경우를 막으려는 것이다. 여기는 회원님이 자기 기기에 자기 열쇠를
       넣는 경우라 그 위험이 해당하지 않는다. */
    'anthropic-dangerous-direct-browser-access': 'true'
  };
  function keyHdr() { var h = {}; for (var k in HDR) h[k] = HDR[k]; h['x-api-key'] = myKey(); return h; }

  var running = null;   /* {q, text, phase} — 지금 흐르고 있는 답 */

  function askNow(q, ctx) {
    if (!hasKey()) return;
    var brain = window.BCAskBrain;
    if (!brain) return;
    running = { q: q, text: '', phase: '생각하는 중…' };
    onChange();

    var body = {
      model: brain.MODEL,
      max_tokens: 6000,
      system: brain.SYSTEM,
      thinking: { type: 'adaptive' },
      stream: true,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
      messages: [{ role: 'user', content: brain.buildContext(ctx.brainCtx(q)) }]
    };

    stream(body, function (chunk) {
      running.text += chunk;
      running.phase = '';
      onChange();
    }).then(function () {
      if (!running.text) throw new Error('답이 비어 있습니다');
      running.phase = '정리하는 중…'; onChange();
      return extractNow(running.text).catch(function () { return null; });
    }).then(function (meta) {
      var row = {
        n: -Date.now(), q: q, body: running.text,
        meta: meta, at: new Date().toISOString(), via: 'app'
      };
      pushMine(row);
      /* 방금 받은 답은 **펼친 채로** 둔다. 눈앞에서 흐르던 글이 다 쓰이자마자
         접혀 버리면 답이 사라진 것처럼 보인다. */
      cache['o' + row.n] = true;
      running = null;
      save();
      onChange();
    }).catch(function (e) {
      running = { q: q, text: running ? running.text : '', phase: '', err: keyErr(e) };
      onChange();
    });
  }

  function keyErr(e) {
    var m = String(e && e.message || e);
    if (/401|authentication|invalid x-api-key/i.test(m)) return '열쇠가 맞지 않습니다. 다시 넣어 주세요.';
    if (/credit|billing|402/i.test(m)) return '크레딧이 부족합니다. Anthropic 콘솔에서 확인해 주세요.';
    if (/429|rate/i.test(m)) return '요청이 몰렸습니다. 잠시 뒤 다시 눌러 주세요.';
    return '답을 만들지 못했습니다: ' + m;
  }

  /* SSE 를 손으로 읽는다. 라이브러리를 넣을 만한 일이 아니다.
     스트리밍을 쓰는 이유는 두 가지 — 답이 길어 한 번에 받으면 오래 걸리고,
     한 글자도 안 보이는 30초는 고장난 것처럼 느껴진다. */
  function stream(body, onText) {
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: keyHdr(), body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(r.status + ' ' + t.slice(0, 200)); });
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump() {
        return reader.read().then(function (res) {
          if (res.done) return;
          buf += dec.decode(res.value, { stream: true });
          var lines = buf.split('\n'); buf = lines.pop();
          lines.forEach(function (ln) {
            if (ln.indexOf('data:') !== 0) return;
            var d; try { d = JSON.parse(ln.slice(5).trim()); } catch (e) { return; }
            if (d.type === 'content_block_delta' && d.delta && d.delta.type === 'text_delta') onText(d.delta.text);
            if (d.type === 'error') throw new Error((d.error && d.error.message) || 'error');
          });
          return pump();
        });
      }
      return pump();
    });
  }

  /* 앱이 쓸 값(비율 등)만 따로 뽑는다. 글에서 정규식으로 긁으면 틀린다.
     여기서는 SDK 를 못 쓰니 도구(tool)로 모양을 강제한다. */
  function extractNow(answer) {
    var S = window.BCAskBrain.SHAPE;
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: keyHdr(), body: JSON.stringify({
        model: window.BCAskBrain.MODEL, max_tokens: 1500,
        system: window.BCAskBrain.EXTRACT_SYSTEM,
        tool_choice: { type: 'tool', name: 'record' },
        tools: [{
          name: 'record', description: '상담 답변에서 뽑은 값',
          input_schema: {
            type: 'object', properties: {
              verdict: { type: 'string', enum: ['core', 'satellite', 'watch', 'unsuited', 'general'], description: S.verdict },
              headline: { type: 'string', description: S.headline },
              pctLo: { type: 'number', description: S.pctLo },
              pctHi: { type: 'number', description: S.pctHi },
              checks: { type: 'array', items: { type: 'string' }, description: S.checks }
            },
            required: ['verdict', 'headline', 'pctLo', 'pctHi', 'checks']
          }
        }],
        messages: [{ role: 'user', content: answer }]
      })
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return null;
        var t = (j.content || []).filter(function (b) { return b.type === 'tool_use'; })[0];
        if (!t) return null;
        return { v: 1, verdict: t.input.verdict, headline: t.input.headline,
                 pct: [t.input.pctLo, t.input.pctHi], checks: t.input.checks };
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
      '<button class="btn" id="asksend">' +
        (hasKey() ? '질문하기 →' : '질문 보내기 →') + '</button>' +
      keyBoxHtml() +
      '<div class="ask-warn">답은 <b>“전체 투자금의 몇 %”</b>로 오고, ' +
      '금액 환산은 이 기기 안에서만 합니다. ' +
      (hasKey() ? '' : '질문은 <b>공개 저장소에 이슈로 남습니다</b> — ' +
        '금액·계좌번호처럼 남에게 보이면 안 되는 건 적지 마세요.') + '</div>' +
      /* 예전엔 "GitHub 화면이 열립니다"라고만 적었다. 그랬더니 영어 화면이
         떠서 "이게 맞나" 하고 멈추셨다. **무엇을 누르면 되는지**를 적는다.
         열쇠를 넣으신 분에게는 이 길 자체가 없으니 안 보여준다. */
      (hasKey() ? '' : '<div class="ask-how"><div class="ask-how-h">보내기를 누르면 이렇게 됩니다</div>' +
        '<div class="ask-step"><b>1</b><span>GitHub 라는 <b>영어 화면</b>이 열립니다. ' +
          '제목과 내용은 <b>이미 채워져 있습니다</b> — 고치실 필요 없습니다.</span></div>' +
        '<div class="ask-step"><b>2</b><span>맨 아래 <b class="ask-green">초록색 Create</b> 단추를 ' +
          '한 번 누르세요. 그게 전부입니다.</span></div>' +
        '<div class="ask-step"><b>3</b><span>이 앱으로 돌아오시면 ' +
          '<b>답이 올 때까지 알아서 확인합니다.</b> 보통 1~3분 걸립니다.</span></div>' +
      '</div>');

    if (running) h += runningHtml();

    if (autoWaiting()) {
      h += '<div class="ask-wait">⏳ <b>답을 기다리는 중입니다.</b> ' +
        '앱이 알아서 확인하고 있으니 이 화면을 그냥 두세요. ' +
        '(보통 1~3분, 남은 확인 ' + left + '회)</div>';
    }

    h += '<div class="ask-listh"><span>지난 질문과 답</span>' +
      '<button class="quietbtn" id="askre">' +
      (st === 'loading' ? '불러오는 중…' : '새로 확인') + '</button></div>';

    /* 앱에서 바로 물은 것과 GitHub 로 물은 것을 **한 목록**에 세운다.
       사용자에겐 어느 길로 갔든 "내가 한 질문"일 뿐이다. */
    var mine = localList(), rows = [];
    mine.forEach(function (m) { rows.push(mineRowHtml(m, ctx)); });
    if (list && list.length) rows = rows.concat(list.map(function (i) { return rowHtml(i, ctx); }));

    if (!rows.length) {
      h += '<div class="ask-note">' + (
        st === 'loading' ? '불러오는 중…'
        : st === 'failed' ? esc(err)
        : '아직 물어본 게 없습니다.') + '</div>';
    } else {
      h += rows.join('');
      if (st === 'failed') h += '<div class="ask-note">' + esc(err) + '</div>';
    }
    return h + '</div>';
  }

  /* ── 열쇠 넣는 칸 ───────────────────────────────────────────
     기본은 접혀 있다. 대부분은 열쇠가 뭔지도 모르시고, 몰라도 GitHub 길로
     쓸 수 있다. "번거롭다"고 느끼신 분에게만 보이면 된다. */
  function keyBoxHtml() {
    var on = hasKey();
    if (!cache.keyOpen) {
      return '<button class="ask-keytoggle" id="askkeyt">' +
        (on ? '🔑 앱에서 바로 답받는 중 · 설정 보기'
            : '⚡ GitHub 없이 앱에서 바로 답받기') + '</button>';
    }
    return '<div class="ask-key">' +
      '<div class="ask-key-h">⚡ 앱에서 바로 답받기</div>' +
      '<div class="ask-key-b">Anthropic <b>API 열쇠</b>를 넣으면 GitHub 를 거치지 않고 ' +
        '<b>이 화면에서 바로</b> 답이 흐릅니다.</div>' +
      '<div class="ask-key-b"><b>열쇠는 이 브라우저에만 저장됩니다.</b> ' +
        '저장소에도, 서버에도, 저에게도 가지 않습니다 — 나가는 곳은 ' +
        'api.anthropic.com 한 군데뿐입니다.</div>' +
      '<div class="ask-key-b">다만 기기에 열쇠를 두는 건 위험이 0 은 아닙니다. ' +
        '<b>이 앱 전용 열쇠를 따로 하나 만들어</b> 넣으시길 권합니다 — 그래야 ' +
        '나중에 그것만 폐기해도 카톡 알림·종목 해설은 계속 돕니다.</div>' +
      '<input id="askkey" type="password" autocomplete="off" spellcheck="false" ' +
        'placeholder="sk-ant-... 붙여넣기" value="' + esc(myKey()) + '" />' +
      '<div class="ask-key-row">' +
        '<button class="btn ghost" id="askkeysave">저장</button>' +
        (on ? '<button class="btn ghost" id="askkeydel">지우기</button>' : '') +
      '</div>' +
      '<div class="ask-key-n">' + (on
        ? '✅ 넣어 두셨습니다. 이제 질문하면 바로 답이 옵니다.'
        : '비워 두시면 예전처럼 GitHub 를 거쳐 답을 받습니다 — 그것도 잘 됩니다.') +
      '</div>' +
      '<button class="ask-keytoggle" id="askkeyt">닫기</button>' +
    '</div>';
  }

  /* 지금 흐르고 있는 답 */
  function runningHtml() {
    if (running.err) {
      return '<div class="ask-run err"><div class="ask-run-h">⚠️ ' + esc(running.err) + '</div>' +
        '<button class="quietbtn" id="askclear">닫기</button></div>';
    }
    return '<div class="ask-run">' +
      '<div class="ask-run-h">' + esc(running.q) + '</div>' +
      (running.phase ? '<div class="ask-run-p">' + esc(running.phase) + '</div>' : '') +
      (running.text ? '<div class="ask-a">' + md(running.text) + '</div>' : '') +
    '</div>';
  }

  /* 앱에서 바로 물어본 것 한 줄 */
  function mineRowHtml(m, ctx) {
    var open = !!cache['o' + m.n];
    var h = '<div class="ask-item' + (open ? ' is-open' : '') + '">' +
      '<button class="ask-q" data-askq="' + m.n + '">' +
      '<span class="ask-qt">' + esc(m.q) + '</span>' +
      '<span class="ask-st done">답 도착</span></button>';
    if (open) {
      h += '<div class="ask-a">' + md(m.body) + amtHtml(m.meta, ctx) +
        '<div class="ask-foot">이 답은 <b>참고 자료</b>이지 매수·매도 권유가 아닙니다. ' +
        '손실이 날 수 있고, 판단과 그 결과는 본인에게 있습니다.</div></div>';
    }
    return h + '</div>';
  }

  /* 비율로 온 답을 이 기기에서만 금액으로 바꿔 준다.
     이 계산의 입력(시드)은 브라우저 밖으로 나간 적이 없다. */
  function amtHtml(m, ctx) {
    if (!m || !m.pct || !ctx.seed || !(m.pct[1] > 0)) return '';
    var lo = Math.round(ctx.seed * m.pct[0] / 100), hi = Math.round(ctx.seed * m.pct[1] / 100);
    return '<div class="ask-amt"><div class="ask-amt-h">🧮 회원님 시드로 바꾸면</div>' +
      '<div class="ask-amt-v">' + (lo > 0 && lo !== hi ? ctx.won(lo) + ' ~ ' : '') +
      ctx.won(hi) + (lo > 0 && lo !== hi ? '' : '까지') + '</div>' +
      '<div class="ask-amt-n">전체 투자금의 ' +
      (m.pct[0] !== m.pct[1] ? m.pct[0] + '~' + m.pct[1] : m.pct[1]) + '% 입니다. ' +
      '이 계산은 <b>회원님 기기 안에서만</b> 했습니다 — 금액은 어디에도 보내지 않았습니다.</div></div>';
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
      h += '<div class="ask-a">' + md(stripMeta(got.body)) + amtHtml(metaOf(got.body), ctx);
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
    if (t.closest && t.closest('#askkeyt')) { cache.keyOpen = !cache.keyOpen; save(); onChange(); return true; }
    if (t.closest && t.closest('#askkeysave')) {
      var inp = document.getElementById('askkey');
      var v = inp ? inp.value.trim() : '';
      /* 열쇠는 저장 전에 모양만 본다. 맞는지는 실제로 물어봐야 안다 —
         확인만 하려고 요청을 한 번 더 쓰지 않는다. */
      if (v && !/^sk-/.test(v)) { alert('열쇠는 보통 sk-ant- 로 시작합니다. 다시 확인해 주세요.'); return true; }
      setKey(v); cache.keyOpen = false; save(); onChange(); return true;
    }
    if (t.closest && t.closest('#askkeydel')) { setKey(''); save(); onChange(); return true; }
    if (t.closest && t.closest('#askclear')) { running = null; onChange(); return true; }

    if (t.id === 'asksend' || (t.closest && t.closest('#asksend'))) {
      var ta = document.getElementById('askq');
      var q = ta ? ta.value.trim() : '';
      if (!q) { if (ta) ta.focus(); return true; }
      cache.draft = ''; save();
      /* 열쇠가 있으면 GitHub 를 거치지 않는다 — 그 자리에서 답이 흐른다. */
      if (hasKey()) { if (ta) ta.value = ''; askNow(q, ctx); return true; }
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
    /* 열쇠는 draft 처럼 흘려 저장하지 않는다. 저장 단추를 눌러야 들어간다. */
    if (t && t.id === 'askkey') return true;
    return false;
  }

  return {
    on: ON, html: html, load: load, click: click, input: input, stopAuto: stopAuto,
    hasKey: hasKey,
    onChange: function (f) { onChange = f; }
  };
})();
