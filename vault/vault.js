// ALEPH T08 · 06 나만 보는 자리 (브라우저 쪽)
// 이 파일에는 비공개 내용이 없습니다. 내용은 패스키로 들어간 뒤 서버(/vault)가 내려 줍니다.
// 세션 토큰은 이 탭의 sessionStorage에만 두고, 요청할 때 x-session 헤더로 보냅니다.
(function () {
  'use strict';
  var API = window.VAULT_CONFIG.API;
  var SWA = window.SimpleWebAuthnBrowser;
  var TOKEN_KEY = 'aleph_t08_session';
  var $ = function (id) { return document.getElementById(id); };
  var state = { vault: null, myCredId: null };

  // ── 저장 (막혀 있는 브라우저에서도 멈추지 않게) ──
  function getToken() { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return state.mem || ''; } }
  function setToken(t, credId) {
    state.mem = t;
    try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
    try { credId ? sessionStorage.setItem(TOKEN_KEY + '_cred', credId) : sessionStorage.removeItem(TOKEN_KEY + '_cred'); } catch (e) {}
    state.myCredId = credId || null;
  }
  try { state.myCredId = sessionStorage.getItem(TOKEN_KEY + '_cred'); } catch (e) {}

  function api(path, opts) {
    opts = opts || {};
    var headers = {};
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    var t = opts.noSession ? '' : getToken();
    if (t) headers['x-session'] = t;
    return fetch(API + path, {
      method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
    }).then(function (r) {
      return r.text().then(function (txt) {
        var data = {};
        try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = { message: txt }; }
        if (!r.ok) { var err = new Error(data.message || ('HTTP ' + r.status)); err.status = r.status; err.code = data.error; throw err; }
        return data;
      });
    }, function () {
      var err = new Error('서버에 닿지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.'); err.status = 0; throw err;
    });
  }

  function msg(text, kind) {
    var m = $('v-msg');
    m.className = 'v-msg show ' + (kind || '');
    m.textContent = text;
    if (!text) m.className = 'v-msg';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' KST';
  }
  function busy(btn, on) { if (btn) btn.disabled = !!on; }

  // 패스키를 어디에 저장했는지 (AAGUID·전송 방식으로 추정)
  var AAGUID = {
    'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': '구글 비밀번호 관리자',
    '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello (기기 자체)',
    '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello (기기 자체)',
    '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello (기기 자체)',
    'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud 키체인',
    'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud 키체인',
    '53414d53-554e-4700-0000-000000000000': '삼성 패스',
    'adce0002-35bc-c60a-648b-0b25f1f05503': 'Mac의 크롬 프로필 (기기 자체)',
    'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
    'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  };
  function whereStored(c) {
    if (AAGUID[c.aaguid]) return AAGUID[c.aaguid];
    var tr = c.transports || [];
    if (tr.indexOf('usb') >= 0 || tr.indexOf('nfc') >= 0) return '보안 키 (USB·NFC)';
    if (tr.indexOf('hybrid') >= 0) return '휴대폰 (QR로 연결)';
    if (tr.indexOf('internal') >= 0) return '이 기기 자체';
    return '알 수 없음';
  }

  function explainWebAuthnError(e, what) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'AbortError') return what + '을(를) 취소했거나 시간이 지났습니다.';
    if (n === 'InvalidStateError') return '이 기기에는 이미 이 계정의 패스키가 있습니다. 다른 기기나 다른 저장소(휴대폰 QR 등)를 골라 주세요.';
    if (n === 'SecurityError') return '이 주소에서는 패스키를 쓸 수 없습니다(https 주소인지 확인).';
    if (n === 'NotSupportedError') return '이 브라우저나 기기가 패스키를 지원하지 않습니다.';
    if (INAPP || /credential manager/i.test((e && e.message) || '')) return '앱 안의 브라우저(카카오톡 등)에서는 패스키를 쓸 수 없습니다. 크롬·삼성 인터넷·사파리로 열어 주세요.';
    return (e && e.message) || String(e);
  }

  // ── 등록 (새 계정 / 로그인한 계정에 추가) ──
  function register(isAdd) {
    var btn = isAdd ? $('v-addkey') : $('v-signup');
    var name = (isAdd ? $('v-keyname-add') : $('v-keyname-new')).value.trim();
    var body = isAdd ? {} : { username: $('v-username').value.trim().toLowerCase() };
    if (!isAdd && !body.username) { msg('아이디를 먼저 적어 주세요.', 'warn'); $('v-username').focus(); return; }
    if (!SWA || !SWA.browserSupportsWebAuthn()) { msg('이 브라우저는 패스키를 지원하지 않습니다.', 'err'); return; }
    busy(btn, true); msg('서버에서 등록용 질문을 받는 중…');
    var challengeId;
    api('/register/options', { body: body, noSession: !isAdd })
      .then(function (r) {
        challengeId = r.challengeId;
        msg('기기 창에서 패스키 만들기를 마쳐 주세요.');
        return SWA.startRegistration({ optionsJSON: r.options }).catch(function (e) {
          // 취소: 서버에 받아 둔 질문을 지워서 아무것도 남지 않게
          return api('/register/cancel', { body: { challengeId: challengeId }, noSession: true }).catch(function () {}).then(function () {
            var err = new Error(explainWebAuthnError(e, '패스키 등록') + ' 서버에는 아무것도 저장되지 않았습니다.');
            err.cancelled = true; throw err;
          });
        });
      })
      .then(function (resp) {
        msg('서명을 서버에서 확인하는 중…');
        return api('/register/verify', { body: { challengeId: challengeId, response: resp, name: name }, noSession: !isAdd });
      })
      .then(function (r) {
        if (r.session) setToken(r.session.token, r.credential.id);
        (isAdd ? $('v-keyname-add') : $('v-keyname-new')).value = '';
        return loadVault().then(function () {
          msg('패스키 "' + r.credential.name + '"을(를) 등록했습니다. 서버에 저장된 것은 공개키뿐입니다.', 'ok');
        });
      })
      .catch(function (e) { msg(e.message, e.cancelled ? 'warn' : 'err'); })
      .then(function () { busy(btn, false); });
  }

  // ── 로그인 ──
  function login() {
    var btn = $('v-login');
    if (!SWA || !SWA.browserSupportsWebAuthn()) { msg('이 브라우저는 패스키를 지원하지 않습니다.', 'err'); return; }
    busy(btn, true); msg('서버에서 로그인용 질문을 받는 중…');
    var challengeId;
    api('/login/options', { body: {}, noSession: true })
      .then(function (r) {
        challengeId = r.challengeId;
        msg('기기 창에서 패스키를 골라 주세요.');
        return SWA.startAuthentication({ optionsJSON: r.options }).catch(function (e) {
          var err = new Error(explainWebAuthnError(e, '로그인')); err.cancelled = true; throw err;
        });
      })
      .then(function (resp) {
        msg('서명을 저장된 공개키로 확인하는 중…');
        return api('/login/verify', { body: { challengeId: challengeId, response: resp }, noSession: true });
      })
      .then(function (r) {
        setToken(r.session.token, r.credential.id);
        return loadVault().then(function () { msg('"' + r.credential.name + '" 패스키로 들어왔습니다.', 'ok'); });
      })
      .catch(function (e) { msg(e.message, e.cancelled ? 'warn' : 'err'); })
      .then(function () { busy(btn, false); });
  }

  function logout() {
    var btn = $('v-logout'); busy(btn, true);
    api('/logout', { body: {} }).catch(function () {}).then(function () {
      setToken('', null); state.vault = null; showLocked();
      msg('로그아웃했습니다. 이 탭에 있던 세션 토큰은 서버에서도 더는 통하지 않습니다.', 'ok');
      busy(btn, false);
    });
  }

  // ── 비공개 자료 ──
  function loadVault() {
    if (!getToken()) { showLocked(); return Promise.resolve(); }
    return api('/vault').then(function (v) { state.vault = v; showOpen(); }, function (e) {
      if (e.status === 401) { setToken('', null); showLocked(); msg(e.message, 'warn'); return; }
      throw e;
    });
  }

  function showLocked() {
    $('v-locked').hidden = false; $('v-open').hidden = true;
    $('v-state').textContent = '잠김'; $('v-state').className = 'state';
    $('v-notes').innerHTML = ''; $('v-keys').innerHTML = ''; $('v-who').innerHTML = '';
  }

  var KIND = { memo: '프로젝트 메모', list: '지원할 곳 목록', retro: '회고' };
  function showOpen() {
    var v = state.vault;
    $('v-locked').hidden = true; $('v-open').hidden = false;
    $('v-state').textContent = '열림 · ' + v.user.username; $('v-state').className = 'state open';
    $('v-who').innerHTML = esc(v.user.displayName || v.user.username) + '<small>계정 ' + esc(v.user.username) + ' · 만든 날 ' + esc(fmt(v.user.createdAt)) + '</small>';

    var notes = $('v-notes');
    notes.innerHTML = v.notes.length ? '' : '<div class="v-empty">아직 항목이 없습니다. 아래에서 추가하세요.</div>';
    v.notes.forEach(function (n) {
      var el = document.createElement('article'); el.className = 'note'; el.dataset.id = n.id;
      el.innerHTML = '<span class="k">' + esc(KIND[n.kind] || n.kind) + '</span><h4>' + esc(n.title) + '</h4><p class="b">' + esc(n.body) + '</p>' +
        '<div class="acts"><button class="v-btn ghost sm" data-act="edit" type="button">고치기</button><button class="v-btn danger sm" data-act="del" type="button">지우기</button></div>';
      notes.appendChild(el);
    });

    var keys = $('v-keys'); keys.innerHTML = '';
    var only = v.credentials.length <= 1;
    v.credentials.forEach(function (c) {
      var el = document.createElement('div'); el.className = 'key'; el.dataset.id = c.id;
      el.innerHTML =
        '<div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.2-8.2M17 6l2 2M15 8l2 2"/></svg></div>' +
        '<div><div class="nm">' + esc(c.name) + (c.id === state.myCredId ? '<span class="me">지금 쓰는 패스키</span>' : '') + '</div>' +
        '<div class="meta">등록 ' + esc(fmt(c.createdAt)) + ' · 마지막 사용 ' + esc(fmt(c.lastUsedAt)) + '<br>저장된 곳(추정): ' + esc(whereStored(c)) + (c.backedUp ? ' · 여러 기기 동기화됨' : '') + '</div>' +
        '<div class="pk" title="서버에 저장된 공개키 (COSE, base64url)">공개키 ' + esc(c.publicKey.slice(0, 44)) + '…</div></div>' +
        '<div class="acts"><button class="v-btn ghost sm" data-act="rename" type="button">이름 바꾸기</button>' +
        '<button class="v-btn danger sm" data-act="delkey" type="button"' + (only ? ' disabled title="마지막 패스키는 지울 수 없습니다"' : '') + '>지우기</button></div>';
      keys.appendChild(el);
    });
  }

  function addNote() {
    var btn = $('v-note-add');
    var title = $('v-note-title').value.trim();
    if (!title) { msg('제목을 적어 주세요.', 'warn'); return; }
    busy(btn, true);
    api('/notes', { body: { kind: $('v-note-kind').value, title: title, body: $('v-note-body').value } })
      .then(function () { $('v-note-title').value = ''; $('v-note-body').value = ''; return loadVault(); })
      .then(function () { msg('항목을 추가했습니다.', 'ok'); }, function (e) { msg(e.message, 'err'); })
      .then(function () { busy(btn, false); });
  }

  $('v-notes').addEventListener('click', function (ev) {
    var b = ev.target.closest('button'); if (!b) return;
    var card = b.closest('.note'); var id = card.dataset.id;
    var n = state.vault.notes.filter(function (x) { return x.id === id; })[0];
    if (b.dataset.act === 'del') {
      if (!confirm('"' + n.title + '" 항목을 지울까요?')) return;
      api('/notes/' + id, { method: 'DELETE' }).then(loadVault).then(function () { msg('지웠습니다.', 'ok'); }, function (e) { msg(e.message, 'err'); });
    } else if (b.dataset.act === 'edit') {
      card.classList.add('edit');
      var box = document.createElement('div');
      box.innerHTML = '<input class="v-input" maxlength="80" style="width:100%;margin:6px 0 8px"><textarea class="v-input" maxlength="4000"></textarea>' +
        '<div class="acts"><button class="v-btn sm" data-act="save" type="button">저장</button><button class="v-btn ghost sm" data-act="cancel" type="button">그만두기</button></div>';
      box.querySelector('input').value = n.title; box.querySelector('textarea').value = n.body;
      card.querySelector('.acts').replaceWith(box);
    } else if (b.dataset.act === 'save') {
      var box2 = b.closest('div').parentNode;
      api('/notes/' + id, { method: 'PATCH', body: { title: box2.querySelector('input').value, body: box2.querySelector('textarea').value } })
        .then(loadVault).then(function () { msg('고쳤습니다.', 'ok'); }, function (e) { msg(e.message, 'err'); });
    } else if (b.dataset.act === 'cancel') { showOpen(); }
  });

  $('v-keys').addEventListener('click', function (ev) {
    var b = ev.target.closest('button'); if (!b || b.disabled) return;
    var id = b.closest('.key').dataset.id;
    var c = state.vault.credentials.filter(function (x) { return x.id === id; })[0];
    if (b.dataset.act === 'rename') {
      var nm = prompt('새 이름', c.name); if (nm == null) return;
      api('/credentials/' + encodeURIComponent(id), { method: 'PATCH', body: { name: nm } }).then(loadVault).then(function () { msg('이름을 바꿨습니다.', 'ok'); }, function (e) { msg(e.message, 'err'); });
    } else if (b.dataset.act === 'delkey') {
      var warnSelf = id === state.myCredId ? '\n(지금 이 패스키로 들어와 있어서, 지우면 바로 로그아웃됩니다.)' : '';
      if (!confirm('"' + c.name + '" 패스키를 지울까요? 지운 패스키로는 다시 들어올 수 없습니다.' + warnSelf)) return;
      api('/credentials/' + encodeURIComponent(id), { method: 'DELETE' }).then(function (r) {
        var text = '"' + c.name + '"을(를) 지웠습니다. 남은 패스키 ' + r.remaining + '개. 그 패스키로 열려 있던 세션 ' + r.revokedSessions + '개도 끊었습니다. 기기 쪽(비밀번호 관리자 등)에 남은 패스키 항목은 직접 지워 주세요.';
        if (id === state.myCredId) { setToken('', null); state.vault = null; showLocked(); msg(text + ' 지금 쓰던 패스키라 로그아웃되었습니다.', 'ok'); return; }
        return loadVault().then(function () { msg(text, 'ok'); });
      }, function (e) { msg(e.message, e.status === 409 ? 'warn' : 'err'); });
    }
  });

  // ── 카카오톡·네이버 등 앱 안 브라우저는 패스키 관리자와 연결되지 않습니다 ──
  var INAPP = /KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV|Line\/|DaumApps|everytimeApp|; wv\)/i.test(navigator.userAgent);
  function inAppHint() {
    var url = location.href.split('#')[0];
    var m = $('v-msg');
    m.className = 'v-msg show warn';
    m.innerHTML = '지금은 <b>앱 안의 브라우저</b>(카카오톡 등)로 열려 있어서 패스키를 쓸 수 없습니다. <b>크롬·삼성 인터넷·사파리</b>로 열어 주세요.<br>' +
      '<a style="color:inherit;font-weight:700" href="' + (/KAKAOTALK/i.test(navigator.userAgent)
        ? 'kakaotalk://web/openExternal?url=' + encodeURIComponent(url)
        : 'intent://' + url.replace(/^https?:\/\//, '') + '#Intent;scheme=https;package=com.android.chrome;end') + '">→ 다른 브라우저로 열기</a>';
  }
  if (INAPP) inAppHint();

  // ── 새 계정 만들기가 열려 있는지 ──
  api('/health', { noSession: true }).then(function (h) {
    if (!h.registrationOpen) {
      $('v-username').disabled = true; $('v-keyname-new').disabled = true; $('v-signup').disabled = true;
      $('v-reg-note').textContent = '지금은 새 계정 만들기가 닫혀 있습니다. 심사하시는 분은 여기서 아무것도 만들지 않으셔도 됩니다.';
    }
  }, function () {});

  $('v-login').addEventListener('click', login);
  $('v-signup').addEventListener('click', function () { register(false); });
  $('v-addkey').addEventListener('click', function () { register(true); });
  $('v-logout').addEventListener('click', logout);
  $('v-refresh').addEventListener('click', function () { loadVault().then(function () { msg('새로 불러왔습니다.', 'ok'); }, function (e) { msg(e.message, 'err'); }); });
  $('v-note-add').addEventListener('click', addNote);
  $('v-username').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('v-keyname-new').focus(); });

  loadVault().catch(function (e) { msg(e.message, 'err'); });
})();
