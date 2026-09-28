// 공개해도 되는 값만 있습니다. (서버 주소뿐 — 키·비밀번호 없음)
window.VAULT_CONFIG = {
  API: (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:8000/passkey'
    : 'https://kkwiaqyiktvejylfdwov.supabase.co/functions/v1/passkey',
  SOURCE_URL: 'https://github.com/dochiHS/about',
};
