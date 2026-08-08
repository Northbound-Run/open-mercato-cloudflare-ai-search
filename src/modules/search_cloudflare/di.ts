import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityId } from '@open-mercato/shared/modules/entities'
import type { SearchFieldPolicy, SearchModuleConfig } from '@open-mercato/shared/modules/search'
import { getSearchModuleConfigs } from '@open-mercato/shared/modules/search'
import type { FullTextSearchDriver } from '@open-mercato/search/fulltext'
import { createAiSearchDriverFromEnv } from '../../lib/driver'

/**
 * Registers the driver so it works in EVERY runtime — Next, the mercato CLI,
 * and queue workers.
 *
 * ── Why not the app's src/di.ts ─────────────────────────────────────────────
 *
 * `registerCloudflareAiSearch()` (src/register.ts) is the obvious hook and it
 * only half works. `createRequestContainer` reaches app-level DI via
 * `await import('@/di')`, and `@/` is a bundler-only path alias: under Next it
 * resolves, under raw Node it throws ERR_MODULE_NOT_FOUND into a bare
 * `catch {}`. So app DI silently never runs in the CLI or in queue workers.
 *
 * That is not a cosmetic gap. Indexing runs in workers spawned by
 * `mercato server start` as separate CLI processes, so a driver registered only
 * in app DI serves reads from Next while never writing anything — the index
 * stays permanently empty and nothing logs a reason.
 *
 * Module `di.ts` runs in every runtime, so this is the hook that works.
 *
 * ── Why pre-seed instead of addSearchStrategy() ─────────────────────────────
 *
 * Module registrars run at step 2 of container creation; `searchService` does
 * not exist until core bootstrap at step 3. So `addSearchStrategy` is not an
 * option here. What IS available is the key `registerSearchModule` memoizes its
 * driver on: seed it at step 2 and step 3 adopts it instead of building the
 * env-only built-in.
 *
 * This depends on an undocumented internal. `mercato search_cloudflare doctor`
 * verifies registration against a live container precisely so a rename upstream
 * surfaces as a loud failed check rather than silently absent search.
 */

/** Private to @open-mercato/search — see the caveat above. */
const FULLTEXT_DRIVER_KEY = '__omSearchFulltextDriver__'

/**
 * Deny everything. Used when the search-config registry cannot be read, because
 * an absent `fieldPolicy` means "no whitelist" to `extractSearchableFields`,
 * which would index EVERY field on the record — including the ones modules
 * deliberately exclude, like `ssn`, `government_id`, `date_of_birth` and
 * `tax_id`. Indexing nothing is recoverable; indexing those is not.
 */
export const DENY_ALL: SearchFieldPolicy = { searchable: [], hashOnly: [], excluded: [] }

/**
 * Resolve field policies LAZILY, on first index/search rather than here.
 *
 * `getSearchModuleConfigs()` is populated during app bootstrap. Module DI runs
 * early enough that the registry can still be empty, and capturing it now would
 * freeze an empty map for the process lifetime — silently removing every
 * whitelist. Reading it on first use lets it be populated by then, and failing
 * closed covers the case where it never is.
 */
export function createLazyFieldPolicyResolver(
  // Injected so the fail-closed behaviour can be tested directly. Defaults to
  // the real registry.
  readConfigs: () => SearchModuleConfig[] = getSearchModuleConfigs,
): (entityId: EntityId) => SearchFieldPolicy | undefined {
  let byEntity: Map<string, SearchFieldPolicy | undefined> | null = null

  return (entityId: EntityId): SearchFieldPolicy | undefined => {
    if (!byEntity) {
      const configs = readConfigs() ?? []
      if (configs.length === 0) return DENY_ALL
      byEntity = new Map()
      for (const moduleConfig of configs) {
        for (const entity of moduleConfig.entities ?? []) {
          if (entity.enabled === false) continue
          byEntity.set(String(entity.entityId), entity.fieldPolicy)
        }
      }
    }

    const key = String(entityId)
    // Present but without a policy: match the built-in driver, which passes
    // `undefined` and lets every field through. Absent entirely: deny, since an
    // unconfigured entity should not be reaching the index at all.
    return byEntity.has(key) ? byEntity.get(key) : DENY_ALL
  }
}

/**
 * `registerSearchModule` only consults the memoized driver when it would also
 * memoize one itself. When it will not, the seed is ignored and fulltext search
 * silently does not exist — so say so rather than leaving it to be discovered.
 */
export function memoizationBlockedBy(): string | null {
  if (process.env.SEARCH_DISABLE_SINGLETON_CACHE === '1') return 'SEARCH_DISABLE_SINGLETON_CACHE=1'
  const raw = (process.env.SEARCH_EXCLUDE_ENCRYPTED_FIELDS ?? '').toLowerCase()
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
    return 'SEARCH_EXCLUDE_ENCRYPTED_FIELDS is enabled'
  }
  return null
}

export function register(_container: AppContainer): void {
  const globals = globalThis as unknown as Record<string, unknown>

  // Idempotent: registrars run once per container, the driver is stateless, and
  // re-seeding per request would churn a new instance on every hit.
  if (globals[FULLTEXT_DRIVER_KEY]) return

  const driver: FullTextSearchDriver | null = createAiSearchDriverFromEnv({
    fieldPolicyResolver: createLazyFieldPolicyResolver(),
    // No encryptionMapResolver: it would need a request-scoped Kysely handle,
    // and a memoized driver must not hold one. Consequence: fields listed in a
    // module's encryption map are indexed decrypted, exactly as the built-in
    // Meilisearch driver does by default (SEARCH_EXCLUDE_ENCRYPTED_FIELDS is
    // off by default upstream). `fieldPolicy` still applies, so `ssn`,
    // `government_id`, `date_of_birth` and `tax_id` stay out and
    // `primary_email` / `primary_phone` remain hash-only.
  })

  // Not configured — stay completely inert.
  if (!driver) return

  const blocked = memoizationBlockedBy()
  if (blocked) {
    console.warn(
      `[search_cloudflare] ${blocked}, so @open-mercato/search will ignore the pre-registered ` +
        'driver and fulltext search will be unavailable. Unset it, or register from the app\'s ' +
        'src/di.ts instead (Next-only: the CLI and queue workers will not index).',
    )
    return
  }

  globals[FULLTEXT_DRIVER_KEY] = driver
}

export default register
