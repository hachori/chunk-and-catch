-- Chunk & Catch 단어장 — Supabase 스키마
-- Supabase 대시보드 > SQL Editor 에 전체를 붙여넣고 Run 하세요.

create table if not exists vocab_entries (
  id bigint generated always as identity primary key,
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

-- 같은 단어를 여러 문장에서 만나도 한 번만 쌓이게
create unique index if not exists vocab_entries_term_uniq
  on vocab_entries (type, lower(term));

create index if not exists vocab_entries_created_idx
  on vocab_entries (created_at desc);

-- RLS: 로그인(authenticated)한 사용자만 읽기/쓰기 가능
alter table vocab_entries enable row level security;

create policy "authenticated full access" on vocab_entries
  for all to authenticated using (true) with check (true);
