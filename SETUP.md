# Setup Guide

You already have: Supabase project, database (schema.sql run), Gemini key,
BotFather token, admin chat id 1506907137.

Use Option A (webhook) for production. Option B is an emergency fallback for a
true always-on, single-instance worker.

---

## Common step (both options): create the database

Supabase -> SQL Editor -> New query -> paste all of `db/schema.sql` -> Run.
You should see "Success". This creates the tables and loads your prices +
policies into the `settings` table. For an existing installation, run
`db/security-migration.sql` once instead; it keeps the data and removes direct
anonymous/authenticated access. (This migration has already been applied to
the live project.)

For the private support-group workflow, also run
`db/support-topics-migration.sql`. It creates the topic mappings, admin modes,
conversation summaries, reviewed-knowledge queue, duplicate-update guard, and
the five-minute scheduler that finds conversations inactive for 30 minutes.
Then run `db/delete-topic-migration.sql` to enable safely confirmed topic
deletion with retained database history and an audit log.

---

## OPTION A - Webhook on Supabase (serverless)

1. Files are in `supabase/`. From the project root:
   ```
   supabase login
   supabase link --project-ref nrbvowuozpbforgibdpq
   ```

2. Make sure `supabase/config.toml` contains exactly:
   ```
   project_id = "nrbvowuozpbforgibdpq"

   [functions.telegram-bot]
   enabled = true
   verify_jwt = false
   entrypoint = "./functions/telegram-bot/index.ts"
   ```
   (Only ONE [functions.telegram-bot] block. Duplicates cause CliConfigParseError.)

3. Set secrets:
   ```
   supabase secrets set TELEGRAM_TOKEN=your_botfather_token
   supabase secrets set GEMINI_KEY=your_gemini_key
   supabase secrets set ADMIN_CHAT_ID=1506907137
   supabase secrets set TELEGRAM_WEBHOOK_SECRET=a_random_64_character_hex_value
   ```
   Generate the webhook secret with `openssl rand -hex 32`, copy its output,
   and use that same value in step 7. Never commit it.

4. Deploy:
   ```
   supabase functions deploy telegram-bot --no-verify-jwt
   ```

5. Verify the deployed source before touching Telegram:
   ```
   curl -i https://nrbvowuozpbforgibdpq.supabase.co/functions/v1/telegram-bot
   ```
   Expect HTTP 200 and `"service":"digimium-telegram-bot"`. If the response
   says `Invalid credentials` or `Hello`, the wrong source is deployed.

6. The Dashboard/CLI metadata must show `verify_jwt=false`. Do not add an anon
   key to the webhook URL; Telegram authentication uses its dedicated secret.

7. Configure the webhook through the bot's authenticated setup route. Replace
   `WEBHOOK_SECRET` with the same value from step 3:
   ```
   curl -X POST \
     -H "X-Telegram-Bot-Api-Secret-Token: WEBHOOK_SECRET" \
     https://nrbvowuozpbforgibdpq.supabase.co/functions/v1/telegram-bot/setup-webhook
   ```
   Expect `"ok":true`, the correct URL, no last error, and eventually zero
   pending updates.

8. Run the authenticated dependency self-test with the same header and the URL
   ending in `/self-test`. Telegram, database, and Gemini must all show
   `"ok":true`.

9. Message the bot `/start`, then `ChatGPT Plus ဘယ်လောက်လဲ`.

10. Register the private admin group:
    - General topic: `/setup`
    - Knowledge Review topic: `/setup knowledge`
    - System Log topic: `/setup logs`

The bot must be a group admin with Manage Topics, and human admins must have
Remain Anonymous disabled. See `docs/SUPPORT-GROUP.md`.

---

## OPTION B - Polling (fallback only)

The file is `polling-bot/bot.ts`. It needs no webhook and no Supabase function.

### B1. Test it on your Mac first
1. Install Deno (one time):
   ```
   curl -fsSL https://deno.land/install.sh | sh
   ```
   (restart terminal, or follow the PATH line it prints)

2. Set env vars and run (fill in your values):
   ```
   export TELEGRAM_TOKEN=your_botfather_token
   export GEMINI_KEY=your_gemini_key
   export ADMIN_CHAT_ID=1506907137
   export SUPABASE_URL=https://nrbvowuozpbforgibdpq.supabase.co
   export SUPABASE_SECRET=your_backend_secret_or_service_role_key
   deno run --allow-net --allow-env polling-bot/bot.ts
   ```

3. You should see "Digimium bot polling started." Message the bot `/start` and
   `ChatGPT Plus ဘယ်လောက်လဲ`. It replies. (While your Mac + terminal stay open.)

`SUPABASE_SECRET` is backend-only. Never use it in a browser, mobile app, or
public repository.

### B2. Host it correctly

Use a single always-on worker process (for example a VPS or a background-worker
service configured to exactly one replica). Deno Deploy is serverless and may
evict or multiply instances, so it is not an appropriate Telegram long-polling
host. Two pollers will conflict with HTTP 409.

### B3. Important
- Polling and webhook can't both be active. The polling bot auto-calls
  deleteWebhook on start, so it takes over cleanly.
- To go back to webhook later, stop the polling bot and re-run the setWebhook URL.

---

## Test checklist (either option)

| Send to bot                     | Expected                                   |
|---------------------------------|--------------------------------------------|
| /start                          | Burmese greeting                           |
| ChatGPT Plus ဘယ်လောက်လဲ         | 130,000 Ks (fix price)                      |
| Netflix ဘယ်လောက်လဲ              | 18,000 / 19,997 Ks                          |
| Gamma ရှိလား                    | 78,000 / 165,000 Ks                         |
| ငွေလွှဲပြီးပါပြီ                 | "team will help" + handoff alert to you     |

---

## Troubleshooting

- **No reply / 401** -> health-check the function and inspect the deployed
  source. `Invalid credentials` usually means an authenticated template or
  wrapper is still deployed.
- **Gemini error / no price answers** -> run `/self-test` and replace the key
  only if Google rejects it. Current `AQ.` keys are valid; do not prefix-check.
- **CliConfigParseError** -> `supabase/config.toml` has a duplicate
  [functions.telegram-bot] block. Keep only one.
- **Bot can't message you for handoffs** -> open your bot once and press Start,
  so Telegram allows it to message you.
