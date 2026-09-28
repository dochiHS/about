// 로컬 자동 검사: Chromium + CDP 가상 인증기(실제 WebAuthn 흐름) + 확인 기록기
// 실행: 서버를 PK_STORE=memory PK_RP_ID=localhost PK_ORIGINS=http://localhost:8080 deno run -A supabase/functions/passkey/index.ts 로 띄우고
//       이 저장소 루트를 localhost:8080 으로 연 뒤  CHROME=<크롬 경로> node checks/local/e2e.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8080/';
const OUT = process.env.OUT || './out';
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : '')); };

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_TUNNEL_CONNECTION_FAILED/.test(m.text())) errors.push(m.text()); });
const cdp = await ctx.newCDPSession(page);
await cdp.send('WebAuthn.enable');
const addAuth = async () => (await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })).authenticatorId;
const auth1 = await addAuth();

const msg = () => page.locator('#v-msg').textContent();
const waitMsg = async (re, t = 10000) => { await page.waitForFunction((r) => new RegExp(r).test(document.getElementById('v-msg').textContent), re.source, { timeout: t }); return msg(); };

// 1) 잠긴 첫 화면
await page.goto(BASE, { waitUntil: 'networkidle' });
ok('첫 화면: 공개 소개 제목 보임', await page.locator('h1').isVisible());
ok('첫 화면: 경계선 보임', await page.locator('#boundary').isVisible());
ok('첫 화면: 잠김 상태', (await page.locator('#v-state').textContent()) === '잠김');
ok('첫 화면: 비공개 목록 비어 있음', (await page.locator('#v-notes').innerHTML()) === '' && await page.locator('#v-open').isHidden());
ok('비밀번호 입력칸 0개 (C35)', (await page.locator('input[type=password]').count()) === 0);
await page.locator('#vault').scrollIntoViewIfNeeded();
await page.screenshot({ path: OUT + '/01-locked.png', fullPage: false });

// 2) 등록 취소 (기기 창에서 취소한 것처럼)
await page.fill('#v-username', 'hyeseong');
await page.evaluate(() => { window.__origCreate = navigator.credentials.create.bind(navigator.credentials); navigator.credentials.create = () => Promise.reject(new DOMException('cancelled', 'NotAllowedError')); });
await page.click('#v-signup');
const cancelMsg = await waitMsg(/취소/);
ok('등록 취소 안내 (C25)', /아무것도 저장되지 않았습니다/.test(cancelMsg), cancelMsg);
await page.evaluate(() => { navigator.credentials.create = window.__origCreate; });

// 3) 새 계정 + 첫 패스키
await page.fill('#v-keyname-new', '노트북 크롬');
await page.click('#v-signup');
const regMsg = await waitMsg(/등록했습니다|실패|오류|없습니다/);
ok('새 계정 등록 → 열림', /등록했습니다/.test(regMsg) && await page.locator('#v-open').isVisible(), regMsg);
ok('패스키 목록 1개 + 이름', (await page.locator('.key').count()) === 1 && (await page.locator('.key .nm').first().textContent()).includes('노트북 크롬'));
ok('마지막 패스키 지우기 버튼 막힘', await page.locator('.key [data-act=delkey]').first().isDisabled());

// 4) 비공개 항목 3개
const items = [
  ['memo', '준비 중인 프로젝트 메모', '만들어 넣은 메모 1'],
  ['list', '지원하려는 곳 목록', '가상의 회사 A, B'],
  ['retro', '이번 주 회고', '만들어 넣은 회고'],
];
for (const [k, t, b] of items) {
  await page.selectOption('#v-note-kind', k); await page.fill('#v-note-title', t); await page.fill('#v-note-body', b);
  const before = await page.locator('.note').count(); await page.click('#v-note-add'); await page.waitForFunction((n) => document.querySelectorAll('.note').length === n + 1, before);
}
ok('비공개 항목 3개 (C14)', (await page.locator('.note').count()) === 3);

// 고치기
await page.locator('.note [data-act=edit]').first().click();
await page.locator('.note textarea').fill('고친 메모');
await page.locator('.note [data-act=save]').click();
await waitMsg(/고쳤습니다/);
ok('항목 고치기', (await page.locator('.note .b').first().textContent()) === '고친 메모');

