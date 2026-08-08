import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

/**
 * Module metadata.
 *
 * The module exists for operability only — it ships no entities, no migrations,
 * no routes and no UI. The driver itself is plain library code and works
 * without enabling this module at all; what you gain by enabling it is
 * `yarn mercato search_cloudflare doctor`.
 *
 * `requires: ['search']` is not optional. The doctor command resolves
 * `searchStrategies` from the container to verify the driver actually got
 * registered, and that key only exists once `@open-mercato/search` has
 * bootstrapped. Declaring it lets the generator's dependency check catch a
 * missing `search` module at build time instead of at runtime.
 *
 * There is deliberately NO `di.ts`. Module DI registrars run before core
 * bootstrap creates `searchService`, and that phase swallows exceptions — so a
 * registrar here could not register the strategy and would fail silently
 * trying. Registration is `registerCloudflareAiSearch()`, called from the app's
 * own `src/di.ts`. See src/register.ts.
 *
 * `ejectable` must stay a literal `true`. The CLI reads it by parsing this
 * file's source text, not by evaluating the module — a spread or computed value
 * would not be seen.
 */
export const metadata: ModuleInfo = {
  name: 'search_cloudflare',
  title: 'Cloudflare AI Search',
  description:
    'Cloudflare AI Search as a fulltext search driver: hybrid BM25 + vector retrieval behind the stock FullTextSearchDriver contract, with diagnostics for the instance configuration it depends on.',
  version: '0.1.1',
  author: 'Northbound',
  license: 'MIT',
  requires: ['search'],
  ejectable: true,
}

export default metadata
