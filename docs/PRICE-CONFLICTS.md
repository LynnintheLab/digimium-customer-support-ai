# Price decisions resolved by owner approval

The running bot reads `settings.system_prompt`. On 31 Aug 2026, the owner
reviewed and approved all 51 products through the Knowledge Review site. The
approved export is now stored in `docs/digimium_approved_knowledge.json`, and
its bot-ready text is stored in `docs/approved-product-knowledge.txt`.

The previous conflicts were resolved as follows:

| Product / plan | Owner-approved result |
|---|---:|
| ChatGPT Go own-mail, 1 month | 55,000 Ks |
| ChatGPT Go Share, 1 month, 1 device | 18,000 Ks |
| ChatGPT Plus Share, 1 month, 1 device | 45,000 Ks |
| Gemini Pro 3 / 6 / 12 month | Price still requires admin confirmation |
| Netflix TV, 1 month | 19,997 Ks |
| Canva Pro, 12 month | 125,000 Ks |
| QuillBot Premium, 3 months, 1 device | 40,000 Ks |
| QuillBot Premium, 6 months, 1 device | 60,000 Ks |

The live prompt was updated with `db/approved-knowledge-migration.sql`. The
migration backs up the previous prompt before replacing the knowledge section
and is safe to rerun for this approved export.
