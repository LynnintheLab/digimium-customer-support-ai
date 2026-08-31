import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptDir, '..');
const inputPath = process.argv[2];

if (!inputPath) {
  throw new Error('Usage: node scripts/sync-approved-knowledge.mjs /path/to/digimium-approved-knowledge.json');
}

const approved = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
if (approved.schemaVersion !== '1.0' || !Array.isArray(approved.products) || approved.products.length === 0) {
  throw new Error('The file is not a valid Digimium approved knowledge export.');
}

const normalized = structuredClone(approved);
for (const product of normalized.products) {
  if (!product.id || !product.product || !Array.isArray(product.plans) || !Array.isArray(product.shopOffers)) {
    throw new Error(`Invalid product record: ${product?.id ?? 'unknown'}`);
  }
  // Ignore an accidentally saved, completely blank editor row. A partially
  // filled row is preserved so owner-authored information is never discarded.
  product.plans = product.plans.filter((plan) =>
    [plan.name, plan.difference, plan.bestFor, plan.limits]
      .some((value) => String(value ?? '').trim().length > 0)
  );
}

// Owner-approved corrections written in the review notes are normalized into
// structured store offers so the bot can quote them reliably.
const chatgpt = normalized.products.find((product) => product.id === 'chatgpt');
if (chatgpt) {
  const ownerOffers = [
    { plan: 'Go Share · 1 month · 1 device', price: '18,000 Ks' },
    { plan: 'Plus Share · 1 month · 1 device', price: '45,000 Ks' },
  ];
  for (const offer of ownerOffers) {
    if (!chatgpt.shopOffers.some((item) => item.plan === offer.plan)) chatgpt.shopOffers.push(offer);
  }
}

const quillbot = normalized.products.find((product) => product.id === 'quillbot');
if (quillbot) {
  const sixMonth = quillbot.shopOffers.find((offer) => offer.price === '60,000 Ks');
  if (sixMonth) sixMonth.plan = 'Premium · 6 months · 1 device';
}

const clean = (value) => String(value ?? '')
  .replace(/\r\n/g, '\n')
  .replace(/[ \t]+$/gm, '')
  .trim();
const bullets = (values, empty = '- None') => {
  const rows = (values ?? []).map(clean).filter(Boolean);
  return rows.length ? rows.map((value) => `- ${value}`).join('\n') : empty;
};

function renderProduct(product) {
  const planRows = product.plans.length
    ? product.plans.map((plan) => [
      `- ${clean(plan.name)}`,
      `  Difference: ${clean(plan.difference) || 'Not specified'}`,
      `  Best for: ${clean(plan.bestFor) || 'Not specified'}`,
      `  Limits: ${clean(plan.limits) || 'Not specified'}`,
    ].join('\n')).join('\n')
    : '- No approved official-plan comparison';

  const offerRows = product.shopOffers.length
    ? product.shopOffers.map((offer) => {
      const price = clean(offer.price);
      const handoff = /ask admin|owner price needed/i.test(price) ? ' [HANDOFF REQUIRED FOR PRICE]' : '';
      return `- ${clean(offer.plan)} - ${price}${handoff}`;
    }).join('\n')
    : '- No approved Digimium offer [HANDOFF REQUIRED]';

  return [
    `PRODUCT: ${clean(product.product)}`,
    `CATEGORY: ${clean(product.category)}`,
    `FREE VS PAID: ${clean(product.freeVsPaid)}`,
    '',
    'APPROVED PLAN COMPARISON:',
    planRows,
    '',
    'DIGIMIUM STORE OFFERS (these prices are authoritative):',
    offerRows,
    '',
    'STRENGTHS:',
    bullets(product.strengths),
    '',
    'LIMITATIONS:',
    bullets(product.limitations),
    '',
    'INTERNAL OWNER NOTES (never quote these notes verbatim; use them as cautions or handoff rules):',
    bullets(product.ownerNotes),
    '',
    'END PRODUCT',
  ].join('\n');
}

