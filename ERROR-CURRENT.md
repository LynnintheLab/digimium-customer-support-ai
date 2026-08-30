# RESOLVED — Telegram webhook 401

Resolved on 31 August 2026.

## What was actually wrong

The live Supabase function named `telegram-bot` was still the generated
“Hello from Functions!” template. That template used:

```ts
withSupabase({ auth: ["publishable", "secret"] })
```

Telegram does not send a Supabase API key, so that handler returned:

```json
{"message":"Invalid credentials","code":"INVALID_CREDENTIALS"}
```

The local bot source and `verify_jwt=false` configuration were correct; the
actual bot file simply had not replaced the authenticated template. This is
why the logs contained “Hello from Functions!”. The earlier conclusion that
Supabase's new API-key system made public webhooks impossible was incorrect.

## Fix applied

1. Downloaded and compared the deployed source with the local entrypoint.
2. Deployed `supabase/functions/telegram-bot/index.ts` explicitly with
   `--project-ref nrbvowuozpbforgibdpq --no-verify-jwt`.
3. Added `TELEGRAM_WEBHOOK_SECRET` and require Telegram's
   `X-Telegram-Bot-Api-Secret-Token` header on every webhook POST.
4. Reconfigured Telegram's webhook through the secured `/setup-webhook` route.
5. Added checked Telegram/Supabase errors, an authenticated `/self-test`, and
   authenticated `/webhook-status` diagnostics.
6. Corrected Gemini 3.6 settings for the current API.

## Verified live

- Public health endpoint: HTTP 200, correct bot service.
- Forged POST without Telegram's secret: HTTP 401 from our handler.
- `/start` delivery through the live bot token: HTTP 200 and message sent.
- Telegram `getWebhookInfo`: correct URL, zero pending updates, no last error.
- Authenticated self-test: Telegram, Supabase database, and Gemini all pass.
- Model: `gemini-3.6-flash` responds successfully.

The webhook is the recommended production path. Polling is not needed for this
incident.

## Important corrections to the old notes

- `verify_jwt=false` is Supabase's supported configuration for external
  webhooks. A persistent 401 should trigger a deployed-source/config check.
- Current Google AI Studio keys can begin with `AQ.`; requiring `AIza` is
  obsolete. Test the key through the API instead of checking its prefix.
- Deno Deploy is not a reliable always-on, single-instance long-polling host.

See `SETUP.md` for the current deployment and diagnostic commands.
