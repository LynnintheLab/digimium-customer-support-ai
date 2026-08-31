-- Audit customer-topic deletion while preserving customer conversations.

begin;

create table if not exists public.deleted_customer_topics (
  id                           bigint generated always as identity primary key,
  customer_id                  bigint not null references public.customers(id) on delete cascade,
  support_group_id             smallint not null,
  message_thread_id            bigint not null,
  deleted_by_telegram_id       bigint not null,
  deleted_at                   timestamptz not null default now()
);

alter table public.customer_topics
  add column if not exists deleted_at timestamptz;

alter table public.customer_topics
  add column if not exists deleted_by_telegram_id bigint;

create index if not exists idx_deleted_customer_topics_customer
  on public.deleted_customer_topics(customer_id, deleted_at desc);

alter table public.deleted_customer_topics enable row level security;

revoke all on table public.deleted_customer_topics from anon, authenticated;

grant select, insert on table public.deleted_customer_topics to service_role;
grant usage, select on sequence public.deleted_customer_topics_id_seq
  to service_role;

commit;
