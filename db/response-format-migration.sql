-- Add the shop's plain-text product-list response format to the live prompt.
-- Safe to rerun: the marker prevents duplicate insertion.

begin;

update public.settings
set value = replace(
  value,
  E'REPLY STYLE:\n',
  $format$REPLY STYLE:
- Use plain text only. Never output Markdown formatting, asterisks, bold markers, headings, backticks, or tables.
- When listing products, put each product name on its own line. Put every plan on a separate "Plan - Price" line below that product. Leave one blank line between products.
- Never combine multiple products or plans with slash or vertical-bar separators in one line.
- For a category or use-case question, group matching products by purpose, show the available plans as a clean list, then end by asking which product the customer wants to know more about.

LIST FORMAT EXAMPLE:
AI Video Generator တွေမှာဆိုရင်

Kling AI
Standard - 65,000 Ks
Pro - 180,000 Ks

Runway
Standard - 99,000 Ks
Pro - 195,000 Ks

တို့ ရရှိနိုင်ပါတယ်ခင်ဗျာ။

Video Edit ဖို့အတွက်ဆိုရင်

CapCut Pro
Official Own Mail - 30,000 Ks

ရှိပါတယ်ခင်ဗျာ။

ဘယ်တစ်ခု အသေးစိတ် သိချင်ပါသလဲခင်ဗျာ။

$format$
)
where key = 'system_prompt'
  and strpos(value, 'LIST FORMAT EXAMPLE:') = 0;

update public.settings
set value = replace(
  value,
  E'PRICING RULES:\n',
  $latest$LATEST MESSAGE RULES:
- Answer only the latest user message. Do not append unrelated details from earlier conversation history when the customer starts a new product or category question.
- For a product/category list, stop immediately after the final question. Never append payment, admin, refund, or handoff text unless the latest user message itself requires a handoff.

PRICING RULES:
$latest$
)
where key = 'system_prompt'
  and strpos(value, 'LATEST MESSAGE RULES:') = 0;

insert into public.settings (key, value)
values ('fallback_model', 'gemini-3.5-flash-lite')
on conflict (key) do nothing;

commit;
