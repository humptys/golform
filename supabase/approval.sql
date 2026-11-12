-- GolForm 가입 승인제. Supabase 대시보드 > SQL Editor 에 붙여넣고 한 번 실행한다. (schema.sql 을 먼저 실행한 상태여야 한다)
--
-- 가입은 열어 두되, 관리자가 승인한 계정만 기록을 읽고 쓸 수 있다.
-- - 이 SQL을 실행하는 시점에 이미 가입해 있던 계정은 모두 승인된 것으로 둔다.
-- - 그중 가장 먼저 가입한 계정이 관리자가 된다. 관리자는 앱의 「설정」에서 가입 요청을 승인한다.
-- - 여러 번 실행해도 안전하다.

create table if not exists public.golform_members (
  user_id      uuid        primary key references auth.users (id) on delete cascade,
  email        text,
  approved     boolean     not null default false,
  is_admin     boolean     not null default false,
  requested_at timestamptz not null default now()
);
alter table public.golform_members enable row level security;

-- 알림 설정 등 관리자만 SQL로 다루는 값. 정책을 두지 않아 앱에서는 읽거나 쓸 수 없다.
create table if not exists public.golform_config (
  key   text primary key,
  value text
);
alter table public.golform_config enable row level security;
revoke all on public.golform_config from anon, authenticated;

-- 정책 안에서 자기 자신의 표를 다시 조회하면 무한 반복이 되므로, 권한 확인은 별도 함수로 한다.
create or replace function public.golform_is_approved() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.golform_members where user_id = auth.uid() and approved);
$$;
create or replace function public.golform_is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.golform_members where user_id = auth.uid() and approved and is_admin);
$$;

-- 이미 가입해 있던 계정은 승인 상태로 등록하고, 관리자가 아직 없으면 가장 먼저 가입한 계정을 관리자로 둔다.
insert into public.golform_members (user_id, email, approved, requested_at)
  select id, email, true, created_at from auth.users
  on conflict (user_id) do nothing;
update public.golform_members set is_admin = true, approved = true
  where user_id = (select id from auth.users order by created_at limit 1)
    and not exists (select 1 from public.golform_members where is_admin);

-- 새로 가입하면 승인 대기 상태로 등록하고, 알림 주소가 설정돼 있으면 관리자에게 알림을 보낸다.
-- 어떤 이유로든 실패해도 가입 자체는 막지 않는다.
create or replace function public.golform_on_signup() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  topic text;
begin
  begin
    insert into public.golform_members (user_id, email) values (new.id, new.email)
      on conflict (user_id) do nothing;
  exception when others then
    null;
  end;
  begin
    select value into topic from public.golform_config where key = 'ntfy_topic';
    if coalesce(topic, '') <> '' then
      perform net.http_post(
        url := 'https://ntfy.sh',
        body := jsonb_build_object(
          'topic', topic,
          'title', 'GolForm 가입 요청',
          'message', '새 가입 요청이 있습니다. 앱의 설정 탭에서 승인해 주세요.'
        )
      );
    end if;
  exception when others then
    null;
  end;
  return new;
end;
$$;
drop trigger if exists golform_on_signup on auth.users;
create trigger golform_on_signup after insert on auth.users
  for each row execute function public.golform_on_signup();

-- 등록이 누락된 계정이 로그인했을 때 스스로 승인 대기 상태로 등록하게 하는 안전장치.
create or replace function public.golform_request_access() returns void
  language sql security definer set search_path = public as $$
  insert into public.golform_members (user_id, email)
    select auth.uid(), (select email from auth.users where id = auth.uid())
    where auth.uid() is not null
    on conflict (user_id) do nothing;
$$;

-- 회원 표: 본인 것은 볼 수 있고, 관리자는 전체를 보고 승인 여부를 바꿀 수 있다.
drop policy if exists "golform member read" on public.golform_members;
create policy "golform member read" on public.golform_members
  for select to authenticated
  using (user_id = auth.uid() or public.golform_is_admin());
drop policy if exists "golform member approve" on public.golform_members;
create policy "golform member approve" on public.golform_members
  for update to authenticated
  using (public.golform_is_admin())
  with check (public.golform_is_admin());
revoke all on public.golform_members from anon, authenticated;
grant select on public.golform_members to authenticated;
grant update (approved) on public.golform_members to authenticated; -- 승인 여부만 바꿀 수 있다(관리자 지정은 SQL로만)

revoke all on function public.golform_request_access() from public, anon;
grant execute on function public.golform_request_access() to authenticated;
grant execute on function public.golform_is_approved(), public.golform_is_admin() to authenticated;

-- 기록: 승인된 계정만 자기 기록을 읽고 쓴다.
drop policy if exists "golform own rows" on public.golform_records;
create policy "golform own rows" on public.golform_records
  for all to authenticated
  using (auth.uid() = user_id and public.golform_is_approved())
  with check (auth.uid() = user_id and public.golform_is_approved());
