/**
 * Package entry point.
 *
 * v0.1.0 ships library code only — no Open Mercato module, no entities, no
 * migrations, no UI. The dependency graph reachable from here is deliberately
 * tiny: `fetchWithTimeout` and `lib/field-policy` are both leaf modules, so
 * importing this package does not drag kysely, meilisearch or the ai-sdk
 * providers into a consumer's bundle.
 *
 * `registerCloudflareAiSearch` is intentionally NOT re-exported here. It is
 * reached at `@northbound-run/search-cloudflare-ai/register` so that the DI
 * wiring — the only part that touches `@open-mercato/search`'s heavier
 * strategy and DI modules — is loaded only by the app file that actually wires
 * it. Same split as `channel-cloudflare-email`'s `/inbox-bridge`.
 *
 * When the operability module lands (CLI provision/doctor/stats), this file
 * narrows to a metadata-only re-export, because `mercato module add` parses
 * `src/modules/<id>/index.ts` as text and must not need to evaluate the package.
 */

export { AiSearchClient, AiSearchApiError } from './lib/client'
export type {
  AiSearchClientConfig,
  AiSearchChunk,
  AiSearchItem,
  AiSearchRetrievalFilters,
  AiSearchRetrievalOptions,
  AiSearchSearchResponse,
} from './lib/client'

export { createAiSearchDriver, createAiSearchDriverFromEnv } from './lib/driver'
export type { AiSearchDriverOptions, EncryptionMapEntry } from './lib/driver'
