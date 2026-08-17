-- 業務績效監控儀表板：請在 Supabase Dashboard > SQL Editor 執行本檔案。
-- 安全設計：所有資料皆需登入；只有 profiles.role = 'manager' 能新增、修改與刪除。

create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'viewer' check (role in ('viewer', 'manager')),
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, role) values (new.id, 'viewer') on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

-- 若此專案已有使用者，補齊 viewer profile。
insert into public.profiles (id)
select id from auth.users on conflict (id) do nothing;

create or replace function public.is_manager()
returns boolean
language sql
stable security definer set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'manager');
$$;

create table if not exists public.salespeople (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) > 0),
  job_title text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name)
);

create table if not exists public.performance_entries (
  id uuid primary key default gen_random_uuid(),
  view_date date not null,
  salesperson_id uuid not null references public.salespeople(id) on delete restrict,
  job_title text not null default '',
  valid_calls integer not null default 0 check (valid_calls >= 0),
  valid_meetings integer not null default 0 check (valid_meetings >= 0),
  abay_progress text not null default '',
  svip_progress text not null default '',
  vip_progress text not null default '',
  hvip_progress text not null default '',
  call_progress text not null default '',
  coverage_rate text not null default '',
  projects jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (view_date, salesperson_id)
);

create index if not exists performance_entries_date_idx on public.performance_entries (view_date desc);
create index if not exists performance_entries_salesperson_date_idx on public.performance_entries (salesperson_id, view_date desc);

-- 既有資料庫的遷移：進度欄位從百分比改為自由文字紀錄；舊有數字會保留為文字。
alter table public.performance_entries
  drop constraint if exists performance_entries_abay_progress_check,
  drop constraint if exists performance_entries_svip_progress_check,
  drop constraint if exists performance_entries_vip_progress_check,
  drop constraint if exists performance_entries_hvip_progress_check,
  drop constraint if exists performance_entries_call_progress_check,
  drop constraint if exists performance_entries_coverage_rate_check;

alter table public.performance_entries
  alter column abay_progress drop default,
  alter column svip_progress drop default,
  alter column vip_progress drop default,
  alter column hvip_progress drop default,
  alter column call_progress drop default,
  alter column coverage_rate drop default,
  alter column abay_progress type text using coalesce(abay_progress::text, ''),
  alter column svip_progress type text using coalesce(svip_progress::text, ''),
  alter column vip_progress type text using coalesce(vip_progress::text, ''),
  alter column hvip_progress type text using coalesce(hvip_progress::text, ''),
  alter column call_progress type text using coalesce(call_progress::text, ''),
  alter column coverage_rate type text using coalesce(coverage_rate::text, ''),
  alter column abay_progress set default '',
  alter column svip_progress set default '',
  alter column vip_progress set default '',
  alter column hvip_progress set default '',
  alter column call_progress set default '',
  alter column coverage_rate set default '';

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;

drop trigger if exists set_salespeople_updated_at on public.salespeople;
create trigger set_salespeople_updated_at before update on public.salespeople for each row execute procedure public.set_updated_at();
drop trigger if exists set_performance_entries_updated_at on public.performance_entries;
create trigger set_performance_entries_updated_at before update on public.performance_entries for each row execute procedure public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.salespeople enable row level security;
alter table public.performance_entries enable row level security;

-- 建表於 SQL Editor 時，需另行授予 authenticated 資料表權限；細部存取仍由下方 RLS policies 控制。
grant usage on schema public to authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.salespeople to authenticated;
grant select, insert, update, delete on public.performance_entries to authenticated;

drop policy if exists "authenticated users view profiles" on public.profiles;
create policy "authenticated users view profiles" on public.profiles for select to authenticated using (id = auth.uid());
drop policy if exists "authenticated users view salespeople" on public.salespeople;
create policy "authenticated users view salespeople" on public.salespeople for select to authenticated using (true);
drop policy if exists "managers manage salespeople" on public.salespeople;
create policy "managers manage salespeople" on public.salespeople for all to authenticated using (public.is_manager()) with check (public.is_manager());
drop policy if exists "authenticated users view entries" on public.performance_entries;
create policy "authenticated users view entries" on public.performance_entries for select to authenticated using (true);
drop policy if exists "managers manage entries" on public.performance_entries;
create policy "managers manage entries" on public.performance_entries for all to authenticated using (public.is_manager()) with check (public.is_manager());

-- 建立第一個 Auth 使用者後，將該帳號設為管理者（將 email 換成你的帳號）：
-- update public.profiles set role = 'manager' where id = (select id from auth.users where email = 'YOUR_EMAIL@example.com');
-- 其餘帳號預設為 viewer；要新增管理者時，將 role 更新為 manager 即可。
