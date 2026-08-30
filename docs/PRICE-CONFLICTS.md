# Price-source conflicts requiring owner review

Neither JSON file in this folder is read by the running bot. The live source of
truth is the `settings.system_prompt` database row seeded by `db/schema.sql`.

The supplied exports disagree on these business values, so they were not
silently guessed or merged:

| Product / plan | `digimium_kb.json` | Full export / live prompt |
|---|---:|---:|
| ChatGPT Go own-mail, 1 month | 49,000 Ks | 55,000 Ks |
| ChatGPT Go Share | 18,000 Ks | absent |
| ChatGPT Plus Share | 45,000 Ks | absent |
| Gemini Pro 3 / 6 / 12 month | 40k / 80k / 145k | blank in full export; absent live |
| Netflix TV, 1 month | 20,000 Ks | 19,997 Ks |
| Canva Pro, 12 month | 135,000 Ks | 125,000 Ks |

Quillbot also has two plans with the identical name but different prices
(40,000 and 60,000 Ks), so a customer cannot distinguish them.

Have the shop owner choose the intended values and unique plan names. Then
update one canonical price export, regenerate the system prompt, update the
seed in `db/schema.sql`, and update the live `settings.system_prompt` row.
