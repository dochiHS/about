// 검사용 "소프트웨어 패스키" — 확인 기록을 자동으로 남기려고 만든 시험용 인증기입니다.
// 실제 기기의 패스키와 똑같은 형식(WebAuthn: none 증명, ES256)으로
//   · 등록: 열쇠 한 쌍을 만들고 공개키만 담은 attestationObject를 돌려주고
//   · 로그인: 서버가 보낸 질문(challenge)이 든 clientDataJSON에 개인키로 서명합니다.
// 개인키(CryptoKey)는 이 탭 메모리에만 있고 어떤 요청에도 실리지 않습니다.
// 실제 계정(본인 패스키)은 이 파일을 쓰지 않습니다. 검사용 계정 ev-a-*, ev-b-* 만 씁니다.
(function (g) {
  'use strict';
  var te = new TextEncoder();
  function b64u(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '=';
    var s = atob(str), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function concat() {
    var n = 0, i; for (i = 0; i < arguments.length; i++) n += arguments[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < arguments.length; i++) { out.set(arguments[i], o); o += arguments[i].length; }
    return out;
  }
  async function sha256(u8) { return new Uint8Array(await crypto.subtle.digest('SHA-256', u8)); }

  // ── 아주 작은 CBOR 인코더 (정수·바이트열·문자열·맵만) ──
  function head(major, n) {
    if (n < 24) return new Uint8Array([(major << 5) | n]);
    if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
    if (n < 65536) return new Uint8Array([(major << 5) | 25, n >> 8, n & 255]);
    return new Uint8Array([(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  }
  function cbor(v) {
    if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
    if (typeof v === 'string') { var b = te.encode(v); return concat(head(3, b.length), b); }
    if (v instanceof Uint8Array) return concat(head(2, v.length), v);
    if (v instanceof Map) {
      var parts = [head(5, v.size)];
      v.forEach(function (val, key) { parts.push(cbor(key), cbor(val)); });
      return concat.apply(null, parts);
    }
    throw new Error('cbor: unsupported');
  }
  function u32(n) { return new Uint8Array([(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]); }

  // WebCrypto 서명(r||s 64바이트)을 WebAuthn이 쓰는 DER로
  function rawToDer(sig) {
    function int(x) {
      var i = 0; while (i < x.length - 1 && x[i] === 0) i++;
      x = x.slice(i);
      if (x[0] & 0x80) x = concat(new Uint8Array([0]), x);
      return concat(new Uint8Array([0x02, x.length]), x);
    }
    var r = int(sig.slice(0, 32)), s = int(sig.slice(32));
    return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
  }

  function SoftKey(label) { this.label = label; this.counter = 0; }

  // navigator.credentials.create() 대신
  SoftKey.prototype.create = async function (options, origin) {
    this.keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    var jwk = await crypto.subtle.exportKey('jwk', this.keyPair.publicKey); // 공개 부분(x, y)만 꺼냅니다
    this.rawId = crypto.getRandomValues(new Uint8Array(32));
    this.id = b64u(this.rawId);
    this.rpId = options.rp.id;
    this.userHandle = options.user.id;
    var cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, unb64u(jwk.x)], [-3, unb64u(jwk.y)]]));
    var authData = concat(await sha256(te.encode(this.rpId)), new Uint8Array([0x45]), u32(this.counter),
      new Uint8Array(16), new Uint8Array([0, this.rawId.length]), this.rawId, cose);
    var clientData = te.encode(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: origin, crossOrigin: false }));
    var att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: this.id, rawId: this.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ['internal'] },
    };
  };

  // navigator.credentials.get() 대신
  SoftKey.prototype.get = async function (options, origin) {
    this.counter += 1;
    var authData = concat(await sha256(te.encode(this.rpId)), new Uint8Array([0x05]), u32(this.counter));
    var clientData = te.encode(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: origin, crossOrigin: false }));
    var signed = concat(authData, await sha256(clientData));
    var sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keyPair.privateKey, signed));
    return {
      id: this.id, rawId: this.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(rawToDer(sig)), userHandle: this.userHandle },
    };
  };

  g.SoftKey = SoftKey;
  g.b64u = b64u; g.unb64u = unb64u;
})(window);
