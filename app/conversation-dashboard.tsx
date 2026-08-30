'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  CheckCheck,
  Clock3,
  Inbox,
  MessageCircleMore,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  UserRound,
  UsersRound,
} from 'lucide-react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

type Customer = {
  id: number;
  telegramId: number;
  name: string;
  username: string | null;
  lastMessage: string;
  lastAt: string;
  messageCount: number;
  openHandoffs: number;
};

type ChatMessage = {
  id: number;
  role: 'user' | 'model';
  content: string;
  createdAt: string;
};

type DashboardData = {
  customers: Customer[];
  totals: { customers: number; messages: number; openHandoffs: number };
};

const demoCustomers: Customer[] = [
  { id: 1, telegramId: 720194184, name: 'May Thazin', username: 'maythazin', lastMessage: 'Runway Pro ကို ဘယ်လောက်ကြာရင် ရမလဲခင်ဗျာ', lastAt: new Date(Date.now() - 4 * 60_000).toISOString(), messageCount: 18, openHandoffs: 0 },
  { id: 2, telegramId: 619023551, name: 'Ko Zaw', username: 'zawwin', lastMessage: 'ငွေလွှဲပြီးပါပြီခင်ဗျ', lastAt: new Date(Date.now() - 16 * 60_000).toISOString(), messageCount: 11, openHandoffs: 1 },
  { id: 3, telegramId: 933104062, name: 'Su Myat', username: null, lastMessage: 'CapCut own mail အကြောင်းသိချင်ပါတယ်', lastAt: new Date(Date.now() - 48 * 60_000).toISOString(), messageCount: 8, openHandoffs: 0 },
  { id: 4, telegramId: 889204183, name: 'Nay Lin', username: 'naylin88', lastMessage: 'ကျေးဇူးတင်ပါတယ်ခင်ဗျာ', lastAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), messageCount: 23, openHandoffs: 0 },
];

