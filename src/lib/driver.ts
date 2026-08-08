/**
 * A `FullTextSearchDriver` backed by Cloudflare AI Search.
 *
 * Slots into the same seam Meilisearch uses (`packages/search/src/fulltext/types.ts`),
 * so `FullTextSearchStrategy`, RRF fusion, the tokens fallback, presenter
 * enrichment, the Cmd+K dialog and the `mercato search` CLI all work unchanged.
 *
 * ── Key scheme ─────────────────────────────────────────────────────────────
 *   t/{tenantId}/{encodeURIComponent(recordId)}.md      → folder = `t/{tenantId}/`
 *
 * `folder` is a BUILT-IN metadata attribute, so tenant isolation — the only
 * security-critical filter — works with zero instance configuration. It is
 * applied with EQUALITY, deliberately not with Cloudflare's documented
 * "starts with" range idiom, which leaks across tenants under keyword and
 * hybrid retrieval. See `tenantFolderFilter` for the measurements.
 *
 * recordId alone is the key because the driver interface's `delete(recordId,
 * tenantId)` does not carry entityId. That matches Meilisearch, which uses
 * `_id: recordId` as the primary key of a per-tenant index, so Open Mercato
 * already assumes recordId is unique within a tenant.
 *
 * ── Custom metadata (REQUIRED) ─────────────────────────────────────────────
 *   entity : text   e.g. `inbox_ops:inbox_proposal`
 *   org    : text   organization UUID, or `_` when the record has no org
 *
 * Both must be declared on the instance before upload; Cloudflare silently
 * drops undeclared fields. `entity` is not optional: it is the only way to map
 * a hit back to an Open Mercato entity type. The driver fails loudly rather
 * than returning mislabelled results — see `assertMetadataContract`.
 *
 * ── Deliberately not implemented ───────────────────────────────────────────
 * `getDocuments` returns an empty map. Presenter/url/links are NOT stored in
 * the index: `createPresenterEnricher` rehydrates them from `entity_indexes`
 * and decrypts per tenant, so pushing them to Cloudflare would duplicate state
 * and leak decrypted display strings for no gain.
 */

import type { EntityId } from '@open-mercato/shared/modules/entities'
import type { SearchFieldPolicy } from '@open-mercato/shared/modules/search'
// Deep import on purpose: the `@open-mercato/search` barrel re-exports the
// strategies, which pull in kysely, meilisearch and the ai-sdk providers.
// `lib/field-policy` is a leaf module with no runtime imports.
import { extractSearchableFields } from '@open-mercato/search/lib/field-policy'
import type {
  DocumentLookupKey,
  FullTextSearchDocument,
  FullTextSearchDriver,
  FullTextSearchHit,
  FullTextSearchQuery,
  IndexStats,
} from '@open-mercato/search/fulltext'
import { AiSearchApiError, AiSearchClient, type AiSearchRetrievalFilters } from './client'

/** Cloudflare hard cap on `max_num_results`. */
const CF_MAX_RESULTS = 50
/** Sentinel for records with no organization, so `org` is always a filterable string. */
const NO_ORG = '_'
/** Upload fan-out for bulkIndex. Keeps reindex from opening hundreds of sockets. */
const BULK_CONCURRENCY = 8
/**
 * Items list paging. `per_page` is capped at 50 by Cloudflare — 100 returns
 * `400 code 7001 "Too big: expected number to be <=50"`. Undocumented; found by
 * the live spike. MAX_LIST_PAGES is a safety rail, so purge covers at most
 * 200 x 50 = 10,000 items per entity before it refuses rather than truncating.
 */
const MAX_LIST_PAGES = 200
const LIST_PAGE_SIZE = 50

/**
 * One entry of a tenant encryption map. Structurally identical to the search
 * package's internal `EncryptionMapEntry`, which it does not export.
 */
export type EncryptionMapEntry = {
  field: string
  hashField?: string | null
}

