-- 為全員指標加入欄位型態，number 可直接於表格中輸入數值。
alter table public.custom_metric_definitions
  add column if not exists value_type text not null default 'text';

alter table public.custom_metric_definitions
  drop constraint if exists custom_metric_definitions_value_type_check,
  add constraint custom_metric_definitions_value_type_check check (value_type in ('text', 'number'));
