/**
 * Verifies everything about the Cloudflare AI Search driver that can be checked
 * without a Cloudflare account: request construction, tenant/org/entity filter
 * shape, chunk collapse, and the metadata contract guard.
 *
 * What this CANNOT verify is whether Cloudflare accepts the multipart
 * `metadata` part — that contract is undocumented for REST. See the README.
 */

// Globals are imported explicitly rather than relied on ambiently: this app's
// tsconfig sets no `types` field, so `tsc --noEmit` does not pull in
// @types/jest's global declarations. Same convention as the other app tests.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals'

import { createAiSearchDriver, createAiSearchDriverFromEnv } from '../driver'

type Captured = { url: string; init: RequestInit }

const captured: Captured[] = []
let respond: (url: string, init: RequestInit) => { status: number; body: unknown }

const originalFetch = globalThis.fetch

beforeEach(() => {
  captured.length = 0
  respond = () => ({ status: 200, body: { success: true, result: {} } })
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString()
    captured.push({ url, init })
    const { status, body } = respond(url, init)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function makeDriver(overrides = {}) {
  return createAiSearchDriver({
    accountId: 'acct-1',
    apiToken: 'token-1',
    instanceId: 'spike',
    ...overrides,
  })
}

type SearchBody = {
  query: string
  ai_search_options: {
    retrieval: {
      retrieval_type?: string
      max_num_results?: number
      match_threshold?: number
      // Always sent: the tenant folder range is non-negotiable.
      filters: Record<string, unknown>
    }
  }
}

function lastSearchBody(): SearchBody {
  const call = captured.find((c) => c.url.endsWith('/search'))
  if (!call) throw new Error('no /search call captured')
  return JSON.parse(String(call.init.body)) as SearchBody
}

function chunk(key: string, score: number, entity: string, org: string) {
  return { id: `c-${key}-${score}`, score, text: 'x', item: { key, metadata: { entity, org } } }
}

describe('key scheme and tenant isolation', () => {
  it('scopes every search to the tenant folder by equality, never a range', async () => {
    respond = () => ({ status: 200, body: { success: true, result: { chunks: [] } } })
    await makeDriver().search('invoice', { tenantId: 'tenant-a' })

    const folder = lastSearchBody().ai_search_options.retrieval.filters.folder
    expect(folder).toEqual({ $eq: 't/tenant-a/' })

    // Regression guard. Cloudflare's BM25 path ignores range operators on
    // `folder`, so the documented `{ $gte, $lt }` "starts with" idiom leaks
    // foreign-tenant documents under keyword and hybrid retrieval. Measured
    // 2026-08-08 — see the comment on tenantFolderFilter.
    expect(folder).not.toHaveProperty('$gte')
    expect(folder).not.toHaveProperty('$lt')
  })

  it('percent-encodes tenant and record ids into the item key', async () => {
    await makeDriver().index({
      recordId: 'rec/1 2',
      entityId: 'inbox_ops:inbox_proposal',
      tenantId: 'ten ant',
      organizationId: 'org-9',
      fields: { summary: 'Freight invoice on hold' },
    })

    const upload = captured.find((c) => c.url.endsWith('/items'))
    const form = upload!.init.body as FormData
    expect((form.get('file') as File).name).toBe('t/ten%20ant/rec%2F1%202.md')
  })
})

describe('filters', () => {
  it('uses $eq for a single organization', async () => {
    respond = () => ({ status: 200, body: { success: true, result: { chunks: [] } } })
    await makeDriver().search('q', { tenantId: 't1', organizationId: 'org-a' })
    expect(lastSearchBody().ai_search_options.retrieval.filters.org).toEqual({ $eq: 'org-a' })
  })

  it('uses $in for an organization scope list', async () => {
    respond = () => ({ status: 200, body: { success: true, result: { chunks: [] } } })
    await makeDriver().search('q', { tenantId: 't1', organizationIds: ['org-a', 'org-b', 'org-a'] })
    expect(lastSearchBody().ai_search_options.retrieval.filters.org).toEqual({ $in: ['org-a', 'org-b'] })
  })

  it('matches nothing when the org allow-list is empty rather than exposing org-less records', async () => {
    respond = () => ({ status: 200, body: { success: true, result: { chunks: [] } } })
    await makeDriver().search('q', { tenantId: 't1', organizationIds: [] })
    // Must NOT fall through to the `_` sentinel used for records with no org.
    expect(lastSearchBody().ai_search_options.retrieval.filters.org).toEqual({
      $eq: '__no_matching_organization__',
    })
  })

  it('filters entity types with $in', async () => {
    respond = () => ({ status: 200, body: { success: true, result: { chunks: [] } } })
    await makeDriver().search('q', { tenantId: 't1', entityTypes: ['a:b', 'c:d'] })
    expect(lastSearchBody().ai_search_options.retrieval.filters.entity).toEqual({ $in: ['a:b', 'c:d'] })
  })
})

describe('result mapping', () => {
  it('collapses chunks onto records, keeping the best score', async () => {
    respond = () => ({
      status: 200,
      body: {
        success: true,
        result: {
          chunks: [
            chunk('t/t1/rec-1.md', 0.4, 'inbox_ops:inbox_proposal', 'org-a'),
            chunk('t/t1/rec-1.md', 0.9, 'inbox_ops:inbox_proposal', 'org-a'),
            chunk('t/t1/rec-2.md', 0.6, 'procurement:purchase_order', '_'),
          ],
        },
      },
    })

    const hits = await makeDriver().search('q', { tenantId: 't1' })

    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({ recordId: 'rec-1', score: 0.9, organizationId: 'org-a' })
    // The `_` sentinel maps back to a genuine null org.
    expect(hits[1]).toMatchObject({ recordId: 'rec-2', organizationId: null })
  })

  it('omits presenter data so the Postgres presenter enricher owns it', async () => {
    respond = () => ({
      status: 200,
      body: { success: true, result: { chunks: [chunk('t/t1/rec-1.md', 0.8, 'a:b', 'org-a')] } },
    })
    const [hit] = await makeDriver().search('q', { tenantId: 't1' })
    expect(hit.presenter).toBeUndefined()
    expect(hit.url).toBeUndefined()
  })

  it('caps requested results at the Cloudflare maximum of 50', async () => {
    respond = () => ({ status: 200, body: { success: true, result: { chunks: [] } } })
    await makeDriver().search('q', { tenantId: 't1', limit: 100 })
    expect(lastSearchBody().ai_search_options.retrieval.max_num_results).toBe(50)
  })

  it('returns nothing for paged requests, since Cloudflare has no offset', async () => {
    const hits = await makeDriver().search('q', { tenantId: 't1', limit: 10, offset: 10 })
    expect(hits).toEqual([])
    expect(captured).toHaveLength(0)
  })

  it('treats a missing instance as empty, not fatal', async () => {
    respond = () => ({ status: 404, body: { success: false, errors: [{ message: 'not found' }] } })
    await expect(makeDriver().search('q', { tenantId: 't1' })).resolves.toEqual([])
  })
})

describe('metadata contract guard', () => {
  it('fails loudly with the wrangler fix when `entity` metadata is absent', async () => {
    respond = () => ({
      status: 200,
      body: {
        success: true,
        result: { chunks: [{ id: 'c1', score: 0.9, item: { key: 't/t1/rec-1.md', metadata: {} } }] },
      },
    })

    // Guessing an entity type would surface wrong-typed rows to users.
    await expect(makeDriver().search('q', { tenantId: 't1' })).rejects.toThrow(
      /missing the `entity` custom metadata field/,
    )
  })
})

describe('indexing', () => {
  it('honours fieldPolicy so excluded fields never reach Cloudflare', async () => {
    const driver = makeDriver({
      fieldPolicyResolver: () => ({ searchable: ['summary'], excluded: ['secret_note'] }),
    })

    await driver.index({
      recordId: 'rec-1',
      entityId: 'inbox_ops:inbox_proposal',
      tenantId: 't1',
      organizationId: 'org-a',
      fields: { summary: 'Freight invoice', secret_note: 'do-not-index', status: 'hold' },
    })

    const form = captured[0].init.body as FormData
    const body = await (form.get('file') as File).text()

    expect(body).toContain('summary: Freight invoice')
    expect(body).not.toContain('do-not-index')
    // `searchable` is a whitelist, so `status` is dropped too.
    expect(body).not.toContain('status: hold')
    expect(JSON.parse(String(form.get('metadata')))).toEqual({
      entity: 'inbox_ops:inbox_proposal',
      org: 'org-a',
    })
  })

  it('drops encryption-mapped fields', async () => {
    const driver = makeDriver({
      encryptionMapResolver: async () => [{ field: 'email', hashField: 'email_hash' }],
    })

    await driver.index({
      recordId: 'rec-1',
      entityId: 'customers:customer_person_profile',
      tenantId: 't1',
      organizationId: null,
      fields: { display_name: 'Acme Ltd', email: 'ciphertext:blob:v1' },
    })

    const form = captured[0].init.body as FormData
    const body = await (form.get('file') as File).text()
    expect(body).toContain('display_name: Acme Ltd')
    expect(body).not.toContain('ciphertext')
    // Records with no organization use the `_` sentinel so `org` stays filterable.
    expect(JSON.parse(String(form.get('metadata'))).org).toBe('_')
  })

  it('never uploads an empty body', async () => {
    const driver = makeDriver({ fieldPolicyResolver: () => ({ searchable: ['nope'] }) })
    await driver.index({
      recordId: 'rec-1',
      entityId: 'a:b',
      tenantId: 't1',
      organizationId: 'org-a',
      fields: { other: 'value' },
    })
    const form = captured[0].init.body as FormData
    expect(await (form.get('file') as File).text()).toBe('id: rec-1')
  })
})

describe('delete', () => {
  it('resolves the item id by key, then deletes it', async () => {
    respond = (url) => {
      if (url.includes('/items?')) {
        return { status: 200, body: { success: true, result: [{ id: 'item-77', key: 't/t1/rec-1.md' }] } }
      }
      return { status: 200, body: { success: true, result: null } }
    }

    await makeDriver().delete('rec-1', 't1')

    expect(captured[0].url).toContain(`key=${encodeURIComponent('t/t1/rec-1.md')}`)
    expect(captured[0].url).toContain('source=builtin')
    expect(captured[1].url).toMatch(/\/items\/item-77$/)
    expect(captured[1].init.method).toBe('DELETE')
  })

  it('is a no-op when the record was never indexed', async () => {
    respond = () => ({ status: 200, body: { success: true, result: [] } })
    await makeDriver().delete('missing', 't1')
    expect(captured).toHaveLength(1)
  })
})

describe('environment gating', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('returns null when unconfigured, so the app falls back to tokens-only', () => {
    delete process.env.CF_AI_SEARCH_ACCOUNT_ID
    delete process.env.CF_AI_SEARCH_API_TOKEN
    delete process.env.CF_AI_SEARCH_INSTANCE
    expect(createAiSearchDriverFromEnv()).toBeNull()
  })

  it('builds a driver once all three required vars are present', () => {
    process.env.CF_AI_SEARCH_ACCOUNT_ID = 'acct'
    process.env.CF_AI_SEARCH_API_TOKEN = 'tok'
    process.env.CF_AI_SEARCH_INSTANCE = 'spike'
    expect(createAiSearchDriverFromEnv()?.id).toBe('cloudflare-ai-search')
  })
})
