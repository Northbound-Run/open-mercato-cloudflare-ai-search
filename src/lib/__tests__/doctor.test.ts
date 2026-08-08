// Globals are imported explicitly rather than relied on ambiently, matching the
// driver tests.
import { describe, expect, it } from '@jest/globals'

import type { AiSearchInstance } from '../client'
import {
  checkConfiguration,
  checkCustomMetadata,
  checkIndexMethod,
  checkInstanceReachable,
  checkStrategyRegistration,
  interpretProbe,
  summarize,
  type DoctorCheck,
  type FilterProbeResult,
} from '../doctor'

const healthy: AiSearchInstance = {
  id: 'inst',
  status: 'ready',
  index_method: { vector: true, keyword: true },
  custom_metadata: [
    { field_name: 'entity', data_type: 'text' },
    { field_name: 'org', data_type: 'text' },
  ],
  indexing_options: { keyword_tokenizer: 'porter' },
}

const noProbe: FilterProbeResult = {
  ran: false,
  driverLeaked: false,
  eqLeaked: false,
  rangeLeaked: false,
  indexWaitMs: 0,
}

function statusOf(check: DoctorCheck) {
  return check.status
}

describe('configuration', () => {
  it('names every missing variable at once rather than one at a time', () => {
    const check = checkConfiguration({ apiToken: 'x' })
    expect(check.status).toBe('fail')
    expect(check.detail).toContain('CF_AI_SEARCH_ACCOUNT_ID')
    expect(check.detail).toContain('CF_AI_SEARCH_INSTANCE')
    expect(check.detail).not.toContain('CF_AI_SEARCH_API_TOKEN')
  })

  it('passes when all three are present', () => {
    expect(statusOf(checkConfiguration({ accountId: 'a', apiToken: 'b', instanceId: 'c' }))).toBe('pass')
  })
})

describe('instance reachability', () => {
  it('fails with a create command when the instance is absent', () => {
    const check = checkInstanceReachable(null, 'missing-one')
    expect(check.status).toBe('fail')
    expect(check.remedy).toContain('wrangler ai-search create missing-one')
    // The remedy must carry the metadata flags, or following it produces an
    // instance the driver cannot use.
    expect(check.remedy).toContain('--custom-metadata entity:text')
  })

  it('warns rather than passes when indexing is paused', () => {
    // A paused instance is fully searchable, so it looks fine — but nothing new
    // is ever indexed, which is worse than an outage because it is silent.
    expect(statusOf(checkInstanceReachable({ ...healthy, paused: true }, 'inst'))).toBe('warn')
  })

  it('passes for a live instance', () => {
    expect(statusOf(checkInstanceReachable(healthy, 'inst'))).toBe('pass')
  })
})

describe('custom metadata schema', () => {
  it('passes when both required fields are declared as text', () => {
    expect(statusOf(checkCustomMetadata(healthy))).toBe('pass')
  })

  it('fails when `entity` is missing, since hits cannot be mapped without it', () => {
    const check = checkCustomMetadata({ ...healthy, custom_metadata: [{ field_name: 'org', data_type: 'text' }] })
    expect(check.status).toBe('fail')
    expect(check.detail).toContain('`entity` not declared')
  })

  it('fails on a wrong data type, not just a missing field', () => {
    const check = checkCustomMetadata({
      ...healthy,
      custom_metadata: [
        { field_name: 'entity', data_type: 'number' },
        { field_name: 'org', data_type: 'text' },
      ],
    })
    expect(check.status).toBe('fail')
    expect(check.detail).toContain('`entity` is number, expected text')
  })

  it('treats field names case-insensitively, as Cloudflare does', () => {
    const check = checkCustomMetadata({
      ...healthy,
      custom_metadata: [
        { field_name: 'Entity', data_type: 'TEXT' },
        { field_name: 'ORG', data_type: 'text' },
      ],
    })
    expect(check.status).toBe('pass')
  })

  it('fails when no custom metadata is configured at all', () => {
    expect(statusOf(checkCustomMetadata({ ...healthy, custom_metadata: null }))).toBe('fail')
  })
})

