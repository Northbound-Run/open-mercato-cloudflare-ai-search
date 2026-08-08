# Changelog

## 0.1.1

Documentation correction. No code changes.

0.1.0's README claimed the package was "not usable end to end" because field
policies were not visible in the mercato CLI runtime. **That was wrong**, and
the diagnosis behind it was wrong too — it was an artifact of how the package
was being tested, not a defect in the package or in Open Mercato.

Under `portal:` / `yarn link`, Node resolves `@open-mercato/shared` from the
linked package's own `node_modules` instead of the app's, creating a second
module instance whose module-level registries are empty. `getSearchModuleConfigs()`
returned nothing, the field-policy resolver correctly failed closed, and every
document indexed empty.

Installed normally from the registry it works. Verified against Open Mercato
0.6.6 on 2026-08-08: a real `inbox_ops:inbox_proposal` indexed through `mercato
search index` reached Cloudflare with `fieldPolicy` correctly applied
(`summary` + `category` indexed, `metadata` + `participants` excluded), and
returned for natural-language, exact-identifier and vendor-name queries.

The README now warns against link-based testing, and `doctor`'s `field-policies`
check — added in 0.1.0 and the thing that surfaced this — is documented as the
way to detect it.

## 0.1.0

First release. Cloudflare AI Search behind Open Mercato's stock
`FullTextSearchDriver` contract, so `SearchService` fuses it with the `vector`
and `tokens` strategies exactly as it does Meilisearch.

Note: this version's README wrongly stated the package was not usable end to
end. See 0.1.1.

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
