/* ============================================================================
   kakao.mjs — 카카오톡 "나에게 보내기"
   ----------------------------------------------------------------------------
   왜 "나에게 보내기"인가
     친구에게 보내기(friends)나 알림톡은 카카오 검수·사업자등록이 필요하다.
     개인이 쓰는 앱에서 현실적으로 쓸 수 있는 건 **나에게 보내기(memo)** 뿐이고,
     회원님이 받고 싶어 하는 것도 본인 알림이라 이걸로 충분하다.
     메시지는 카카오톡 "나와의 채팅"으로 온다.

   토큰
     access token 은 몇 시간이면 만료된다. 그래서 **refresh token 을 시크릿에
     두고** 실행할 때마다 access token 을 새로 받는다. refresh token 은 두 달
     넘게 안 쓰면 만료되므로, 매일 도는 이 워크플로가 곧 갱신 장치가 된다.
     카카오가 새 refresh token 을 함께 주는 경우가 있는데(만료 임박 시),
     그때는 로그에 남겨 회원님이 시크릿을 바꿔 넣을 수 있게 한다.
     ⚠️ 토큰 값 자체는 절대 로그에 찍지 않는다.

   글자 수
     카카오 기본 텍스트 템플릿은 **200자까지**다. 넘으면 그대로 거절당한다.
     그래서 보내기 직전에 자르고, 자세한 내용은 앱 링크로 넘긴다.
   ========================================================================== */

const TOKEN_URL = 'https://kauth.kakao.com/oauth/token';
const SEND_URL  = 'https://kapi.kakao.com/v2/api/talk/memo/default/send';
const LIMIT = 200;

export function kakaoReady() {
  return !!(process.env.KAKAO_REST_KEY && process.env.KAKAO_REFRESH_TOKEN);
}

async function accessToken() {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.KAKAO_REST_KEY,
    refresh_token: process.env.KAKAO_REFRESH_TOKEN
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    /* 응답에 토큰이 섞여 올 수 있으므로 코드와 설명만 남긴다 */
    throw new Error(`토큰 갱신 실패 (${r.status} ${j.error || ''} ${j.error_description || ''})`);
  }
  if (j.refresh_token) {
    console.log('⚠️ 카카오가 새 refresh token 을 발급했습니다. ' +
      'KAKAO_REFRESH_TOKEN 시크릿을 새 값으로 바꿔 주세요. (값은 로그에 남기지 않습니다)');
  }
  return j.access_token;
}

/* 200자에 맞춘다. 줄 단위로 넣다가 넘치면 거기서 멈추고 "…"를 붙인다 —
   문장 한가운데서 잘리면 무슨 말인지 알 수 없다. */
export function fit(lines, limit = LIMIT) {
  const out = [];
  let n = 0;
  for (const line of lines) {
    const add = (out.length ? 1 : 0) + line.length;
    if (n + add > limit - 1) { out.push('…'); break; }
    out.push(line); n += add;
  }
  return out.join('\n').slice(0, limit);
}

export async function sendKakao(lines, linkUrl) {
  const text = Array.isArray(lines) ? fit(lines) : String(lines).slice(0, LIMIT);
  if (!text.trim()) return { ok: false, skipped: '빈 메시지' };

  const token = await accessToken();
  const template = {
    object_type: 'text',
    text,
    link: linkUrl ? { web_url: linkUrl, mobile_web_url: linkUrl } : {},
    button_title: linkUrl ? '앱에서 보기' : undefined
  };
  const r = await fetch(SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8'
    },
    body: new URLSearchParams({ template_object: JSON.stringify(template) })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.result_code !== 0) {
    throw new Error(`전송 실패 (${r.status} ${j.code || ''} ${j.msg || ''})`);
  }
  return { ok: true, chars: text.length };
}
