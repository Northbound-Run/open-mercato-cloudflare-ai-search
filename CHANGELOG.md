# Changelog

## 0.1.0

First release. Cloudflare AI Search behind Open Mercato's stock
`FullTextSearchDriver` contract, so `SearchService` fuses it with the `vector`
and `tokens` strategies exactly as it does Meilisearch.

**Not yet usable end to end** — see "Status" in the README. Reads work;
indexing is blocked by field-policy configs not being visible in the mercato
CLI runtime, which `doctor` reports as a failed check.

### Added

- `createAiSearchDriver()` — `FullTextSearchDriver` over the AI Search REST API.
  Hybrid BM25 + vector retrieval, chunk results collapsed to records, tenant
  scoping by `folder` equality, `entity`/`org` custom metadata.
- `search_cloudflare` module with a `di.ts` that registers the driver in every
  runtime (Next, mercato CLI, queue workers).
- `mercato search_cloudflare doctor` — seven checks against a live instance,
  including a cross-tenant isolation probe that plants a canary under a second
  synthetic tenant and deletes it afterwards. Exits non-zero, so it works as a
  deploy gate.
- `scripts/spike.ts` — standalone live harness, no database required.

### Findings that shaped the design

Measured against a real instance on 2026-08-08; details in the README.

- **Cloudflare's BM25 path ignores range operators on `folder`.** The "starts
  with" idiom Cloudflare's own multitenancy docs prescribe for per-tenant
  scoping leaks foreign-tenant documents under keyword and hybrid retrieval.
  Equality operators are enforced correctly. Item keys are therefore exactly one
  folder level deep so the broken operator is never reached; a unit test pins
  this and `doctor` re-measures it live.
- Custom metadata does survive REST multipart upload — undocumented, now
  verified.
- Items list `per_page` caps at 50; `max_num_results` caps at 50 with no offset,
  so there is no pagination past the first page.
- Indexing is asynchronous and highly variable: 36–90s for tiny documents.
- Search latency ~250ms median, against single-digit ms for a local Meilisearch.

### Notes

- Presenter data is deliberately not indexed. `createPresenterEnricher` rebuilds
  titles, subtitles and links from Postgres and decrypts per tenant, so only
  `(entityId, recordId, score, organizationId)` leaves Cloudflare.
- No `encryptionMapResolver`: a memoized driver must not hold a request-scoped
  Kysely handle. Encryption-mapped fields are indexed decrypted, matching the
  built-in driver's default (`SEARCH_EXCLUDE_ENCRYPTED_FIELDS` is off upstream).
  `fieldPolicy` still applies.
