/**
 * Live harness for the Cloudflare AI Search fulltext driver.
 *
 * Exercises the REAL driver against a REAL instance so the parts unit tests
 * cannot reach get verified: the undocumented multipart metadata contract,
 * cross-tenant isolation (with a planted canary), indexing latency, and query
 * quality.
 *
 * This is not a demo. Cloudflare AI Search is in open beta and its BM25 path
 * has already been observed ignoring a documented filter operator, so this
 * harness is the regression net for the assumption the driver's tenant scoping
 * rests on. Re-run it after every dependency bump.
 *
 * Run:
 *   CF_AI_SEARCH_ACCOUNT_ID=<id> CF_AI_SEARCH_INSTANCE=<name> yarn spike
 *
 * Credentials fall back to the local wrangler OAuth token when
 * CF_AI_SEARCH_API_TOKEN is unset. Nothing printed leaks the token.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AiSearchClient } from '../src/lib/client'
import { createAiSearchDriver } from '../src/lib/driver'

// ── Credentials ─────────────────────────────────────────────────────────────

function wranglerOAuthToken(): string | null {
  const path = join(homedir(), 'Library', 'Preferences', '.wrangler', 'config', 'default.toml')
  try {
    const match = readFileSync(path, 'utf8').match(/^oauth_token\s*=\s*"([^"]+)"/m)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

// No defaults for account or instance. An account id baked into a public repo
// is a needless disclosure, and a default instance name risks a stray run
// writing fixtures into somebody's real index.
const accountId = process.env.CF_AI_SEARCH_ACCOUNT_ID
const instanceId = process.env.CF_AI_SEARCH_INSTANCE
const apiToken = process.env.CF_AI_SEARCH_API_TOKEN ?? wranglerOAuthToken()

if (!accountId || !instanceId) {
  console.error(
    'Set CF_AI_SEARCH_ACCOUNT_ID and CF_AI_SEARCH_INSTANCE.\n' +
      '  account id:  npx wrangler whoami\n' +
      '  instance:    npx wrangler ai-search list',
  )
  process.exit(1)
}

if (!apiToken) {
  console.error('No credentials: set CF_AI_SEARCH_API_TOKEN or run `npx wrangler login`.')
  process.exit(1)
}

const driver = createAiSearchDriver({ accountId, apiToken, instanceId })
const client = new AiSearchClient({ accountId, apiToken, instanceId })

// ── Fixtures ────────────────────────────────────────────────────────────────

const TENANT = 'spike-tenant-a'
const OTHER_TENANT = 'spike-tenant-b'
const ORG_A = 'org-alpha'
const ORG_B = 'org-beta'

const PO = 'procurement:purchase_order'
const PROPOSAL = 'inbox_ops:inbox_proposal'

const fixtures = [
  {
    recordId: 'po-1',
    entityId: PO,
    tenantId: TENANT,
    organizationId: ORG_A,
    fields: {
      po_number: 'PO-10432',
      vendor_name: 'Acme Fastener Supply',
      status: 'hold',
      notes: 'Freight invoice disputed; awaiting revised order acknowledgement from the vendor.',
    },
  },
  {
    recordId: 'po-2',
    entityId: PO,
    tenantId: TENANT,
    organizationId: ORG_B,
    fields: {
      po_number: 'PO-99871',
      vendor_name: 'Northwind Steel',
      status: 'received',
      notes: 'Goods receipt posted, three pallets of galvanized sheet delivered to the Mississauga dock.',
    },
  },
  {
    recordId: 'prop-1',
    entityId: PROPOSAL,
    tenantId: TENANT,
    organizationId: ORG_A,
    fields: {
      summary: 'Vendor invoice from Acme Fastener Supply requires approval before payment release',
      category: 'invoice',
      status: 'pending',
    },
  },
  // Different tenant, deliberately similar text: if tenant scoping is wrong,
  // this is what leaks.
  {
    recordId: 'po-3',
    entityId: PO,
    tenantId: OTHER_TENANT,
    organizationId: ORG_A,
    fields: {
      po_number: 'PO-10432',
      vendor_name: 'Acme Fastener Supply',
      status: 'hold',
      notes: 'CONFIDENTIAL TENANT B RECORD — must never appear in tenant A results.',
    },
  },
]

// ── Helpers ─────────────────────────────────────────────────────────────────

const results: Array<{ name: string; pass: boolean; detail: string }> = []

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now()
  const value = await fn()
  return [value, Math.round(performance.now() - start)]
}

function ids(hits: Array<{ recordId: string }>): string {
  return hits.length ? hits.map((h) => h.recordId).join(', ') : '(none)'
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Run ─────────────────────────────────────────────────────────────────────

console.log(`\nInstance: ${instanceId}   Account: ${accountId.slice(0, 8)}…\n`)

console.log('1. Indexing')
let indexMs = 0
for (const doc of fixtures) {
  try {
    const [, ms] = await timed(() => driver.index(doc))
    indexMs += ms
    console.log(`  uploaded ${doc.tenantId}/${doc.recordId} (${ms}ms)`)
  } catch (error) {
    // The multipart metadata contract is the #1 unknown; surface it verbatim.
    console.error(`  UPLOAD FAILED for ${doc.recordId}:\n  ${(error as Error).message}`)
    process.exit(1)
  }
}
check('upload accepted', true, `${fixtures.length} docs, ${indexMs}ms total`)

console.log('\n2. Waiting for async indexing')
// Poll item status rather than search hits: searching for "some results" races
// with partially-indexed corpora and silently weakens every later assertion.
let completed = 0
const indexStart = performance.now()
for (let attempt = 0; attempt < 40; attempt++) {
  await sleep(2000)
  const { items } = await client.listItems({ perPage: 100 })
  const mine = items.filter((i) => fixtures.some((f) => i.key === `t/${f.tenantId}/${f.recordId}.md`))
  completed = mine.filter((i) => i.status === 'completed').length
  if (completed === fixtures.length) break
  process.stdout.write(`  ${Math.round((performance.now() - indexStart) / 1000)}s: ${completed}/${fixtures.length} completed\r`)
}
const indexLagS = Math.round((performance.now() - indexStart) / 1000)
check('all documents indexed', completed === fixtures.length, `${completed}/${fixtures.length} completed after ${indexLagS}s`)

try {
  await driver.search('Acme Fastener Supply', { tenantId: TENANT, limit: 10 })
} catch (error) {
  // assertMetadataContract fires here if `entity` metadata did not survive.
  console.error(`  SEARCH FAILED:\n  ${(error as Error).message}`)
  process.exit(1)
}

console.log('\n3. Metadata contract (the undocumented bit)')
const sample = await driver.search('Acme Fastener Supply', { tenantId: TENANT, limit: 10 })
const mapped = sample.filter((h) => h.entityId && h.entityId.includes(':'))
check(
  'custom metadata survives multipart upload',
  mapped.length === sample.length && sample.length > 0,
  `${mapped.length}/${sample.length} hits carry a usable entityId`,
)
check(
  'organizationId round-trips',
  sample.every((h) => h.organizationId === ORG_A || h.organizationId === ORG_B),
  sample.map((h) => `${h.recordId}=${h.organizationId}`).join(' '),
)

console.log('\n4. Tenant isolation (security-critical)')
// Tenant A legitimately matches its own records on a loose vector query, so the
// bar is "no tenant-B record", not "no results". po-3 is the planted canary.
const leak = await driver.search('CONFIDENTIAL TENANT B RECORD', { tenantId: TENANT, limit: 20 })
check('tenant A cannot see tenant B records', !leak.some((h) => h.recordId === 'po-3'), `got ${ids(leak)}`)
const ownTenant = await driver.search('CONFIDENTIAL TENANT B RECORD', { tenantId: OTHER_TENANT, limit: 20 })
check('tenant B can see its own record', ownTenant.some((h) => h.recordId === 'po-3'), ids(ownTenant))

console.log('\n5. Filters')
const entityFiltered = await driver.search('Acme', { tenantId: TENANT, entityTypes: [PROPOSAL], limit: 20 })
check(
  'entity filter narrows to one type',
  entityFiltered.length > 0 && entityFiltered.every((h) => h.entityId === PROPOSAL),
  ids(entityFiltered),
)
const orgFiltered = await driver.search('vendor', { tenantId: TENANT, organizationId: ORG_B, limit: 20 })
check(
  'org filter narrows to one org',
  orgFiltered.every((h) => h.organizationId === ORG_B),
  ids(orgFiltered),
)
const noOrg = await driver.search('vendor', { tenantId: TENANT, organizationIds: [], limit: 20 })
check('empty org allow-list returns nothing', noOrg.length === 0, ids(noOrg))

console.log('\n6. Query quality (vs what Meilisearch would do)')
const queries: Array<[string, string, string]> = [
  ['exact identifier', 'PO-10432', 'po-1'],
  ['short prefix', 'Acm', 'po-1'],
  ['misspelling', 'freigt invoice', 'po-1'],
  ['natural language', 'which orders are on hold awaiting a vendor response', 'po-1'],
  ['semantic, no shared words', 'shipment arrived at the loading bay', 'po-2'],
]
// Recall is the pass/fail bar; rank is reported because a Cmd+K dialog shows
// ~10 rows, so rank 2 of 3 is usable — just worse than Meilisearch would do.
for (const [label, query, expected] of queries) {
  const [hits, ms] = await timed(() => driver.search(query, { tenantId: TENANT, limit: 10 }))
  const rank = hits.findIndex((h) => h.recordId === expected)
  check(
    `${label}: "${query}"`,
    rank !== -1,
    rank === -1
      ? `MISS (${ms}ms, got ${ids(hits)})`
      : `rank ${rank + 1}/${hits.length} (${ms}ms)${rank > 0 ? ` — outranked by ${hits[0].recordId}` : ''}`,
  )
}

console.log('\n7. Search latency')
const samples: number[] = []
for (let i = 0; i < 5; i++) {
  const [, ms] = await timed(() => driver.search(`vendor invoice ${i}`, { tenantId: TENANT, limit: 10 }))
  samples.push(ms)
}
samples.sort((a, b) => a - b)
check('latency measured', true, `min ${samples[0]}ms / median ${samples[2]}ms / max ${samples[4]}ms`)

console.log('\n8. Delete')
await driver.delete('po-2', TENANT)
await sleep(3000)
const afterDelete = await driver.search('Northwind Steel galvanized sheet', { tenantId: TENANT, limit: 20 })
check('deleted record disappears', !afterDelete.some((h) => h.recordId === 'po-2'), ids(afterDelete))

// ── Summary ─────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.pass)
console.log(`\n${'─'.repeat(60)}`)
console.log(`${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('\nFailures:')
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
}
console.log(`${'─'.repeat(60)}\n`)
