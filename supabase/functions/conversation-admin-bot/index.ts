import { createClient } from 'jsr:@supabase/supabase-js@2';

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const TELEGRAM_TOKEN = requiredEnv('ADMIN_DASHBOARD_BOT_TOKEN');
const WEBHOOK_SECRET = requiredEnv('ADMIN_DASHBOARD_WEBHOOK_SECRET');
const ADMIN_CHAT_ID = requiredEnv('ADMIN_CHAT_ID');
const DASHBOARD_URL = requiredEnv('DASHBOARD_URL');
const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');

const telegramApi = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function telegram(method: string, payload: Record<string, unknown>) {
  const response = await fetch(`${telegramApi}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(`Telegram ${method} failed`);
  return data.result;
}

async function sendDashboard(chatId: number) {
  await telegram('sendMessage', {
    chat_id: chatId,
    text: 'Digimium customer conversations dashboard ကို အောက်က button ကနေ ဖွင့်နိုင်ပါတယ်။',
    reply_markup: {
      inline_keyboard: [[{ text: 'Open Conversations Dashboard', url: DASHBOARD_URL }]],
    },
  });
}

async function sendStatus(chatId: number) {
  const [customers, messages, handoffs] = await Promise.all([
    supabase.from('customers').select('*', { count: 'exact', head: true }),
    supabase.from('messages').select('*', { count: 'exact', head: true }),
    supabase.from('handoffs').select('*', { count: 'exact', head: true }).eq('resolved', false),
  ]);
  await telegram('sendMessage', {
    chat_id: chatId,
    text: [
      'Digimium Support Status',
      '',
      `Customers - ${customers.count ?? 0}`,
      `Messages - ${messages.count ?? 0}`,
      `Open handoffs - ${handoffs.count ?? 0}`,
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [[{ text: 'View conversations', url: DASHBOARD_URL }]],
    },
  });
}

Deno.serve(async (request) => {
  if (request.method === 'GET') {
    return Response.json({ ok: true, service: 'conversation-admin-bot' });
  }
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  if (request.headers.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }

  try {
    const update = await request.json();
    const message = update.message;
    if (!message?.chat?.id || String(message.chat.id) !== ADMIN_CHAT_ID) {
      return new Response('ok');
    }

    const text = String(message.text ?? '').trim();
    if (/^\/(?:status)(?:@\w+)?(?:\s|$)/i.test(text)) {
      await sendStatus(message.chat.id);
    } else {
      await sendDashboard(message.chat.id);
    }
    return new Response('ok');
  } catch (error) {
    console.error('Admin bot error', error);
    return new Response('error', { status: 500 });
  }
});
