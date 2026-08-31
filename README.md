# Digimium Telegram Support Bot

> **LIVE STATUS: FIXED (31 Aug 2026).** The 401 came from Supabase's default
> authenticated “Hello” template still being deployed under `telegram-bot`; the
> actual bot source had never replaced it. The real webhook handler is now
> deployed, protected by Telegram's webhook secret, and verified end to end.

A Burmese-language AI customer-support bot for Digimium (digital subscription
shop). It answers price/product questions from your real price list, remembers
each customer, caps usage per day, and hands off to you (admin) for payments,
refunds, broken accounts, and unlisted prices.

---

## What it does

- Replies in Burmese, in your shop's style (trained on 35,000 of your real chats).
- Quotes exact prices from your price list (ChatGPT, Gemini, Claude, Spotify,
  Netflix, VPN, and more), including Official / Fix / Not-Official plans.
- For products not on the list: gives a rough estimate (USD x 6,500) and says
  "confirm with admin".
- Remembers each customer's recent conversation.
- 40 messages/day per customer (editable).
- When a customer needs a human (payment, refund, broken account, unlisted
  price), it tells them the team will help AND pings your Telegram (id 1506907137).
- Logs every chat and every handoff to the database.
- Creates one private admin-group topic per customer on their next message.
- Mirrors customer and bot messages into that topic; an admin's normal topic
  message is relayed directly to the customer.
- Supports hybrid AI/admin handling, total handoff, manual or 30-minute
  inactivity summaries, and owner-reviewed learned knowledge.

---

## Architecture (plain words)

```
Customer (Telegram)
        |
        v
  Telegram servers
        |
        v
  [ Your bot code ]  <-- webhook OR polling
        |  reads prices/policies + customer memory
        |  asks Gemini for a Burmese reply
        v
  Gemini (Google)  ->  writes the answer
        |
        v
  Bot sends reply back to customer
        |
        +--> saves chat + usage to Supabase (Postgres)
        +--> if handoff: pings Admin Telegram
```

- **Brain / tone:** Gemini `gemini-3.6-flash` (cheap, good Burmese).
- **Facts:** your price list + policies, stored in the `settings` table.
- **Memory / usage / handoffs:** Supabase Postgres database.
- **Channel:** Telegram Bot API.

There are two ways to run the bot code. The webhook is the production path.

### Option A - Webhook on Supabase Edge Functions
Telegram pushes each message to a Supabase function URL.
This is the recommended, serverless deployment. `verify_jwt=false` makes the
endpoint reachable by Telegram, while `TELEGRAM_WEBHOOK_SECRET` authenticates
each Telegram request inside the handler.

### Option B - Polling (fallback only)
The bot asks Telegram for new messages instead of Telegram pushing to it.
Run it only on a true always-on, single-instance worker. Do not use a
serverless/scale-to-zero host for long polling, and do not run it at the same
time as the webhook.

---

## Files in this project

```
digimium-bot-project/
├── README.md                         <- this file
├── SETUP.md                          <- step-by-step deploy for both options
├── db/
│   ├── schema.sql                    <- run once for a new database
│   ├── security-migration.sql        <- harden an existing database
│   ├── response-format-migration.sql <- plain-text product list formatting
│   ├── support-topics-migration.sql  <- group topics, relay, review, scheduler
│   ├── delete-topic-migration.sql    <- deletion audit + retained topic mapping
│   └── approved-knowledge-migration.sql <- approved 51-product knowledge
├── supabase/
│   ├── config.toml                   <- Supabase function config (verify_jwt=false)
│   ├── migrations/                   <- linked production migrations
│   └── functions/telegram-bot/
│       └── index.ts                  <- Option A: webhook Edge Function
├── polling-bot/
│   └── bot.ts                        <- Option B: single-worker fallback
└── docs/
    ├── SUPPORT-GROUP.md              <- admin group setup and commands
    ├── digimium_kb.json              <- older compact export
    ├── digimium_full_prices.json     <- full price-editor export
    ├── digimium_approved_knowledge.json <- current owner-approved source
    ├── approved-product-knowledge.txt <- bot-ready approved knowledge
    └── PRICE-CONFLICTS.md            <- resolved owner price decisions
```

---

## Config values (yours)

| Name           | Value                                             |
|----------------|---------------------------------------------------|
| Supabase ref   | `nrbvowuozpbforgibdpq`                            |
| Supabase URL   | `https://nrbvowuozpbforgibdpq.supabase.co`       |
| Admin chat id  | `1506907137`                                      |
| Model          | `gemini-3.6-flash`                                |
| Daily cap      | `40` (row `daily_cap` in `settings`)             |

> SECURITY: regenerate any API key/token that has appeared in screenshots or
> chat. Bot token via @BotFather -> /mybots -> Revoke. Gemini key via AI Studio.

---

## If a 401 returns again

Supabase supports external webhooks with `verify_jwt=false`. A 401 does not mean
the new key system makes webhooks impossible. First download or inspect the
deployed source: the original incident happened because the live function was
still the generated template with
`withSupabase({ auth: ["publishable", "secret"] })`.

Use the health endpoint before setting Telegram's webhook:

```sh
curl -i https://nrbvowuozpbforgibdpq.supabase.co/functions/v1/telegram-bot
```

It must return HTTP 200 and `"service":"digimium-telegram-bot"`. See
`ERROR-CURRENT.md` for the resolved incident and `SETUP.md` for deployment.

---

## Updating prices later (no redeploy)

Prices and approved product comparisons live in the `settings` table, row
`system_prompt`.
Supabase -> Table Editor -> `settings` -> edit `system_prompt` -> Save.
The bot uses the new text on the next message. The current reviewed source is
`docs/digimium_approved_knowledge.json`; JSON files are reference exports and
are not loaded directly at runtime. After a new owner-approved export, run
`scripts/sync-approved-knowledge.mjs` to regenerate the bot-ready knowledge,
database migration, and new-install seed.

## See customers / chats / handoffs

Supabase -> Table Editor -> `customers`, `messages`, `handoffs`, `usage`.
The topic workflow additionally uses `support_groups`, `customer_topics`,
`conversation_summaries`, and `knowledge_candidates`.

## Admin support group

Create a private Telegram supergroup with Topics enabled, add the customer bot
as an administrator with Manage Topics, and keep anonymous-admin mode off. Then
register it from Telegram:

1. General topic: `/setup`
2. Knowledge Review topic: `/setup knowledge`
3. System Log topic: `/setup logs`

See `docs/SUPPORT-GROUP.md` for the relay rules, commands, review buttons, and
safe operating details. The polling fallback is intentionally legacy-only and
does not implement this group workflow; production must remain on the webhook.

## Cost

Gemini 3.6 Flash has a free tier, but request quotas depend on the project and
should be checked in AI Studio. Paid standard pricing through 31 Dec 2026 is
$0.75 per million input tokens and $3.75 per million output/thinking tokens;
Google lists higher rates from 1 Jan 2027. Google marks free-tier data as usable
to improve its products and paid-tier data as not used for that purpose. Check
the current [official pricing page](https://ai.google.dev/gemini-api/docs/pricing)
before estimating monthly cost.
