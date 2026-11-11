-- GolForm 동기화용 테이블. Supabase 대시보드 > SQL Editor 에 붙여넣고 한 번 실행한다.
-- 기준 영상의 측정값과 분석 기록(수치 + 구간 이미지)만 저장하며 영상 원본은 저장하지 않는다.

create table if not exists public.golform_records (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id         text        not null,
  kind       text        not null check (kind in ('ref', 'session')),
  data       jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.golform_records enable row level security;

-- 로그인한 사용자는 자기 행만 읽고 쓸 수 있다
drop policy if exists "golform own rows" on public.golform_records;
create policy "golform own rows" on public.golform_records
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
