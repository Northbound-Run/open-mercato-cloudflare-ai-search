/**
 * Package entry point — module metadata ONLY.
 *
 * `mercato module add` reads module identity and the `ejectable` flag by parsing
 * `src/modules/search_cloudflare/index.ts` as text, so nothing here needs to
 * pull in the driver — and pulling it in would drag the dependency graph into
 * any consumer that merely inspects the package.
 *
 * Everything else is reached by subpath, so a consumer loads only what it uses:
 *
 *   @northbound-run/search-cloudflare/register     registerCloudflareAiSearch()
 *   @northbound-run/search-cloudflare/lib/driver   createAiSearchDriver()
 *   @northbound-run/search-cloudflare/lib/client   AiSearchClient
 *   @northbound-run/search-cloudflare/lib/doctor   runDoctor() and its checks
 *
 * This matters most for `/register`, which is the only file that imports
 * `@open-mercato/search`'s strategy and DI modules — and those pull in kysely,
 * meilisearch and the ai-sdk providers.
 */
export { metadata } from './modules/search_cloudflare/index'
