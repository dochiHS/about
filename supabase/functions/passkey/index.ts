// ALEPH T08 · 소개 페이지 패스키 잠금 서버 (Supabase Edge Function "passkey")
//
// 흐름 네 가지가 이 파일 안에서 지나는 자리:
//   등록   : POST /register/options → POST /register/verify   (취소: POST /register/cancel)
//   로그인 : POST /login/options    → POST /login/verify
//   로그아웃: POST /logout
//   비공개 자료 조회: GET /vault, GET/POST/PATCH/DELETE /notes, GET/PATCH/DELETE /credentials
//
// 비밀번호는 어디에도 없습니다. 서버가 저장하는 것은 패스키의 "공개키"뿐이고,
// 로그인할 때마다 새로 만든 일회용 질문(challenge)에 기기가 개인키로 서명한 답을
// 그 공개키로 확인한 뒤에만 세션 토큰을 내줍니다.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "npm:@simplewebauthn/server@13.3.3";
import { isoBase64URL } from "npm:@simplewebauthn/server@13.3.3/helpers";
import { createClient } from "npm:@supabase/supabase-js@2";

// ─────────────────────────── 설정 ───────────────────────────
const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const RP_ID = env("PK_RP_ID", "dochihs.github.io");
const RP_NAME = env("PK_RP_NAME", "강혜성 · 나만 보는 자리");
const EXPECTED_ORIGINS = env("PK_ORIGINS", "https://dochihs.github.io").split(",").map((s) => s.trim()).filter(Boolean);
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 질문 보관 시간 5분
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 세션 8시간
const MAX_PASSKEYS = 10;
const ALGS = [-7, -8, -257]; // ES256, EdDSA, RS256

// ─────────────────────────── 저장소 ───────────────────────────
type Row = Record<string, any>;
type Consume = { status: "ok" | "missing" | "used" | "expired" | "wrong_purpose"; row?: Row };

interface Store {
  getSetting(key: string): Promise<any>;
  getUser(id: string): Promise<Row | null>;
  getUserByName(username: string): Promise<Row | null>;
  createUser(u: Row): Promise<void>;
  listCreds(userId: string): Promise<Row[]>;
  getCred(id: string): Promise<Row | null>;
  insertCred(c: Row): Promise<void>;
  touchCred(id: string, counter: number): Promise<void>;
  renameCred(id: string, userId: string, name: string): Promise<void>;
  deleteCred(id: string, userId: string): Promise<void>;
  insertChallenge(c: Row): Promise<Row>;
  consumeChallenge(id: string, purpose: string): Promise<Consume>;
  cancelChallenge(id: string): Promise<boolean>;
  purgeChallenges(): Promise<void>;
  insertSession(s: Row): Promise<void>;
  getSession(hash: string): Promise<Row | null>;
  revokeSession(hash: string): Promise<void>;
  revokeSessionsByCred(credId: string): Promise<number>;
  listNotes(userId: string): Promise<Row[]>;
  getNote(id: string): Promise<Row | null>;
  insertNote(n: Row): Promise<Row>;
  updateNote(id: string, userId: string, patch: Row): Promise<Row | null>;
  deleteNote(id: string, userId: string): Promise<void>;
}

const nowIso = () => new Date().toISOString();

