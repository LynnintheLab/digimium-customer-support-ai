// deno-lint-ignore-file no-explicit-any
// Digimium Telegram Support Bot - Supabase Edge Function
// Production webhook with private support-group topics, human relay, reviewed
// knowledge learning, and 30-minute inactivity summaries.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const TELEGRAM_TOKEN = requiredEnv("TELEGRAM_TOKEN");
const TELEGRAM_WEBHOOK_SECRET = requiredEnv("TELEGRAM_WEBHOOK_SECRET");
const GEMINI_KEY = requiredEnv("GEMINI_KEY");
const PRIMARY_ADMIN_ID = requiredEnv("ADMIN_CHAT_ID");
const SUPABASE_URL = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
const supabase = createClient(
  SUPABASE_URL,
  requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
);
const TG = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

type TopicContext = {
  customer_id: number;
  support_group_id: number;
  message_thread_id: number;
  mode: "hybrid" | "total_handoff";
  handoff_active: boolean;
  last_activity_at: string;
  summary_due_at: string | null;
  last_summarized_message_id: number | null;
  last_summary_at: string | null;
};

type SupportGroup = {
  id: number;
  telegram_chat_id: number;
  title: string | null;
  knowledge_topic_id: number | null;
  logs_topic_id: number | null;
  active: boolean;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanPlainText(value: string): string {
  return value.replaceAll("**", "").trim();
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function tgSend(
  chatId: number | string,
  text: string,
  options: {
    messageThreadId?: number | null;
    replyToMessageId?: number | null;
    replyMarkup?: Record<string, unknown> | null;
  } = {},
): Promise<any> {
  const chars = Array.from(cleanPlainText(text) || "...");
  let lastMessage: any = null;
  const chunkCount = Math.max(1, Math.ceil(chars.length / 4096));
  for (let start = 0, chunk = 0; start < chars.length; start += 4096, chunk++) {
    const isLast = chunk === chunkCount - 1;
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: chars.slice(start, start + 4096).join(""),
    };
    if (options.messageThreadId) {
      payload.message_thread_id = options.messageThreadId;
    }
    if (options.replyToMessageId && chunk === 0) {
      payload.reply_parameters = {
        message_id: options.replyToMessageId,
        allow_sending_without_reply: true,
      };
    }
    if (options.replyMarkup && isLast) {
      payload.reply_markup = options.replyMarkup;
    }
    lastMessage = await tgCall("sendMessage", payload);
  }
  return lastMessage;
}

async function tgCopyMessage(
  targetChatId: number | string,
  fromChatId: number | string,
  messageId: number,
  messageThreadId?: number | null,
): Promise<any> {
  const payload: Record<string, unknown> = {
    chat_id: targetChatId,
    from_chat_id: fromChatId,
    message_id: messageId,
  };
  if (messageThreadId) payload.message_thread_id = messageThreadId;
  return await tgCall("copyMessage", payload);
}

async function sendTopicText(
  group: SupportGroup,
  threadId: number,
  text: string,
  options: { replyMarkup?: Record<string, unknown> | null } = {},
): Promise<any> {
  try {
    return await tgSend(group.telegram_chat_id, text, {
      messageThreadId: threadId,
      replyMarkup: options.replyMarkup,
    });
  } catch (firstError) {
    try {
      await tgCall("reopenForumTopic", {
        chat_id: group.telegram_chat_id,
        message_thread_id: threadId,
      });
      return await tgSend(group.telegram_chat_id, text, {
        messageThreadId: threadId,
        replyMarkup: options.replyMarkup,
      });
    } catch {
      throw firstError;
    }
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

async function getSetting(key: string, fallback = ""): Promise<string> {
  const { data, error } = await supabase.from("settings")
    .select("value").eq("key", key).maybeSingle();
  if (error) throw error;
  return data?.value ?? fallback;
}

async function getSupportGroup(): Promise<SupportGroup | null> {
  const { data, error } = await supabase.from("support_groups")
    .select("*").eq("id", 1).eq("active", true).maybeSingle();
  if (error) throw error;
  return data as SupportGroup | null;
}

async function claimUpdate(updateId: number, kind: string): Promise<boolean> {
  const { data: existing, error: readError } = await supabase.from(
    "bot_updates",
  )
    .select("status,updated_at").eq("telegram_update_id", updateId)
    .maybeSingle();
  if (readError) throw readError;
  if (existing?.status === "processed") return false;
  if (
    existing?.status === "processing" &&
    Date.now() - new Date(existing.updated_at).getTime() < 120_000
  ) return false;

  const { error } = await supabase.from("bot_updates").upsert({
    telegram_update_id: updateId,
    kind,
    status: "processing",
    error: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "telegram_update_id" });
  if (error) throw error;
  return true;
}

async function finishUpdate(
  updateId: number,
  status: "processed" | "failed",
  error: string | null = null,
) {
  const { error: updateError } = await supabase.from("bot_updates").update({
    status,
    error: error?.slice(0, 1000) ?? null,
    updated_at: new Date().toISOString(),
  }).eq("telegram_update_id", updateId);
  if (updateError) console.error("Could not finalize update", updateError);
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
  const candidates = [
    ...new Set(models.map((model) => model.trim()).filter(Boolean)),
  ];
  let lastResult = {
    ok: false,
    status: 0,
    data: {} as any,
    model: candidates[0] ?? "",
  };
  for (const model of candidates) {
    const result = await geminiGenerate(model, payload);
    lastResult = { ...result, model };
    if (result.ok) return lastResult;
    const canTryAnother = result.status === 404 || result.status === 408 ||
      result.status === 429 || result.status >= 500;
    if (!canTryAnother) return lastResult;
  }
  return lastResult;
}

const VIDEO_LIST_CLOSING = "ဘယ်တစ်ခု အသေးစိတ် သိချင်ပါသလဲခင်ဗျာ။";
const VIDEO_PRODUCTS = [
  "Kling AI",
  "Runway",
  "HeyGen",
  "Higgsfield",
  "CapCut Pro",
];

function formatBroadVideoList(
  question: string,
  generatedReply: string,
): string {
  const normalizedQuestion = question.toLowerCase();
  const mentionsVideo = normalizedQuestion.includes("video") ||
    question.includes("ဗီဒီယို");
  const asksForOptions = question.includes("ဘာ") || question.includes("ရှိ") ||
    question.includes("ထုတ်ဖို့") || normalizedQuestion.includes("tool") ||
    normalizedQuestion.includes("generator");
  const namesSpecificProduct = VIDEO_PRODUCTS.some((product) =>
    normalizedQuestion.includes(product.toLowerCase())
  );
  if (!mentionsVideo || !asksForOptions || namesSpecificProduct) {
    return generatedReply;
  }

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

async function upsertCustomer(msg: any): Promise<any> {
  const chatId = Number(msg.chat.id);
  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean)
    .join(" ").trim();
  const username = msg.from?.username ?? null;
  const { data, error } = await supabase.from("customers").upsert({
    telegram_id: chatId,
    name,
    username,
    last_seen: new Date().toISOString(),
  }, { onConflict: "telegram_id" }).select().single();
  if (error || !data) {
    throw error ?? new Error("Customer upsert returned no row");
  }
  return data;
}

function topicName(customer: any): string {
  const display = String(customer.name || customer.username || "Customer")
    .replace(/[\r\n]+/g, " ").trim().slice(0, 90);
  return `👤 ${display} · ${String(customer.telegram_id).slice(-6)}`.slice(
    0,
    128,
  );
}

async function ensureCustomerTopic(
  customer: any,
  group: SupportGroup | null,
): Promise<TopicContext | null> {
  if (!group) return null;
  const { data: existing, error: existingError } = await supabase
    .from("customer_topics").select("*").eq("customer_id", customer.id)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) return existing as TopicContext;

  const created = await tgCall("createForumTopic", {
    chat_id: group.telegram_chat_id,
    name: topicName(customer),
  });
  const now = new Date().toISOString();
  const { data, error } = await supabase.from("customer_topics").upsert({
    customer_id: customer.id,
    support_group_id: group.id,
    message_thread_id: created.message_thread_id,
    mode: "hybrid",
    last_activity_at: now,
    summary_due_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    updated_at: now,
  }, { onConflict: "customer_id" }).select().single();
  if (error || !data) throw error ?? new Error("Could not save customer topic");

  const who = customer.username ? `@${customer.username}` : "username မရှိပါ";
  await sendTopicText(
    group,
    created.message_thread_id,
    [
      "👤 Customer topic အသစ်",
      `Name: ${customer.name || "Unknown"}`,
      `Telegram: ${who}`,
      `Customer ID: ${customer.telegram_id}`,
      "Mode: Hybrid AI + Admin",
      "",
      "ဒီ Topic ထဲမှာ ပုံမှန်စာရေးရင် customer ဆီ တိုက်ရိုက်ပို့ပါမယ်။",
      "Internal note အတွက် /note ကိုသုံးပါ။ Command များအတွက် /help ကိုသုံးပါ။",
    ].join("\n"),
  );
  return data as TopicContext;
}

async function touchTopic(
  customerId: number,
  values: Record<string, unknown> = {},
) {
  const { error } = await supabase.from("customer_topics").update({
    last_activity_at: new Date().toISOString(),
    summary_due_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    updated_at: new Date().toISOString(),
    ...values,
  }).eq("customer_id", customerId);
  if (error) throw error;
}

async function saveMessage(
  customerId: number,
  role: "user" | "model",
  source: "customer" | "bot" | "admin" | "system",
  content: string,
  telegramMessageId?: number | null,
  telegramAuthorId?: number | null,
): Promise<any> {
  const { data, error } = await supabase.from("messages").insert({
    customer_id: customerId,
    role,
    source,
    content: cleanPlainText(content) || "[empty]",
    telegram_message_id: telegramMessageId ?? null,
    telegram_author_id: telegramAuthorId ?? null,
  }).select().single();
  if (error) throw error;
  return data;
}

async function mirrorText(
  group: SupportGroup | null,
  topic: TopicContext | null,
  speaker: "customer" | "bot",
  text: string,
) {
  if (!group || !topic) return;
  const label = speaker === "customer" ? "👤 Customer" : "🤖 Bot";
  await sendTopicText(group, topic.message_thread_id, `${label}\n${text}`);
}

function messageKind(msg: any): string {
  if (msg.photo) return "Photo";
  if (msg.video) return "Video";
  if (msg.document) return "Document";
  if (msg.audio) return "Audio";
  if (msg.voice) return "Voice message";
  if (msg.sticker) return "Sticker";
  if (msg.contact) return "Contact";
  if (msg.location) return "Location";
  return "Unsupported message";
}

async function loadApprovedLearnedKnowledge(): Promise<string> {
  const { data, error } = await supabase.from("knowledge_candidates")
    .select("content,edited_content,reviewed_at")
    .eq("status", "approved").order("reviewed_at", { ascending: false }).limit(
      100,
    );
  if (error) throw error;
  const items = (data ?? []).map((row: any) =>
    cleanPlainText(row.edited_content || row.content)
  ).filter(Boolean);
  if (!items.length) return "";
  return [
    "ADMIN-APPROVED LEARNED KNOWLEDGE:",
    "Use these owner-approved facts as current support knowledge.",
    ...items.map((item, index) => `${index + 1}. ${item}`),
  ].join("\n").slice(0, 40_000);
}

async function createHandoff(
  customer: any,
  group: SupportGroup | null,
  topic: TopicContext | null,
  reason: string,
  question: string,
) {
  const { error: handoffError } = await supabase.from("handoffs").insert({
    customer_id: customer.id,
    reason,
    question,
  });
  if (handoffError) throw handoffError;
  if (topic) await touchTopic(customer.id, { handoff_active: true });
  const who = customer.username
    ? `@${customer.username}`
    : (customer.name || `id ${customer.telegram_id}`);
  const alert = [
    "🔔 Handoff လိုအပ်ပါတယ်",
    `Customer: ${who}`,
    `Reason: ${reason}`,
    `Question: ${question}`,
    "",
    "ဒီ Topic ထဲမှာ ပုံမှန်စာရေးပြီး တိုက်ရိုက်ပြန်ဖြေနိုင်ပါတယ်။",
  ].join("\n");
  if (group && topic) {
    await sendTopicText(group, topic.message_thread_id, alert);
  } else {
    await tgSend(PRIMARY_ADMIN_ID, alert);
  }
}

async function getUsage(
  customerId: number,
): Promise<{ used: number; cap: number }> {
  const cap = Number.parseInt(await getSetting("daily_cap", "40"), 10);
  const { data, error } = await supabase.from("usage").select("count")
    .eq("customer_id", customerId).eq("day", bangkokDate()).maybeSingle();
  if (error) throw error;
  return { used: data?.count ?? 0, cap };
}

async function incrementUsage(customerId: number, used: number) {
  const { error } = await supabase.from("usage").upsert({
    customer_id: customerId,
    day: bangkokDate(),
    count: used + 1,
  }, { onConflict: "customer_id,day" });
  if (error) throw error;
}

async function handlePrivateMessage(msg: any): Promise<boolean> {
  const customer = await upsertCustomer(msg);
  const group = await getSupportGroup();
  const topic = await ensureCustomerTopic(customer, group);
  if (topic) await touchTopic(customer.id);

  const text = String(msg.text ?? msg.caption ?? "").trim();
  if (!msg.text) {
    const kind = messageKind(msg);
    const mediaDescription = `[${kind}]${text ? ` ${text}` : ""}`;
    await saveMessage(
      customer.id,
      "user",
      "customer",
      mediaDescription,
      msg.message_id,
      msg.from?.id,
    );
    if (group && topic) {
      await sendTopicText(
        group,
        topic.message_thread_id,
        `👤 Customer sent: ${kind}`,
      );
      await tgCopyMessage(
        group.telegram_chat_id,
        msg.chat.id,
        msg.message_id,
        topic.message_thread_id,
      );
    }
    if (topic?.mode !== "total_handoff") {
      const reply = "ဒီဖိုင်ကို Admin team က စစ်ဆေးပြီး ပြန်ဖြေပေးပါမယ်ခင်ဗျ။";
      await tgSend(msg.chat.id, reply);
      await saveMessage(customer.id, "model", "bot", reply);
      await mirrorText(group, topic, "bot", reply);
    }
    await createHandoff(
      customer,
      group,
      topic,
      `${kind} needs review`,
      mediaDescription,
    );
    return topic?.mode !== "total_handoff";
  }

  const incoming = await saveMessage(
    customer.id,
    "user",
    "customer",
    text,
    msg.message_id,
    msg.from?.id,
  );
  await mirrorText(group, topic, "customer", text);

  if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
    const greeting = "မင်္ဂလာပါ Digimium မှ ကြိုဆိုပါတယ်ခင်ဗျ။ ဘာများ ကူညီပေးရမလဲခင်ဗျ။";
    await tgSend(msg.chat.id, greeting);
    await saveMessage(customer.id, "model", "bot", greeting);
    await mirrorText(group, topic, "bot", greeting);
    return true;
  }

  if (topic?.mode === "total_handoff") {
    if (!topic.handoff_active) {
      await createHandoff(
        customer,
        group,
        topic,
        "Total handoff mode is active",
        text,
      );
    }
    return false;
  }

  const usage = await getUsage(customer.id);
  if (usage.used >= usage.cap) {
    const limitReply =
      "ဒီနေ့အတွက် မေးခွန်း ကန့်သတ်ချက် ပြည့်သွားပါပြီခင်ဗျ။ မနက်ဖြန် ပြန်လာမေးပေးပါနော် သို့မဟုတ် Admin ကို တိုက်ရိုက် ဆက်သွယ်ပါ။";
    await tgSend(msg.chat.id, limitReply);
    await saveMessage(customer.id, "model", "bot", limitReply);
    await mirrorText(group, topic, "bot", limitReply);
    return true;
  }

  const historyTurns = Number.parseInt(
    await getSetting("history_turns", "12"),
    10,
  );
  const { data: history, error: historyError } = await supabase.from("messages")
    .select("role,content").eq("customer_id", customer.id)
    .lte("id", incoming.id).order("id", { ascending: false }).limit(
      historyTurns,
    );
  if (historyError) throw historyError;
  const contents = (history ?? []).reverse().map((row: any) => ({
    role: row.role,
    parts: [{ text: row.content }],
  }));
  const [systemPrompt, learnedKnowledge, model, fallbackModel] = await Promise
    .all([
      getSetting(
        "system_prompt",
        "You are Digimium support. Reply in Burmese.",
      ),
      loadApprovedLearnedKnowledge(),
      getSetting("model", "gemini-3.6-flash"),
      getSetting("fallback_model", "gemini-3.5-flash-lite"),
    ]);
  const fullInstruction = learnedKnowledge
    ? `${systemPrompt}\n\n${learnedKnowledge}`
    : systemPrompt;
  const result = await geminiGenerateWithFallback([model, fallbackModel], {
    systemInstruction: { parts: [{ text: fullInstruction }] },
    contents,
    generationConfig: {
      maxOutputTokens: 900,
      thinkingConfig: { thinkingLevel: "low" },
    },
  });
  if (!result.ok) {
    console.error(
      "Gemini reply error",
      result.status,
      result.model,
      result.data,
    );
    const unavailable =
      "ဆောရီးပါခင်ဗျ၊ ခဏ စက်ပိုင်းဆိုင်ရာ ပြဿနာလေးရှိနေပါတယ်။ Admin team ကို အသိပေးထားပါတယ်ခင်ဗျ။";
    await tgSend(msg.chat.id, unavailable);
    await saveMessage(customer.id, "model", "bot", unavailable);
    await mirrorText(group, topic, "bot", unavailable);
    await createHandoff(customer, group, topic, "AI service error", text);
    return true;
  }

  let reply = (result.data.candidates?.[0]?.content?.parts ?? [])
    .filter((part: any) => !part.thought)
    .map((part: any) => part.text ?? "").join("").trim() ||
    "Admin team က မကြာခင် ကူညီပေးပါမယ်ခင်ဗျ။";
  reply = formatBroadVideoList(text, cleanPlainText(reply));
  const listClosingAt = reply.indexOf(VIDEO_LIST_CLOSING);
  if (listClosingAt >= 0) {
    reply = reply.slice(0, listClosingAt + VIDEO_LIST_CLOSING.length);
  }

  let handoffReason: string | null = null;
  const lines = reply.split("\n");
  const handoffMatch = lines[lines.length - 1].trim().match(
    /^\[HANDOFF:?\s*(.*?)\]$/i,
  );
  if (handoffMatch) {
    handoffReason = handoffMatch[1] || "customer needs help";
    lines.pop();
    reply = lines.join("\n").trim() || "Admin team က မကြာခင် ကူညီပေးပါမယ်ခင်ဗျ။";
  }
  await tgSend(msg.chat.id, reply);
  await saveMessage(customer.id, "model", "bot", reply);
  await mirrorText(group, topic, "bot", reply);
  await incrementUsage(customer.id, usage.used);
  if (handoffReason) {
    await createHandoff(customer, group, topic, handoffReason, text);
  }
  return true;
}

function parseCommand(text: string): { name: string; args: string } | null {
  const match = text.trim().match(/^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

async function isGroupAdmin(chatId: number, userId: number): Promise<boolean> {
  if (String(userId) === PRIMARY_ADMIN_ID) return true;
  try {
    const member = await tgCall("getChatMember", {
      chat_id: chatId,
      user_id: userId,
    });
    return member.status === "creator" || member.status === "administrator";
  } catch {
    return false;
  }
}

async function setupGroup(msg: any, args: string) {
  if (String(msg.from?.id) !== PRIMARY_ADMIN_ID) return;
  if (msg.chat?.type !== "supergroup" || !msg.chat?.is_forum) {
    await tgSend(
      msg.chat.id,
      "ဒီ command ကို Topics ဖွင့်ထားတဲ့ Supergroup ထဲမှာပဲ သုံးနိုင်ပါတယ်။",
    );
    return;
  }
  const section = args.toLowerCase();
  const now = new Date().toISOString();
  const { data: existing, error: existingError } = await supabase
    .from("support_groups").select("*").eq("id", 1).maybeSingle();
  if (existingError) throw existingError;
  const base = {
    id: 1,
    telegram_chat_id: msg.chat.id,
    title: msg.chat.title ?? "Digimium Support Admin",
    configured_by_telegram_id: msg.from.id,
    active: true,
    updated_at: now,
  };

  if (section === "knowledge" || section === "review") {
    if (!msg.message_thread_id) {
      await tgSend(
        msg.chat.id,
        "Knowledge Review Topic ထဲမှာ /setup knowledge လို့ပို့ပါ။",
      );
      return;
    }
    const { error } = await supabase.from("support_groups").upsert({
      ...base,
      knowledge_topic_id: msg.message_thread_id,
      logs_topic_id: existing?.logs_topic_id ?? null,
    }, { onConflict: "id" });
    if (error) throw error;
    await tgSend(msg.chat.id, "Knowledge Review Topic ကို register လုပ်ပြီးပါပြီ။", {
      messageThreadId: msg.message_thread_id,
    });
    await publishPendingCandidates();
    return;
  }

  if (section === "logs" || section === "log") {
    if (!msg.message_thread_id) {
      await tgSend(msg.chat.id, "System Log Topic ထဲမှာ /setup logs လို့ပို့ပါ။");
      return;
    }
    const { error } = await supabase.from("support_groups").upsert({
      ...base,
      logs_topic_id: msg.message_thread_id,
      knowledge_topic_id: existing?.knowledge_topic_id ?? null,
    }, { onConflict: "id" });
    if (error) throw error;
    await tgSend(msg.chat.id, "System Log Topic ကို register လုပ်ပြီးပါပြီ။", {
      messageThreadId: msg.message_thread_id,
    });
    return;
  }

  const { error } = await supabase.from("support_groups").upsert({
    ...base,
    knowledge_topic_id: existing?.knowledge_topic_id ?? null,
    logs_topic_id: existing?.logs_topic_id ?? null,
  }, { onConflict: "id" });
  if (error) throw error;
  await tgSend(
    msg.chat.id,
    [
      "✅ Digimium Support Group register လုပ်ပြီးပါပြီ။",
      "",
      "နောက်ထပ် နှစ်ဆင့်လုပ်ပါ။",
      "1. Knowledge Review Topic ထဲမှာ /setup knowledge",
      "2. System Log Topic ထဲမှာ /setup logs",
    ].join("\n"),
    { messageThreadId: msg.message_thread_id ?? null },
  );
}

async function getTopicWithCustomer(
  groupId: number,
  threadId: number,
): Promise<any> {
  const { data, error } = await supabase.from("customer_topics")
    .select("*, customers(*)")
    .eq("support_group_id", groupId)
    .eq("message_thread_id", threadId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function setSupportMode(
  group: SupportGroup,
  topicRow: any,
  mode: "hybrid" | "total_handoff",
) {
  await touchTopic(topicRow.customer_id, {
    mode,
    handoff_active: mode === "total_handoff" ? topicRow.handoff_active : false,
  });
  const label = mode === "total_handoff"
    ? "🧑‍💼 Total Handoff ON — Bot က မဖြေတော့ပါ။ Admin ပဲဖြေပါမယ်။"
    : "🤖 Hybrid Mode ON — Bot သိတာကိုဖြေပြီး မသိတာကို Handoff လုပ်ပါမယ်။";
  await sendTopicText(group, topicRow.message_thread_id, label);
}

async function closeHandoff(group: SupportGroup, topicRow: any) {
  await touchTopic(topicRow.customer_id, {
    mode: "hybrid",
    handoff_active: false,
  });
  const { error } = await supabase.from("handoffs").update({ resolved: true })
    .eq("customer_id", topicRow.customer_id).eq("resolved", false);
  if (error) throw error;
  await sendTopicText(
    group,
    topicRow.message_thread_id,
    "✅ Handoff ကို resolved လုပ်ပြီး Hybrid Mode ပြန်ဖွင့်ထားပါတယ်။ Topic ကို မပိတ်ထားပါ။",
  );
}

async function relayAdminMessage(group: SupportGroup, topicRow: any, msg: any) {
  const customer = topicRow.customers;
  if (!customer?.telegram_id) {
    throw new Error("Topic customer mapping is missing");
  }
  const text = String(msg.text ?? msg.caption ?? "").trim();
  if (msg.text) {
    await tgSend(customer.telegram_id, text);
    await saveMessage(
      topicRow.customer_id,
      "model",
      "admin",
      text,
      msg.message_id,
      msg.from?.id,
    );
  } else {
    await tgCopyMessage(
      customer.telegram_id,
      group.telegram_chat_id,
      msg.message_id,
    );
    await saveMessage(
      topicRow.customer_id,
      "model",
      "admin",
      `[${messageKind(msg)}]${text ? ` ${text}` : ""}`,
      msg.message_id,
      msg.from?.id,
    );
  }
  await touchTopic(topicRow.customer_id, { handoff_active: false });
  const { error } = await supabase.from("handoffs").update({ resolved: true })
    .eq("customer_id", topicRow.customer_id).eq("resolved", false);
  if (error) throw error;
  try {
    await tgCall("setMessageReaction", {
      chat_id: group.telegram_chat_id,
      message_id: msg.message_id,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
  } catch (error) {
    console.warn("Admin relay reaction was not available", errorText(error));
  }
}

function reviewKeyboard(
  candidateId: number,
  status = "pending",
): Record<string, unknown> {
  if (status === "approved") {
    return {
      inline_keyboard: [[
        { text: "✏️ Edit", callback_data: `kr:e:${candidateId}` },
        { text: "🗑 Delete", callback_data: `kr:d:${candidateId}` },
      ]],
    };
  }
  if (status === "declined") {
    return {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `kr:a:${candidateId}` },
          { text: "✏️ Edit", callback_data: `kr:e:${candidateId}` },
        ],
        [{ text: "🗑 Delete", callback_data: `kr:d:${candidateId}` }],
      ],
    };
  }
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `kr:a:${candidateId}` },
        { text: "✏️ Edit", callback_data: `kr:e:${candidateId}` },
      ],
      [
        { text: "❌ Decline", callback_data: `kr:x:${candidateId}` },
        { text: "🗑 Delete", callback_data: `kr:d:${candidateId}` },
      ],
    ],
  };
}