// 5) 두 번째 패스키: 같은 인증기는 제외 목록 때문에 거절 → 안내 확인, 두 번째 인증기로 등록
await page.fill('#v-keyname-add', '휴대폰');
await page.click('#v-addkey');
const dupMsg = await waitMsg(/이미|취소|등록했습니다/, 20000);
ok('같은 기기 두 번째 등록 시 안내', /이미|취소/.test(dupMsg), dupMsg);
await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: auth1 }).catch(() => {});
// auth1의 자격 증명을 보관해 두었다가 다시 붙일 수 있게
const auth2 = await addAuth();
await page.fill('#v-keyname-add', '휴대폰');
await page.click('#v-addkey');
const addMsg = await waitMsg(/등록했습니다|이미|취소|실패/, 20000);
ok('두 번째 패스키 등록 (C42)', /등록했습니다/.test(addMsg) && (await page.locator('.key').count()) === 2, addMsg);
ok('목록에 이름·등록 날짜 (C43)', (await page.locator('.key .meta').first().textContent()).includes('등록 '));
await page.locator('.keys').scrollIntoViewIfNeeded();
await page.screenshot({ path: OUT + '/02-open.png', fullPage: false });

// 6) 로그아웃 → 잠김, 새로고침해도 잠김
await page.click('#v-logout');
await waitMsg(/로그아웃했습니다/);
ok('로그아웃 → 잠김', await page.locator('#v-locked').isVisible() && (await page.locator('.note').count()) === 0);

// 7) 두 번째 패스키(auth2)로 로그인
await page.click('#v-login');
const li = await waitMsg(/들어왔습니다|취소|실패|지워진/, 20000);
ok('패스키 로그인 (auth2)', /휴대폰.*들어왔습니다/.test(li), li);

// 8) 첫 패스키 지우기 → 하나 남음 → 마지막 지우기 막힘
page.once('dialog', (d) => d.accept());
const firstKey = page.locator('.key', { hasText: '노트북 크롬' });
await firstKey.locator('[data-act=delkey]').click();
const delMsg = await waitMsg(/지웠습니다|실패/);
ok('패스키 하나 지우기 (C44)', /남은 패스키 1개/.test(delMsg), delMsg);
ok('남은 하나 지우기 버튼 막힘 (C46)', await page.locator('.key [data-act=delkey]').first().isDisabled());

// 9) 지운 패스키(auth1)로 로그인 시도 → 거절
await page.click('#v-logout'); await waitMsg(/로그아웃했습니다/);
await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: auth2 });
const auth3 = await addAuth(); // 빈 인증기: 지운 것 대신, 서버에 없는 패스키 흉내는 확인 기록기에서
await page.click('#v-login');
const noKey = await waitMsg(/취소|실패|지워진|시간/, 20000);
ok('패스키가 없는 기기 로그인 → 안내', /취소|시간/.test(noKey), noKey);
await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: auth3 });

// 10) 로그인 없이 받은 페이지 소스
const src = await (await ctx.request.get(BASE)).text();
ok('로그인 없는 페이지 소스에 비공개 항목 없음 (C18)', !items.some(([, t, b]) => src.includes(t) || src.includes(b)) && !src.includes('고친 메모'));

// 11) 모바일 폭
const m = await browser.newPage({ viewport: { width: 375, height: 800 } });
await m.goto(BASE, { waitUntil: 'networkidle' });
await m.locator('#vault').scrollIntoViewIfNeeded();
const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
ok('모바일 가로 넘침 없음', overflow <= 0, 'overflow ' + overflow);
await m.screenshot({ path: OUT + '/03-mobile.png' });

// 12) 확인 기록기 (소프트웨어 패스키, 같은 서버)
const ev = await browser.newPage();
ev.on('pageerror', (e) => errors.push('evidence: ' + e.message));
await ev.goto(BASE + 'checks/evidence.html', { waitUntil: 'networkidle' });
await ev.click('#run');
await ev.waitForFunction(() => window.__evidence || /중단/.test(document.getElementById('ev-sum').textContent), null, { timeout: 60000 });
const evr = await ev.evaluate(() => window.__evidence ? { s: window.__evidence.summary, c: window.__evidence.checks, md: window.__evidence.markdown } : { err: document.getElementById('ev-sum').textContent });
if (evr.err) ok('확인 기록기', false, evr.err);
else {
  evr.c.forEach((c) => ok('기록기 ' + c.id + ' ' + c.title, c.pass, c.detail.split('\n')[0]));
  fs.writeFileSync(OUT + '/evidence-local.md', evr.md);
}
ok('콘솔 오류 없음', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r.pass);
console.log(`\n${results.length - fails.length} / ${results.length} 통과`);
process.exit(fails.length ? 1 : 0);