function supabaseStore(): Store {
  // Edge Function 안에서만 쓰는 서버 키(환경변수로 자동 주입). 브라우저로는 절대 나가지 않습니다.
  let key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) {
    try { const ks = JSON.parse(env("SUPABASE_SECRET_KEYS", "{}")); key = ks.default ?? Object.values(ks)[0] ?? ""; } catch { key = ""; }
  }
  const db = createClient(env("SUPABASE_URL"), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const one = async (q: any) => {
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data;
  };
  return {
    async getSetting(key) {
      const d = await one(db.from("pk_settings").select("value").eq("key", key).maybeSingle());
      return d?.value;
    },
    getUser: (id) => one(db.from("pk_users").select("*").eq("id", id).maybeSingle()),
    getUserByName: (u) => one(db.from("pk_users").select("*").eq("username", u).maybeSingle()),
    createUser: (u) => one(db.from("pk_users").insert(u)),
    listCreds: (uid) => one(db.from("pk_credentials").select("*").eq("user_id", uid).order("created_at")),
    getCred: (id) => one(db.from("pk_credentials").select("*").eq("id", id).maybeSingle()),
    insertCred: (c) => one(db.from("pk_credentials").insert(c)),
    touchCred: (id, counter) => one(db.from("pk_credentials").update({ counter, last_used_at: nowIso() }).eq("id", id)),
    renameCred: (id, uid, name) => one(db.from("pk_credentials").update({ name }).eq("id", id).eq("user_id", uid)),
    deleteCred: (id, uid) => one(db.from("pk_credentials").delete().eq("id", id).eq("user_id", uid)),
    insertChallenge: async (c) => (await one(db.from("pk_challenges").insert(c).select().single())),
    async consumeChallenge(id, purpose) {
      // 한 번의 UPDATE로 "아직 안 쓴 것만" 쓴 것으로 바꿉니다. 동시에 두 번 와도 하나만 통과합니다.
      const hit = await one(
        db.from("pk_challenges").update({ used_at: nowIso() })
          .eq("id", id).eq("purpose", purpose).is("used_at", null).gt("expires_at", nowIso())
          .select(),
      );
      if (hit?.length) return { status: "ok", row: hit[0] };
      const row = await one(db.from("pk_challenges").select("*").eq("id", id).maybeSingle());
      if (!row) return { status: "missing" };
      if (row.purpose !== purpose) return { status: "wrong_purpose", row };
      if (row.used_at) return { status: "used", row };
      return { status: "expired", row };
    },
    async cancelChallenge(id) {
      const d = await one(db.from("pk_challenges").delete().eq("id", id).is("used_at", null).select());
      return !!d?.length;
    },
    async purgeChallenges() {
      const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      await one(db.from("pk_challenges").delete().lt("expires_at", cutoff));
      await one(db.from("pk_sessions").delete().lt("expires_at", cutoff));
    },
    insertSession: (s) => one(db.from("pk_sessions").insert(s)),
    getSession: (h) => one(db.from("pk_sessions").select("*").eq("token_hash", h).maybeSingle()),
    revokeSession: (h) => one(db.from("pk_sessions").update({ revoked_at: nowIso() }).eq("token_hash", h).is("revoked_at", null)),
    async revokeSessionsByCred(cid) {
      const d = await one(db.from("pk_sessions").update({ revoked_at: nowIso() }).eq("credential_id", cid).is("revoked_at", null).select("token_hash"));
      return d?.length ?? 0;
    },
    listNotes: (uid) => one(db.from("pk_notes").select("*").eq("user_id", uid).order("created_at")),
    getNote: (id) => one(db.from("pk_notes").select("*").eq("id", id).maybeSingle()),
    insertNote: async (n) => (await one(db.from("pk_notes").insert(n).select().single())),
    async updateNote(id, uid, patch) {
      const d = await one(db.from("pk_notes").update({ ...patch, updated_at: nowIso() }).eq("id", id).eq("user_id", uid).select());
      return d?.[0] ?? null;
    },
    deleteNote: (id, uid) => one(db.from("pk_notes").delete().eq("id", id).eq("user_id", uid)),
  };
}

