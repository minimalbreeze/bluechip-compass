/* ============================================================================
   ask.js — "물어보기". 궁금한 걸 적으면 그 자리에서 답이 흐른다.
   ----------------------------------------------------------------------------
   이 앱은 빌드도 서버도 없는 정적 사이트다. 그래서 AI 를 부를 열쇠를 앱이
   대신 갖고 있을 수 없다 — 소스에 심으면 누구에게나 보인다. 대신 **회원님이
   자기 열쇠를 한 번 넣으면** 브라우저가 Anthropic 을 직접 부른다.

   ⚠️ 열쇠는 **이 브라우저에만** 저장된다(localStorage `bcc:akey`).
      저장소에도, 서버에도, 다른 누구에게도 가지 않는다. 나가는 곳은
      api.anthropic.com 한 군데뿐이다.

   ⚠️ **금액을 보내지 않는다.** 보내는 건 성향·시장·(있으면) 종목·질문 글까지다.
      답도 "전체 투자금의 몇 %" 로 받고, 원 단위 환산은 이 파일이 브라우저
      안에서 한다. 이 규칙은 ask-brain.js 의 buildContext 가 애초에 금액을
      받지 않는 것으로 지켜진다.

   ── 없앤 것 두 가지 (다시 만들지 말 것) ──────────────────────
   1. **GitHub 길.** 질문을 이슈로 올리면 워크플로가 답을 댓글로 붙이고 앱이
      그걸 읽어 오는 길이 있었다. 열쇠가 필요 없다는 게 장점이었지만 영어
      화면으로 나갔다 오고 1~3분 기다려야 했다. "이걸 이렇게 받아야 하나,
      너무 번거롭다" — 맞는 말이라 통째로 걷어냈다.
   2. **길을 고르게 하는 단추.** 단추는 하나뿐이다. 사용자가 GitHub 이 뭔지
      알 이유도, 두 길 중 하나를 고를 이유도 없다.
   ========================================================================== */
