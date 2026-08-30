// Digimium Telegram Support Bot - long-polling fallback.
// Run exactly one instance on a true always-on worker. Do not run this while
// the webhook is active, and do not use a scale-to-zero/serverless host.
//
// Required environment variables:
//   TELEGRAM_TOKEN, GEMINI_KEY, ADMIN_CHAT_ID, SUPABASE_URL, SUPABASE_SECRET

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const TG_TOKEN = requiredEnv("TELEGRAM_TOKEN");
const GEMINI_KEY = requiredEnv("GEMINI_KEY");
const ADMIN_CHAT_ID = requiredEnv("ADMIN_CHAT_ID");
const SB_URL = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
const SB_SECRET = requiredEnv("SUPABASE_SECRET");

const TG = `https://api.telegram.org/bot${TG_TOKEN}`;
const sbHeaders: Record<string, string> = {
  apikey: SB_SECRET,
  "Content-Type": "application/json",
};

// Legacy service-role keys are JWTs and also belong in Authorization. New
// sb_secret_ keys are API keys, not bearer JWTs, so they use apikey only.
if (SB_SECRET.startsWith("eyJ")) {
  sbHeaders.Authorization = `Bearer ${SB_SECRET}`;
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

async function sb(path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...sbHeaders,
      ...(init.headers as Record<string, string> ?? {}),
    },
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `Supabase request failed (${response.status}): ${raw.slice(0, 500)}`,
    );
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Supabase returned non-JSON data (${response.status})`);
  }
}

async function tgCall(method: string, payload: Record<string, unknown> = {}) {
  const response = await fetch(`${TG}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `Telegram ${method} returned non-JSON data (${response.status})`,
    );
  }
  if (!response.ok || !data.ok) {
    const retryAfter = data.parameters?.retry_after;
    throw new Error(
      `Telegram ${method} failed (${data.error_code ?? response.status}): ` +
        `${data.description ?? "unknown error"}${
          retryAfter ? `; retry after ${retryAfter}s` : ""
        }`,
    );
  }
  return data.result;
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

async function getSetting(key: string, fallback: string): Promise<string> {
  const rows = await sb(
    `settings?key=eq.${encodeURIComponent(key)}&select=value`,
  );
  return rows?.[0]?.value ?? fallback;
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

async function handle(msg: any) {
  if (msg.chat?.type !== "private") return;

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text) return;

  const fromName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean)
    .join(" ");
  const username = msg.from?.username ?? null;

  if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
    await tgSend(
      chatId,
      "မင်္ဂလာပါ Digimium မှ ကြိုဆိုပါတယ်ခင်ဗျ။ ဘာများ ကူညီပေးရမလဲခင်ဗျ။",
    );
    return;
  }

  const customers = await sb("customers?on_conflict=telegram_id&select=*", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      telegram_id: chatId,
      name: fromName,
      username,
      last_seen: new Date().toISOString(),
    }),
  });
  const customer = customers?.[0];
  if (!customer?.id) throw new Error("Customer upsert returned no row");

  const cap = Number.parseInt(await getSetting("daily_cap", "40"), 10);
  const today = bangkokDate();
  const usageRows = await sb(
    `usage?customer_id=eq.${customer.id}&day=eq.${today}&select=count`,
  );
  const used = usageRows?.[0]?.count ?? 0;
  if (used >= cap) {
    await tgSend(
      chatId,
      "ဒီနေ့အတွက် ကန့်သတ်ချက် ပြည့်သွားပါပြီခင်ဗျ။ မနက်ဖြန် ပြန်လာပေးပါနော် သို့မဟုတ် Admin ကို ဆက်သွယ်ပါ။",
    );
    return;
  }

  const historyTurns = Number.parseInt(
    await getSetting("history_turns", "12"),
    10,
  );
  const history = await sb(
    `messages?customer_id=eq.${customer.id}&select=role,content&order=created_at.desc&limit=${historyTurns}`,
  ) ?? [];
  history.reverse();

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
    ...history.map((message: any) => ({
      role: message.role,
      parts: [{ text: message.content }],
    })),
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
  const geminiData = geminiResult.data;
  if (!geminiResult.ok) {
    console.error(
      "Gemini error",
      geminiResult.status,
      geminiResult.model,
      geminiData.error?.message ?? "unknown",
    );
    await tgSend(
      chatId,
      "ဆောရီးပါခင်ဗျ၊ ခဏ ပြဿနာလေးရှိနေပါတယ်။ ခဏနေ ပြန်ကြိုးစားပေးပါ။",
    );
    return;
  }

  let reply = (geminiData.candidates?.[0]?.content?.parts ?? [])
    .filter((part: any) => !part.thought)
    .map((part: any) => part.text ?? "")
    .join("")
    .trim() || "ဆောရီးပါခင်ဗျ၊ အဖြေမရသေးလို့ Admin team ကို ဆက်သွယ်ပေးပါမယ်။";

  reply = reply.replaceAll("**", "");
  reply = formatBroadVideoList(text, reply);

  const listClosingAt = reply.indexOf(VIDEO_LIST_CLOSING);
  if (listClosingAt >= 0) {
    reply = reply.slice(0, listClosingAt + VIDEO_LIST_CLOSING.length);
  }

  let handoff: string | null = null;
  const lines = reply.split("\n");
  const match = lines[lines.length - 1].trim().match(
    /^\[HANDOFF:?\s*(.*?)\]$/i,
  );
  if (match) {
    handoff = match[1] || "customer needs help";
    lines.pop();
    reply = lines.join("\n").trim() || "Admin team က မကြာခင် ကူညီပေးပါမယ်ခင်ဗျ။";
  }

  await tgSend(chatId, reply);

  await sb("messages", {
    method: "POST",
    body: JSON.stringify([
      { customer_id: customer.id, role: "user", content: text },
      { customer_id: customer.id, role: "model", content: reply },
    ]),
  });
  await sb("usage?on_conflict=customer_id%2Cday", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      customer_id: customer.id,
      day: today,
      count: used + 1,
    }),
  });

  if (handoff) {
    await sb("handoffs", {
      method: "POST",
      body: JSON.stringify({
        customer_id: customer.id,
        reason: handoff,
        question: text,
      }),
    });
    const who = username ? `@${username}` : (fromName || `id ${chatId}`);
    await tgSend(
      ADMIN_CHAT_ID,
      `🔔 Handoff needed\nCustomer: ${who} (id ${chatId})\nReason: ${handoff}\nQuestion: ${text}`,
    );
  }
}

async function main() {
  const me = await tgCall("getMe");
  await tgCall("deleteWebhook", { drop_pending_updates: false });
  const webhook = await tgCall("getWebhookInfo");
  if (webhook.url) {
    throw new Error("Telegram webhook is still active; polling cannot start");
  }

  console.log(`Digimium polling started for @${me.username ?? "unknown"}.`);
  let offset = 0;
  let backoffMs = 1000;

  while (true) {
    try {
      const updates = await tgCall("getUpdates", {
        timeout: 30,
        offset,
        allowed_updates: ["message"],
      });
      if (!Array.isArray(updates)) {
        throw new Error("Telegram getUpdates returned no update list");
      }

      for (const update of updates) {
        if (update.message) await handle(update.message);
        offset = update.update_id + 1;
      }
      backoffMs = 1000;
    } catch (error) {
      console.error("Polling error", error);
      await delay(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }
}

main().catch((error) => {
  console.error("Fatal startup error", error);
  Deno.exit(1);
});