// 로컬 검사용 메모리 저장소 (PK_STORE=memory 일 때만)
function memoryStore(): Store {
  const t = { settings: new Map<string, any>([["registration_open", env("PK_REG_OPEN", "true") === "true"]]),
    users: new Map<string, Row>(), creds: new Map<string, Row>(), ch: new Map<string, Row>(),
    sess: new Map<string, Row>(), notes: new Map<string, Row>() };
  const byCreated = (a: Row, b: Row) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0);
  (globalThis as any).__pkMemory = t;
  return {
    getSetting: async (k) => t.settings.get(k),
    getUser: async (id) => t.users.get(id) ?? null,
    getUserByName: async (u) => [...t.users.values()].find((x) => x.username === u) ?? null,
    createUser: async (u) => {
      if ([...t.users.values()].some((x) => x.username === u.username)) throw new Error("duplicate username");
      t.users.set(u.id, { created_at: nowIso(), display_name: "", ...u });
    },
    listCreds: async (uid) => [...t.creds.values()].filter((c) => c.user_id === uid).sort(byCreated),
    getCred: async (id) => t.creds.get(id) ?? null,
    insertCred: async (c) => { t.creds.set(c.id, { created_at: nowIso(), last_used_at: null, ...c }); },
    touchCred: async (id, counter) => { const c = t.creds.get(id); if (c) Object.assign(c, { counter, last_used_at: nowIso() }); },
    renameCred: async (id, uid, name) => { const c = t.creds.get(id); if (c && c.user_id === uid) c.name = name; },
    deleteCred: async (id, uid) => { const c = t.creds.get(id); if (c && c.user_id === uid) t.creds.delete(id); },
    insertChallenge: async (c) => { const r = { id: crypto.randomUUID(), used_at: null, created_at: nowIso(), ...c }; t.ch.set(r.id, r); return r; },
    consumeChallenge: async (id, purpose) => {
      const r = t.ch.get(id);
      if (!r) return { status: "missing" };
      if (r.purpose !== purpose) return { status: "wrong_purpose", row: r };
      if (r.used_at) return { status: "used", row: r };
      if (r.expires_at <= nowIso()) return { status: "expired", row: r };
      r.used_at = nowIso();
      return { status: "ok", row: r };
    },
    cancelChallenge: async (id) => { const r = t.ch.get(id); if (r && !r.used_at) { t.ch.delete(id); return true; } return false; },
    purgeChallenges: async () => {},
    insertSession: async (s) => { t.sess.set(s.token_hash, { created_at: nowIso(), revoked_at: null, ...s }); },
    getSession: async (h) => t.sess.get(h) ?? null,
    revokeSession: async (h) => { const s = t.sess.get(h); if (s && !s.revoked_at) s.revoked_at = nowIso(); },
    revokeSessionsByCred: async (cid) => { let n = 0; t.sess.forEach((s) => { if (s.credential_id === cid && !s.revoked_at) { s.revoked_at = nowIso(); n++; } }); return n; },
    listNotes: async (uid) => [...t.notes.values()].filter((n) => n.user_id === uid).sort(byCreated),
    getNote: async (id) => t.notes.get(id) ?? null,
    insertNote: async (n) => { const r = { id: crypto.randomUUID(), created_at: nowIso(), updated_at: nowIso(), kind: "memo", body: "", ...n }; t.notes.set(r.id, r); return r; },
    updateNote: async (id, uid, p) => { const n = t.notes.get(id); if (!n || n.user_id !== uid) return null; Object.assign(n, p, { updated_at: nowIso() }); return n; },
    deleteNote: async (id, uid) => { const n = t.notes.get(id); if (n && n.user_id === uid) t.notes.delete(id); },
  };
}

const store: Store = env("PK_STORE") === "memory" ? memoryStore() : supabaseStore();

// ─────────────────────────── 도구 ───────────────────────────
class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Row = {}) { super(message); }
}
const fail = (status: number, code: string, message: string, extra: Row = {}) => { throw new HttpError(status, code, message, extra); };

function cors(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-session, authorization, apikey, x-client-info",
    "Access-Control-Max-Age": "600",
  };
  if (origin && EXPECTED_ORIGINS.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

async function sha256Hex(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomToken() {
  return isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)));
}
const cleanName = (s: unknown, fallback: string) => {
  const v = String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40);
  return v || fallback;
};

