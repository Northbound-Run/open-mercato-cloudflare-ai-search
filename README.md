# @northbound-run/search-cloudflare-ai

Cloudflare AI Search as a pluggable **fulltext driver** for [Open Mercato](https://docs.openmercato.com) — hybrid BM25 + vector retrieval behind the stock `FullTextSearchDriver` contract, with no search service to operate.

A peer of the built-in Meilisearch driver in `@open-mercato/search`, implementing the same interface. Drop it in and `SearchService` fuses it with the `vector` and `tokens` strategies exactly as before.

---

## Read this first

### It replaces the search *service*, not the search *architecture*

Open Mercato's search is three strategies fused with Reciprocal Rank Fusion: `fulltext` (Meilisearch), `vector` (pgvector/Chroma/Qdrant + an embedding provider), and `tokens` (a Postgres hash index that always works). This package supplies a second `fulltext` driver. Everything else is untouched, and `tokens` remains the fallback when Cloudflare is unreachable.

The practical trade: you stop operating a Meilisearch container, and you accept ~250ms search latency instead of single-digit milliseconds.

### Backend list views are NOT affected

Despite what you might assume, list-view `q` filtering does not go through `SearchService` — it joins `search_tokens` directly inside `QueryEngine`. Installing this changes **Cmd+K global search, `/api/search`, and the AI assistant's MCP search tool**. Nothing else. That is what makes it low-risk and trivially reversible.

### Your data goes to a managed service

Meilisearch was a container you controlled. Cloudflare AI Search is managed and must hold readable text in order to embed it. This driver honours `fieldPolicy.excluded` / `fieldPolicy.hashOnly` and, with `SEARCH_EXCLUDE_ENCRYPTED_FIELDS=true`, the tenant encryption map — so encrypted fields stay searchable only via the `tokens` strategy, which hashes rather than storing plaintext.

**Decide this before indexing production data.** It is a deployment decision the package cannot make for you.

### Cloudflare AI Search is in open beta, and we found a data leak in it

See [Cross-tenant safety](#cross-tenant-safety). It is handled, but you should understand it before trusting the product with multi-tenant data.

---

## Install

```bash
yarn add @northbound-run/search-cloudflare-ai
```

Peer dependencies: `@open-mercato/search` and `@open-mercato/shared` (0.6.x).

### 1. Provision the instance

Custom metadata fields must exist **before** any upload — Cloudflare silently drops undeclared fields, which would produce hits that cannot be mapped back to an Open Mercato entity.

```bash
npx wrangler ai-search create my-instance \
  --type builtin \
  --hybrid-search \
  --custom-metadata entity:text \
  --custom-metadata org:text
```

`--hybrid-search` sets `index_method` to `{vector: true, keyword: true}`. Vector-only is the default and misses exact identifiers like `PO-10432`.

### 2. API token

Needs **Account → AI Search:Edit** and **AI Search:Run**. A `wrangler login` OAuth token already carries both.

### 3. Environment

```bash
CF_AI_SEARCH_ACCOUNT_ID=<account id>      # npx wrangler whoami
CF_AI_SEARCH_API_TOKEN=<token>
CF_AI_SEARCH_INSTANCE=my-instance
# Optional
CF_AI_SEARCH_NAMESPACE=                   # default namespace when unset
CF_AI_SEARCH_RETRIEVAL_TYPE=hybrid        # vector | keyword | hybrid
CF_AI_SEARCH_MATCH_THRESHOLD=0.3          # Cloudflare default is 0.4
```

### 4. One line of app wiring

```ts
// src/di.ts
import { registerCloudflareAiSearch } from '@northbound-run/search-cloudflare-ai/register'

export async function register(container: AppContainer) {
  await bootstrap(container)
  registerCloudflareAiSearch(container)   // no-op unless CF_AI_SEARCH_* is set
}
```

**This cannot be a module `di.ts`.** Open Mercato registers module DI at step 2 of container creation and `searchService` only exists after core bootstrap at step 3 — and step 2 swallows throws, so the failure mode would be silent. The app's own `src/di.ts` runs at step 4, which is the first point where the strategy can be added. See the comment block in `src/register.ts`.

### 5. Verify

```bash
yarn mercato search status         # expect: Full-Text Search (fulltext)  AVAILABLE
yarn mercato search reindex --tenant <tenantId> --purgeFirst
yarn mercato search query -q "freight invoice" --tenant <tenantId> --strategy fulltext
```

---

## Cross-tenant safety

Cloudflare's **BM25 keyword path ignores range operators on the built-in `folder` attribute.** Equality-family operators are applied correctly on every path. Measured 2026-08-08 against a hybrid instance with a canary document planted under a second tenant:

| Filter on `folder` | `vector` | `keyword` | `hybrid` |
| --- | --- | --- | --- |
| `{ $gte: 't/a/', $lt: 't/a0' }` | clean | **LEAK** | **LEAK** |
| `{ $eq: 't/a/' }` | clean | clean | clean |
| `{ $in: ['t/a/'] }` | clean | clean | clean |
| `{ $ne: 't/b/' }` | clean | clean | clean |

The leak only surfaces when a foreign tenant's document is the strongest *keyword* match — which is both the most damaging case and the one a friendly smoke test will never produce.

This is not an exotic filter shape. It is the one Cloudflare's own docs prescribe, in [Filtering](https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/) as *the* folder "starts with" idiom, and in [Multitenancy](https://developers.cloudflare.com/ai-search/how-to/per-tenant-search/) as the recommended way to scope a shared instance per tenant.

**How this driver avoids it.** Item keys are exactly one folder level deep — `t/{tenantId}/{recordId}.md` — so tenant scoping is a plain `$eq` and the broken operator is never used. Custom metadata filters (`entity`, `org`) were verified correct on all three retrieval types.

If you fork this driver, **do not nest the key scheme** without re-running `yarn spike`. There is a unit test asserting the tenant filter carries `$eq` and no `$gte`/`$lt`, and the live harness plants the canary.

---

## How it maps onto Open Mercato

| Open Mercato | Cloudflare AI Search |
| --- | --- |
| Per-tenant Meilisearch index | Key prefix `t/{tenantId}/`, filtered with `folder: { $eq }` |
| `_entityId` filterable attribute | Custom metadata `entity`, filtered with `$in` |
| `_organizationId` filterable attribute | Custom metadata `org` (`_` sentinel when null) |
| `index()` / `bulkIndex()` | Items API upload; built-in storage indexes without a sync schedule |
| `delete()` | Items API: resolve key → id, then delete |
| `search()` | `POST /search`, hybrid retrieval, chunks collapsed to records by key |
| presenter / url / links in the index | **Not stored.** `createPresenterEnricher` rebuilds them from `entity_indexes` and decrypts per tenant |

Field selection runs through `extractSearchableFields` from `@open-mercato/search` — the same helper the Meilisearch driver uses — so field policies and encryption maps behave identically.

---

## Measured characteristics

From the live harness against a real instance. Re-measure on your own corpus.

**Search latency:** min 219ms, median ~250ms, max 296ms. Meilisearch on the same host is single-digit ms. Fine for a debounced Cmd+K; not for keystroke-level type-ahead.

**Indexing is slow and variable:** four ~200-byte documents reached `completed` in **36s** on one run and **>84s** on another. Uploads return in ~500ms; the queue behind them is the variance. There is no read-after-write — treat reindex as a background job.

**Query quality** on a deliberately tiny 3-document corpus (rank of the document a human would pick):

| Shape | Query | Rank |
| --- | --- | --- |
| Exact identifier | `PO-10432` | **1** |
| Semantic, no shared words | `shipment arrived at the loading bay` | **1** |
| Short prefix | `Acm` | 2 |
| Misspelling | `freigt invoice` | 2 |
| Natural language | `which orders are on hold awaiting a vendor response` | 2 |

Exact identifiers and genuine semantic matches land first — the two ends Meilisearch alone never covered well. Short prefixes and misspellings retrieve but rank second: there is no typo-tolerance knob, so vector similarity has to carry them.

**Three documents says almost nothing about ranking.** Re-measure before quoting this. If prefixes matter to you, try the `trigram` keyword tokenizer instead of the default `porter` — but note that changing it triggers a full reindex.

---

## Limits

1. **`max_num_results` caps at 50, and there is no offset.** `/api/search` advertises `limit` up to 100; Cloudflare cannot serve it. The driver returns `[]` for `offset > 0` rather than silently repeating page one.
2. **Items list `per_page` caps at 50** — 100 returns `400 code 7001`. Undocumented.
3. **Results are chunks, not records.** The driver over-fetches 3× and collapses by item key.
4. **No filtered bulk delete.** `purge()` lists and deletes item by item at 50/page, capped at 200 pages (10,000 items), throwing rather than truncating past that. Meilisearch does this in one call.
5. **No batch upload.** `bulkIndex` is N parallel requests at concurrency 8.
6. **Max 5 custom metadata fields**, 500 chars per text value. This driver uses two.
7. **Every query is metered inference.** AI Search is free during open beta, but Workers AI and AI Gateway bill separately and each query embeds the query text.

---

## Development

```bash
yarn install
yarn typecheck
yarn test          # unit tests, no network
yarn build

# Live harness against a real instance — the regression net for the leak above
CF_AI_SEARCH_ACCOUNT_ID=<id> CF_AI_SEARCH_INSTANCE=<name> yarn spike
```

The harness creates fixtures across two tenants, two orgs and two entity types, then checks the metadata contract, cross-tenant isolation, all three filter kinds, five query shapes, latency and delete. Run it after every dependency bump — this is an open-beta product.

## Teardown

Unset `CF_AI_SEARCH_ACCOUNT_ID`. `registerCloudflareAiSearch()` becomes a no-op and search returns to whatever strategies remain. Then `npx wrangler ai-search delete my-instance`.

## License

MIT
