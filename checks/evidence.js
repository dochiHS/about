// ALEPH T08 확인 기록기 — 실제 서버에 실제 요청을 보내고, 요청·응답을 나란히 적습니다.
// 검사용 계정 두 개(ev-a-*, ev-b-*)를 소프트웨어 패스키(softkey.js)로 만들어 씁니다.
// 기록에서 세션 토큰은 앞 6자만 남기고 가립니다(C34).
(function () {
  'use strict';
  var API = window.VAULT_CONFIG.API;
  var ORIGIN = location.origin;
  var PUBLIC_REST = { url: 'https://kkwiaqyiktvejylfdwov.supabase.co/rest/v1', key: 'sb_publishable_MLsgr6OLWYz6bImODWn8vw_5CTYOcJp' };
  var te = new TextEncoder();

  var log = [];        // {kind:'h', text} | {kind:'req', ...}
  var checks = [];     // {id, title, pass, note}
  var tokens = [];     // 가릴 값들

  function mask(s) {
    s = String(s);
    tokens.forEach(function (t) { if (t) s = s.split(t).join(t.slice(0, 6) + '…(가림)'); });
    return s;
  }
  function shortVal(v, depth) {
    depth = depth || 0;
    if (typeof v === 'string') {
      if (tokens.indexOf(v) >= 0) return v.slice(0, 6) + '…(가림)';
      return v.length > 48 ? v.slice(0, 32) + '…(' + v.length + '자)' : v;
    }
    if (Array.isArray(v)) return v.map(function (x) { return shortVal(x, depth + 1); });
    if (v && typeof v === 'object') {
      var o = {}; Object.keys(v).forEach(function (k) { o[k] = shortVal(v[k], depth + 1); }); return o;
    }
    return v;
  }
  function h(text) { log.push({ kind: 'h', text: text }); render(); }
  function note(text) { log.push({ kind: 'note', text: text }); render(); }
  function check(id, title, pass, detail) { checks.push({ id: id, title: title, pass: !!pass, detail: detail || '' }); log.push({ kind: 'check', id: id, title: title, pass: !!pass, detail: detail || '' }); render(); }

  async function call(method, path, opts) {
    opts = opts || {};
    var headers = {};
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.token) headers['x-session'] = opts.token;
    var url = (opts.base || API) + path;
    if (opts.headers) Object.keys(opts.headers).forEach(function (k) { headers[k] = opts.headers[k]; });
    var r = await fetch(url, { method: method, headers: headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, cache: 'no-store' });
    var txt = await r.text(), data;
    try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = txt; }
    if (data && data.session && data.session.token) tokens.push(data.session.token);
    var shownHeaders = {};
    Object.keys(headers).forEach(function (k) {
      shownHeaders[k] = k === 'x-session' ? headers[k].slice(0, 6) + '…(가림)' : k === 'apikey' ? headers[k].slice(0, 16) + '…(공개용 키)' : headers[k];
    });
    log.push({
      kind: 'req', label: opts.label || '', method: method, path: opts.base ? url.replace(/^https:\/\/[^/]+/, '') : path,
      headers: shownHeaders, body: opts.body !== undefined ? shortVal(opts.body) : undefined,
      status: r.status, res: typeof data === 'string' ? data.slice(0, 300) : shortVal(data),
    });
    render();
    return { status: r.status, data: data };
  }

  // ── 작은 CBOR 해석기 (저장된 공개키가 무엇으로 이뤄졌는지 보이려고) ──
  function cborDecode(u8) {
    var i = 0;
    function len(ai) {
      if (ai < 24) return ai;
      if (ai === 24) return u8[i++];
      if (ai === 25) { var v = (u8[i] << 8) | u8[i + 1]; i += 2; return v; }
      if (ai === 26) { var w = ((u8[i] << 24) >>> 0) + (u8[i + 1] << 16) + (u8[i + 2] << 8) + u8[i + 3]; i += 4; return w; }
      throw new Error('cbor len');
    }
    function item() {
      var b = u8[i++], mt = b >> 5, n = len(b & 31);
      if (mt === 0) return n;
      if (mt === 1) return -1 - n;
      if (mt === 2) { var s = u8.slice(i, i + n); i += n; return s; }
      if (mt === 3) { var t = new TextDecoder().decode(u8.slice(i, i + n)); i += n; return t; }
      if (mt === 5) { var m = {}; for (var k = 0; k < n; k++) { var key = item(); m[key] = item(); } return m; }
      throw new Error('cbor type ' + mt);
    }
    return item();
  }

  function rid() { return Math.random().toString(36).slice(2, 7); }
  async function registerNew(key, username, name) {
    var o = await call('POST', '/register/options', { body: { username: username }, label: username + ' 등록 질문 받기' });
    if (o.status !== 200) throw new Error('등록 질문 실패 ' + o.status + ' ' + JSON.stringify(o.data));
    var resp = await key.create(o.data.options, ORIGIN);
    var v = await call('POST', '/register/verify', { body: { challengeId: o.data.challengeId, response: resp, name: name }, label: username + ' 등록 확인' });
    if (v.status !== 200) throw new Error('등록 확인 실패 ' + v.status + ' ' + JSON.stringify(v.data));
    return { options: o, verify: v, response: resp, token: v.data.session.token, userId: null };
  }
  async function login(key, label) {
    var o = await call('POST', '/login/options', { body: {}, label: label + ' — 로그인 질문 받기' });
    var resp = await key.get(o.data.options, ORIGIN);
    var body = { challengeId: o.data.challengeId, response: resp };
    var v = await call('POST', '/login/verify', { body: body, label: label + ' — 서명 보내기' });
    return { options: o, body: body, verify: v };
  }

  async function run() {
    log = []; checks = []; tokens = [];
    var started = new Date();
    var tag = rid();
    var A = new window.SoftKey('A-1'), A2 = new window.SoftKey('A-2'), B = new window.SoftKey('B-1');
    var userA = 'ev-a-' + tag, userB = 'ev-b-' + tag;
    note('시작 ' + started.toISOString() + ' · 서버 ' + API + ' · 이 페이지 ' + ORIGIN + ' · 검사용 계정 ' + userA + ', ' + userB);

    var hl = await call('GET', '/health', { label: '서버 상태' });
    if (!hl.data.registrationOpen) { check('준비', '새 계정 만들기가 열려 있어야 검사용 계정을 만들 수 있습니다', false, 'pk_settings.registration_open = true 로 잠시 열어 주세요'); return finish(started); }

    // ── 1. 로그인 없이 ─────────────────────────────
    h('① 로그인 없이 비공개 자료 요청 (C15·C16·C17)');
    var n1 = await call('GET', '/vault', { label: '세션 없이 /vault' });
    var n2 = await call('GET', '/notes', { label: '세션 없이 /notes' });
    var n3 = await call('GET', '/vault', { token: 'made-up-token-000000000000000000000000000', label: '지어낸 세션 값으로 /vault' });
    check('C16·C17', '로그인 없이 요청하면 401로 거절', n1.status === 401 && n2.status === 401 && n3.status === 401, n1.status + ' / ' + n2.status + ' / ' + n3.status);
    if (location.hostname !== 'localhost') {
      var rest = await call('GET', '/pk_notes?select=*', { base: PUBLIC_REST.url, headers: { apikey: PUBLIC_REST.key }, label: '공개용 키로 DB(REST)에 직접 pk_notes 요청' });
      var restEmpty = rest.status === 401 || rest.status === 403 || rest.status === 404 || (Array.isArray(rest.data) && rest.data.length === 0);
      check('C16', 'DB 표를 공개용 키로 직접 읽어도 내용이 나오지 않음', restEmpty, 'HTTP ' + rest.status);
    }

    // ── 2. 등록 ─────────────────────────────────────
    h('② 패스키 등록 — 질문은 매번 새로, 서버에는 공개키만 (C19~C26)');
    var o1 = await call('POST', '/register/options', { body: { username: userA }, label: '등록 질문 1' });
    var o2 = await call('POST', '/register/options', { body: { username: userA }, label: '등록 질문 2 (같은 아이디로 한 번 더)' });
    check('C19·C20', '등록 질문이 요청마다 다름', o1.data.options.challenge !== o2.data.options.challenge,
      '1: ' + o1.data.options.challenge + '\n2: ' + o2.data.options.challenge);

    note('등록 취소 흉내: 기기 창에서 취소하면 화면이 /register/cancel 을 보냅니다.');
    var c1 = await call('POST', '/register/cancel', { body: { challengeId: o1.data.challengeId }, label: '등록 취소 (질문 1 버리기)' });
    var c2 = await call('POST', '/register/cancel', { body: { challengeId: o2.data.challengeId }, label: '등록 취소 (질문 2 버리기)' });
    var cv = await call('POST', '/register/verify', { body: { challengeId: o1.data.challengeId, response: await A2.create(o1.data.options, ORIGIN), name: '취소된 것' }, label: '취소한 질문으로 등록 마무리 시도' });
    check('C25', '취소하면 서버에 아무것도 안 남음 (질문 삭제, 뒤늦은 등록도 거절)', c1.data.removedChallenge === true && c2.data.removedChallenge === true && cv.status === 400, '취소 ' + c1.status + '/' + c2.status + ', 뒤늦은 등록 ' + cv.status + ' ' + (cv.data.error || ''));

    var ra = await registerNew(A, userA, '검사용 A · 첫 패스키');
    var regBody = ra.response;
    var bodyStr = JSON.stringify(regBody);
    var att = cborDecode(window.unb64u(regBody.response.attestationObject));
    var jwk = await crypto.subtle.exportKey('jwk', A.keyPair.privateKey); // 비교용으로만 (요청에는 싣지 않음)
    var leaks = [jwk.d].filter(function (d) { return bodyStr.indexOf(d) >= 0; }).length;
    note('등록 요청 본문의 칸: ' + Object.keys(regBody).join(', ') + ' / response 안: ' + Object.keys(regBody.response).join(', ') +
      '\nattestationObject 안: fmt=' + att.fmt + ', attStmt=' + JSON.stringify(att.attStmt) + ', authData ' + att.authData.length + '바이트(공개키 포함)');
    check('C23', '등록 요청 본문에 개인키가 없음 (개인키 d 값이 본문 어디에도 없음)', leaks === 0 && !/"d"\s*:/.test(bodyStr) && !/private/i.test(bodyStr), '본문 ' + bodyStr.length + '자에서 개인키 d(' + jwk.d.length + '자) 검색 결과 ' + leaks + '건');
    var tokA = ra.token;
    check('C21·C24', '등록 뒤 서버에 공개키가 저장되고 이름이 붙음', ra.verify.data.credential && ra.verify.data.credential.publicKey && ra.verify.data.credential.name === '검사용 A · 첫 패스키', ra.verify.data.credential.name);

    var cr = await call('GET', '/credentials', { token: tokA, label: 'A: 서버에 저장된 패스키 보기' });
    var stored = cr.data.credentials[0];
    var cose = cborDecode(window.unb64u(stored.publicKey));
    var pubJwk = await crypto.subtle.exportKey('jwk', A.keyPair.publicKey);
    var sameXY = window.b64u(cose[-2]) === pubJwk.x && window.b64u(cose[-3]) === pubJwk.y;
    note('서버에 저장된 값(public_key, base64url): ' + stored.publicKey +
      '\n풀어 보면 COSE 키 {1(kty): ' + cose[1] + ' = EC2, 3(alg): ' + cose[3] + ' = ES256, -1(crv): ' + cose[-1] + ' = P-256, -2(x): ' + cose[-2].length + '바이트, -3(y): ' + cose[-3].length + '바이트}' +
      '\n개인키 성분(-4, d)은 없음: ' + (cose[-4] === undefined));
    check('C22', '저장된 값은 공개키(x, y)이며 기기의 공개키와 같고, 개인키 성분이 없음', sameXY && cose[-4] === undefined, 'x·y 일치 ' + sameXY);

    // 비공개 항목 (만들어 넣은 내용)
    var notesA = [
      { kind: 'memo', title: '[검사용 A] 준비 중인 프로젝트 메모', body: '가상의 메모입니다. 로그 수집기 뼈대 먼저.' },
      { kind: 'list', title: '[검사용 A] 지원하려는 곳 목록', body: '가상의 회사 가 · 나 · 다' },
      { kind: 'retro', title: '[검사용 A] 이번 주 회고', body: '가상의 회고: 질문(challenge)은 서버가 보관해야 한다.' },
    ];
    for (var i = 0; i < notesA.length; i++) await call('POST', '/notes', { token: tokA, body: notesA[i], label: 'A: 비공개 항목 추가 ' + (i + 1) });

    var rb = await registerNew(B, userB, '검사용 B · 첫 패스키');
    var tokB = rb.token;
    var notesB = [
      { kind: 'memo', title: '[검사용 B] 다른 사람의 메모', body: 'B만 보는 가상의 메모' },
      { kind: 'list', title: '[검사용 B] B의 목록', body: '가상의 목록 하나 둘 셋' },
      { kind: 'retro', title: '[검사용 B] B의 회고', body: 'B의 가상 회고' },
    ];
    var bNoteIds = [];
    for (var j = 0; j < notesB.length; j++) { var nb = await call('POST', '/notes', { token: tokB, body: notesB[j], label: 'B: 비공개 항목 추가 ' + (j + 1) }); bNoteIds.push(nb.data.note.id); }
    var vA = await call('GET', '/vault', { token: tokA, label: 'A: 내 비공개 자리 열기' });
    var vB = await call('GET', '/vault', { token: tokB, label: 'B: 내 비공개 자리 열기' });
    var aNoteIds = vA.data.notes.map(function (n) { return n.id; });
    check('C14·C36', '계정 두 개에 서로 다른 비공개 항목이 3개 이상씩', vA.data.notes.length >= 3 && vB.data.notes.length >= 3 &&
      vA.data.notes.every(function (n) { return n.title.indexOf('[검사용 A]') === 0; }) && vB.data.notes.every(function (n) { return n.title.indexOf('[검사용 B]') === 0; }),
      'A ' + vA.data.notes.length + '개, B ' + vB.data.notes.length + '개');

    // ── 3. 로그인 ────────────────────────────────────
    h('③ 로그인 — 매번 새 질문, 공개키로 서명 확인, 재사용 거절 (C27~C33)');
    var lo1 = await call('POST', '/login/options', { body: {}, label: '로그인 질문 1' });
    var lo2 = await call('POST', '/login/options', { body: {}, label: '로그인 질문 2' });
    var ok = await login(A, 'A 정상 로그인');
    var chs = [lo1.data.options.challenge, lo2.data.options.challenge, ok.options.data.options.challenge];
    check('C27·C28', '로그인 질문이 요청마다 다름 (3번)', new Set(chs).size === 3, chs.join('\n'));
    check('C29·C30 (성공)', '올바른 서명 → 200, 세션 발급', ok.verify.status === 200 && !!ok.verify.data.session, 'HTTP ' + ok.verify.status);

    var bo = await call('POST', '/login/options', { body: {}, label: '틀린 서명 시험 — 로그인 질문 받기' });
    var good = await A.get(bo.data.options, ORIGIN);
    var sig = window.unb64u(good.response.signature); sig[sig.length - 3] ^= 0x5a;
    var bad = JSON.parse(JSON.stringify(good)); bad.response.signature = window.b64u(sig);
    var badv = await call('POST', '/login/verify', { body: { challengeId: bo.data.challengeId, response: bad }, label: '서명 한 바이트를 바꿔 보냄' });
    check('C29·C30 (실패)', '틀린 서명 → 401로 거절', badv.status === 401, 'HTTP ' + badv.status + ' ' + (badv.data.error || ''));

    var replay = await call('POST', '/login/verify', { body: ok.body, label: '성공했던 로그인 요청을 그대로 한 번 더 (이미 쓴 질문)' });
    check('C31', '이미 쓴 질문으로 다시 로그인 → 거절', replay.status === 401 && replay.data.error === 'challenge_used', 'HTTP ' + replay.status + ' ' + replay.data.error);
    var fresh = await call('POST', '/login/options', { body: {}, label: '새 질문 받기' });
    var oldOnNew = await call('POST', '/login/verify', { body: { challengeId: fresh.data.challengeId, response: ok.body.response }, label: '예전 서명을 새 질문 번호에 붙여 보냄' });
    check('C31 (덧붙임)', '예전 서명을 새 질문에 붙여도 거절', oldOnNew.status === 401, 'HTTP ' + oldOnNew.status + ' ' + (oldOnNew.data.error || ''));

    var tokA2 = ok.verify.data.session.token;
    var me = await call('GET', '/me', { token: tokA2, label: '로그인 뒤 세션 토큰으로 사람 알아보기' });
    check('C32', '로그인 뒤에는 x-session 헤더의 세션 토큰(서버는 SHA-256만 저장)으로 알아봄', me.status === 200 && me.data.user.username === userA, me.data.user && me.data.user.username);
    var lg = await call('POST', '/logout', { token: tokA2, body: {}, label: '로그아웃' });
    var after = await call('GET', '/vault', { token: tokA2, label: '로그아웃한 같은 토큰으로 다시 /vault' });
    var after2 = await call('POST', '/logout', { token: tokA2, body: {}, label: '로그아웃한 같은 토큰으로 다시 로그아웃' });
    check('C33', '로그아웃 뒤 같은 값으로 요청 → 401', lg.status === 200 && after.status === 401 && after.data.error === 'session_revoked' && after2.status === 401, after.status + ' ' + after.data.error);

    // ── 4. 남의 자료 ─────────────────────────────────
    h('④ 한쪽 패스키로 다른 쪽 자료 읽기 (C37~C40)');
    var before = await call('GET', '/notes', { token: tokB, label: 'B: 거절 전 내 항목 수' });
    var beforeA = await call('GET', '/notes', { token: tokA, label: 'A: 거절 전 내 항목 수' });
    var x1 = await call('GET', '/notes/' + bNoteIds[0], { token: tokA, label: 'A 세션으로 B의 항목 읽기' });
    var x2 = await call('PATCH', '/notes/' + bNoteIds[0], { token: tokA, body: { title: 'A가 고침' }, label: 'A 세션으로 B의 항목 고치기' });
    var x3 = await call('DELETE', '/notes/' + bNoteIds[1], { token: tokA, label: 'A 세션으로 B의 항목 지우기' });
    check('C37', 'A → B 읽기·고치기·지우기 모두 403', x1.status === 403 && x2.status === 403 && x3.status === 403, x1.status + ' / ' + x2.status + ' / ' + x3.status);
    var y1 = await call('GET', '/notes/' + aNoteIds[0], { token: tokB, label: 'B 세션으로 A의 항목 읽기' });
    var y2 = await call('DELETE', '/notes/' + aNoteIds[1], { token: tokB, label: 'B 세션으로 A의 항목 지우기' });
    var y3 = await call('DELETE', '/credentials/' + encodeURIComponent(A.id), { token: tokB, label: 'B 세션으로 A의 패스키 지우기' });
    check('C38', 'B → A 읽기·지우기·패스키 지우기 모두 403', y1.status === 403 && y2.status === 403 && y3.status === 403, y1.status + ' / ' + y2.status + ' / ' + y3.status);
    var z1 = await call('GET', '/vault?user=' + encodeURIComponent(vB.data.user.id) + '&user_id=' + encodeURIComponent(vB.data.user.id), { token: tokA, label: 'A 세션 + 주소에 B를 적어 /vault' });
    var z2 = await call('POST', '/notes', { token: tokA, body: { title: '[검사용 A] 본문에 B를 적어 보냄', body: '가상', user_id: vB.data.user.id, userId: vB.data.user.id, owner: userB }, label: 'A 세션 + 본문에 B를 적어 항목 추가' });
    var z3 = await call('GET', '/notes', { token: tokA, label: 'A: 방금 항목이 누구 것이 됐나' });
    var onlyA = z1.status === 200 && z1.data.user.username === userA && z1.data.notes.every(function (n) { return n.title.indexOf('[검사용 A]') === 0; });
    var landedA = z2.status === 201 && z3.data.notes.some(function (n) { return n.id === z2.data.note.id; });
    var afterB = await call('GET', '/notes', { token: tokB, label: 'B: 거절 뒤 내 항목 수' });
    check('C40', '주소·본문에 다른 계정을 적어도 내 자료만 돌아옴', onlyA && landedA, 'vault 주인 ' + (z1.data.user && z1.data.user.username) + ', 새 항목 주인 A=' + landedA);
    var sameB = before.data.notes.length === afterB.data.notes.length &&
      before.data.notes.map(function (n) { return n.id + n.title; }).join() === afterB.data.notes.map(function (n) { return n.id + n.title; }).join();
    var afterA = await call('GET', '/notes', { token: tokA, label: 'A: 거절 뒤 내 항목 수' });
    check('C39', '거절 앞뒤로 반대편 자료 건수·내용이 같음', sameB && beforeA.data.notes.length + 1 === afterA.data.notes.length,
      'B ' + before.data.notes.length + ' → ' + afterB.data.notes.length + ' (내용 동일 ' + sameB + '), A ' + beforeA.data.notes.length + ' → ' + afterA.data.notes.length + ' (A가 자기 것 1개 추가)');

    // ── 5. 패스키 두 개, 하나 지우기 ─────────────────────
    h('⑤ 패스키 두 개 등록 → 하나 지우기 → 남은 것으로만 들어가기 (C42~C46)');
    var ao = await call('POST', '/register/options', { token: tokA, body: {}, label: 'A: 패스키 하나 더 — 등록 질문 (이미 있는 패스키는 제외 목록에)' });
    var excl = (ao.data.options.excludeCredentials || []).map(function (c) { return c.id; });
    var ar = await A2.create(ao.data.options, ORIGIN);
    var av = await call('POST', '/register/verify', { token: tokA, body: { challengeId: ao.data.challengeId, response: ar, name: '검사용 A · 두 번째 패스키' }, label: 'A: 두 번째 패스키 등록 확인' });
    var list2 = await call('GET', '/credentials', { token: tokA, label: 'A: 패스키 목록' });
    check('C42·C43', '한 계정에 패스키 2개, 목록에 이름과 등록 날짜', av.status === 200 && list2.data.credentials.length === 2 &&
      list2.data.credentials.every(function (c) { return c.name && c.createdAt; }) && excl.indexOf(A.id) >= 0,
      list2.data.credentials.map(function (c) { return c.name + ' (' + c.createdAt + ')'; }).join(' / '));
    var del = await call('DELETE', '/credentials/' + encodeURIComponent(A.id), { token: tokA, label: 'A: 첫 패스키 지우기' });
    var l2 = await login(A2, 'A 남은 패스키(두 번째)로 로그인');
    var l1 = await login(A, 'A 지운 패스키(첫 번째)로 로그인');
    check('C44', '하나를 지운 뒤 남은 패스키로 들어감', del.status === 200 && l2.verify.status === 200, '지우기 ' + del.status + ', 남은 것 로그인 ' + l2.verify.status);
    check('C45', '지운 패스키로는 못 들어감', l1.verify.status === 401 && l1.verify.data.error === 'unknown_credential', 'HTTP ' + l1.verify.status + ' ' + l1.verify.data.error);
    var last = await call('DELETE', '/credentials/' + encodeURIComponent(A2.id), { token: l2.verify.data.session.token, label: 'A: 마지막 남은 패스키까지 지우기' });
    check('C46', '마지막 패스키는 지울 수 없음 (0개가 되면 누구도 못 들어오므로 409로 막음)', last.status === 409 && last.data.error === 'last_passkey', 'HTTP ' + last.status + ' ' + last.data.error);

    // ── 6. 로그인 없이 받은 페이지 소스 ─────────────────
    h('⑥ 로그인 없이 받은 페이지 소스에 비공개 내용이 있나 (C15·C18)');
    var secrets = notesA.concat(notesB).map(function (n) { return n.title; }).concat(notesA.concat(notesB).map(function (n) { return n.body; }));
    var files = ['../index.html', '../vault/vault.js', '../vault/config.js'];
    var hits = 0, sizes = [];
    for (var f = 0; f < files.length; f++) {
      var r = await fetch(files[f], { cache: 'no-store', credentials: 'omit' });
      var src = await r.text(); sizes.push(files[f].replace('../', '') + ' ' + r.status + ' ' + src.length + '자');
      secrets.forEach(function (s) { if (src.indexOf(s) >= 0) hits++; });
    }
    log.push({ kind: 'note', text: '쿠키·세션 없이 받은 파일: ' + sizes.join(', ') + '\n비공개 항목 제목·본문 ' + secrets.length + '개를 찾은 결과: ' + hits + '건' });
    check('C18', '로그인 없이 받은 페이지 소스에 비공개 내용 0건', hits === 0, hits + '건');

    return finish(started, { userA: userA, userB: userB });
  }

  function finish(started, extra) {
    var passN = checks.filter(function (c) { return c.pass; }).length;
    var reqN = log.filter(function (l) { return l.kind === 'req'; }).length;
    var out = { started: started.toISOString(), finished: new Date().toISOString(), pass: passN, total: checks.length, requests: reqN, extra: extra || {} };
    window.__evidence = { summary: out, checks: checks, markdown: toMarkdown(out) };
    render(out);
    return window.__evidence;
  }

  function toMarkdown(sum) {
    var L = [];
    L.push('# T08 확인 기록 — 패스키 잠금 (실제 서버 요청·응답)');
    L.push('');
    L.push('- 실행: ' + sum.started + ' ~ ' + sum.finished);
    L.push('- 서버: `' + API + '`');
    L.push('- 실행한 페이지: `' + location.href + '`');
    L.push('- 결과: **' + sum.pass + ' / ' + sum.total + ' 통과**, 요청 ' + sum.requests + '건');
    L.push('- 검사용 계정: ' + (sum.extra.userA || '') + ', ' + (sum.extra.userB || '') + ' (소프트웨어 시험용 패스키 · 만들어 넣은 내용만)');
    L.push('- 세션 토큰은 앞 6자만 남기고 가렸습니다. 긴 base64 값은 앞부분과 길이만 적었습니다.');
    L.push('');
    L.push('| 기준 | 확인 | 결과 |'); L.push('|---|---|---|');
    checks.forEach(function (c) { L.push('| ' + c.id + ' | ' + c.title + ' | ' + (c.pass ? '통과' : '**실패**') + ' |'); });
    L.push('');
    log.forEach(function (l) {
      if (l.kind === 'h') { L.push('## ' + l.text); L.push(''); }
      else if (l.kind === 'note') { L.push('> ' + mask(l.text).split('\n').join('\n> ')); L.push(''); }
      else if (l.kind === 'check') { L.push('**' + (l.pass ? '✔ 통과' : '✘ 실패') + ' · ' + l.id + '** ' + l.title + (l.detail ? ' — ' + mask(l.detail).split('\n').join(' / ') : '')); L.push(''); }
      else {
        L.push('`' + l.label + '`');
        L.push('```');
        L.push('→ ' + l.method + ' ' + l.path + (Object.keys(l.headers).length ? '   ' + mask(JSON.stringify(l.headers)) : ''));
        if (l.body !== undefined) L.push('  ' + mask(JSON.stringify(l.body)));
        L.push('← ' + l.status + ' ' + mask(JSON.stringify(l.res)));
        L.push('```');
      }
    });
    return L.join('\n');
  }

  function render(sum) {
    var el = document.getElementById('ev-out'); if (!el) return;
    var html = '';
    log.forEach(function (l) {
      if (l.kind === 'h') html += '<h2>' + esc(l.text) + '</h2>';
      else if (l.kind === 'note') html += '<blockquote>' + esc(mask(l.text)) + '</blockquote>';
      else if (l.kind === 'check') html += '<div class="ck ' + (l.pass ? 'ok' : 'bad') + '"><b>' + (l.pass ? '통과' : '실패') + ' · ' + esc(l.id) + '</b> ' + esc(l.title) + (l.detail ? '<small>' + esc(mask(l.detail)) + '</small>' : '') + '</div>';
      else html += '<div class="rq"><span class="lb">' + esc(l.label) + '</span><pre>→ ' + esc(l.method + ' ' + l.path) + (l.body !== undefined ? '\n  ' + esc(mask(JSON.stringify(l.body))) : '') +
        '\n<span class="s' + String(l.status)[0] + '">← ' + l.status + '</span> ' + esc(mask(JSON.stringify(l.res))) + '</pre></div>';
    });
    el.innerHTML = html;
    if (sum) document.getElementById('ev-sum').textContent = sum.pass + ' / ' + sum.total + ' 통과 · 요청 ' + sum.requests + '건 · ' + sum.finished;
  }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  window.runEvidence = run;
})();