function publicCred(c: Row) {
  return {
    id: c.id, name: c.name, createdAt: c.created_at, lastUsedAt: c.last_used_at,
    deviceType: c.device_type, backedUp: c.backed_up, transports: c.transports, aaguid: c.aaguid,
    publicKey: c.public_key, publicKeyFormat: "COSE_Key (base64url) — 공개키",
  };
}
const publicUser = (u: Row) => ({ id: u.id, username: u.username, displayName: u.display_name, createdAt: u.created_at });
const publicNote = (n: Row) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, createdAt: n.created_at, updatedAt: n.updated_at });

// 요청 헤더 x-session 의 토큰으로 사람을 알아봅니다. 없거나 틀리면 401.
async function requireSession(req: Request) {
  const token = req.headers.get("x-session") ?? "";
  if (!token) fail(401, "no_session", "패스키로 들어가야 볼 수 있습니다.");
  const s = await store.getSession(await sha256Hex(token));
  if (!s) fail(401, "bad_session", "알 수 없는 세션입니다.");
  if (s!.revoked_at) fail(401, "session_revoked", "로그아웃된 세션입니다. 다시 패스키로 들어가 주세요.");
  if (s!.expires_at <= nowIso()) fail(401, "session_expired", "세션이 만료되었습니다.");
  const user = await store.getUser(s!.user_id);
  if (!user) fail(401, "no_user", "계정이 없습니다.");
  return { session: s!, user: user!, tokenHash: await sha256Hex(token) };
}

async function newSession(userId: string, credentialId: string) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await store.insertSession({ token_hash: await sha256Hex(token), user_id: userId, credential_id: credentialId, expires_at: expires });
  return { token, expiresAt: expires };
}

function challengeFailure(c: Consume, kind: "등록" | "로그인") {
  const status = kind === "로그인" ? 401 : 400;
  const map: Record<string, [string, string]> = {
    missing: ["challenge_missing", `서버가 보관한 ${kind} 질문이 아닙니다.`],
    used: ["challenge_used", `이미 한 번 쓴 ${kind} 질문입니다. 새 질문을 받아 다시 시도하세요.`],
    expired: ["challenge_expired", `${kind} 질문의 유효 시간(5분)이 지났습니다.`],
    wrong_purpose: ["challenge_wrong_purpose", `${kind}용 질문이 아닙니다.`],
  };
  const [code, msg] = map[c.status];
  fail(status, code, msg);
}

async function readJson(req: Request): Promise<Row> {
  if (req.method === "GET" || req.method === "DELETE") return {};
  try { return (await req.json()) ?? {}; } catch { fail(400, "bad_json", "요청 본문이 JSON이 아닙니다."); }
  return {};
}

