-- Safe, idempotent hardening for an existing Digimium bot database.
-- The bot is a trusted backend and uses service_role; browser roles need no
-- direct access to customer chats, handoffs, usage, or prompt settings.

begin;

alter table public.customers enable row level security;
alter table public.messages  enable row level security;
alter table public.usage     enable row level security;
alter table public.handoffs  enable row level security;
alter table public.settings  enable row level security;

revoke all on table
  public.customers,
  public.messages,
  public.usage,
  public.handoffs,
  public.settings
from anon, authenticated;

grant usage on schema public to service_role;
grant select, insert, update on table public.customers to service_role;
grant select, insert         on table public.messages  to service_role;
grant select, insert, update on table public.usage     to service_role;
grant insert                 on table public.handoffs  to service_role;
grant select                 on table public.settings  to service_role;

grant usage, select on sequence
  public.customers_id_seq,
  public.messages_id_seq,
  public.handoffs_id_seq
to service_role;

commit;