window.BCAsk = (function () {
  'use strict';

  var ON = !!window.BCAskBrain;
  var KEY = 'bcc:ask';     /* 물어본 것과 받은 답 */
  var KKEY = 'bcc:akey';   /* 열쇠 */

  var cache = (function () {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  })();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) {} }

  var onChange = function () {};
  var running = null;   /* 지금 흐르고 있는 답 {q, text, phase, err} */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── 아주 작은 마크다운 ─────────────────────────────────────
     답은 마크다운으로 온다. 라이브러리를 넣을 만한 일이 아니라서 쓰는 것만
     만든다. **반드시 먼저 이스케이프하고** 그 위에 태그를 붙인다 — 순서가
     바뀌면 답 안의 글자가 태그로 해석된다. */
  function md(src) {
    var out = [], buf = [], li = false;
    function flush() { if (buf.length) { out.push('<p>' + buf.join('<br>') + '</p>'); buf = []; } }
    String(src || '').split('\n').forEach(function (raw) {
      var t = raw.replace(/\s+$/, '');
      var line = esc(t)
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
        .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
          '<a href="$2" target="_blank" rel="noopener">$1 ↗</a>');
      var h = /^(#{1,6})\s+/.test(t), b = /^\s*[-*]\s+/.test(t);
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

  /* ── 열쇠 ───────────────────────────────────────────────────── */
  function myKey() { try { return localStorage.getItem(KKEY) || ''; } catch (e) { return ''; } }
  function setKey(v) {
    try { v ? localStorage.setItem(KKEY, v) : localStorage.removeItem(KKEY); } catch (e) {}
  }
  function hasKey() { return /^sk-/.test(myKey()); }

  /* ── 물어본 것 보관 ─────────────────────────────────────────── */
  function localList() { return (cache.mine || []).slice().reverse(); }
  function pushMine(row) { cache.mine = (cache.mine || []).concat([row]).slice(-20); save(); }

  /* ── 화면 ───────────────────────────────────────────────────
     ctx = { mk, style, seed, stock:{n,t}|null, won:fn, brainCtx:fn }
     seed 는 답으로 온 비율을 이 기기에서 금액으로 적을 때만 쓴다. */
  function html(ctx) {
    if (!ON) return '';
    var h = '<div class="card ask">' +
      '<div class="ask-lead"><b>노후자금 기준</b>으로만 답합니다. ' +
      '단타(며칠 안의 등락·매수 타이밍) 질문에는 그렇게 말하고 답하지 않습니다.</div>' +
      (ctx.stock && ctx.stock.n
        ? '<div class="ask-with">함께 보내는 종목 · <b>' + esc(ctx.stock.n) + '</b></div>' : '') +
      /* ⚠️ 예시 질문을 적어 두지 않는다. 종목 이름을 예시로 적으면 그 종목을
         권하는 것처럼 읽히고, 예시가 있으면 그 틀 안에서만 묻게 된다. */
      '<textarea id="askq" rows="4" placeholder="궁금한 것을 적어 보세요">' +
        esc(cache.draft || '') + '</textarea>' +
      '<button class="btn" id="asksend">질문하기 →</button>' +
      keyBoxHtml() +
      '<div class="ask-warn">답은 <b>“전체 투자금의 몇 %”</b>로 옵니다. ' +
      '금액 환산은 <b>이 기기 안에서만</b> 하고, 회원님의 투자 금액은 어디에도 ' +
      '보내지 않습니다.</div>';

    if (running) h += runningHtml();

    var mine = localList();
    if (mine.length) {
      h += '<div class="ask-listh">지난 질문과 답</div>' +
        mine.map(function (m) { return mineRowHtml(m, ctx); }).join('');
    }
    return h + '</div>';
  }

  /* ── 열쇠 칸 ────────────────────────────────────────────────
     평소엔 **안 보인다.** 질문을 눌렀는데 열쇠가 없을 때만 그 자리에 뜬다.

     ⚠️ 여기에 설명을 늘어놓지 말 것. 한때 "왜 필요한지 · 어디 저장되는지 ·
        전용 열쇠를 따로 만들라"를 세 문단으로 적어 놨다가 "이 설명은 뭐야,
        이런 게 왜 있어"를 들었다. 맞는 말이다 — 열쇠를 넣는 사람은 열쇠가
        뭔지 아는 사람이고, 필요한 건 **어디 저장되는지 한 줄**뿐이다.
        나머지는 CLAUDE.md 에 적고 화면에는 올리지 않는다. */
  function keyBoxHtml() {
    if (!cache.keyOpen) return '';
    return '<div class="ask-key">' +
      '<input id="askkey" type="password" autocomplete="off" spellcheck="false" ' +
        'placeholder="Anthropic API 열쇠 (sk-ant-…)" value="' + esc(myKey()) + '" />' +
      '<div class="ask-key-row">' +
        '<button class="btn" id="askkeysave">저장하고 질문하기</button>' +
        (hasKey() ? '<button class="btn ghost" id="askkeydel">지우기</button>' : '') +
      '</div>' +
      '<div class="ask-key-n">이 브라우저에만 저장됩니다.</div>' +
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

  /* 비율로 온 답을 이 기기에서만 금액으로 바꿔 준다. 답 본문과 섞지 않는
     이유: 섞으면 AI 가 금액을 말한 것처럼 보인다. */
  function amtHtml(m, ctx) {
    if (!m || !m.pct || !ctx.seed || !(m.pct[1] > 0)) return '';
    var lo = Math.round(ctx.seed * m.pct[0] / 100), hi = Math.round(ctx.seed * m.pct[1] / 100);
    return '<div class="ask-amt"><div class="ask-amt-h">🧮 회원님 시드로 바꾸면</div>' +
      '<div class="ask-amt-v">' + (lo > 0 && lo !== hi ? ctx.won(lo) + ' ~ ' : '') +
      ctx.won(hi) + (lo > 0 && lo !== hi ? '' : '까지') + '</div>' +
      '<div class="ask-amt-n">전체 투자금의 ' +
      (m.pct[0] !== m.pct[1] ? m.pct[0] + '~' + m.pct[1] : m.pct[1]) + '% 입니다. ' +
      '이 계산은 <b>회원님 기기 안에서만</b> 했습니다 — 금액은 어디에도 ' +
      '보내지 않았습니다.</div></div>';
  }

  /* ══════════════════════════════════════════════════════════════════
     묻기 — 브라우저가 Anthropic 을 직접 부른다
     ══════════════════════════════════════════════════════════════ */
  function hdr() {
    return {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      /* 브라우저에서 직접 부르려면 이 헤더가 있어야 한다. 이름 그대로 "위험"
         하다고 붙어 있는 이유는 **여러 사람이 쓰는 앱에 열쇠 하나를 심는**
         경우를 막으려는 것이다. 여기는 회원님이 자기 기기에 자기 열쇠를
         넣는 경우라 그 위험이 해당하지 않는다. */
      'anthropic-dangerous-direct-browser-access': 'true',
      'x-api-key': myKey()
    };
  }

  function askNow(q, ctx) {
    if (!hasKey() || !window.BCAskBrain) return;
    var brain = window.BCAskBrain;
    running = { q: q, text: '', phase: '찾아보는 중…' };
    onChange();

    stream({
      model: brain.MODEL,
      max_tokens: 6000,
      system: brain.SYSTEM,
      thinking: { type: 'adaptive' },
      stream: true,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
      messages: [{ role: 'user', content: brain.buildContext(ctx.brainCtx(q)) }]
    }, function (chunk) {
      running.text += chunk; running.phase = ''; onChange();
    }).then(function () {
      if (!running || !running.text) throw new Error('답이 비어 있습니다');
      running.phase = '정리하는 중…'; onChange();
      return extract(running.text).catch(function () { return null; });
    }).then(function (meta) {
      var row = { n: -Date.now(), q: q, body: running.text, meta: meta, at: new Date().toISOString() };
      pushMine(row);
      /* 방금 받은 답은 **펼친 채로** 둔다. 눈앞에서 흐르던 글이 다 쓰이자마자
         접혀 버리면 답이 사라진 것처럼 보인다. */
      cache['o' + row.n] = true; save();
      running = null; onChange();
    }).catch(function (e) {
      running = { q: q, text: running ? running.text : '', phase: '', err: errText(e) };
      onChange();
    });
  }

  function errText(e) {
    var m = String((e && e.message) || e);
    if (/401|authentication|invalid x-api-key/i.test(m)) return '열쇠가 맞지 않습니다. 다시 넣어 주세요.';
    if (/credit|billing|402/i.test(m)) return '크레딧이 부족합니다. Anthropic 콘솔에서 확인해 주세요.';
    if (/429|rate/i.test(m)) return '요청이 몰렸습니다. 잠시 뒤 다시 눌러 주세요.';
    return '답을 만들지 못했습니다: ' + m;
  }

  /* SSE 를 손으로 읽는다. 스트리밍을 쓰는 이유는 두 가지 — 답이 길어 한 번에
     받으면 오래 걸리고, 한 글자도 안 보이는 30초는 고장난 것처럼 느껴진다. */
  function stream(body, onText) {
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: hdr(), body: JSON.stringify(body)
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
  function extract(answer) {
    var B = window.BCAskBrain, S = B.SHAPE;
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: hdr(), body: JSON.stringify({
        model: B.MODEL, max_tokens: 1500, system: B.EXTRACT_SYSTEM,
        tool_choice: { type: 'tool', name: 'record' },
        tools: [{
          name: 'record', description: '상담 답변에서 뽑은 값',
          input_schema: {
            type: 'object',
            properties: {
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

  /* ── 이 카드 안에서 일어난 클릭. 처리했으면 true. ────────────── */
  function click(t, ctx) {
    if (!ON) return false;

    if (t.closest && t.closest('#askkeysave')) {
      var inp = document.getElementById('askkey');
      var v = inp ? inp.value.trim() : '';
      /* 모양만 본다. 맞는지는 실제로 물어봐야 안다 — 확인만 하려고 요청을
         한 번 더 쓰지 않는다. */
      if (v && !/^sk-/.test(v)) { alert('열쇠는 보통 sk-ant- 로 시작합니다. 다시 확인해 주세요.'); return true; }
      setKey(v); cache.keyOpen = false; save();
      /* 넣자마자 아까 적어 둔 질문을 그대로 보낸다 — 두 번 누르게 하지 않는다. */
      if (hasKey() && cache.draft) { var q0 = cache.draft; cache.draft = ''; save(); askNow(q0, ctx); }
      else onChange();
      return true;
    }
    if (t.closest && t.closest('#askkeydel')) { setKey(''); save(); onChange(); return true; }
    if (t.closest && t.closest('#askclear')) { running = null; onChange(); return true; }

    if (t.id === 'asksend' || (t.closest && t.closest('#asksend'))) {
      var ta = document.getElementById('askq');
      var q = ta ? ta.value.trim() : '';
      if (!q) { if (ta) ta.focus(); return true; }
      /* 열쇠가 없으면 그 자리에서 한 번 물어본다. 질문은 지우지 않고 담아
         뒀다가, 열쇠를 넣는 즉시 그대로 보낸다. */
      if (!hasKey()) { cache.draft = q; cache.keyOpen = true; save(); onChange(); return true; }
      cache.draft = ''; save();
      if (ta) ta.value = '';
      askNow(q, ctx);
      return true;
    }

    var qb = t.closest && t.closest('[data-askq]');
    if (qb) {
      var n = qb.getAttribute('data-askq');
      cache['o' + n] = !cache['o' + n];
      save(); onChange();
      return true;
    }
    return false;
  }

  function input(t) {
    if (t && t.id === 'askq') { cache.draft = t.value; save(); return true; }
    /* 열쇠는 draft 처럼 흘려 저장하지 않는다. 저장 단추를 눌러야 들어간다. */
    if (t && t.id === 'askkey') return true;
    return false;
  }

  return {
    on: ON, html: html, click: click, input: input, hasKey: hasKey,
    onChange: function (f) { onChange = f; }
  };
})();