async function loadCandidate(candidateId: number): Promise<any | null> {
  const { data: candidate, error } = await supabase.from("knowledge_candidates")
    .select("*").eq("id", candidateId).maybeSingle();
  if (error) throw error;
  if (!candidate) return null;
  const [{ data: summary }, { data: customer }] = await Promise.all([
    supabase.from("conversation_summaries").select("*")
      .eq("id", candidate.summary_id).maybeSingle(),
    supabase.from("customers").select("*")
      .eq("id", candidate.customer_id).maybeSingle(),
  ]);
  return { ...candidate, summary, customer };
}

function renderCandidate(candidate: any): string {
  const statusLabels: Record<string, string> = {
    pending: "Pending",
    approved: "Approved",
    declined: "Declined",
    deleted: "Deleted (recoverable in database)",
  };
  const customerName = candidate.customer?.username
    ? `@${candidate.customer.username}`
    : (candidate.customer?.name || `Customer ${candidate.customer_id}`);
  const summary = String(candidate.summary?.summary || "No summary").slice(
    0,
    1200,
  );
  const knowledge = String(candidate.edited_content || candidate.content).slice(
    0,
    2200,
  );
  return [
    `🧠 Knowledge Candidate #${candidate.id}`,
    `Source: ${customerName}`,
    `Status: ${statusLabels[candidate.status] ?? candidate.status}`,
    "",
    "Conversation Summary",
    summary,
    "",
    "Reusable Knowledge",
    knowledge,
    "",
    "Edit လုပ်ရန် ဒီ message ကို reply လုပ်ပြီး /edit ပြင်ထားတဲ့စာ လို့ပို့ပါ။",
  ].join("\n");
}

