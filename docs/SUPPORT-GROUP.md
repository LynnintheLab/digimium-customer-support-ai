# Digimium Private Support Group

The customer continues chatting privately with the Digimium bot. Customers are
never added to this group. The group contains only the owner, trusted support
admins, and the bot.

## One-time Telegram setup

1. Use a private supergroup and enable Topics.
2. Add the Digimium customer bot as an administrator.
3. Give the bot Manage Topics. Delete Messages and Pin Messages are optional.
4. Keep Remain Anonymous off for human admins.
5. Create `Knowledge Review` and `System Log` topics.
6. Send `/setup` in General, `/setup knowledge` in Knowledge Review, and
   `/setup logs` in System Log.

Only the configured group is accepted. The initial `/setup` commands are
restricted to the primary owner ID in `ADMIN_CHAT_ID`. After setup, Telegram
group creator/administrator status controls who may relay or run commands.

## Customer topics

A topic is created lazily when a customer next messages the bot. Existing
customers are not bulk-created, which avoids group clutter and startup load.
From that point, new customer and bot messages are mirrored into the topic.

A normal text or media message written by an admin in a customer topic is sent
to that customer. Use `/note text` for a private group note that must not be
sent. Bot command messages are never relayed.

## Customer-topic commands

- `/totalhandoff` — admin-only mode; AI sends no customer replies.
- `/auto` or `/resumeai` — hybrid mode; AI answers known questions and hands
  unknown or sensitive ones to the topic.
- `/summarize` or `/summerize` — summarize messages added since the previous
  summary and extract reusable facts specifically confirmed by an admin.
- `/close` — resolve the handoff and return to hybrid mode. It deliberately
  leaves the Telegram topic open.
- `/deletetopic` — show a confirmation button, summarize any new conversation,
  then permanently delete the Telegram topic and its Telegram messages. The
  customer, messages, summary, learned candidate, and deletion audit remain in
  the database. If summary creation fails, deletion is cancelled. The next
  customer message creates a fresh topic.
- `/status` — show current mode and handoff state.
- `/note text` — keep the message inside the admin group.
- `/help` — show the topic command list.

## Automatic summary and learning

Every customer or admin activity sets a summary due time 30 minutes ahead.
Supabase Cron wakes the maintenance endpoint every five minutes. When due, the
bot stores a conversation summary. It creates a knowledge candidate only when
the transcript contains a reusable fact from an admin answer; personal data,
payments, credentials, order IDs, and customer-only claims are excluded.

Candidates appear in Knowledge Review with Approve, Edit, Decline, and Delete
controls. Approved facts are appended to the AI's instructions on future
questions. Edit requires replying to the candidate message with
`/edit corrected text`. Delete is a recoverable soft-delete in the database.

## Performance and safety

- Topics are created only for active customers.
- The webhook processes incoming updates; it never scans every Telegram topic.
- The inactivity queue is indexed by its due time and processes a bounded batch.
- Telegram update IDs are recorded to prevent normal webhook retries from
  sending the same customer/admin action twice.
- Webhook, maintenance, customer records, and learned knowledge remain
  backend-only. Browser roles have no direct database access.
