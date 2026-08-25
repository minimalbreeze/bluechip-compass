/* 인증 코드 → refresh token 교환. 워크플로에서 한 번만 쓴다.
   휴대폰에서 curl 을 칠 수 없어서 이 단계를 워크플로로 옮겼다. */
const code = process.env.KAKAO_CODE;
const key  = process.env.KAKAO_REST_KEY;
const uri  = process.env.KAKAO_REDIRECT_URI;

if (!code) { console.log('❌ code 가 비었습니다.'); process.exit(1); }
if (!key)  { console.log('❌ KAKAO_REST_KEY 시크릿이 없습니다. 먼저 저장하세요.'); process.exit(1); }

/* ── 보내기 전에 값의 '모양'을 확인한다 ─────────────────────────
   invalid_client 로 세 번 막혔는데, 원인이 시크릿인지 키인지 추측만 했다.
   값을 로그에 찍을 수는 없으니(자격증명이다) **모양만** 남긴다.
   REST API 키는 32자 소문자 16진수다. 다른 키를 붙여넣었으면 여기서 걸린다. */
const looksHex32 = /^[0-9a-f]{32}$/.test(key);
console.log('— 보내기 전 확인 —');
/* 앞뒤 4자만 보여준다. 32자 중 8자라 값을 복원할 수는 없고, 카카오 콘솔의
   앱별 REST 키와 눈으로 대조하기에는 충분하다.
   실제로 앱이 두 개인데 동의는 A 앱 키로, 토큰 발급은 B 앱 키로 하고 있어서
   invalid_client 이 났다. 그 어긋남은 이 여덟 글자만 있으면 바로 보인다. */
console.log(`  REST 키      : ${key.length}자, 모양 ${looksHex32 ? '맞음' : '⚠️ 다름'}` +
            ` · ${key.slice(0, 4)}…${key.slice(-4)}`);
console.log('                 ↑ 카카오 콘솔 > 해당 앱 > 앱 키 > REST API 키 와 대조하세요.');
if (!looksHex32) {
  console.log('                 REST API 키는 32자 소문자 16진수입니다.');
  console.log('                 대문자·하이픈이 섞였거나 길이가 다르면 다른 키입니다.');
}
console.log(`  클라이언트 시크릿: ${process.env.KAKAO_CLIENT_SECRET ? '보냄' : '안 보냄(시크릿 미저장)'}`);
console.log(`  Redirect URI : ${uri}`);
console.log(`  코드 길이     : ${code.length}자`);
console.log('');

/* 클라이언트 시크릿이 카카오 콘솔에서 켜져 있으면 이 값을 같이 보내야 한다.
   안 보내면 401 invalid_client 로 거절당한다(실제로 그렇게 막혔다).
   꺼져 있으면 시크릿을 안 넣어도 되고, 보내도 무시된다 — 그래서 있으면
   보내고 없으면 안 보내는 쪽으로 둔다. 어느 설정이든 동작한다. */
const body = {
  grant_type: 'authorization_code',
  client_id: key,
  redirect_uri: uri,
  code
};
if (process.env.KAKAO_CLIENT_SECRET) body.client_secret = process.env.KAKAO_CLIENT_SECRET;

const r = await fetch('https://kauth.kakao.com/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
  body: new URLSearchParams(body)
});
const j = await r.json().catch(() => ({}));

if (!r.ok || !j.refresh_token) {
  console.log(`❌ 실패 (${r.status}) ${j.error || ''} ${j.error_description || ''}`);
  console.log('');
  console.log('자주 있는 원인');
  console.log(' · 코드를 이미 한 번 썼다 → 인증 주소로 다시 들어가 새 코드를 받으세요.');
  console.log(' · 코드가 10분을 넘겼다 → 마찬가지로 새로 받으세요.');
  console.log(' · Redirect URI 가 카카오에 등록한 것과 다르다 → 글자 하나까지 같아야 합니다.');
  console.log(`   지금 쓴 값: ${uri}`);
  console.log(' · talk_message 동의항목이 꺼져 있다 → 켜고 다시 인증하세요.');
  if (j.error === 'invalid_client') {
    console.log('');
    console.log('⚠️ invalid_client 은 위 원인들이 아니라 **자격증명 문제**입니다.');
    console.log('');
    console.log(' 가장 흔한 것 — 앱이 여러 개일 때 키가 섞였다.');
    console.log('   동의(코드 발급)는 회원님이 페이지에 붙여넣은 키로 하고,');
    console.log('   토큰 발급은 KAKAO_REST_KEY 로 합니다. 이 둘이 다른 앱이면');
    console.log('   "A 앱 코드를 들고 B 앱이라 주장"하는 꼴이라 거절당합니다.');
    console.log(`   → 위에 찍힌 ${key.slice(0, 4)}…${key.slice(-4)} 가 **동의할 때 쓴 앱**의`);
    console.log('     REST API 키가 맞는지 확인하세요. 시크릿도 같은 앱 것이어야 합니다.');
    console.log('');
    console.log(' 그 밖에');
    console.log('   · 클라이언트 시크릿이 켜져 있는데 값을 안 보냈다(지금은 ' +
      (process.env.KAKAO_CLIENT_SECRET ? '보내는 중' : '안 보내는 중') + ').');
    console.log('   · REST API 키가 아닌 다른 키(네이티브·JavaScript·Admin)를 넣었다.');
  }
  process.exit(1);
}

/* 값은 로그(stdout)에 찍지 않는다. 로그는 URL 만 알면 볼 수 있는 경우가 있어서
   Job Summary 로만 내보낸다 — 저장소 접근 권한이 있어야 볼 수 있다. */
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(summary, [
    '## 🧭 카카오 refresh token 발급 완료',
    '',
    '아래 값을 복사해 **Settings → Secrets and variables → Actions** 의',
    '`KAKAO_REFRESH_TOKEN` 에 저장하세요.',
    '',
    '```',
    j.refresh_token,
    '```',
    '',
    `유효기간 약 ${Math.round((j.refresh_token_expires_in || 0) / 86400)}일 ` +
      '(매일 도는 알림 워크플로가 자동으로 갱신합니다)',
    '',
    '> ⚠️ 저장한 뒤에는 **이 실행 기록을 지우는 것**을 권합니다.',
    '> Actions → 이 실행 → 오른쪽 위 ··· → Delete workflow run',
    ''
  ].join('\n'));
  console.log('✅ 발급 성공. 값은 이 실행의 **Summary** 에 있습니다 (로그에는 남기지 않았습니다).');
} else {
  console.log('✅ 발급 성공했지만 Summary 에 쓸 수 없었습니다.');
}