async function publishCandidate(candidateId: number): Promise<void> {
  const [group, candidate] = await Promise.all([
    getSupportGroup(),
    loadCandidate(candidateId),
  ]);
  if (
    !group?.knowledge_topic_id || !candidate || candidate.status !== "pending"
  ) return;
  const sent = await sendTopicText(
    group,
    group.knowledge_topic_id,
    renderCandidate(candidate),
    { replyMarkup: reviewKeyboard(candidate.id, candidate.status) },
  );
  const { error } = await supabase.from("knowledge_candidates").update({
    review_chat_id: group.telegram_chat_id,
    review_message_id: sent.message_id,
    updated_at: new Date().toISOString(),
  }).eq("id", candidate.id);
  if (error) throw error;
}

async function publishPendingCandidates() {
  const { data, error } = await supabase.from("knowledge_candidates")
    .select("id").eq("status", "pending").is("review_message_id", null)
    .order("created_at", { ascending: true }).limit(20);
  if (error) throw error;
  for (const row of data ?? []) await publishCandidate(row.id);
}

async function refreshCandidateMessage(candidateId: number) {
  const candidate = await loadCandidate(candidateId);
  if (!candidate?.review_chat_id || !candidate.review_message_id) return;
  const payload: Record<string, unknown> = {
    chat_id: candidate.review_chat_id,
    message_id: candidate.review_message_id,
    text: renderCandidate(candidate),
  };
  if (candidate.status !== "deleted") {
    payload.reply_markup = reviewKeyboard(candidate.id, candidate.status);
  }
  await tgCall("editMessageText", payload);
}

