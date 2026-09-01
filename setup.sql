-- Chunk & Catch 단어장 — Supabase 스키마
-- Supabase 대시보드 > SQL Editor 에 전체를 붙여넣고 Run 하세요.

create table if not exists vocab_entries (
  id bigint generated always as identity primary key,
  -- 소유자. 기본값이 auth.uid() 라 클라이언트가 따로 넣지 않아도 채워진다.
  user_id uuid not null default auth.uid(),
  type text not null default 'word' check (type in ('word', 'idiom')),
  term text not null,
  meaning text not null,
  source_sentence text,
  -- 플래시카드 학습 이력
  known boolean not null default false,
  review_count int not null default 0,
  wrong_count int not null default 0,
  last_reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

-- 같은 단어를 여러 문장에서 만나도 한 번만 쌓이게 (사용자 단위)
create unique index if not exists vocab_entries_term_uniq
  on vocab_entries (user_id, type, lower(term));

create index if not exists vocab_entries_created_idx
  on vocab_entries (created_at desc);

-- RLS: 로그인한 사용자가 '자기 행만' 읽고 쓸 수 있다.
-- (authenticated 전체 허용으로 두면 아무나 가입해서 남의 단어장을 보게 된다)
alter table vocab_entries enable row level security;

create policy "own rows only" on vocab_entries
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
