-- Digimium support-group topics, admin relay, summaries, and reviewed learning.
-- Safe to run on the existing production database.

begin;

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.support_groups (
  id                           smallint primary key default 1 check (id = 1),
  telegram_chat_id             bigint unique not null,
  title                        text,
  knowledge_topic_id           bigint,
  logs_topic_id                bigint,
  configured_by_telegram_id    bigint not null,
  active                       boolean not null default true,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

create table if not exists public.customer_topics (
  customer_id                  bigint primary key references public.customers(id) on delete cascade,
  support_group_id             smallint not null default 1 references public.support_groups(id) on delete cascade,
  message_thread_id            bigint not null,
  mode                         text not null default 'hybrid'
                               check (mode in ('hybrid', 'total_handoff')),
  handoff_active               boolean not null default false,
  last_activity_at             timestamptz not null default now(),
  summary_due_at               timestamptz,
  last_summarized_message_id   bigint,
  last_summary_at              timestamptz,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  unique (support_group_id, message_thread_id)
);

alter table public.messages
  add column if not exists source text;

update public.messages
set source = case when role = 'user' then 'customer' else 'bot' end
where source is null;

alter table public.messages
  alter column source set default 'bot';

alter table public.messages
  alter column source set not null;

alter table public.messages
  add column if not exists telegram_message_id bigint;

alter table public.messages
  add column if not exists telegram_author_id bigint;

create table if not exists public.conversation_summaries (
  id                           bigint generated always as identity primary key,
  customer_id                  bigint not null references public.customers(id) on delete cascade,
  from_message_id              bigint not null,
  to_message_id                bigint not null,
  trigger_type                 text not null check (trigger_type in ('manual', 'inactivity')),
  summary                      text not null,
  created_by_telegram_id       bigint,
  created_at                   timestamptz not null default now(),
  unique (customer_id, to_message_id)
);

create table if not exists public.knowledge_candidates (
  id                           bigint generated always as identity primary key,
  summary_id                   bigint unique not null references public.conversation_summaries(id) on delete cascade,
  customer_id                  bigint not null references public.customers(id) on delete cascade,
  content                      text not null,
  edited_content               text,
  status                       text not null default 'pending'
                               check (status in ('pending', 'approved', 'declined', 'deleted')),
  review_chat_id               bigint,
  review_message_id            bigint,
  reviewed_by_telegram_id      bigint,
  reviewed_at                  timestamptz,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

create table if not exists public.bot_updates (
  telegram_update_id           bigint primary key,
  kind                         text not null,
  status                       text not null default 'processing'
                               check (status in ('processing', 'processed', 'failed')),
  error                        text,
  started_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

create index if not exists idx_customer_topics_summary_due
  on public.customer_topics(summary_due_at)
  where summary_due_at is not null;

create index if not exists idx_messages_customer_id_id
  on public.messages(customer_id, id);

create index if not exists idx_knowledge_candidates_status
  on public.knowledge_candidates(status, reviewed_at desc, created_at desc);

alter table public.support_groups         enable row level security;
alter table public.customer_topics        enable row level security;
alter table public.conversation_summaries enable row level security;
alter table public.knowledge_candidates   enable row level security;
alter table public.bot_updates            enable row level security;

revoke all on table
  public.support_groups,
  public.customer_topics,
  public.conversation_summaries,
  public.knowledge_candidates,
  public.bot_updates
from anon, authenticated;

grant usage on schema public to service_role;
grant select, insert, update on table public.support_groups to service_role;
grant select, insert, update on table public.customer_topics to service_role;
grant select, insert on table public.messages to service_role;
grant select, insert, update on table public.handoffs to service_role;
grant select, insert on table public.conversation_summaries to service_role;
grant select, insert, update on table public.knowledge_candidates to service_role;
grant select, insert, update on table public.bot_updates to service_role;

grant usage, select on sequence
  public.conversation_summaries_id_seq,
  public.knowledge_candidates_id_seq
to service_role;

-- Supabase Cron wakes the Edge Function every five minutes. The endpoint itself
-- performs the exact 30-minute inactivity check and is protected by the random
-- database-only secret generated above.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

insert into public.settings (key, value)
values ('maintenance_secret', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'digimium-auto-summarize') then
    perform cron.unschedule('digimium-auto-summarize');
  end if;
end $$;

select cron.schedule(
  'digimium-auto-summarize',
  '*/5 * * * *',
  $cron$
    select net.http_post(
      url := 'https://nrbvowuozpbforgibdpq.supabase.co/functions/v1/telegram-bot/maintenance',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Maintenance-Secret', (select value from public.settings where key = 'maintenance_secret')
      ),
      body := jsonb_build_object('source', 'supabase-cron')
    );
  $cron$
);

commit;