async function reviewCandidate(
  candidateId: number,
  action: "approved" | "declined" | "deleted",
  adminId: number,
) {
  const candidate = await loadCandidate(candidateId);
  if (!candidate) throw new Error("Knowledge candidate not found");
  const { error } = await supabase.from("knowledge_candidates").update({
    status: action,
    reviewed_by_telegram_id: adminId,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", candidateId);
  if (error) throw error;
  await refreshCandidateMessage(candidateId);
}

async function findCandidateFromCommand(
  msg: any,
  args: string,
): Promise<number | null> {
  const explicit = args.match(/^(\d+)(?:\s|$)/);
  if (explicit) return Number(explicit[1]);
  const replyId = msg.reply_to_message?.message_id;
  if (!replyId) return null;
  const { data, error } = await supabase.from("knowledge_candidates")
    .select("id").eq("review_chat_id", msg.chat.id)
    .eq("review_message_id", replyId).maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

async function handleReviewCommand(
  group: SupportGroup,
  msg: any,
  command: any,
) {
  if (!["approve", "decline", "delete", "edit"].includes(command.name)) {
    return false;
  }
  const candidateId = await findCandidateFromCommand(msg, command.args);
  if (!candidateId) {
    await sendTopicText(
      group,
      group.knowledge_topic_id!,
      "Candidate message ကို reply လုပ်ပြီး command သုံးပါ၊ သို့မဟုတ် candidate number ထည့်ပါ။",
    );
    return true;
  }
  if (command.name === "edit") {
    let edited = command.args;
    const withId = edited.match(/^\d+\s+([\s\S]+)$/);
    if (withId) edited = withId[1];
    if (!edited || /^\d+$/.test(edited)) {
      await sendTopicText(
        group,
        group.knowledge_topic_id!,
        "အသစ်ပြင်ထားတဲ့စာပါထည့်ပါ။ ဥပမာ /edit ChatGPT Business 1 seat က 150,000 Ks ဖြစ်ပါတယ်။",
      );
      return true;
    }
    const { error } = await supabase.from("knowledge_candidates").update({
      edited_content: cleanPlainText(edited).slice(0, 4000),
      status: "pending",
      reviewed_by_telegram_id: null,
      reviewed_at: null,
      updated_at: new Date().toISOString(),
    }).eq("id", candidateId);
    if (error) throw error;
    await refreshCandidateMessage(candidateId);
    await sendTopicText(
      group,
      group.knowledge_topic_id!,
      `✏️ Candidate #${candidateId} ကို ပြင်ပြီးပါပြီ။ Approve လုပ်နိုင်ပါပြီ။`,
    );
    return true;
  }
  const action = command.name === "approve"
    ? "approved"
    : command.name === "decline"
    ? "declined"
    : "deleted";
  await reviewCandidate(candidateId, action, msg.from.id);
  return true;
}

async function summarizeConversation(
  topicRow: any,
  triggerType: "manual" | "inactivity",
  adminId: number | null,
): Promise<{ created: boolean; candidateId?: number; summary?: string }> {
  let query = supabase.from("messages")
    .select("id,role,source,content,created_at")
    .eq("customer_id", topicRow.customer_id)
    .order("id", { ascending: true }).limit(120);
  if (topicRow.last_summarized_message_id) {
    query = query.gt("id", topicRow.last_summarized_message_id);
  }
  const { data: rows, error } = await query;
  if (error) throw error;
  if (!rows?.length) {
    const { error: clearError } = await supabase.from("customer_topics").update(
      {
        summary_due_at: null,
        updated_at: new Date().toISOString(),
      },
    ).eq("customer_id", topicRow.customer_id);
    if (clearError) throw clearError;
    return { created: false };
  }

  const hasAdminAnswer = rows.some((row: any) => row.source === "admin");
  const transcript = rows.map((row: any) => {
    const label = row.source === "customer"
      ? "CUSTOMER"
      : row.source === "admin"
      ? "ADMIN"
      : "BOT";
    return `[${label}] ${row.content}`;
  }).join("\n");
  const [model, fallbackModel] = await Promise.all([
    getSetting("model", "gemini-3.6-flash"),
    getSetting("fallback_model", "gemini-3.5-flash-lite"),
  ]);
  const prompt = [
    "Summarize this Digimium customer-support conversation.",
    "Return JSON only with exactly two keys: summary and knowledge_candidate.",
    "summary: concise Burmese record of the question, answer, and outcome.",
    "knowledge_candidate: a reusable Burmese fact learned specifically from an ADMIN answer, or null.",
    "Never turn customer claims, personal data, payment details, order IDs, credentials, or one-customer exceptions into knowledge.",
    "If there is no reusable ADMIN-confirmed fact, use null.",
    `An admin answer exists in this segment: ${hasAdminAnswer ? "yes" : "no"}`,
    "",
    transcript,
  ].join("\n");
  const result = await geminiGenerateWithFallback([model, fallbackModel], {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: 1000,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingLevel: "minimal" },
    },
  });
  if (!result.ok) {
    throw new Error(`Summary model failed (${result.status}, ${result.model})`);
  }
  const raw = (result.data.candidates?.[0]?.content?.parts ?? [])
    .filter((part: any) => !part.thought)
    .map((part: any) => part.text ?? "").join("").trim()
    .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {
      summary: raw || "Conversation summarized.",
      knowledge_candidate: null,
    };
  }
  const summaryText = cleanPlainText(
    String(parsed.summary || "Conversation summarized."),
  );
  const candidateText = hasAdminAnswer && parsed.knowledge_candidate
    ? cleanPlainText(String(parsed.knowledge_candidate))
    : "";
  const fromId = rows[0].id;
  const toId = rows[rows.length - 1].id;
  const { data: summary, error: summaryError } = await supabase
    .from("conversation_summaries").upsert({
      customer_id: topicRow.customer_id,
      from_message_id: fromId,
      to_message_id: toId,
      trigger_type: triggerType,
      summary: summaryText,
      created_by_telegram_id: adminId,
    }, { onConflict: "customer_id,to_message_id", ignoreDuplicates: true })
    .select().maybeSingle();
  if (summaryError) throw summaryError;
  if (!summary) return { created: false };

  const { error: topicError } = await supabase.from("customer_topics").update({
    last_summarized_message_id: toId,
    last_summary_at: new Date().toISOString(),
    summary_due_at: rows.length >= 120 ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq("customer_id", topicRow.customer_id);
  if (topicError) throw topicError;

  let candidateId: number | undefined;
  if (candidateText) {
    const { data: candidate, error: candidateError } = await supabase
      .from("knowledge_candidates").insert({
        summary_id: summary.id,
        customer_id: topicRow.customer_id,
        content: candidateText,
      }).select().single();
    if (candidateError) throw candidateError;
    candidateId = candidate.id;
    await publishCandidate(candidate.id);
  }

  const group = await getSupportGroup();
  if (group) {
    await sendTopicText(
      group,
      topicRow.message_thread_id,
      [
        triggerType === "manual"
          ? "📝 Summary saved"
          : "🕒 30-minute auto summary saved",
        summaryText,
        candidateId
          ? `Knowledge Candidate #${candidateId} ကို Review Topic ဆီပို့ထားပါတယ်။`
          : "အသစ်သင်ယူရန် Admin-confirmed fact မတွေ့ပါ။",
      ].join("\n\n"),
    );
  }
  return { created: true, candidateId, summary: summaryText };
}

async function runMaintenance(): Promise<any> {
  const now = new Date().toISOString();
  const { data, error } = await supabase.from("customer_topics")
    .select("*").not("summary_due_at", "is", null).lte("summary_due_at", now)
    .order("summary_due_at", { ascending: true }).limit(5);
  if (error) throw error;
  const results = [];
  for (const topic of data ?? []) {
    try {
      const result = await summarizeConversation(topic, "inactivity", null);
      results.push({ customerId: topic.customer_id, ...result });
    } catch (error) {
      console.error("Auto-summary failed", topic.customer_id, error);
      results.push({ customerId: topic.customer_id, error: errorText(error) });
    }
  }
  return { checked: data?.length ?? 0, results };
}

function isServiceMessage(msg: any): boolean {
  return Boolean(
    msg.forum_topic_created || msg.forum_topic_closed ||
      msg.forum_topic_reopened || msg.forum_topic_edited ||
      msg.general_forum_topic_hidden || msg.general_forum_topic_unhidden ||
      msg.new_chat_members || msg.left_chat_member || msg.new_chat_title ||
      msg.new_chat_photo || msg.delete_chat_photo || msg.group_chat_created ||
      msg.supergroup_chat_created || msg.pinned_message,
  );
}

async function handleGroupMessage(msg: any): Promise<boolean> {
  if (msg.chat?.type !== "supergroup") return false;
  if (msg.from?.is_bot) return false;
  if (isServiceMessage(msg)) return false;
  const text = String(msg.text ?? msg.caption ?? "").trim();
  const command = msg.text ? parseCommand(text) : null;

  if (command?.name === "setup") {
    await setupGroup(msg, command.args);
    return false;
  }

  const group = await getSupportGroup();
  if (!group || Number(group.telegram_chat_id) !== Number(msg.chat.id)) {
    return false;
  }
  if (!msg.from?.id || !(await isGroupAdmin(msg.chat.id, msg.from.id))) {
    return false;
  }

  if (
    group.knowledge_topic_id &&
    Number(msg.message_thread_id) === Number(group.knowledge_topic_id) &&
    command
  ) {
    if (await handleReviewCommand(group, msg, command)) return false;
  }

  if (!msg.message_thread_id) return false;
  if (
    Number(msg.message_thread_id) === Number(group.knowledge_topic_id) ||
    Number(msg.message_thread_id) === Number(group.logs_topic_id)
  ) return false;

  const topicRow = await getTopicWithCustomer(group.id, msg.message_thread_id);
  if (!topicRow) return false;

  if (command) {
    if (command.name === "totalhandoff") {
      await setSupportMode(group, topicRow, "total_handoff");
      return false;
    }
    if (command.name === "auto" || command.name === "resumeai") {
      await setSupportMode(group, topicRow, "hybrid");
      return false;
    }
    if (command.name === "close") {
      await closeHandoff(group, topicRow);
      return false;
    }
    if (command.name === "summarize" || command.name === "summerize") {
      const result = await summarizeConversation(
        topicRow,
        "manual",
        msg.from.id,
      );
      if (!result.created) {
        await sendTopicText(
          group,
          topicRow.message_thread_id,
          "Summary လုပ်ဖို့ message အသစ်မရှိသေးပါ။",
        );
      }
      return false;
    }
    if (command.name === "note") {
      await sendTopicText(
        group,
        topicRow.message_thread_id,
        command.args
          ? "🗒 Internal note အဖြစ်ထားပါတယ်။ Customer ဆီမပို့ပါ။"
          : "အသုံးပြုပုံ: /note internal message",
      );
      return false;
    }
    if (command.name === "status") {
      await sendTopicText(
        group,
        topicRow.message_thread_id,
        `Mode: ${topicRow.mode}\nHandoff: ${
          topicRow.handoff_active ? "active" : "clear"
        }`,
      );
      return false;
    }
    if (command.name === "help") {
      await sendTopicText(
        group,
        topicRow.message_thread_id,
        [
          "Customer Topic Commands",
          "/totalhandoff - Admin-only mode",
          "/auto or /resumeai - Hybrid AI mode",
          "/summarize or /summerize - Summary + knowledge candidate",
          "/close - Resolve handoff; topic stays open",
          "/status - Current mode",
          "/note text - Internal note; not sent to customer",
          "ပုံမှန်စာနဲ့ media တွေကို customer ဆီ တိုက်ရိုက်ပို့ပါမယ်။",
        ].join("\n"),
      );
      return false;
    }
    await sendTopicText(
      group,
      topicRow.message_thread_id,
      "မသိသော command ဖြစ်ပါတယ်။ /help ကိုသုံးပါ။",
    );
    return false;
  }

  await relayAdminMessage(group, topicRow, msg);
  return true;
}

async function handleCallbackQuery(callback: any) {
  const message = callback.message;
  const match = String(callback.data ?? "").match(/^kr:([aexd]):(\d+)$/);
  if (!message || !match) return;
  const group = await getSupportGroup();
  if (!group || Number(message.chat?.id) !== Number(group.telegram_chat_id)) {
    return;
  }
  if (
    !callback.from?.id ||
    !(await isGroupAdmin(message.chat.id, callback.from.id))
  ) {
    await tgCall("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Admin only",
      show_alert: true,
    });
    return;
  }
  const action = match[1];
  const candidateId = Number(match[2]);
  if (action === "e") {
    await tgCall("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "ဒီ candidate message ကို reply လုပ်ပြီး /edit အသစ်ပြင်ထားတဲ့စာ လို့ပို့ပါ။",
      show_alert: true,
    });
    return;
  }
  const status = action === "a"
    ? "approved"
    : action === "x"
    ? "declined"
    : "deleted";
  await reviewCandidate(candidateId, status, callback.from.id);
  await tgCall("answerCallbackQuery", {
    callback_query_id: callback.id,
    text: status === "approved"
      ? "Approved"
      : status === "declined"
      ? "Declined"
      : "Deleted",
  });
}

