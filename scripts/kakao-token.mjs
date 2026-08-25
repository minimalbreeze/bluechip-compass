/* 인증 코드 → refresh token 교환. 워크플로에서 한 번만 쓴다.
   휴대폰에서 curl 을 칠 수 없어서 이 단계를 워크플로로 옮겼다. */
const code = process.env.KAKAO_CODE;
const key  = process.env.KAKAO_REST_KEY;
const uri  = process.env.KAKAO_REDIRECT_URI;

if (!code) { console.log('❌ code 가 비었습니다.'); process.exit(1); }
if (!key)  { console.log('❌ KAKAO_REST_KEY 시크릿이 없습니다. 먼저 저장하세요.'); process.exit(1); }

const r = await fetch('https://kauth.kakao.com/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: key,
    redirect_uri: uri,
    code
  })
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
