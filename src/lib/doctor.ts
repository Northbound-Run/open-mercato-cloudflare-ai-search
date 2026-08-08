/**
 * Operational diagnostics for a Cloudflare AI Search instance.
 *
 * The reason this exists is the filter probe at the bottom. Cloudflare AI
 * Search is in open beta, and its BM25 retrieval path was measured on
 * 2026-08-08 silently ignoring RANGE operators on the built-in `folder`
 * attribute — the exact idiom Cloudflare's own multitenancy docs prescribe for
 * per-tenant scoping. This driver sidesteps it by keeping keys one folder level
 * deep and filtering with `$eq`, but "sidesteps a live bug in a beta product"
 * is not a property that can be assumed to hold. So we re-measure it, against
 * the real instance, on demand.
 *
 * Everything here is pure and injectable so the interpretation logic can be
 * unit-tested without a Cloudflare account; only `runFilterProbe` touches the
 * network.
 */

import type { AiSearchClient, AiSearchInstance } from './client'
import { AiSearchApiError } from './client'
import type { FullTextSearchDriver } from '@open-mercato/search/fulltext'
import type { EntityId } from '@open-mercato/shared/modules/entities'

export type DoctorStatus = 'pass' | 'fail' | 'warn' | 'skip'

export type DoctorCheck = {
  id: string
  title: string
  status: DoctorStatus
  detail: string
  /** Shown only for fail/warn — the concrete next action. */
  remedy?: string
}

export type DoctorReport = {
  checks: DoctorCheck[]
  /** False when any check failed. Warnings do not fail the report. */
  ok: boolean
}

/** Custom metadata fields the driver requires, with their required types. */
export const REQUIRED_CUSTOM_METADATA: ReadonlyArray<{ field: string; type: string }> = [
  { field: 'entity', type: 'text' },
  { field: 'org', type: 'text' },
]

// ---------------------------------------------------------------------------
// Pure checks
// ---------------------------------------------------------------------------

