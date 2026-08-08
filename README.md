# @northbound-run/search-cloudflare

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
yarn add @northbound-run/search-cloudflare
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

### 4. Enable the module

```ts
// src/modules.ts
{ id: 'search_cloudflare', from: '@northbound-run/search-cloudflare' },
```

Then `yarn generate`. That is the whole integration — no app `src/di.ts` wiring.
The module ships no entities, migrations, routes or UI: a `di.ts` that registers
the driver, and the `doctor` CLI. It declares `requires: ['search']`.

**Registration has to live in a module `di.ts`, not the app's.** Open Mercato
reaches app-level DI through `await import('@/di')` — a bundler-only path alias
that throws `ERR_MODULE_NOT_FOUND` under raw Node into a bare `catch {}`. So app
DI silently never runs in the mercato CLI or in queue workers. Since indexing
runs in workers spawned as CLI processes, a driver registered there would serve
reads from Next while never writing anything. Module `di.ts` runs in every
runtime. `src/register.ts` remains as a fallback for one narrow case — see its
header.

### 5. Verify

```bash
yarn mercato search_cloudflare doctor
yarn mercato search status         # expect: Full-Text Search (fulltext)  AVAILABLE
yarn mercato search reindex --tenant <tenantId> --purgeFirst
yarn mercato search query -q "freight invoice" --tenant <tenantId> --strategy fulltext
```

---

## Status: 0.1.x is not yet usable end to end

Reads work. **Indexing does not, on stock Open Mercato 0.6.x**, and `doctor`
reports it as a failed check rather than letting you discover it later.

Field policies — the per-entity whitelists that keep `ssn`, `government_id`,
`date_of_birth` and `tax_id` out of any index — live in a registry populated by
**app** bootstrap, which the mercato CLI does not load for the same reason it
does not load app DI. In CLI and worker processes that registry is empty, so:

- this driver **fails closed** and indexes documents with no content;
- the built-in Meilisearch driver **fails open** — with no whitelist it indexes
  every field, excluded ones included. That is an upstream bug in the runtime
  that does the actual indexing, and it is not caused by this package.

Until the configs are visible in the CLI, either index from the Next runtime
(`AUTO_SPAWN_WORKERS=false`, giving up background reindex) or carry the configs
into the CLI registry upstream. `doctor`'s `field-policies` check tells you
which situation you are in.

---

## Diagnostics

```bash
yarn mercato search_cloudflare doctor           # full, includes the live probe
yarn mercato search_cloudflare doctor --quick   # config checks only
```

Checks, in order:

| Check | Fails when |
| --- | --- |
| Environment configured | any `CF_AI_SEARCH_*` variable is missing — the driver silently does not register without them |
| Instance exists | no such instance, or the API token is wrong/expired (warns if indexing is paused) |
| Custom metadata schema | `entity` or `org` is undeclared or the wrong type — Cloudflare **silently drops** undeclared fields, and a hit without `entity` cannot be mapped to an Open Mercato entity |
| Hybrid retrieval | *(warn)* keyword or vector indexing is off |
| Driver registered | no `fulltext` strategy in the container — i.e. the app forgot the wiring in step 4, which is otherwise completely silent |
| Cross-tenant isolation | a planted canary from a second synthetic tenant came back. **This is the check the command exists for.** |
| Range-filter bug | *(warn)* reports whether the upstream Cloudflare bug is still present |

Exits non-zero on any failure, so it works as a deploy gate.

The isolation probe indexes two canary documents under synthetic tenants
(`__om-doctor-a` / `__om-doctor-b`), queries them, and deletes them in a
`finally`. It writes to your real index, so the command says so before it
starts. Expect it to take a minute or two — Cloudflare indexing is
asynchronous and was measured at 36–90s even for tiny documents. `--quick`
skips it.

Sample output from a healthy instance:

```
  ✓ Environment configured
      all three variables present
  ✓ Instance exists
      "my-instance" (status: ready, namespace: default)
  ✓ Custom metadata schema
      entity:text, org:text declared
  ✓ Hybrid retrieval enabled
      vector + keyword (tokenizer: porter)
  ✓ Driver registered with SearchService
      fulltext -> cloudflare-ai-search
  ✓ Cross-tenant isolation (live)
      canary stayed in its own tenant (indexed in 50s)
  ! Cloudflare range-filter bug
      still present — BM25 ignores $gte/$lt on `folder`
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

If you fork this driver, **do not nest the key scheme**. There is a unit test asserting the tenant filter carries `$eq` and no `$gte`/`$lt`, and two live checks that plant a canary: `yarn spike` during development, and `yarn mercato search_cloudflare doctor` against a deployed instance.

Because this is a beta product, "we measured it once" is not durable. `doctor` re-measures it on demand and reports separately on whether the upstream bug is still present — so if Cloudflare fixes it, you will see that too, and nested key schemes become available again.

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
