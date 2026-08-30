// ============================================================
// Digimium Telegram Support Bot - Supabase Edge Function
// Deploy as function name: telegram-bot
// ============================================================
// Secrets required (set with `supabase secrets set` or in dashboard):
//   TELEGRAM_TOKEN   - from @BotFather
//   GEMINI_KEY       - your Gemini API key
//   ADMIN_CHAT_ID    - 1506907137  (your Telegram id, for handoff alerts)
//   TELEGRAM_WEBHOOK_SECRET - random value shared with Telegram
//   SUPABASE_URL         (auto-provided)
//   SUPABASE_SERVICE_ROLE_KEY (auto-provided)
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const TELEGRAM_TOKEN = requiredEnv("TELEGRAM_TOKEN");
const TELEGRAM_WEBHOOK_SECRET = requiredEnv("TELEGRAM_WEBHOOK_SECRET");
const GEMINI_KEY = requiredEnv("GEMINI_KEY");
const ADMIN_CHAT_ID = requiredEnv("ADMIN_CHAT_ID");
const SUPABASE_URL = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
const supabase = createClient(
  SUPABASE_URL,
  requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
);

const TG = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function tgCall(method: string, payload: Record<string, unknown>) {
  const response = await fetch(`${TG}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();
  let result: any;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error(
      `Telegram ${method} returned a non-JSON response (${response.status})`,
    );
  }

  if (!response.ok || !result.ok) {
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(result)}`);
  }
  return result.result;
}

async function tgSend(chatId: number | string, text: string) {
  const chars = Array.from(text.trim() || "...");
  for (let start = 0; start < chars.length; start += 4096) {
    await tgCall("sendMessage", {
      chat_id: chatId,
      text: chars.slice(start, start + 4096).join(""),
    });
  }
}

function bangkokDate(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function getSetting(key: string, fallback: string): Promise<string> {
  const { data, error } = await supabase.from("settings")
    .select("value").eq("key", key).maybeSingle();
  if (error) throw error;
  return data?.value ?? fallback;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const VIDEO_LIST_CLOSING = "ဘယ်တစ်ခု အသေးစိတ် သိချင်ပါသလဲခင်ဗျာ။";
const VIDEO_PRODUCTS = ["Kling AI", "Runway", "HeyGen", "Higgsfield", "CapCut Pro"];

function formatBroadVideoList(question: string, generatedReply: string): string {
  const normalizedQuestion = question.toLowerCase();
  const mentionsVideo = normalizedQuestion.includes("video") ||
    question.includes("ဗီဒီယို");
  const asksForOptions = question.includes("ဘာ") || question.includes("ရှိ") ||
    question.includes("ထုတ်ဖို့") || normalizedQuestion.includes("tool") ||
    normalizedQuestion.includes("generator");
  const namesSpecificProduct = VIDEO_PRODUCTS.some((product) =>
    normalizedQuestion.includes(product.toLowerCase())
  );
  if (!mentionsVideo || !asksForOptions || namesSpecificProduct) return generatedReply;

  const blocks = new Map<string, string[]>();
  let currentProduct: string | null = null;
  for (const rawLine of generatedReply.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const product = VIDEO_PRODUCTS.find((name) =>
      line.toLowerCase() === name.toLowerCase() ||
      line.toLowerCase().startsWith(`${name.toLowerCase()}:`)
    );
    if (product) {
      currentProduct = product;
      const block = [product];
      const inlinePlan = line.slice(product.length).replace(/^[:\s-]+/, "");
      if (inlinePlan) block.push(inlinePlan);
      blocks.set(product, block);
      continue;
    }

    if (
      currentProduct && !line.includes("ရရှိနိုင်ပါတယ်") &&
      !line.includes("ရှိပါတယ်") && !line.includes("သိချင်ပါသလဲ") &&
      !line.startsWith("[HANDOFF")
    ) {
      blocks.get(currentProduct)?.push(line);
    } else {
      currentProduct = null;
    }
  }

  const aiBlocks = VIDEO_PRODUCTS.filter((product) => product !== "CapCut Pro")
    .map((product) => blocks.get(product)).filter(Boolean) as string[][];
  const editBlock = blocks.get("CapCut Pro");
  if (aiBlocks.length === 0 || !editBlock) return generatedReply;

  return [
    "AI Video Generator တွေမှာဆိုရင်",
    "",
    ...aiBlocks.flatMap((block, index) => index === 0 ? block : ["", ...block]),
    "",
    "တို့ ရရှိနိုင်ပါတယ်ခင်ဗျာ။",
    "",
    "Video Edit ဖို့အတွက်ဆိုရင်",
    "",
    ...editBlock,
    "",
    "ရှိပါတယ်ခင်ဗျာ။",
    "",
    VIDEO_LIST_CLOSING,
  ].join("\n");
}

async function geminiGenerate(
  model: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: any }> {
  let lastResult = { ok: false, status: 0, data: {} as any };

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_KEY,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(45_000),
        },
      );
      const raw = await response.text();
      let data: any;
      try {
        data = JSON.parse(raw);
      } catch {
        data = { error: { message: "Gemini returned a non-JSON response" } };
      }

      lastResult = { ok: response.ok, status: response.status, data };
      if (response.ok) return lastResult;

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 3) return lastResult;
    } catch (error) {
      if (attempt === 3) throw error;
    }

    await delay(1_000 * 2 ** attempt + Math.floor(Math.random() * 250));
  }

  return lastResult;
}