export type AiSearchDriverOptions = {
  accountId: string
  apiToken: string
  instanceId: string
  namespace?: string | null
  /** `hybrid` (default) runs BM25 + vector and fuses them. */
  retrievalType?: 'vector' | 'keyword' | 'hybrid'
  /** Cloudflare default is 0.4. Lower widens recall for short Cmd+K prefixes. */
  matchThreshold?: number
  defaultLimit?: number
  timeoutMs?: number
  encryptionMapResolver?: (entityId: EntityId) => Promise<EncryptionMapEntry[]>
  fieldPolicyResolver?: (entityId: EntityId) => SearchFieldPolicy | undefined
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function tenantFolder(tenantId: string): string {
  return `t/${encodeURIComponent(tenantId)}/`
}

function itemKey(tenantId: string, recordId: string): string {
  return `${tenantFolder(tenantId)}${encodeURIComponent(recordId)}.md`
}

function recordIdFromKey(key: string): string | null {
  const leaf = key.slice(key.lastIndexOf('/') + 1)
  if (!leaf.endsWith('.md')) return null
  try {
    return decodeURIComponent(leaf.slice(0, -3))
  } catch {
    return null
  }
}

/**
 * Tenant scoping uses folder EQUALITY, never Cloudflare's documented
 * "starts with" range idiom (`{ $gte: 'p/', $lt: 'p0' }`).
 *
 * Measured on 2026-08-08 against a hybrid instance: the BM25 keyword retrieval
 * path silently ignores RANGE operators on `folder`, so a foreign-tenant
 * document that is the strongest keyword match is returned despite the filter.
 * Equality-family operators ($eq, $in, $ne) are enforced correctly on both the
 * vector and keyword paths.
 *
 *   folder {$gte,$lt}  ->  keyword=LEAK   hybrid=LEAK
 *   folder $eq         ->  keyword=clean  hybrid=clean
 *   folder $in         ->  keyword=clean  hybrid=clean
 *
 * This is why item keys are exactly one folder level deep (`t/{tenantId}/`):
 * subtree matching is never needed, so the broken operator is never used.
 * Do not "optimise" the key scheme into nested folders without re-testing this.
 */
function tenantFolderFilter(tenantId: string): { $eq: string } {
  return { $eq: tenantFolder(tenantId) }
}

// ---------------------------------------------------------------------------
// Document rendering
// ---------------------------------------------------------------------------

function renderValue(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  try {
    const json = JSON.stringify(value)
    return json && json !== '{}' && json !== '[]' ? json : null
  } catch {
    return null
  }
}

/**
 * Cloudflare chunks and embeds plain text, so the JSON document Meilisearch
 * stores has to be flattened. `label: value` lines keep the field name in the
 * embedded text, which measurably helps queries like "status hold".
 */
function renderBody(fields: Record<string, unknown>, recordId: string): string {
  const lines: string[] = []
  for (const [field, raw] of Object.entries(fields)) {
    const value = renderValue(raw)
    if (value) lines.push(`${field}: ${value}`)
  }
  // Never upload an empty body — Cloudflare would either reject it or index a
  // document that can never match, leaving a tombstone we would not notice.
  if (lines.length === 0) lines.push(`id: ${recordId}`)
  return lines.join('\n')
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const failures: unknown[] = []
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      try {
        await fn(items[index])
      } catch (error) {
        failures.push(error)
      }
    }
  })
  await Promise.all(workers)
  // Surface failures so the queue worker retries the job — SearchService relies
  // on write operations throwing rather than silently leaving index gaps.
  if (failures.length > 0) {
    throw new AggregateError(failures, `Cloudflare AI Search bulk upload failed for ${failures.length} document(s)`)
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export function createAiSearchDriver(options: AiSearchDriverOptions): FullTextSearchDriver {
  const client = new AiSearchClient({
    accountId: options.accountId,
    apiToken: options.apiToken,
    instanceId: options.instanceId,
    namespace: options.namespace,
    timeoutMs: options.timeoutMs,
  })

  const retrievalType = options.retrievalType ?? 'hybrid'
  const matchThreshold = options.matchThreshold
  const defaultLimit = options.defaultLimit ?? 20
  const { encryptionMapResolver, fieldPolicyResolver } = options

  let metadataContractChecked = false

  /**
   * A hit with no `entity` metadata cannot be mapped to an Open Mercato entity.
   * Guessing would put wrong-typed rows in front of users, so fail with the
   * setup command instead. Checked once per process, on the first hit.
   */
  function assertMetadataContract(metadata: Record<string, unknown> | null | undefined): void {
    if (metadataContractChecked) return
    if (metadata && typeof metadata.entity === 'string' && metadata.entity.length > 0) {
      metadataContractChecked = true
      return
    }
    throw new Error(
      '[ai-search] Indexed items are missing the `entity` custom metadata field. ' +
        'Declare it on the instance and reindex:\n' +
        `  npx wrangler ai-search update ${options.instanceId} --custom-metadata entity:text --custom-metadata org:text\n` +
        '  yarn mercato search reindex --tenant <tenantId> --purgeFirst',
    )
  }

  function buildFilters(query: FullTextSearchQuery): AiSearchRetrievalFilters {
    // Tenant scope is always applied and never depends on custom metadata.
    const filters: AiSearchRetrievalFilters = { folder: tenantFolderFilter(query.tenantId) }

    const singleOrg = typeof query.organizationId === 'string' ? query.organizationId.trim() : ''
    if (singleOrg) {
      filters.org = { $eq: singleOrg }
    } else if (Array.isArray(query.organizationIds)) {
      const orgs = Array.from(
        new Set(
          query.organizationIds
            .map((value) => (typeof value === 'string' ? value.trim() : ''))
            .filter((value) => value.length > 0),
        ),
      )
      // An empty allow-list means "no organizations are visible". Matching the
      // sentinel would wrongly expose org-less records, so use an impossible value.
      filters.org = orgs.length > 0 ? { $in: orgs } : { $eq: '__no_matching_organization__' }
    }

    if (query.entityTypes?.length) {
      filters.entity = { $in: Array.from(new Set(query.entityTypes)) }
    }

    return filters
  }

  async function prepareUpload(doc: FullTextSearchDocument): Promise<{
    key: string
    body: string
    metadata: Record<string, string>
  }> {
    const encryptedFields = encryptionMapResolver ? await encryptionMapResolver(doc.entityId) : []
    const fieldPolicy = fieldPolicyResolver?.(doc.entityId)
    const searchable = extractSearchableFields(doc.fields, { encryptedFields, fieldPolicy })

    const org = typeof doc.organizationId === 'string' && doc.organizationId.trim() ? doc.organizationId.trim() : NO_ORG

    return {
      key: itemKey(doc.tenantId, doc.recordId),
      body: renderBody(searchable, doc.recordId),
      // Cloudflare truncates text metadata at 500 characters; both values are
      // an entity id and a UUID, so neither is anywhere near the limit.
      metadata: { entity: String(doc.entityId), org },
    }
  }

  const driver: FullTextSearchDriver = {
    // Upstream type bug: FullTextSearchDriverId's open-union escape hatch is
    // written `(string & Record<string, never>)` instead of `(string & {})`.
    // Record<string, never> requires every property to be `never`, and `string`
    // has `length: number`, so no custom id satisfies it. The union is meant to
    // accept third-party drivers — the cast restores that intent.
    id: 'cloudflare-ai-search' as FullTextSearchDriver['id'],

    async ensureReady(): Promise<void> {
      // Stateless HTTP client; the instance is provisioned out-of-band.
    },

    /**
     * SearchService probes this before every search behind a 2s TTL cache. A
     * real round trip to api.cloudflare.com here would add a full RTT to Cmd+K
     * on every cache miss, so availability is config presence only. Genuine
     * outages degrade through `Promise.allSettled` in SearchService, which is
     * what the tokens fallback exists for.
     */
    async isHealthy(): Promise<boolean> {
      return Boolean(options.accountId && options.apiToken && options.instanceId)
    },

    async search(query: string, searchQuery: FullTextSearchQuery): Promise<FullTextSearchHit[]> {
      const trimmed = query.trim()
      if (!trimmed) return []

      // Cloudflare exposes no offset, so any page past the first cannot be
      // served. Returning [] degrades to the other strategies instead of
      // silently repeating page 1.
      if (searchQuery.offset && searchQuery.offset > 0) return []

      const limit = Math.min(searchQuery.limit ?? defaultLimit, CF_MAX_RESULTS)
      // Results are chunks, not records: several chunks can collapse onto one
      // record, so over-fetch to keep the post-collapse count near `limit`.
      const maxNumResults = Math.min(CF_MAX_RESULTS, Math.max(limit * 3, limit))

      let response
      try {
        response = await client.search({
          query: trimmed,
          ai_search_options: {
            retrieval: {
              retrieval_type: retrievalType,
              max_num_results: maxNumResults,
              filters: buildFilters(searchQuery),
              ...(matchThreshold != null ? { match_threshold: matchThreshold } : {}),
            },
          },
        })
      } catch (error) {
        // An instance that does not exist yet behaves like Meilisearch's
        // `index_not_found`: empty, not fatal.
        if (error instanceof AiSearchApiError && error.status === 404) return []
        throw error
      }

      const chunks = response.chunks ?? []
      if (chunks.length === 0) return []

      // Collapse chunk-level hits to record-level hits, keeping the best score.
      const byRecord = new Map<string, FullTextSearchHit>()
      for (const chunk of chunks) {
        const key = chunk.item?.key
        if (!key) continue
        const recordId = recordIdFromKey(key)
        if (!recordId) continue

        const metadata = chunk.item?.metadata ?? null
        assertMetadataContract(metadata)

        const entityId = String(metadata?.entity ?? '') as EntityId
        if (!entityId) continue

        const orgRaw = typeof metadata?.org === 'string' ? metadata.org : NO_ORG
        const organizationId = orgRaw === NO_ORG ? null : orgRaw
        const score = typeof chunk.score === 'number' ? chunk.score : 0

        const existing = byRecord.get(key)
        if (existing) {
          if (score > existing.score) existing.score = score
          continue
        }

        byRecord.set(key, {
          recordId,
          entityId,
          score,
          organizationId,
          // presenter/url/links intentionally omitted — presenterEnricher
          // rehydrates them from Postgres and decrypts per tenant.
          metadata: { _aiSearchChunks: 1 },
        })
      }

      return Array.from(byRecord.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    },

    async index(doc: FullTextSearchDocument): Promise<void> {
      const { key, body, metadata } = await prepareUpload(doc)
      await client.uploadItem(key, body, metadata)
    },

    async delete(recordId: string, tenantId: string): Promise<void> {
      // No delete-by-key endpoint: resolve the item id first.
      const item = await client.findItemByKey(itemKey(tenantId, recordId))
      if (!item?.id) return
      await client.deleteItem(item.id)
    },

    async bulkIndex(docs: FullTextSearchDocument[]): Promise<void> {
      if (docs.length === 0) return
      // No batch upload endpoint — this is N requests, unlike Meilisearch's
      // single addDocuments call. Reindex throughput is the second thing this
      // spike is meant to measure.
      await mapWithConcurrency(docs, BULK_CONCURRENCY, async (doc) => {
        const { key, body, metadata } = await prepareUpload(doc)
        await client.uploadItem(key, body, metadata)
      })
    },

    /**
     * Meilisearch purges with one filtered delete. Cloudflare has no equivalent,
     * so this lists the tenant subtree and deletes matches one by one. Slow and
     * paged — the cap below is a safety rail, and hitting it is reported.
     */
    async purge(entityId: EntityId, tenantId: string, organizationId?: string | null): Promise<void> {
      const prefix = tenantFolder(tenantId)
      const targetOrg =
        typeof organizationId === 'string' && organizationId.trim() ? organizationId.trim() : null

      const doomed: string[] = []
      let cursor: string | null = null
      let pages = 0

      do {
        const page = await client.listItems({ cursor, perPage: LIST_PAGE_SIZE })
        for (const item of page.items) {
          if (!item.key?.startsWith(prefix)) continue
          const metadata = item.metadata ?? {}
          if (String(metadata.entity ?? '') !== String(entityId)) continue
          if (targetOrg !== null && String(metadata.org ?? NO_ORG) !== targetOrg) continue
          doomed.push(item.id)
        }
        cursor = page.cursor
        pages += 1
      } while (cursor && pages < MAX_LIST_PAGES)

      if (cursor) {
        throw new Error(
          `[ai-search] purge stopped after ${MAX_LIST_PAGES} pages for ${entityId} (tenant ${tenantId}); ` +
            'the index is larger than the spike purge path supports. Recreate the instance instead.',
        )
      }

      await mapWithConcurrency(doomed, BULK_CONCURRENCY, (id) => client.deleteItem(id))
    },

    /**
     * Not implemented on purpose. Presenter data lives in Postgres and is
     * rebuilt by createPresenterEnricher; returning an empty map makes the
     * strategy defer to it rather than serving stale copies.
     */
    async getDocuments(_ids: DocumentLookupKey[], _tenantId: string): Promise<Map<string, FullTextSearchHit>> {
      return new Map()
    },

    // Returning null rather than a fabricated count keeps Settings > Search
    // honest about what this driver can report.
    async getIndexStats(_tenantId: string): Promise<IndexStats | null> {
      return null
    },

    async getEntityCounts(_tenantId: string): Promise<Record<string, number> | null> {
      return null
    },
  }

  return driver
}

/**
 * Build the driver from environment, or return null when it is not configured.
 * Mirrors `createFulltextDriver()`: absent config is a no-op, never a throw.
 */
export function createAiSearchDriverFromEnv(
  overrides: Partial<AiSearchDriverOptions> = {},
): FullTextSearchDriver | null {
  const accountId = overrides.accountId ?? process.env.CF_AI_SEARCH_ACCOUNT_ID
  const apiToken = overrides.apiToken ?? process.env.CF_AI_SEARCH_API_TOKEN
  const instanceId = overrides.instanceId ?? process.env.CF_AI_SEARCH_INSTANCE

  if (!accountId || !apiToken || !instanceId) return null

  const rawThreshold = process.env.CF_AI_SEARCH_MATCH_THRESHOLD
  const parsedThreshold = rawThreshold ? Number.parseFloat(rawThreshold) : undefined

  return createAiSearchDriver({
    accountId,
    apiToken,
    instanceId,
    namespace: overrides.namespace ?? process.env.CF_AI_SEARCH_NAMESPACE ?? null,
    retrievalType:
      overrides.retrievalType ??
      (process.env.CF_AI_SEARCH_RETRIEVAL_TYPE as AiSearchDriverOptions['retrievalType']) ??
      'hybrid',
    matchThreshold:
      overrides.matchThreshold ??
      (parsedThreshold != null && Number.isFinite(parsedThreshold) ? parsedThreshold : undefined),
    timeoutMs: overrides.timeoutMs,
    encryptionMapResolver: overrides.encryptionMapResolver,
    fieldPolicyResolver: overrides.fieldPolicyResolver,
  })
}
