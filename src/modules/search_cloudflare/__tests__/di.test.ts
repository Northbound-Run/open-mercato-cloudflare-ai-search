// Globals imported explicitly, matching the other suites.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals'

import type { SearchModuleConfig } from '@open-mercato/shared/modules/search'
import { DENY_ALL, createLazyFieldPolicyResolver, memoizationBlockedBy } from '../di'

const configs = [
  {
    entities: [
      {
        entityId: 'customers:customer_person_profile',
        fieldPolicy: {
          searchable: ['first_name', 'last_name'],
          hashOnly: ['primary_email'],
          excluded: ['ssn', 'government_id'],
        },
      },
      { entityId: 'catalog:product' }, // configured, but declares no policy
      { entityId: 'sales:order', enabled: false, fieldPolicy: { searchable: ['code'] } },
    ],
  },
] as unknown as SearchModuleConfig[]

describe('field policy resolution', () => {
  it('returns the declared policy for a configured entity', () => {
    const resolve = createLazyFieldPolicyResolver(() => configs)
    expect(resolve('customers:customer_person_profile' as never)).toMatchObject({
      searchable: ['first_name', 'last_name'],
      excluded: ['ssn', 'government_id'],
    })
  })

  it('fails CLOSED when the registry is empty', () => {
    // Module DI can run before the registry is populated. An absent policy means
    // "no whitelist" to extractSearchableFields, which would index every field
    // on the record — ssn and government_id included. Denying is the only safe
    // answer, and it is why this resolver is lazy rather than captured once.
    const resolve = createLazyFieldPolicyResolver(() => [])
    expect(resolve('customers:customer_person_profile' as never)).toBe(DENY_ALL)
  })

  it('denies an entity that is absent from the registry', () => {
    const resolve = createLazyFieldPolicyResolver(() => configs)
    expect(resolve('some_module:never_configured' as never)).toBe(DENY_ALL)
  })

  it('passes through undefined for a configured entity with no policy', () => {
    // Matches the built-in Meilisearch driver, which sends `undefined` and lets
    // every field through. Diverging here would silently index less than the
    // driver being replaced.
    const resolve = createLazyFieldPolicyResolver(() => configs)
    expect(resolve('catalog:product' as never)).toBeUndefined()
  })

  it('denies a disabled entity', () => {
    const resolve = createLazyFieldPolicyResolver(() => configs)
    expect(resolve('sales:order' as never)).toBe(DENY_ALL)
  })

  it('does not cache an empty registry, so a later population still works', () => {
    // The whole point of resolving lazily: an early empty read must not freeze
    // DENY_ALL in for the life of the process.
    let ready = false
    const resolve = createLazyFieldPolicyResolver(() => (ready ? configs : []))

    expect(resolve('customers:customer_person_profile' as never)).toBe(DENY_ALL)
    ready = true
    expect(resolve('customers:customer_person_profile' as never)).toMatchObject({
      searchable: ['first_name', 'last_name'],
    })
  })

  it('reads the registry once it is populated and then stops re-reading', () => {
    let reads = 0
    const resolve = createLazyFieldPolicyResolver(() => {
      reads += 1
      return configs
    })
    resolve('customers:customer_person_profile' as never)
    resolve('catalog:product' as never)
    expect(reads).toBe(1)
  })
})

describe('memoization guard', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    delete process.env.SEARCH_DISABLE_SINGLETON_CACHE
    delete process.env.SEARCH_EXCLUDE_ENCRYPTED_FIELDS
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  it('is clear when nothing blocks the pre-seeded driver', () => {
    expect(memoizationBlockedBy()).toBeNull()
  })

  it('reports SEARCH_EXCLUDE_ENCRYPTED_FIELDS, which makes the seed a no-op', () => {
    // registerSearchModule skips its memoized-driver lookup entirely in this
    // mode, so the seed is ignored and fulltext silently vanishes.
    for (const value of ['1', 'true', 'yes', 'on', 'ON']) {
      process.env.SEARCH_EXCLUDE_ENCRYPTED_FIELDS = value
      expect(memoizationBlockedBy()).toMatch(/SEARCH_EXCLUDE_ENCRYPTED_FIELDS/)
    }
  })

  it('ignores falsey spellings of the flag', () => {
    for (const value of ['0', 'false', 'no', '']) {
      process.env.SEARCH_EXCLUDE_ENCRYPTED_FIELDS = value
      expect(memoizationBlockedBy()).toBeNull()
    }
  })

  it('reports SEARCH_DISABLE_SINGLETON_CACHE', () => {
    process.env.SEARCH_DISABLE_SINGLETON_CACHE = '1'
    expect(memoizationBlockedBy()).toMatch(/SEARCH_DISABLE_SINGLETON_CACHE/)
  })
})