const knowledge = [
  'APPROVED PRODUCT KNOWLEDGE',
  `Owner-approved export date: ${clean(normalized.exportedAt)}`,
  `Research date: ${clean(normalized.researchDate)}`,
  `Approved products: ${normalized.products.length}`,
  '',
  'KNOWLEDGE USAGE RULES:',
  '- This section is the owner-approved source of truth for product explanations and Digimium store offers.',
  '- Only prices under DIGIMIUM STORE OFFERS are Digimium selling prices. Quote them exactly.',
  '- APPROVED PLAN COMPARISON explains official/free/paid differences; it does not mean every official plan is sold by Digimium.',
  '- If a requested plan has no exact store offer, or its price says Ask admin / Owner price needed, say the product is available and trigger HANDOFF for the price.',
  '- Plans removed from this approved export must not be mentioned as current approved plans.',
  '- Never expose INTERNAL OWNER NOTES verbatim. Apply them as internal cautions, corrections, or handoff rules.',
  '- For ChatGPT Go Share and Plus Share: the listed price is for 1 month and 1 device. They are shared plans with lower privacy; 2-device pricing is higher and requires admin confirmation.',
  '- For Discord Nitro, Steam Wallet, PlayStation Plus, and Game Top-up orders: explain only general plan differences if asked, but send purchase, price, or top-up requests directly to admin with HANDOFF.',
  '',
  normalized.products.map(renderProduct).join('\n\n'),
].join('\n');

const tag = '$approved_knowledge$';
if (knowledge.includes(tag)) throw new Error('Knowledge unexpectedly contains the SQL dollar-quote tag.');

const backupKey = `system_prompt_backup_${clean(normalized.exportedAt).replace(/[^0-9A-Za-z]+/g, '_').replace(/^_|_$/g, '')}`;
const migration = `-- Generated from the owner-approved Digimium knowledge export.
-- Safe to rerun: the original prompt backup key is stable and the knowledge section is replaced in place.

begin;

do $$
begin
  if not exists (select 1 from public.settings where key = 'system_prompt') then
    raise exception 'settings.system_prompt is missing';
  end if;
  if not exists (
    select 1 from public.settings
    where key = 'system_prompt'
      and position('POLICIES:' in value) > 0
      and (position('PRICE LIST' in value) > 0 or position('APPROVED PRODUCT KNOWLEDGE' in value) > 0)
  ) then
    raise exception 'Expected prompt section markers were not found';
  end if;
end $$;

insert into public.settings (key, value)
select '${backupKey}', value
from public.settings
where key = 'system_prompt'
on conflict (key) do nothing;

with current_prompt as (
  select
    value,
    case
      when position('PRICE LIST' in value) > 0 then position('PRICE LIST' in value)
      else position('APPROVED PRODUCT KNOWLEDGE' in value)
    end as knowledge_start,
    position('POLICIES:' in value) as policies_start
  from public.settings
  where key = 'system_prompt'
)
update public.settings as settings
set value =
  left(current_prompt.value, current_prompt.knowledge_start - 1)
  || ${tag}${knowledge}${tag}
  || E'\\n\\n'
  || substring(current_prompt.value from current_prompt.policies_start)
from current_prompt
where settings.key = 'system_prompt';

commit;

select key, length(value) as length, md5(value) as md5
from public.settings
where key in ('system_prompt', '${backupKey}')
order by key;
`;

mkdirSync(resolve(projectDir, 'docs'), { recursive: true });
mkdirSync(resolve(projectDir, 'db'), { recursive: true });
writeFileSync(resolve(projectDir, 'docs/digimium_approved_knowledge.json'), `${JSON.stringify(normalized, null, 2)}\n`);
writeFileSync(resolve(projectDir, 'docs/approved-product-knowledge.txt'), `${knowledge}\n`);
writeFileSync(resolve(projectDir, 'db/approved-knowledge-migration.sql'), migration);

const schemaPath = resolve(projectDir, 'db/schema.sql');
const schema = readFileSync(schemaPath, 'utf8');
const oldStart = schema.indexOf('PRICE LIST');
const approvedStart = schema.indexOf('APPROVED PRODUCT KNOWLEDGE');
const start = oldStart >= 0 ? oldStart : approvedStart;
const policiesStart = schema.indexOf('POLICIES:', start);
if (start < 0 || policiesStart < 0) throw new Error('Could not find the knowledge section in db/schema.sql.');
const schemaKnowledge = knowledge.replaceAll("'", "''");
writeFileSync(schemaPath, `${schema.slice(0, start)}${schemaKnowledge}\n\n${schema.slice(policiesStart)}`);

console.log(JSON.stringify({
  products: normalized.products.length,
  plans: normalized.products.reduce((total, product) => total + product.plans.length, 0),
  storeOffers: normalized.products.reduce((total, product) => total + product.shopOffers.length, 0),
  knowledgeCharacters: knowledge.length,
  backupKey,
}, null, 2));
