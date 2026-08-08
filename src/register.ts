/**
 * DI wiring for the Cloudflare AI Search fulltext driver.
 *
 * ── Why the consuming app must call this, and a module `di.ts` cannot ───────
 *
 * `createRequestContainer` (@open-mercato/shared/src/lib/di/container.ts)
 * registers in this order:
 *
 *   1. core DI defaults                                    ~line 156
 *   2. module `di.ts` registrars                            line 190
 *   3. core bootstrap -> registerSearchModule()             line 212
 *   4. app `@/di` register()                                line 225
 *   5. applyDiOverridesToContainer()                        line 230
 *
 * `addSearchStrategy()` resolves `searchService`, which does not exist until
 * step 3. A module `di.ts` therefore CANNOT register a search strategy — and
 * step 2 is wrapped in `try { reg?.(container) } catch {}`, so a registrar that
 * throws fails silently. The failure mode would be "fulltext search quietly
 * absent", with nothing in the logs.
 *
 * Hence: one line in the app's own `src/di.ts`, which runs at step 4.
 *
 *   import { registerCloudflareAiSearch } from '@northbound-run/search-cloudflare/register'
 *
 *   export async function register(container: AppContainer) {
 *     await bootstrap(container)
 *     registerCloudflareAiSearch(container)
 *   }
 *
 * Rejected alternative: pre-seeding `globalThis.__omSearchFulltextDriver__`,
 * the private key the search module memoizes its driver on. It would need zero
 * app wiring, but it depends on an undocumented internal AND the memoization is
 * skipped entirely when SEARCH_EXCLUDE_ENCRYPTED_FIELDS=true — the very
 * configuration recommended for apps holding sensitive data. It would fail
 * exactly where correctness matters most.
 */

import type { Kysely } from 'kysely'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityId } from '@open-mercato/shared/modules/entities'
import type { SearchFieldPolicy, SearchModuleConfig } from '@open-mercato/shared/modules/search'
import { FullTextSearchStrategy } from '@open-mercato/search/strategies/fulltext.strategy'
import { addSearchStrategy } from '@open-mercato/search/di'
import type { FullTextSearchDriver } from '@open-mercato/search/fulltext'
import { createAiSearchDriverFromEnv } from './lib/driver'
import type { EncryptionMapEntry } from './lib/driver'

const DRIVER_CACHE_KEY = '__cfAiSearchFulltextDriver__'

type DriverCache = { [DRIVER_CACHE_KEY]?: FullTextSearchDriver }

function excludeEncryptedFields(): boolean {
  const raw = (process.env.SEARCH_EXCLUDE_ENCRYPTED_FIELDS ?? '').toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

/**
 * Mirrors the resolver in `packages/search/src/di.ts`. Kept local because the
 * package does not export it, and this driver must honour the same contract:
 * fields listed in an active encryption map never reach an external index.
 */
function createEncryptionMapResolver(db: Kysely<Record<string, never>>) {
  const cache = new Map<string, { entries: EncryptionMapEntry[]; expiresAt: number }>()
  const TTL_MS = 5 * 60 * 1000

  return async (entityId: EntityId): Promise<EncryptionMapEntry[]> => {
    const cached = cache.get(entityId)
    if (cached && cached.expiresAt > Date.now()) return cached.entries

    try {
      const row = (await db
        .selectFrom('encryption_maps' as never)
        .select(['fields_json' as never])
        .where('entity_id' as never, '=', entityId as never)
        .where('is_active' as never, '=', true as never)
        .where('deleted_at' as never, 'is', null)
        .executeTakeFirst()) as { fields_json?: unknown } | undefined

      const fieldsJson = row?.fields_json
      const entries: EncryptionMapEntry[] = Array.isArray(fieldsJson)
        ? fieldsJson.map((f: { field: string; hashField?: string | null }) => ({
            field: f.field,
            hashField: f.hashField ?? null,
          }))
        : []

      cache.set(entityId, { entries, expiresAt: Date.now() + TTL_MS })
      return entries
    } catch {
      // The upstream package swallows this identically and relies on
      // fieldPolicy as the backstop. Failing closed here would exclude nothing,
      // since an empty map means "no fields are encrypted".
      return []
    }
  }
}

function buildFieldPolicyResolver(
  container: AppContainer,
): (entityId: EntityId) => SearchFieldPolicy | undefined {
  const byEntity = new Map<string, SearchFieldPolicy | undefined>()
  try {
    const configs = container.resolve('searchModuleConfigs') as SearchModuleConfig[] | undefined
    for (const moduleConfig of configs ?? []) {
      for (const entity of moduleConfig.entities ?? []) {
        if (entity.enabled === false) continue
        byEntity.set(String(entity.entityId), entity.fieldPolicy)
      }
    }
  } catch {
    // Registered by core bootstrap alongside the search module; if it is absent
    // the search module is not active either, and registration below no-ops.
  }
  return (entityId: EntityId) => byEntity.get(String(entityId))
}

/**
 * Register Cloudflare AI Search as the `fulltext` strategy.
 *
 * Returns true when it registered. Never throws. Safe to call unconditionally:
 *   - returns false when CF_AI_SEARCH_* is unset
 *   - returns false when the search module is not registered in this container
 *
 * REPLACES any existing `fulltext` strategy, since SearchService keys strategies
 * by id. With MEILISEARCH_HOST unset there is nothing to replace; with it set,
 * this wins and Meilisearch is silently bypassed — do not configure both.
 */
export function registerCloudflareAiSearch(container: AppContainer): boolean {
  const excludeEncrypted = excludeEncryptedFields()
  const globals = globalThis as unknown as DriverCache

  // Memoize only when the driver holds no request-scoped state. With
  // SEARCH_EXCLUDE_ENCRYPTED_FIELDS on, the resolver closes over a per-request
  // Kysely handle and must not be shared across requests. Same constraint the
  // upstream search module documents for its own driver cache.
  let driver: FullTextSearchDriver | null = excludeEncrypted ? null : (globals[DRIVER_CACHE_KEY] ?? null)

  if (!driver) {
    let encryptionMapResolver: ((entityId: EntityId) => Promise<EncryptionMapEntry[]>) | undefined
    if (excludeEncrypted) {
      try {
        const em = container.resolve('em') as { getKysely: () => Kysely<Record<string, never>> }
        encryptionMapResolver = createEncryptionMapResolver(em.getKysely())
      } catch {
        // No Kysely handle: fieldPolicy remains the only filter.
      }
    }

    driver = createAiSearchDriverFromEnv({
      fieldPolicyResolver: buildFieldPolicyResolver(container),
      encryptionMapResolver,
    })

    if (!driver) return false
    if (!excludeEncrypted) globals[DRIVER_CACHE_KEY] = driver
  }

  try {
    addSearchStrategy(container, new FullTextSearchStrategy(driver))
    return true
  } catch {
    // searchService/searchStrategies absent — the search module is disabled.
    return false
  }
}
