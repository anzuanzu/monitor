-- 全員指標與累積指標功能：在 Supabase SQL Editor 執行一次。

create table if not exists public.custom_metric_definitions (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(trim(name)) > 0),
  storage_mode text not null default 'daily' check (storage_mode in ('daily', 'cumulative')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cumulative_metric_values (
  metric_id uuid not null references public.custom_metric_definitions(id) on delete cascade,
  salesperson_id uuid not null references public.salespeople(id) on delete restrict,
  value text not null default '',
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (metric_id, salesperson_id)
);

-- 將既有的自訂欄位納入全員可用的「依日期紀錄」指標，不變更任何既有績效資料。
insert into public.custom_metric_definitions (name, storage_mode)
select distinct metric_name, 'daily'
from public.performance_entries
cross join lateral jsonb_object_keys(projects) as metric_name
where char_length(trim(metric_name)) > 0
on conflict (name) do nothing;

drop trigger if exists set_custom_metric_definitions_updated_at on public.custom_metric_definitions;
create trigger set_custom_metric_definitions_updated_at before update on public.custom_metric_definitions for each row execute procedure public.set_updated_at();
drop trigger if exists set_cumulative_metric_values_updated_at on public.cumulative_metric_values;
create trigger set_cumulative_metric_values_updated_at before update on public.cumulative_metric_values for each row execute procedure public.set_updated_at();

alter table public.custom_metric_definitions enable row level security;
alter table public.cumulative_metric_values enable row level security;
grant select, insert, update, delete on public.custom_metric_definitions to authenticated;
grant select, insert, update, delete on public.cumulative_metric_values to authenticated;

drop policy if exists "authenticated users view metric definitions" on public.custom_metric_definitions;
create policy "authenticated users view metric definitions" on public.custom_metric_definitions for select to authenticated using (true);
drop policy if exists "managers manage metric definitions" on public.custom_metric_definitions;
create policy "managers manage metric definitions" on public.custom_metric_definitions for all to authenticated using (public.is_manager()) with check (public.is_manager());
drop policy if exists "authenticated users view cumulative metric values" on public.cumulative_metric_values;
create policy "authenticated users view cumulative metric values" on public.cumulative_metric_values for select to authenticated using (true);
drop policy if exists "managers manage cumulative metric values" on public.cumulative_metric_values;
create policy "managers manage cumulative metric values" on public.cumulative_metric_values for all to authenticated using (public.is_manager()) with check (public.is_manager());
