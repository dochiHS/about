# about — 강혜성 소개 페이지 (+ 패스키로 잠근 나만 보는 자리)

- 결과물: https://dochihs.github.io/about/
- 과제 1(T01): `index.html`의 01~05 공개 소개. 누구나 볼 수 있습니다.
- 과제 8(T08): 맨 아래 **06 나만 보는 자리**. 비밀번호 없이 패스키(WebAuthn)로만 열립니다.
  설명서는 [docs/PASSKEY.md](docs/PASSKEY.md), 실제 서버 확인 기록은 [docs/evidence/](docs/evidence/)에 있습니다.

## 어디에 무엇이 있나

| 파일 | 하는 일 |
|---|---|
| `index.html` | 공개 소개(01~05, T01 그대로) + 06 비공개 자리의 빈 틀(내용 없음) |
| `vault/vault.js` | 화면 쪽: 패스키 등록·로그인·로그아웃, 비공개 자료 불러오기 |
| `vault/config.js` | 서버 주소(공개 값만) |
| `vault/simplewebauthn-browser-13.3.0.umd.min.js` | SimpleWebAuthn 브라우저 라이브러리 (MIT, 그대로 포함) |
| `supabase/functions/passkey/index.ts` | 서버(Supabase Edge Function): 질문 발급·보관, 서명 확인, 세션, 비공개 자료, 401/403 거절 |
| `supabase/schema.sql` | 표 6개(pk_*) · RLS 켜고 브라우저 권한 회수 |
| `checks/evidence.html` | 실제 서버 확인 기록기(시험용 소프트웨어 패스키로 검사용 계정 두 개를 만들어 요청·응답을 남김) |
| `checks/local/e2e.mjs` | 로컬 자동 검사(크로미움 가상 인증기) |

## 흐름 네 가지

```
등록     POST /register/options → (기기: 열쇠 한 쌍 생성, 공개키만 전송) → POST /register/verify
         취소하면 POST /register/cancel (받아 둔 질문을 지움 → 서버에 아무것도 남지 않음)
로그인   POST /login/options → (기기: 질문에 개인키로 서명) → POST /login/verify → 세션 토큰
로그아웃 POST /logout (세션 무효화)
비공개   GET /vault · /notes · /credentials  (헤더 x-session 없으면 401, 남의 것이면 403)
```

비공개 자리에 들어 있는 내용은 모두 만들어 넣은 것이며, 실제 연락처·신분증 번호 같은 개인정보는 없습니다.