const demoMessages: ChatMessage[] = [
  { id: 1, role: 'user', content: 'video ထုတ်ဖို့ AI တွေဘာတွေရှိလဲ', createdAt: new Date(Date.now() - 9 * 60_000).toISOString() },
  { id: 2, role: 'model', content: 'AI Video Generator တွေမှာဆိုရင်\n\nKling AI\nStandard - 65,000 Ks\nPro - 180,000 Ks\n\nRunway\nStandard - 99,000 Ks\nPro - 195,000 Ks\n\nတို့ ရရှိနိုင်ပါတယ်ခင်ဗျာ။', createdAt: new Date(Date.now() - 8 * 60_000).toISOString() },
  { id: 3, role: 'user', content: 'Runway Pro ကို ဘယ်လောက်ကြာရင် ရမလဲခင်ဗျာ', createdAt: new Date(Date.now() - 5 * 60_000).toISOString() },
  { id: 4, role: 'model', content: 'Runway Pro က ပုံမှန်အားဖြင့် 15 မိနစ်မှ 1 နာရီအတွင်း ရနိုင်ပါတယ်ခင်ဗျာ။', createdAt: new Date(Date.now() - 4 * 60_000).toISOString() },
];

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function relativeTime(value: string) {
  const minutes = Math.floor(Math.max(0, Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function clockTime(value: string) {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Bangkok' }).format(new Date(value));
}

export function ConversationDashboard() {
  const [customers, setCustomers] = useState(demoCustomers);
  const [messages, setMessages] = useState(demoMessages);
  const [totals, setTotals] = useState({ customers: 4, messages: 60, openHandoffs: 1 });
  const [selectedId, setSelectedId] = useState(demoCustomers[0].id);
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isLive, setIsLive] = useState(false);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);

  const selected = customers.find((customer) => customer.id === selectedId) ?? customers[0];
  const filteredCustomers = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return customers;
    return customers.filter((customer) => [customer.name, customer.username ?? '', String(customer.telegramId), customer.lastMessage].some((value) => value.toLowerCase().includes(needle)));
  }, [customers, query]);

  const loadCustomers = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/conversations', { cache: 'no-store' });
      if (!response.ok) throw new Error('Conversation service unavailable');
      const data = (await response.json()) as DashboardData;
      setCustomers(data.customers);
      setTotals(data.totals);
      setIsLive(true);
      if (data.customers.length && !data.customers.some((item) => item.id === selectedId)) setSelectedId(data.customers[0].id);
    } catch {
      setIsLive(false);
    } finally {
      setIsLoading(false);
    }
  }, [selectedId]);

  const loadMessages = useCallback(async (customerId: number) => {
    try {
      const response = await fetch(`/api/conversations?customerId=${customerId}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Message service unavailable');
      const data = (await response.json()) as { messages: ChatMessage[] };
      setMessages(data.messages);
      setIsLive(true);
    } catch {
      if (!isLive) setMessages(demoMessages);
    }
  }, [isLive]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadCustomers(), 0);
    return () => window.clearTimeout(timer);
  }, [loadCustomers]);
  useEffect(() => {
    if (!selectedId) return;
    const timer = window.setTimeout(() => void loadMessages(selectedId), 0);
    return () => window.clearTimeout(timer);
  }, [loadMessages, selectedId]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadCustomers();
      if (selectedId) void loadMessages(selectedId);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [loadCustomers, loadMessages, selectedId]);

  return (
    <main className="h-dvh overflow-hidden bg-background text-foreground">
      <header className="flex h-16 items-center justify-between border-b border-border/80 bg-card px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-[0_8px_22px_rgba(19,108,129,0.2)]"><MessageCircleMore className="size-5" /></div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]">Digimium Conversations</h1>
              <Badge className={cn('hidden gap-1 border-0 sm:flex', isLive ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700')}><span className={cn('size-1.5 rounded-full', isLive ? 'bg-emerald-500' : 'bg-amber-500')} />{isLive ? 'Live' : 'Preview'}</Badge>
            </div>
            <p className="truncate text-xs text-muted-foreground">Customer support command center</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-2 rounded-full border border-border bg-muted/45 px-3 py-1.5 text-xs text-muted-foreground md:flex"><ShieldCheck className="size-3.5 text-primary" />Private admin view</div>
          <Button aria-label="Refresh conversations" variant="outline" size="icon-lg" onClick={() => void loadCustomers()} disabled={isLoading}><RefreshCw className={cn('size-4', isLoading && 'animate-spin')} /></Button>
          <Avatar size="lg"><AvatarFallback className="bg-primary/10 text-xs font-bold text-primary">DM</AvatarFallback></Avatar>
        </div>
      </header>

      <section className="grid h-[calc(100dvh-4rem)] grid-cols-1 lg:grid-cols-[340px_minmax(0,1fr)_286px]">
        <aside className={cn('min-w-0 border-r border-border bg-card', mobileChatOpen && 'hidden lg:block')}>
          <div className="border-b border-border p-4">
            <div className="mb-3 flex items-center justify-between">
              <div><p className="text-sm font-semibold">All conversations</p><p className="mt-0.5 text-xs text-muted-foreground">{totals.customers} customers · {totals.messages} messages</p></div>
              {totals.openHandoffs > 0 && <Badge className="bg-rose-50 text-rose-700">{totals.openHandoffs} need help</Badge>}
            </div>
            <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customers or messages" className="h-10 rounded-xl border-border bg-muted/50 pl-9 shadow-none" aria-label="Search conversations" /></div>
          </div>
          <ScrollArea className="h-[calc(100dvh-10.9rem)]">
            <div className="p-2">
              {filteredCustomers.length === 0 ? <div className="grid place-items-center px-6 py-20 text-center"><Search className="mb-3 size-6 text-muted-foreground" /><p className="text-sm font-medium">No conversations found</p><p className="mt-1 text-xs text-muted-foreground">Try a name, username, or Telegram ID.</p></div> : filteredCustomers.map((customer) => {
                const active = customer.id === selected?.id;
                return <button key={customer.id} type="button" onClick={() => { setSelectedId(customer.id); setMobileChatOpen(true); }} className={cn('group mb-1 flex w-full gap-3 rounded-xl px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', active ? 'bg-primary/[0.08]' : 'hover:bg-muted/70')}>
                  <div className="relative"><Avatar size="lg"><AvatarFallback className={cn('font-semibold', active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>{initials(customer.name)}</AvatarFallback></Avatar>{customer.openHandoffs > 0 && <span className="absolute -right-0.5 -top-0.5 size-3 rounded-full border-2 border-card bg-rose-500" />}</div>
                  <div className="min-w-0 flex-1"><div className="flex items-baseline justify-between gap-2"><p className="truncate text-sm font-semibold">{customer.name}</p><time className={cn('shrink-0 text-[11px]', active ? 'text-primary' : 'text-muted-foreground')}>{relativeTime(customer.lastAt)}</time></div><p className="mt-1 truncate text-xs leading-5 text-muted-foreground">{customer.lastMessage}</p></div>
                </button>;
              })}
            </div>
          </ScrollArea>
        </aside>

        <section className={cn('min-w-0 bg-[#f5f8f8]', !mobileChatOpen && 'hidden lg:flex', 'flex-col')}>
          {selected ? <>
            <div className="flex h-[70px] items-center justify-between border-b border-border bg-card px-4 md:px-5">
              <div className="flex min-w-0 items-center gap-3"><Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileChatOpen(false)} aria-label="Back to conversations"><ArrowLeft /></Button><Avatar size="lg"><AvatarFallback className="bg-primary text-sm font-semibold text-primary-foreground">{initials(selected.name)}</AvatarFallback></Avatar><div className="min-w-0"><p className="truncate text-sm font-semibold">{selected.name}</p><p className="truncate text-xs text-muted-foreground">{selected.username ? `@${selected.username}` : `Telegram ${selected.telegramId}`}</p></div></div>
              <Badge variant="outline" className="gap-1.5 border-primary/15 bg-primary/[0.04] text-primary"><Bot className="size-3" />AI assisted</Badge>
            </div>
            <ScrollArea className="flex-1">
              <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-end px-4 py-6 md:px-8">
                <div className="mb-6 flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"><Separator className="flex-1" />Today<Separator className="flex-1" /></div>
                <div className="space-y-4">{messages.map((message) => {
                  const fromBot = message.role === 'model';
                  return <div key={message.id} className={cn('flex gap-2.5', fromBot ? 'justify-start' : 'justify-end')}>
                    {fromBot && <div className="mt-auto grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"><Sparkles className="size-3.5" /></div>}
                    <div className={cn('max-w-[82%] md:max-w-[72%]', !fromBot && 'items-end')}><div className={cn('whitespace-pre-wrap rounded-2xl px-4 py-3 text-[13px] leading-6 shadow-sm', fromBot ? 'rounded-bl-md border border-border/70 bg-card text-foreground' : 'rounded-br-md bg-primary text-primary-foreground')}>{message.content}</div><div className={cn('mt-1 flex items-center gap-1 px-1 text-[10px] text-muted-foreground', !fromBot && 'justify-end')}>{clockTime(message.createdAt)}{!fromBot && <CheckCheck className="size-3 text-primary" />}</div></div>
                  </div>;
                })}</div>
              </div>
            </ScrollArea>
            <div className="border-t border-border bg-card px-4 py-3 md:px-5"><div className="mx-auto flex max-w-3xl items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3"><div className="flex min-w-0 items-center gap-2.5"><Inbox className="size-4 shrink-0 text-primary" /><p className="truncate text-xs text-muted-foreground">Read-only archive · replies continue through the customer bot</p></div><Badge variant="outline" className="shrink-0 bg-card">Auto refresh</Badge></div></div>
          </> : <div className="grid flex-1 place-items-center text-center"><div><MessageCircleMore className="mx-auto mb-3 size-8 text-muted-foreground" /><p className="text-sm font-medium">Select a conversation</p></div></div>}
        </section>

        <aside className="hidden min-w-0 border-l border-border bg-card lg:block">
          {selected && <ScrollArea className="h-full"><div className="p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Customer details</p>
            <div className="mt-5 flex flex-col items-center text-center"><Avatar className="size-16"><AvatarFallback className="bg-primary/10 text-lg font-bold text-primary">{initials(selected.name)}</AvatarFallback></Avatar><p className="mt-3 text-sm font-semibold">{selected.name}</p><p className="mt-1 text-xs text-muted-foreground">{selected.username ? `@${selected.username}` : 'No public username'}</p></div>
            <div className="mt-6 grid grid-cols-2 gap-2"><div className="rounded-xl border border-border bg-muted/30 p-3"><MessageCircleMore className="mb-2 size-4 text-primary" /><p className="text-lg font-semibold tracking-tight">{selected.messageCount}</p><p className="text-[11px] text-muted-foreground">Messages</p></div><div className="rounded-xl border border-border bg-muted/30 p-3"><Clock3 className="mb-2 size-4 text-primary" /><p className="text-lg font-semibold tracking-tight">{relativeTime(selected.lastAt)}</p><p className="text-[11px] text-muted-foreground">Last active</p></div></div>
            {selected.openHandoffs > 0 && <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3.5"><div className="flex items-center gap-2 text-rose-800"><UserRound className="size-4" /><p className="text-xs font-semibold">Admin help requested</p></div><p className="mt-1.5 text-xs leading-5 text-rose-700">This conversation has an unresolved handoff.</p></div>}
            <Separator className="my-5" />
            <div className="space-y-3 text-xs"><div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">Telegram ID</span><span className="font-mono text-[11px] font-medium">{selected.telegramId}</span></div><div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">Customer ID</span><span className="font-medium">#{selected.id}</span></div><div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">Status</span><span className="inline-flex items-center gap-1.5 font-medium text-emerald-700"><span className="size-1.5 rounded-full bg-emerald-500" />Active</span></div></div>
            <div className="mt-8 rounded-xl bg-[#0d2a32] p-4 text-white"><div className="flex items-center gap-2"><UsersRound className="size-4 text-teal-300" /><p className="text-xs font-semibold">Support pulse</p></div><p className="mt-3 text-2xl font-semibold tracking-tight">{totals.customers}</p><p className="mt-0.5 text-[11px] text-slate-300">Total customers in the archive</p></div>
          </div></ScrollArea>}
        </aside>
      </section>
    </main>
  );
}
