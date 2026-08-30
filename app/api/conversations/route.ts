export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const apiUrl = process.env.CONVERSATION_API_URL?.trim();
  const apiSecret = process.env.DASHBOARD_API_SECRET?.trim();
  if (!apiUrl || !apiSecret) {
    return Response.json({ error: 'service_not_configured' }, { status: 503 });
  }

  const incomingUrl = new URL(request.url);
  const upstreamUrl = new URL(apiUrl);
  const customerId = incomingUrl.searchParams.get('customerId');
  if (customerId) upstreamUrl.searchParams.set('customerId', customerId);

  try {
    const response = await fetch(upstreamUrl, {
      headers: { Authorization: `Bearer ${apiSecret}` },
      cache: 'no-store',
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('content-type') ?? 'application/json',
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    console.error('Conversation proxy error', error);
    return Response.json({ error: 'service_unavailable' }, { status: 502 });
  }
}