export function checkConfiguration(env: {
  accountId?: string
  apiToken?: string
  instanceId?: string
}): DoctorCheck {
  const missing = (
    [
      ['CF_AI_SEARCH_ACCOUNT_ID', env.accountId],
      ['CF_AI_SEARCH_API_TOKEN', env.apiToken],
      ['CF_AI_SEARCH_INSTANCE', env.instanceId],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name)

  if (missing.length > 0) {
    return {
      id: 'config',
      title: 'Environment configured',
      status: 'fail',
      detail: `missing ${missing.join(', ')}`,
      remedy: 'Set the variables listed above. Until they are set the driver silently does not register.',
    }
  }
  return { id: 'config', title: 'Environment configured', status: 'pass', detail: 'all three variables present' }
}

export function checkInstanceReachable(instance: AiSearchInstance | null, instanceId: string): DoctorCheck {
  if (!instance) {
    return {
      id: 'instance',
      title: 'Instance exists',
      status: 'fail',
      detail: `no instance named "${instanceId}"`,
      remedy: `npx wrangler ai-search create ${instanceId} --type builtin --hybrid-search --custom-metadata entity:text --custom-metadata org:text`,
    }
  }
  if (instance.paused) {
    return {
      id: 'instance',
      title: 'Instance exists',
      status: 'warn',
      detail: `"${instanceId}" exists but indexing is PAUSED (status: ${instance.status ?? 'unknown'})`,
      remedy: 'Resume indexing from the dashboard, or new documents will never become searchable.',
    }
  }
  return {
    id: 'instance',
    title: 'Instance exists',
    status: 'pass',
    detail: `"${instanceId}" (status: ${instance.status ?? 'unknown'}, namespace: ${instance.namespace ?? 'default'})`,
  }
}

/**
 * Cloudflare silently DROPS metadata fields that are not declared on the
 * instance. A hit without `entity` cannot be mapped back to an Open Mercato
 * entity, so this is a hard failure rather than a warning.
 */
export function checkCustomMetadata(instance: AiSearchInstance): DoctorCheck {
  const declared = new Map(
    (instance.custom_metadata ?? [])
      .filter((f): f is { field_name: string; data_type?: string } => typeof f?.field_name === 'string')
      .map((f) => [f.field_name.toLowerCase(), (f.data_type ?? '').toLowerCase()]),
  )

  const problems: string[] = []
  for (const { field, type } of REQUIRED_CUSTOM_METADATA) {
    const actual = declared.get(field)
    if (actual === undefined) problems.push(`\`${field}\` not declared`)
    else if (actual !== type) problems.push(`\`${field}\` is ${actual}, expected ${type}`)
  }

  if (problems.length > 0) {
    return {
      id: 'metadata',
      title: 'Custom metadata schema',
      status: 'fail',
      detail: problems.join('; '),
      remedy:
        `npx wrangler ai-search update ${instance.id ?? '<instance>'} ` +
        REQUIRED_CUSTOM_METADATA.map((f) => `--custom-metadata ${f.field}:${f.type}`).join(' ') +
        '\n  Then reindex — changing the schema re-indexes existing documents, but documents ' +
        'uploaded before the fields existed lost their metadata permanently.',
    }
  }

  return {
    id: 'metadata',
    title: 'Custom metadata schema',
    status: 'pass',
    detail: REQUIRED_CUSTOM_METADATA.map((f) => `${f.field}:${f.type}`).join(', ') + ' declared',
  }
}

/**
 * Vector-only retrieval misses exact identifiers (`PO-10432`), which is a large
 * share of what people type into an ERP search box. Not fatal, so: warn.
 */
export function checkIndexMethod(instance: AiSearchInstance): DoctorCheck {
  const vector = instance.index_method?.vector !== false
  const keyword = instance.index_method?.keyword === true
  const tokenizer = instance.indexing_options?.keyword_tokenizer

  if (!keyword) {
    return {
      id: 'index-method',
      title: 'Hybrid retrieval enabled',
      status: 'warn',
      detail: 'keyword (BM25) indexing is OFF — exact identifiers will rank poorly or miss entirely',
      remedy: `npx wrangler ai-search update ${instance.id ?? '<instance>'} --hybrid-search  (triggers a full reindex)`,
    }
  }
  if (!vector) {
    return {
      id: 'index-method',
      title: 'Hybrid retrieval enabled',
      status: 'warn',
      detail: 'vector indexing is OFF — semantic and misspelled queries will miss',
      remedy: 'Enable vector indexing; this driver assumes hybrid.',
    }
  }
  return {
    id: 'index-method',
    title: 'Hybrid retrieval enabled',
    status: 'pass',
    detail: `vector + keyword${tokenizer ? ` (tokenizer: ${tokenizer})` : ''}`,
  }
}

/**
 * Catches the single most likely deployment mistake: forgetting the one line of
 * app wiring. Without it the driver never registers and search silently falls
 * back to whatever other strategies exist, with nothing in the logs.
 */
export function checkStrategyRegistration(info: {
  registered: boolean
  driverId?: string | null
}): DoctorCheck {
  if (!info.registered) {
    return {
      id: 'strategy',
      title: 'Driver registered with SearchService',
      status: 'fail',
      detail: 'no `fulltext` strategy is registered',
      remedy:
        'Call registerCloudflareAiSearch(container) from the app\'s src/di.ts, after bootstrap(). ' +
        'A module di.ts cannot do this — it runs before searchService exists.',
    }
  }
  if (info.driverId !== 'cloudflare-ai-search') {
    return {
      id: 'strategy',
      title: 'Driver registered with SearchService',
      status: 'warn',
      detail: `the \`fulltext\` strategy is backed by "${info.driverId ?? 'unknown'}", not this driver`,
      remedy:
        'Another driver won the `fulltext` slot. MEILISEARCH_HOST being set will do that. ' +
        'Do not configure both.',
    }
  }
  return {
    id: 'strategy',
    title: 'Driver registered with SearchService',
    status: 'pass',
    detail: 'fulltext -> cloudflare-ai-search',
  }
}

// ---------------------------------------------------------------------------
// Filter-enforcement probe
// ---------------------------------------------------------------------------

export type FilterProbeResult = {
  ran: boolean
  skipReason?: string
  /** The driver's own search returned another tenant's record. Catastrophic. */
  driverLeaked: boolean
  /** A raw `$eq` folder filter leaked. The operator the driver depends on. */
  eqLeaked: boolean
  /** A raw range folder filter leaked. Informational: is the CF bug still present? */
  rangeLeaked: boolean
  indexWaitMs: number
}

export function interpretProbe(probe: FilterProbeResult): DoctorCheck[] {
  if (!probe.ran) {
    return [
      {
        id: 'probe.isolation',
        title: 'Cross-tenant isolation (live)',
        status: 'skip',
        detail: probe.skipReason ?? 'not run',
      },
    ]
  }

  const isolation: DoctorCheck =
    probe.driverLeaked || probe.eqLeaked
      ? {
          id: 'probe.isolation',
          title: 'Cross-tenant isolation (live)',
          status: 'fail',
          detail:
            `a planted canary from another tenant was returned ` +
            `(driver: ${probe.driverLeaked ? 'LEAKED' : 'clean'}, raw $eq filter: ${probe.eqLeaked ? 'LEAKED' : 'clean'})`,
          remedy:
            'STOP. Equality filtering on `folder` is the mechanism this driver relies on for tenant ' +
            'isolation. If it no longer holds, every multi-tenant query is unsafe. Unset ' +
            'CF_AI_SEARCH_ACCOUNT_ID to fall back to the other strategies, and open an issue.',
        }
      : {
          id: 'probe.isolation',
          title: 'Cross-tenant isolation (live)',
          status: 'pass',
          detail: `canary stayed in its own tenant (indexed in ${Math.round(probe.indexWaitMs / 1000)}s)`,
        }

  // Informational, and deliberately not a failure: the driver does not use the
  // range form. Tracking it tells us whether nested key schemes have become
  // safe — which is what L2's attachment corpus would want.
  const rangeOperator: DoctorCheck = probe.rangeLeaked
    ? {
        id: 'probe.range-operator',
        title: 'Cloudflare range-filter bug',
        status: 'warn',
        detail: 'still present — BM25 ignores $gte/$lt on `folder`, so the documented "starts with" idiom leaks',
        remedy:
          'No action needed: this driver uses $eq and is unaffected. Do not introduce nested folder ' +
          'keys or range filters while this reads "still present".',
      }
    : {
        id: 'probe.range-operator',
        title: 'Cloudflare range-filter bug',
        status: 'pass',
        detail: 'range filters on `folder` are now enforced on the keyword path — appears fixed upstream',
      }

  return [isolation, rangeOperator]
}

export function summarize(checks: DoctorCheck[]): DoctorReport {
  return { checks, ok: !checks.some((c) => c.status === 'fail') }
}

// ---------------------------------------------------------------------------
// Live probe (the only networked part)
// ---------------------------------------------------------------------------

const PROBE_ENTITY = 'search_cloudflare_ai:doctor_canary' as EntityId
const PROBE_TENANT_A = '__om-doctor-a'
const PROBE_TENANT_B = '__om-doctor-b'

function probeKey(tenantId: string, recordId: string): string {
  return `t/${encodeURIComponent(tenantId)}/${encodeURIComponent(recordId)}.md`
}

/**
 * Plants a canary in a second synthetic tenant, then asks the first tenant for
 * it. Cleans up in `finally`, including when indexing never completed.
 *
 * `runId` scopes the record ids so a crashed earlier run cannot poison this one,
 * and so two operators running doctor concurrently do not collide.
 */
export async function runFilterProbe(deps: {
  client: AiSearchClient
  driver: FullTextSearchDriver
  runId: string
  timeoutMs?: number
  pollIntervalMs?: number
  onProgress?: (message: string) => void
}): Promise<FilterProbeResult> {
  const { client, driver, runId } = deps
  const timeoutMs = deps.timeoutMs ?? 240_000
  const pollIntervalMs = deps.pollIntervalMs ?? 3_000
  const progress = deps.onProgress ?? (() => {})

  const canary = `OMDOCTORCANARY${runId}`
  const recordA = `canary-a-${runId}`
  const recordB = `canary-b-${runId}`
  const keyA = probeKey(PROBE_TENANT_A, recordA)
  const keyB = probeKey(PROBE_TENANT_B, recordB)

  const empty: FilterProbeResult = {
    ran: false,
    driverLeaked: false,
    eqLeaked: false,
    rangeLeaked: false,
    indexWaitMs: 0,
  }

  try {
    await driver.index({
      recordId: recordA,
      entityId: PROBE_ENTITY,
      tenantId: PROBE_TENANT_A,
      organizationId: '__doctor',
      fields: { note: 'routine diagnostic record belonging to tenant a' },
    })
    await driver.index({
      recordId: recordB,
      entityId: PROBE_ENTITY,
      tenantId: PROBE_TENANT_B,
      organizationId: '__doctor',
      // The canary token exists ONLY here, so BM25's strongest match for it is a
      // document tenant A must never see.
      fields: { note: `${canary} confidential diagnostic record belonging to tenant b` },
    })

    const started = Date.now()
    let indexed = false
    while (Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
      const { items } = await client.listItems({ perPage: 50 })
      const mine = items.filter((i) => i.key === keyA || i.key === keyB)
      const done = mine.filter((i) => i.status === 'completed').length
      if (done === 2) {
        indexed = true
        break
      }
      progress(`indexing canaries: ${done}/2 (${Math.round((Date.now() - started) / 1000)}s)`)
    }

    const indexWaitMs = Date.now() - started
    if (!indexed) {
      return {
        ...empty,
        skipReason: `canaries did not finish indexing within ${Math.round(timeoutMs / 1000)}s — cannot verify isolation`,
        indexWaitMs,
      }
    }

    const folderA = `t/${encodeURIComponent(PROBE_TENANT_A)}/`

    // 1. The real thing: the driver's own search, scoped to tenant A.
    const driverHits = await driver.search(canary, { tenantId: PROBE_TENANT_A, limit: 20 })
    const driverLeaked = driverHits.some((hit) => hit.recordId === recordB)

    // 2. The operator the driver depends on, in isolation.
    const eqLeaked = await rawFilterLeaks(client, canary, { folder: { $eq: folderA } })

    // 3. The operator Cloudflare's docs prescribe, which leaked when measured.
    const rangeLeaked = await rawFilterLeaks(client, canary, {
      folder: { $gte: folderA, $lt: `${folderA.slice(0, -1)}0` },
    })

    return { ran: true, driverLeaked, eqLeaked, rangeLeaked, indexWaitMs }
  } finally {
    // Best-effort cleanup. A failure here must not mask a probe result, but it
    // must also not go unmentioned — a stranded canary is a real document in a
    // real index.
    for (const [tenantId, recordId] of [
      [PROBE_TENANT_A, recordA],
      [PROBE_TENANT_B, recordB],
    ] as const) {
      try {
        await driver.delete(recordId, tenantId)
      } catch (error) {
        progress(
          `WARNING: could not delete canary ${probeKey(tenantId, recordId)} — ` +
            `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
}

async function rawFilterLeaks(
  client: AiSearchClient,
  query: string,
  filters: Record<string, unknown>,
): Promise<boolean> {
  const foreignPrefix = `t/${encodeURIComponent(PROBE_TENANT_B)}/`
  try {
    const response = await client.search({
      query,
      ai_search_options: { retrieval: { retrieval_type: 'hybrid', max_num_results: 50, filters } },
    })
    return (response.chunks ?? []).some((chunk) => chunk.item?.key?.startsWith(foreignPrefix) === true)
  } catch (error) {
    if (error instanceof AiSearchApiError && error.status === 404) return false
    throw error
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runDoctor(deps: {
  env: { accountId?: string; apiToken?: string; instanceId?: string }
  client: AiSearchClient
  driver: FullTextSearchDriver
  strategy: { registered: boolean; driverId?: string | null }
  probe: boolean
  runId: string
  onProgress?: (message: string) => void
}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = []

  const config = checkConfiguration(deps.env)
  checks.push(config)
  if (config.status === 'fail') return summarize(checks)

  let instance: AiSearchInstance | null
  try {
    instance = await deps.client.getInstance()
  } catch (error) {
    checks.push({
      id: 'instance',
      title: 'Instance exists',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
      remedy:
        'On a 401: the token is wrong, lacks AI Search:Edit + AI Search:Run, or has EXPIRED. ' +
        'wrangler OAuth tokens are short-lived (about an hour) — `npx wrangler whoami` refreshes one. ' +
        'On a 404 the account id is likely wrong: check `npx wrangler whoami`.',
    })
    return summarize(checks)
  }

  const reachable = checkInstanceReachable(instance, deps.env.instanceId ?? '<unset>')
  checks.push(reachable)
  if (!instance) return summarize(checks)

  checks.push(checkCustomMetadata(instance))
  checks.push(checkIndexMethod(instance))
  checks.push(checkStrategyRegistration(deps.strategy))

  if (!deps.probe) {
    checks.push(...interpretProbe({ ...emptyProbe, skipReason: 'skipped (--quick)' }))
    return summarize(checks)
  }

  // Probing with a broken metadata schema would fail for the wrong reason and
  // report a leak that is really a configuration error.
  if (checks.some((c) => c.id === 'metadata' && c.status === 'fail')) {
    checks.push(...interpretProbe({ ...emptyProbe, skipReason: 'skipped — fix the metadata schema first' }))
    return summarize(checks)
  }

  try {
    const probe = await runFilterProbe({
      client: deps.client,
      driver: deps.driver,
      runId: deps.runId,
      onProgress: deps.onProgress,
    })
    checks.push(...interpretProbe(probe))
  } catch (error) {
    checks.push({
      id: 'probe.isolation',
      title: 'Cross-tenant isolation (live)',
      status: 'fail',
      detail: `probe errored: ${error instanceof Error ? error.message : String(error)}`,
      remedy: 'The probe could not complete, so isolation is UNVERIFIED. Do not treat this as a pass.',
    })
  }

  return summarize(checks)
}

const emptyProbe: FilterProbeResult = {
  ran: false,
  driverLeaked: false,
  eqLeaked: false,
  rangeLeaked: false,
  indexWaitMs: 0,
}