// ─────────────────────────── 경로 ───────────────────────────
async function route(req: Request, path: string): Promise<Response | Row> {
  const m = req.method;
  const body = await readJson(req);

  if (m === "GET" && path === "/health") {
    // 서버 상태 확인용. 키 값은 절대 내보내지 않고, 어떤 이름의 환경변수가 있는지만 알려 줍니다.
    try {
      return { ok: true, rpID: RP_ID, origins: EXPECTED_ORIGINS, registrationOpen: (await store.getSetting("registration_open")) === true };
    } catch (e) {
      return new Response(JSON.stringify({
        ok: false, db: "error", reason: String((e as Error).message).slice(0, 200),
        keyEnv: ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS"].filter((k) => !!Deno.env.get(k)),
      }), { status: 503 });
    }
  }

  // ── 등록 ①: 질문 만들기 ──────────────────────────────
  if (m === "POST" && path === "/register/options") {
    const hasSession = !!req.headers.get("x-session");
    let userId: string, username: string, displayName: string, newAccount: boolean;
    let exclude: Row[] = [];
    if (hasSession) {
      // 로그인한 사람이 자기 계정에 패스키를 하나 더 붙이는 경우
      const { user } = await requireSession(req);
      userId = user.id; username = user.username; displayName = user.display_name; newAccount = false;
      exclude = await store.listCreds(userId);
      if (exclude.length >= MAX_PASSKEYS) fail(409, "too_many", `패스키는 한 계정에 ${MAX_PASSKEYS}개까지입니다.`);
    } else {
      if ((await store.getSetting("registration_open")) !== true) {
        fail(403, "registration_closed", "새 계정 만들기는 닫혀 있습니다. 이미 있는 계정은 로그인 뒤 패스키를 추가할 수 있습니다.");
      }
      username = String(body.username ?? "").trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{2,19}$/.test(username)) fail(400, "bad_username", "아이디는 영문 소문자·숫자·-·_ 3~20자입니다.");
      if (await store.getUserByName(username)) fail(409, "username_taken", "이미 있는 아이디입니다. 그 계정이 본인 것이라면 로그인 뒤 패스키를 추가하세요.");
      displayName = cleanName(body.displayName, username);
      userId = crypto.randomUUID(); newAccount = true;
    }
    const options = await generateRegistrationOptions({
      rpName: RP_NAME, rpID: RP_ID,
      userName: username, userDisplayName: displayName,
      userID: new TextEncoder().encode(userId),
      attestationType: "none",
      excludeCredentials: exclude.map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      supportedAlgorithmIDs: ALGS,
      timeout: 120000,
    });
    const ch = await store.insertChallenge({
      challenge: options.challenge, purpose: "register", user_id: userId, username,
      new_account: newAccount, expires_at: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    });
    store.purgeChallenges().catch(() => {});
    return { challengeId: ch.id, expiresAt: ch.expires_at, options };
  }

  // ── 등록 취소: 쓰지 않은 질문을 지워 서버에 아무것도 남지 않게 ──
  if (m === "POST" && path === "/register/cancel") {
    const removed = await store.cancelChallenge(String(body.challengeId ?? ""));
    return { cancelled: true, removedChallenge: removed, stored: "nothing" };
  }

  // ── 등록 ②: 기기가 돌려준 공개키 확인·저장 ─────────────
  if (m === "POST" && path === "/register/verify") {
    const response = body.response;
    if (!response?.id || !response?.response?.attestationObject) fail(400, "bad_response", "등록 응답이 비어 있습니다.");
    const c = await store.consumeChallenge(String(body.challengeId ?? ""), "register");
    if (c.status !== "ok") challengeFailure(c, "등록");
    const ch = c.row!;
    if (!ch.new_account) {
      const { user } = await requireSession(req);
      if (user.id !== ch.user_id) fail(403, "not_your_challenge", "다른 계정의 등록 질문입니다.");
    } else if (await store.getUserByName(ch.username)) {
      fail(409, "username_taken", "그 사이에 같은 아이디가 만들어졌습니다.");
    }
    let v;
    try {
      v = await verifyRegistrationResponse({
        response, expectedChallenge: ch.challenge, expectedOrigin: EXPECTED_ORIGINS, expectedRPID: RP_ID,
        requireUserVerification: true, supportedAlgorithmIDs: ALGS,
      });
    } catch (e) {
      fail(400, "registration_rejected", `등록 응답 확인 실패: ${(e as Error).message}`);
    }
    if (!v!.verified) fail(400, "registration_rejected", "등록 응답을 확인하지 못했습니다.");
    const info = v!.registrationInfo!;
    if (await store.getCred(info.credential.id)) fail(409, "credential_exists", "이미 등록된 패스키입니다.");
    if (ch.new_account) await store.createUser({ id: ch.user_id, username: ch.username, display_name: ch.username });
    const existing = ch.new_account ? 0 : (await store.listCreds(ch.user_id)).length;
    const row = {
      id: info.credential.id,
      user_id: ch.user_id,
      public_key: isoBase64URL.fromBuffer(info.credential.publicKey),
      counter: info.credential.counter,
      transports: info.credential.transports ?? response.response?.transports ?? [],
      device_type: info.credentialDeviceType,
      backed_up: info.credentialBackedUp,
      aaguid: info.aaguid,
      name: cleanName(body.name, `패스키 ${existing + 1}`),
    };
    await store.insertCred(row);
    const saved = (await store.getCred(row.id))!;
    const out: Row = { registered: true, newAccount: ch.new_account, credential: publicCred(saved) };
    if (ch.new_account) out.session = await newSession(ch.user_id, row.id);
    return out;
  }

  // ── 로그인 ①: 질문 만들기 (아이디 없이, 기기에 저장된 패스키로) ──
  if (m === "POST" && path === "/login/options") {
    const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: "required", timeout: 120000 });
    const ch = await store.insertChallenge({
      challenge: options.challenge, purpose: "login",
      expires_at: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    });
    store.purgeChallenges().catch(() => {});
    return { challengeId: ch.id, expiresAt: ch.expires_at, options };
  }

  // ── 로그인 ②: 서명을 저장된 공개키로 확인 ──────────────
  if (m === "POST" && path === "/login/verify") {
    const response = body.response;
    if (!response?.id || !response?.response?.signature) fail(400, "bad_response", "로그인 응답이 비어 있습니다.");
    const c = await store.consumeChallenge(String(body.challengeId ?? ""), "login");
    if (c.status !== "ok") challengeFailure(c, "로그인");
    const cred = await store.getCred(response.id);
    if (!cred) fail(401, "unknown_credential", "등록되지 않았거나 지워진 패스키입니다.");
    // 기기가 알려 준 사용자 번호(userHandle)와 서버에 적힌 주인이 같아야 합니다.
    if (response.response.userHandle) {
      let handle = "";
      try { handle = new TextDecoder().decode(isoBase64URL.toBuffer(response.response.userHandle)); } catch { /* 아래에서 거절 */ }
      if (handle !== cred!.user_id) fail(401, "user_mismatch", "패스키 주인과 계정이 맞지 않습니다.");
    }
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response, expectedChallenge: c.row!.challenge, expectedOrigin: EXPECTED_ORIGINS, expectedRPID: RP_ID,
        requireUserVerification: true,
        credential: { id: cred!.id, publicKey: isoBase64URL.toBuffer(cred!.public_key), counter: Number(cred!.counter), transports: cred!.transports },
      });
    } catch (e) {
      fail(401, "signature_rejected", `서명 확인 실패: ${(e as Error).message}`);
    }
    if (!v!.verified) fail(401, "signature_rejected", "서명이 저장된 공개키와 맞지 않습니다.");
    await store.touchCred(cred!.id, v!.authenticationInfo.newCounter);
    const user = (await store.getUser(cred!.user_id))!;
    return { verified: true, user: publicUser(user), credential: { id: cred!.id, name: cred!.name }, session: await newSession(user.id, cred!.id) };
  }

  // ── 로그아웃 ──────────────────────────────────────
  if (m === "POST" && path === "/logout") {
    const { tokenHash } = await requireSession(req);
    await store.revokeSession(tokenHash);
    return { loggedOut: true };
  }

  // ── 여기부터는 모두 로그인한 사람의 자료만 ───────────────
  if (m === "GET" && path === "/me") {
    const { user, session } = await requireSession(req);
    return { user: publicUser(user), session: { createdAt: session.created_at, expiresAt: session.expires_at } };
  }

  if (m === "GET" && path === "/vault") {
    // 주소에 ?user=다른사람 을 붙여도 무시합니다. 누구의 자료인지는 세션만 정합니다.
    const { user } = await requireSession(req);
    const [notes, creds] = await Promise.all([store.listNotes(user.id), store.listCreds(user.id)]);
    return { user: publicUser(user), notes: notes.map(publicNote), credentials: creds.map(publicCred) };
  }

  if (path === "/notes" && m === "GET") {
    const { user } = await requireSession(req);
    return { notes: (await store.listNotes(user.id)).map(publicNote) };
  }
  if (path === "/notes" && m === "POST") {
    const { user } = await requireSession(req);
    const title = String(body.title ?? "").trim().slice(0, 80);
    if (!title) fail(400, "bad_note", "제목이 비어 있습니다.");
    const kind = ["memo", "list", "retro"].includes(body.kind) ? body.kind : "memo";
    // 본문에 user_id 를 적어 보내도 쓰지 않습니다. 주인은 언제나 세션의 사람입니다.
    const n = await store.insertNote({ user_id: user.id, kind, title, body: String(body.body ?? "").slice(0, 4000) });
    return new Response(JSON.stringify({ note: publicNote(n) }), { status: 201 });
  }

  const noteM = path.match(/^\/notes\/([0-9a-f-]{36})$/);
  if (noteM) {
    const { user } = await requireSession(req);
    const n = await store.getNote(noteM[1]);
    if (!n) fail(404, "not_found", "없는 항목입니다.");
    if (n!.user_id !== user.id) fail(403, "not_yours", "다른 계정의 비공개 자료입니다.");
    if (m === "GET") return { note: publicNote(n!) };
    if (m === "PATCH") {
      const patch: Row = {};
      if (body.title !== undefined) { patch.title = String(body.title).trim().slice(0, 80); if (!patch.title) fail(400, "bad_note", "제목이 비어 있습니다."); }
      if (body.body !== undefined) patch.body = String(body.body).slice(0, 4000);
      if (body.kind !== undefined && ["memo", "list", "retro"].includes(body.kind)) patch.kind = body.kind;
      return { note: publicNote((await store.updateNote(n!.id, user.id, patch))!) };
    }
    if (m === "DELETE") { await store.deleteNote(n!.id, user.id); return { deleted: true, id: n!.id }; }
  }

  if (path === "/credentials" && m === "GET") {
    const { user } = await requireSession(req);
    return { credentials: (await store.listCreds(user.id)).map(publicCred) };
  }
  const credM = path.match(/^\/credentials\/([A-Za-z0-9_-]{8,1400})$/);
  if (credM) {
    const { user } = await requireSession(req);
    const c = await store.getCred(credM[1]);
    if (!c) fail(404, "not_found", "없는 패스키입니다.");
    if (c!.user_id !== user.id) fail(403, "not_yours", "다른 계정의 패스키는 바꾸거나 지울 수 없습니다.");
    if (m === "PATCH") {
      await store.renameCred(c!.id, user.id, cleanName(body.name, c!.name));
      return { credential: publicCred((await store.getCred(c!.id))!) };
    }
    if (m === "DELETE") {
      const all = await store.listCreds(user.id);
      if (all.length <= 1) {
        fail(409, "last_passkey", "마지막 남은 패스키는 지울 수 없습니다. 이것까지 지우면 비밀번호가 없는 이 계정에는 아무도 다시 들어올 수 없습니다. 새 패스키를 먼저 추가하세요.");
      }
      await store.deleteCred(c!.id, user.id);
      // 잃어버린 기기의 패스키를 지웠다면, 그 패스키로 이미 열려 있던 세션도 함께 끊습니다.
      const revokedSessions = await store.revokeSessionsByCred(c!.id);
      return { deleted: true, id: c!.id, remaining: all.length - 1, revokedSessions };
    }
  }

  fail(404, "no_route", `없는 경로입니다: ${m} ${path}`);
  return {};
}

export async function handler(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  const headers = { ...cors(origin), "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const url = new URL(req.url);
  const i = url.pathname.indexOf("/passkey");
  const path = (i >= 0 ? url.pathname.slice(i + "/passkey".length) : url.pathname).replace(/\/+$/, "") || "/";
  try {
    const out = await route(req, path);
    if (out instanceof Response) {
      const h = new Headers(out.headers);
      for (const [k, v] of Object.entries(headers)) h.set(k, v);
      return new Response(out.body, { status: out.status, headers: h });
    }
    return new Response(JSON.stringify(out), { status: 200, headers });
  } catch (e) {
    if (e instanceof HttpError) {
      return new Response(JSON.stringify({ error: e.code, message: e.message, ...e.extra }), { status: e.status, headers });
    }
    console.error(e);
    return new Response(JSON.stringify({ error: "server_error", message: "서버 오류" }), { status: 500, headers });
  }
}

Deno.serve(handler);
