-- ALEPH T08 · 소개 페이지 패스키 잠금 (pds-diary Supabase 프로젝트에 추가)
-- 기존 T06·T07 표(pds_*, auth.*)는 건드리지 않습니다. 새 표는 모두 pk_ 로 시작합니다.
-- 이 표들은 Edge Function(service_role)만 읽고 씁니다. 브라우저(anon·authenticated)는
-- RLS 정책이 없고 권한도 회수해서 REST로 직접 읽을 수 없습니다.

create table if not exists public.pk_settings (
  key   text primary key,
  value jsonb not null
);
insert into public.pk_settings(key, value) values ('registration_open', 'true'::jsonb)
on conflict (key) do nothing;

create table if not exists public.pk_users (
  id           uuid primary key,
  username     text not null unique check (username ~ '^[a-z0-9][a-z0-9_-]{2,19}$'),
  display_name text not null default '' check (char_length(display_name) <= 40),
  created_at   timestamptz not null default now()
);

-- 패스키 = 공개키. 개인키는 이 표에 없고, 서버 어디에도 없습니다.
create table if not exists public.pk_credentials (
  id            text primary key,                  -- credential ID (base64url)
  user_id       uuid not null references public.pk_users(id) on delete cascade,
  public_key    text not null,                     -- COSE 공개키 (base64url)
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  device_type   text not null default 'singleDevice',
  backed_up     boolean not null default false,
  aaguid        text not null default '',
  name          text not null check (char_length(name) between 1 and 40),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index if not exists pk_credentials_user_idx on public.pk_credentials(user_id);

-- 일회용 질문(challenge). 확인에 쓰이면 used_at이 찍히고 다시는 통하지 않습니다.
create table if not exists public.pk_challenges (
  id          uuid primary key default gen_random_uuid(),
  challenge   text not null unique,
  purpose     text not null check (purpose in ('register','login')),
  user_id     uuid,                                -- 새 계정 등록이면 미리 정한 id, 추가 등록이면 로그인한 사람
  username    text,
  new_account boolean not null default false,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

-- 로그인 뒤 사람을 알아보는 세션 토큰. 원래 값은 저장하지 않고 SHA-256만 저장합니다.
create table if not exists public.pk_sessions (
  token_hash  text primary key,
  user_id     uuid not null references public.pk_users(id) on delete cascade,
  credential_id text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);
create index if not exists pk_sessions_user_idx on public.pk_sessions(user_id);

-- 비공개 자리의 항목들 (만들어 넣은 내용만)
create table if not exists public.pk_notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.pk_users(id) on delete cascade,
  kind        text not null default 'memo' check (kind in ('memo','list','retro')),
  title       text not null check (char_length(title) between 1 and 80),
  body        text not null default '' check (char_length(body) <= 4000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists pk_notes_user_idx on public.pk_notes(user_id);

-- 브라우저 쪽 역할은 이 표들에 아무 권한도 없게
alter table public.pk_settings    enable row level security;
alter table public.pk_users       enable row level security;
alter table public.pk_credentials enable row level security;
alter table public.pk_challenges  enable row level security;
alter table public.pk_sessions    enable row level security;
alter table public.pk_notes       enable row level security;
revoke all on public.pk_settings, public.pk_users, public.pk_credentials,
              public.pk_challenges, public.pk_sessions, public.pk_notes
  from anon, authenticated;
-- 새 프로젝트는 새 표를 service_role에도 자동으로 열어 주지 않으므로, 서버(Edge Function)에만 명시적으로 권한을 줍니다.
grant select, insert, update, delete on public.pk_settings, public.pk_users, public.pk_credentials,
  public.pk_challenges, public.pk_sessions, public.pk_notes to service_role;

-- 확인용: 아래 결과가 6줄, 모두 rowsecurity = true 이면 성공
select tablename, rowsecurity from pg_tables
 where schemaname = 'public' and tablename like 'pk\_%' order by tablename;
