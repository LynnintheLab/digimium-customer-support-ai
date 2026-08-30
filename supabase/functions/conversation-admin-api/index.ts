import { createClient } from 'jsr:@supabase/supabase-js@2';

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const DASHBOARD_API_SECRET = requiredEnv('DASHBOARD_API_SECRET');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function authorized(request: Request) {
  return request.headers.get('authorization') === `Bearer ${DASHBOARD_API_SECRET}`;
}

Deno.serve(async (request) => {
  if (request.method === 'GET' && new URL(request.url).pathname.endsWith('/health')) {
    return json({ ok: true, service: 'conversation-admin-api' });
  }

  if (!authorized(request)) return json({ error: 'unauthorized' }, 401);
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);

  try {
    const requestUrl = new URL(request.url);
    const customerIdValue = requestUrl.searchParams.get('customerId');

    if (customerIdValue) {
      const customerId = Number.parseInt(customerIdValue, 10);
      if (!Number.isSafeInteger(customerId) || customerId <= 0) {
        return json({ error: 'invalid_customer_id' }, 400);
      }

      const [{ data: customer, error: customerError }, { data: messages, error: messagesError }] = await Promise.all([
        supabase.from('customers').select('id,telegram_id,name,username,created_at,last_seen').eq('id', customerId).maybeSingle(),
        supabase.from('messages').select('id,role,content,created_at').eq('customer_id', customerId).order('created_at', { ascending: true }).limit(1000),
      ]);
      if (customerError) throw customerError;
      if (messagesError) throw messagesError;
      if (!customer) return json({ error: 'customer_not_found' }, 404);

      return json({
        customer: {
          id: customer.id,
          telegramId: customer.telegram_id,
          name: customer.name || `Telegram ${customer.telegram_id}`,
          username: customer.username,
          createdAt: customer.created_at,
          lastAt: customer.last_seen,
        },
        messages: (messages ?? []).map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          createdAt: message.created_at,
        })),
      });
    }

    const { data: customers, error: customersError } = await supabase
      .from('customers')
      .select('id,telegram_id,name,username,created_at,last_seen')
      .order('last_seen', { ascending: false })
      .limit(250);
    if (customersError) throw customersError;

    const customerIds = (customers ?? []).map((customer) => customer.id);
    const messageQuery = customerIds.length
      ? supabase.from('messages').select('id,customer_id,role,content,created_at').in('customer_id', customerIds).order('created_at', { ascending: false }).limit(10000)
      : Promise.resolve({ data: [], error: null });
    const handoffQuery = customerIds.length
      ? supabase.from('handoffs').select('id,customer_id,resolved').in('customer_id', customerIds)
      : Promise.resolve({ data: [], error: null });

    const [messageResult, handoffResult, customerCountResult, messageCountResult, handoffCountResult] = await Promise.all([
      messageQuery,
      handoffQuery,
      supabase.from('customers').select('*', { count: 'exact', head: true }),
      supabase.from('messages').select('*', { count: 'exact', head: true }),
      supabase.from('handoffs').select('*', { count: 'exact', head: true }).eq('resolved', false),
    ]);
    if (messageResult.error) throw messageResult.error;
    if (handoffResult.error) throw handoffResult.error;

    const latestByCustomer = new Map<number, { content: string; created_at: string }>();
    const messageCounts = new Map<number, number>();
    for (const message of messageResult.data ?? []) {
      messageCounts.set(message.customer_id, (messageCounts.get(message.customer_id) ?? 0) + 1);
      if (!latestByCustomer.has(message.customer_id)) latestByCustomer.set(message.customer_id, message);
    }

    const openHandoffs = new Map<number, number>();
    for (const handoff of handoffResult.data ?? []) {
      if (!handoff.resolved) openHandoffs.set(handoff.customer_id, (openHandoffs.get(handoff.customer_id) ?? 0) + 1);
    }

    return json({
      customers: (customers ?? []).map((customer) => {
        const latest = latestByCustomer.get(customer.id);
        return {
          id: customer.id,
          telegramId: customer.telegram_id,
          name: customer.name || `Telegram ${customer.telegram_id}`,
          username: customer.username,
          lastMessage: latest?.content ?? 'No messages yet',
          lastAt: latest?.created_at ?? customer.last_seen ?? customer.created_at,
          messageCount: messageCounts.get(customer.id) ?? 0,
          openHandoffs: openHandoffs.get(customer.id) ?? 0,
        };
      }),
      totals: {
        customers: customerCountResult.count ?? customers?.length ?? 0,
        messages: messageCountResult.count ?? messageResult.data?.length ?? 0,
        openHandoffs: handoffCountResult.count ?? 0,
      },
    });
  } catch (error) {
    console.error('Conversation admin API error', error);
    return json({ error: 'internal_error' }, 500);
  }
});
