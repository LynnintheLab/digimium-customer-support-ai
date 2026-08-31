-- Receipt-aware payment confirmation workflow.

begin;

create table if not exists public.payment_confirmations (
  id                           bigint generated always as identity primary key,
  customer_id                  bigint not null references public.customers(id) on delete cascade,
  message_thread_id            bigint,
  status                       text not null
                               check (status in (
                                 'awaiting_receipt',
                                 'pending_admin',
                                 'received',
                                 'not_received'
                               )),
  customer_notice              text,
  receipt_message_id           bigint,
  receipt_kind                 text,
  confirmed_by_telegram_id     bigint,
  confirmed_at                 timestamptz,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

create index if not exists idx_payment_confirmations_customer_status
  on public.payment_confirmations(customer_id, status, created_at desc);

alter table public.payment_confirmations enable row level security;

revoke all on table public.payment_confirmations from anon, authenticated;

grant select, insert, update on table public.payment_confirmations
  to service_role;
grant usage, select on sequence public.payment_confirmations_id_seq
  to service_role;

update public.settings
set value = value || $payment_rules$

PAYMENT CONFIRMATION WORKFLOW:
- Never claim that a payment was received until an admin explicitly confirms it.
- If a customer says they transferred or paid but did not provide a receipt, ask them to send the payment receipt.
- If the receipt is already attached or was just provided, do not ask for it again. Tell the customer to wait for admin confirmation.
- A receipt or a customer's claim is not proof of receipt. Only the admin commands /receive and /notreceive decide the result.
- After /receive, tell the customer that the payment was received and the order will continue.
- After /notreceive, tell the customer that the payment has not arrived and ask them to recheck the destination account, amount, and transaction status.
$payment_rules$
where key = 'system_prompt'
  and position('PAYMENT CONFIRMATION WORKFLOW:' in value) = 0;

commit;