async function geminiGenerateWithFallback(
  models: string[],
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: any; model: string }> {
  const candidates = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  let lastResult = { ok: false, status: 0, data: {} as any, model: candidates[0] ?? "" };

  for (const model of candidates) {
    const result = await geminiGenerate(model, payload);
    lastResult = { ...result, model };
    if (result.ok) return lastResult;

    const canTryAnotherModel = result.status === 404 || result.status === 408 ||
      result.status === 429 || result.status >= 500;
    if (!canTryAnotherModel) return lastResult;
  }

  return lastResult;
}

Deno.serve(async (req) => {
  if (req.method === "GET") {
    return Response.json({
      ok: true,
      service: "digimium-telegram-bot",
      webhookSecured: true,
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (
    req.headers.get("x-telegram-bot-api-secret-token") !==
      TELEGRAM_WEBHOOK_SECRET
  ) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const requestPath = new URL(req.url).pathname;
  if (requestPath.endsWith("/self-test")) {
    const checks: Record<string, unknown> = {};
    let model = "gemini-3.6-flash";
    let fallbackModel = "gemini-3.5-flash-lite";

    try {
      const me = await tgCall("getMe", {});
      checks.telegram = { ok: true, username: me.username ?? null };
    } catch (error) {
      console.error("Self-test Telegram error", error);
      checks.telegram = { ok: false };
    }

    try {
      model = await getSetting("model", model);
      fallbackModel = await getSetting("fallback_model", fallbackModel);
      const dailyCap = await getSetting("daily_cap", "40");
      checks.database = { ok: true, settingsReadable: true, dailyCap };
    } catch (error) {
      console.error("Self-test database error", error);
      checks.database = { ok: false };
    }

    try {
      const result = await geminiGenerateWithFallback([model, fallbackModel], {
        contents: [{ role: "user", parts: [{ text: "Reply with OK." }] }],
        generationConfig: {
          maxOutputTokens: 64,
          thinkingConfig: { thinkingLevel: "minimal" },
        },
      });
      checks.gemini = {
        ok: result.ok &&
          Boolean(result.data.candidates?.[0]?.content?.parts?.length),
        status: result.status,
        model: result.model,
        primaryModel: model,
        fallbackUsed: result.model !== model,
      };
    } catch (error) {
      console.error("Self-test Gemini error", error);
      checks.gemini = { ok: false, model };
    }

    const ok = Object.values(checks).every((check: any) => check.ok === true);
    return Response.json({ ok, checks }, { status: ok ? 200 : 502 });
  }

  if (
    requestPath.endsWith("/setup-webhook") ||
    requestPath.endsWith("/webhook-status")
  ) {
    try {
      const webhookUrl = `${SUPABASE_URL}/functions/v1/telegram-bot`;
      if (requestPath.endsWith("/setup-webhook")) {
        await tgCall("setWebhook", {
          url: webhookUrl,
          secret_token: TELEGRAM_WEBHOOK_SECRET,
          allowed_updates: ["message"],
          drop_pending_updates: false,
        });
      }
      const info = await tgCall("getWebhookInfo", {});
      return Response.json({
        ok: true,
        webhook: {
          url: info.url,
          pendingUpdateCount: info.pending_update_count,
          lastErrorDate: info.last_error_date ?? null,
          lastErrorMessage: info.last_error_message ?? null,
          maxConnections: info.max_connections ?? null,
          allowedUpdates: info.allowed_updates ?? [],
        },
      });
    } catch (error) {
      console.error("Webhook setup error", error);
      return Response.json({ ok: false, error: "webhook setup failed" }, {
        status: 502,
      });
    }
  }

  let customerReplySent = false;
  try {
    const update = await req.json();
    const msg = update.message;
    if (!msg || !msg.text) return new Response("ok"); // ignore non-text
    if (msg.chat?.type !== "private") return new Response("ok");

    const chatId: number = msg.chat.id;
    const text: string = msg.text.trim();
    const fromName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean)
      .join(" ");
    const username = msg.from?.username ?? null;

    // /start greeting
    if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
      await tgSend(
        chatId,
        "မင်္ဂလာပါ Digimium မှ ကြိုဆိုပါတယ်ခင်ဗျ။ ဘာများ ကူညီပေးရမလဲခင်ဗျ။",
      );
      customerReplySent = true;
      return new Response("ok");
    }

    // --- upsert customer ---
    let { data: cust, error: customerError } = await supabase
      .from("customers").select("*").eq("telegram_id", chatId).maybeSingle();
    if (customerError) throw customerError;
    if (!cust) {
      const { data: created, error: createError } = await supabase.from(
        "customers",
      )
        .upsert(
          {
            telegram_id: chatId,
            name: fromName,
            username,
            last_seen: new Date().toISOString(),
          },
          { onConflict: "telegram_id" },
        )
        .select().single();
      if (createError || !created) {
        throw createError ?? new Error("Customer upsert returned no row");
      }
      cust = created;
    } else {
      const { error: updateError } = await supabase.from("customers")
        .update({ last_seen: new Date().toISOString() }).eq("id", cust.id);
      if (updateError) throw updateError;
    }

    // --- daily cap ---
    const dailyCap = parseInt(await getSetting("daily_cap", "40"));
    const today = bangkokDate();
    const { data: u, error: usageError } = await supabase.from("usage")
      .select("count").eq("customer_id", cust.id).eq("day", today)
      .maybeSingle();
    if (usageError) throw usageError;
    const usedToday = u?.count ?? 0;
    if (usedToday >= dailyCap) {
      await tgSend(
        chatId,
        "ဒီနေ့အတွက် မေးခွန်း ကန့်သတ်ချက် ပြည့်သွားပါပြီခင်ဗျ။ မနက်ဖြန် ပြန်လာမေးပေးပါနော် သို့မဟုတ် Admin ကို တိုက်ရိုက် ဆက်သွယ်ပါ။",
      );
      customerReplySent = true;
      return new Response("ok");
    }

    // --- load history ---
    const historyTurns = parseInt(await getSetting("history_turns", "12"));
    const { data: hist, error: historyError } = await supabase.from("messages")
      .select("role,content").eq("customer_id", cust.id)
      .order("created_at", { ascending: false }).limit(historyTurns);
    if (historyError) throw historyError;
    const history = (hist ?? []).reverse();

    // --- build Gemini request ---
    const systemPrompt = await getSetting(
      "system_prompt",
      "You are Digimium support. Reply in Burmese.",
    );
    const model = await getSetting("model", "gemini-3.6-flash");
    const fallbackModel = await getSetting(
      "fallback_model",
      "gemini-3.5-flash-lite",
    );
    const contents = [
      ...history.map((m) => ({ role: m.role, parts: [{ text: m.content }] })),
      { role: "user", parts: [{ text }] },
    ];

    const geminiResult = await geminiGenerateWithFallback(
      [model, fallbackModel],
      {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: {
        maxOutputTokens: 900,
        thinkingConfig: { thinkingLevel: "low" },
      },
      },
    );
    const gData = geminiResult.data;
    if (!geminiResult.ok) {
      console.error(
        "Gemini error",
        geminiResult.status,
        geminiResult.model,
        JSON.stringify(gData),
      );
      await tgSend(
        chatId,
        "ဆောရီးပါခင်ဗျ၊ ခဏ စက်ပိုင်းဆိုင်ရာ ပြဿနာလေးရှိနေပါတယ်။ ခဏနေ ပြန်ကြိုးစားပေးပါ သို့မဟုတ် Admin ကို ဆက်သွယ်ပါ။",
      );
      customerReplySent = true;
      return new Response("ok");
    }
    let reply: string = (gData.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p.text ?? "").join("").trim() || "...";

    // Telegram renders Markdown-looking model output as literal text because
    // parse_mode is intentionally disabled. Remove bold markers even if the
    // model ignores the plain-text response rule.
    reply = reply.replaceAll("**", "");
    reply = formatBroadVideoList(text, reply);

    // Category-list replies have a fixed closing question. Do not let stale
    // conversation history append an unrelated payment or handoff sentence.
    const listClosingAt = reply.indexOf(VIDEO_LIST_CLOSING);
    if (listClosingAt >= 0) {
      reply = reply.slice(0, listClosingAt + VIDEO_LIST_CLOSING.length);
    }

    // --- detect handoff token on last line ---
    let handoffReason: string | null = null;
    const lines = reply.split("\n");
    const last = lines[lines.length - 1].trim();
    const m = last.match(/^\[HANDOFF:?\s*(.*?)\]$/i);
    if (m) {
      handoffReason = m[1] || "customer needs help";
      lines.pop();
      reply = lines.join("\n").trim() || "Admin team က မကြာခင် ကူညီပေးပါမယ်ခင်ဗျ။";
    }

    // --- send reply to customer ---
    await tgSend(chatId, reply);
    customerReplySent = true;

    // --- save messages + usage ---
    const { error: messageError } = await supabase.from("messages").insert([
      { customer_id: cust.id, role: "user", content: text },
      { customer_id: cust.id, role: "model", content: reply },
    ]);
    if (messageError) throw messageError;
    const { error: usageWriteError } = await supabase.from("usage").upsert(
      { customer_id: cust.id, day: today, count: usedToday + 1 },
      { onConflict: "customer_id,day" },
    );
    if (usageWriteError) throw usageWriteError;

    // --- handoff: alert admin + log ---
    if (handoffReason) {
      const { error: handoffError } = await supabase.from("handoffs").insert({
        customer_id: cust.id,
        reason: handoffReason,
        question: text,
      });
      if (handoffError) throw handoffError;
      const who = username ? `@${username}` : (fromName || `id ${chatId}`);
      await tgSend(
        ADMIN_CHAT_ID,
        `🔔 Handoff needed\nCustomer: ${who} (id ${chatId})\nReason: ${handoffReason}\nQuestion: ${text}`,
      );
    }

    return new Response("ok");
  } catch (e) {
    console.error("Bot error", e);
    // Retry only if no customer reply was sent; otherwise a retry would duplicate it.
    return new Response(customerReplySent ? "ok" : "retry", {
      status: customerReplySent ? 200 : 500,
    });
  }
});