async function selfTest() {
  const checks: Record<string, unknown> = {};
  let model = "gemini-3.6-flash";
  let fallbackModel = "gemini-3.5-flash-lite";
  try {
    const me = await tgCall("getMe", {});
    checks.telegram = { ok: true, username: me.username ?? null };
  } catch (error) {
    checks.telegram = { ok: false, error: errorText(error) };
  }
  try {
    model = await getSetting("model", model);
    fallbackModel = await getSetting("fallback_model", fallbackModel);
    const group = await getSupportGroup();
    const { error } = await supabase.from("customer_topics").select(
      "customer_id",
    ).limit(1);
    if (error) throw error;
    checks.database = {
      ok: true,
      supportGroupConfigured: Boolean(group),
      knowledgeTopicConfigured: Boolean(group?.knowledge_topic_id),
      logsTopicConfigured: Boolean(group?.logs_topic_id),
    };
  } catch (error) {
    checks.database = { ok: false, error: errorText(error) };
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
    };
  } catch (error) {
    checks.gemini = { ok: false, error: errorText(error) };
  }
  return checks;
}

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname;
  if (req.method === "GET") {
    return Response.json({
      ok: true,
      service: "digimium-telegram-bot",
      version: "support-topics-1",
      webhookSecured: true,
    });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (path.endsWith("/maintenance")) {
    try {
      const expected = await getSetting("maintenance_secret");
      if (!expected || req.headers.get("x-maintenance-secret") !== expected) {
        return Response.json({ ok: false, error: "unauthorized" }, {
          status: 401,
        });
      }
      return Response.json({ ok: true, ...(await runMaintenance()) });
    } catch (error) {
      console.error("Maintenance error", error);
      return Response.json({ ok: false, error: errorText(error) }, {
        status: 500,
      });
    }
  }

  if (
    req.headers.get("x-telegram-bot-api-secret-token") !==
      TELEGRAM_WEBHOOK_SECRET
  ) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (path.endsWith("/self-test")) {
    const checks = await selfTest();
    const ok = Object.values(checks).every((check: any) => check.ok === true);
    return Response.json({ ok, checks }, { status: ok ? 200 : 502 });
  }

  if (path.endsWith("/setup-webhook") || path.endsWith("/webhook-status")) {
    try {
      if (path.endsWith("/setup-webhook")) {
        await tgCall("setWebhook", {
          url: `${SUPABASE_URL}/functions/v1/telegram-bot`,
          secret_token: TELEGRAM_WEBHOOK_SECRET,
          allowed_updates: ["message", "callback_query"],
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
      return Response.json({ ok: false, error: errorText(error) }, {
        status: 502,
      });
    }
  }

  let updateId: number | null = null;
  let customerDeliveryCommitted = false;
  try {
    const update = await req.json();
    updateId = Number(update.update_id);
    if (!Number.isFinite(updateId)) return new Response("ok");
    const kind = update.callback_query ? "callback_query" : "message";
    if (!(await claimUpdate(updateId, kind))) return new Response("ok");

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    } else if (update.message?.chat?.type === "private") {
      customerDeliveryCommitted = await handlePrivateMessage(update.message);
    } else if (update.message) {
      customerDeliveryCommitted = await handleGroupMessage(update.message);
    }
    await finishUpdate(updateId, "processed");
    return new Response("ok");
  } catch (error) {
    console.error("Bot error", error);
    if (updateId !== null) {
      await finishUpdate(
        updateId,
        customerDeliveryCommitted ? "processed" : "failed",
        errorText(error),
      );
    }
    return new Response(customerDeliveryCommitted ? "ok" : "retry", {
      status: customerDeliveryCommitted ? 200 : 500,
    });
  }
});