describe('index method', () => {
  it('warns when keyword indexing is off — exact identifiers would miss', () => {
    const check = checkIndexMethod({ ...healthy, index_method: { vector: true, keyword: false } })
    expect(check.status).toBe('warn')
    expect(check.remedy).toContain('--hybrid-search')
  })

  it('warns when vector indexing is off', () => {
    expect(statusOf(checkIndexMethod({ ...healthy, index_method: { vector: false, keyword: true } }))).toBe('warn')
  })

  it('passes on hybrid and reports the tokenizer', () => {
    const check = checkIndexMethod(healthy)
    expect(check.status).toBe('pass')
    expect(check.detail).toContain('porter')
  })
})

describe('strategy registration', () => {
  it('fails when no fulltext strategy is registered, and points at the app wiring', () => {
    const check = checkStrategyRegistration({ registered: false })
    expect(check.status).toBe('fail')
    expect(check.remedy).toContain('registerCloudflareAiSearch')
    // The reason a module di.ts cannot do it is the part people get wrong.
    expect(check.remedy).toContain('module di.ts cannot')
  })

  it('warns when another driver won the fulltext slot', () => {
    const check = checkStrategyRegistration({ registered: true, driverId: 'meilisearch' })
    expect(check.status).toBe('warn')
    expect(check.detail).toContain('meilisearch')
  })

  it('passes when this driver is registered', () => {
    expect(statusOf(checkStrategyRegistration({ registered: true, driverId: 'cloudflare-ai-search' }))).toBe('pass')
  })
})

describe('probe interpretation', () => {
  it('fails when the driver itself leaked a foreign tenant record', () => {
    const [isolation] = interpretProbe({ ...noProbe, ran: true, driverLeaked: true })
    expect(isolation.status).toBe('fail')
    expect(isolation.remedy).toContain('STOP')
  })

  it('fails when the raw $eq filter leaked, even if the driver happened not to', () => {
    // $eq is the mechanism the driver depends on. If it stops holding, a clean
    // driver result is luck, not safety.
    const [isolation] = interpretProbe({ ...noProbe, ran: true, eqLeaked: true })
    expect(isolation.status).toBe('fail')
  })

  it('passes isolation while still warning that the range bug is present', () => {
    const [isolation, range] = interpretProbe({
      ...noProbe,
      ran: true,
      rangeLeaked: true,
      indexWaitMs: 42_000,
    })
    // The driver does not use range filters, so this combination is the
    // expected healthy state today — isolation good, upstream bug outstanding.
    expect(isolation.status).toBe('pass')
    expect(isolation.detail).toContain('42s')
    expect(range.status).toBe('warn')
    expect(range.detail).toContain('still present')
  })

  it('reports the range bug as fixed when it no longer leaks', () => {
    const [, range] = interpretProbe({ ...noProbe, ran: true, rangeLeaked: false })
    expect(range.status).toBe('pass')
    expect(range.detail).toContain('fixed')
  })

  it('skips rather than passes when the probe did not run', () => {
    // Reporting an unrun safety check as a pass is the worst possible default.
    const [isolation] = interpretProbe({ ...noProbe, skipReason: 'skipped (--quick)' })
    expect(isolation.status).toBe('skip')
    expect(isolation.detail).toContain('--quick')
  })
})

describe('summary', () => {
  const check = (status: DoctorCheck['status']): DoctorCheck => ({ id: status, title: 't', status, detail: 'd' })

  it('is not ok when anything failed', () => {
    expect(summarize([check('pass'), check('fail')]).ok).toBe(false)
  })

  it('is ok when there are warnings but no failures', () => {
    expect(summarize([check('pass'), check('warn'), check('skip')]).ok).toBe(true)
  })
})
