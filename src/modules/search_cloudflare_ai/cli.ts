import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { AiSearchClient } from '../../lib/client'
import { createAiSearchDriverFromEnv } from '../../lib/driver'
import { runDoctor, type DoctorCheck, type DoctorReport } from '../../lib/doctor'

const SYMBOL: Record<DoctorCheck['status'], string> = {
  pass: '✓',
  fail: '✗',
  warn: '!',
  skip: '-',
}

function render(report: DoctorReport): void {
  console.log('')
  for (const check of report.checks) {
    console.log(`  ${SYMBOL[check.status]} ${check.title}`)
    console.log(`      ${check.detail}`)
    if (check.remedy && (check.status === 'fail' || check.status === 'warn')) {
      for (const line of check.remedy.split('\n')) {
        console.log(`      → ${line.trim()}`)
      }
    }
  }

  const counts = report.checks.reduce<Record<string, number>>((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1
    return acc
  }, {})

  console.log('')
  console.log(
    `  ${report.ok ? 'HEALTHY' : 'PROBLEMS FOUND'} — ` +
      `${counts.pass ?? 0} passed, ${counts.fail ?? 0} failed, ${counts.warn ?? 0} warnings, ${counts.skip ?? 0} skipped`,
  )
  console.log('')
}

/**
 * Read strategy registration from the live container. This is what catches the
 * most likely deployment mistake — the app forgetting to call
 * registerCloudflareAiSearch() — which is otherwise completely silent.
 */
async function readStrategyRegistration(): Promise<{ registered: boolean; driverId?: string | null }> {
  try {
    const container = await createRequestContainer()
    try {
      const strategies = container.resolve('searchStrategies') as Array<{
        id?: string
        driverId?: string
      }>
      const fulltext = strategies?.find((s) => s?.id === 'fulltext')
      if (!fulltext) return { registered: false }
      return { registered: true, driverId: fulltext.driverId ?? null }
    } finally {
      const disposable = container as unknown as { dispose?: () => Promise<void> }
      if (typeof disposable.dispose === 'function') await disposable.dispose()
    }
  } catch {
    // No container (e.g. no database configured). Report as unregistered rather
    // than crashing — the rest of the diagnostics are still worth running.
    return { registered: false }
  }
}

const doctorCli: ModuleCli = {
  command: 'doctor',
  async run(rest) {
    const quick = rest.includes('--quick')

    const accountId = process.env.CF_AI_SEARCH_ACCOUNT_ID
    const apiToken = process.env.CF_AI_SEARCH_API_TOKEN
    const instanceId = process.env.CF_AI_SEARCH_INSTANCE

    console.log('\nCloudflare AI Search — diagnostics')
    if (instanceId) console.log(`instance: ${instanceId}`)
    if (!quick) {
      // Say this before doing it. The probe writes to the operator's real index.
      console.log(
        'running the live isolation probe: two canary documents are indexed under\n' +
          'synthetic tenants, queried, then deleted. Can take a few minutes because\n' +
          'Cloudflare indexing is asynchronous. Pass --quick to skip it.',
      )
    }

    const client = new AiSearchClient({
      accountId: accountId ?? '',
      apiToken: apiToken ?? '',
      instanceId: instanceId ?? '',
      namespace: process.env.CF_AI_SEARCH_NAMESPACE ?? null,
    })

    // Built directly rather than through the container: doctor must be able to
    // diagnose a driver the app failed to register.
    const driver = createAiSearchDriverFromEnv()

    const report = await runDoctor({
      env: { accountId, apiToken, instanceId },
      client,
      // Only reached when config passed, at which point the driver is non-null.
      driver: driver!,
      strategy: await readStrategyRegistration(),
      probe: !quick && driver !== null,
      runId: Date.now().toString(36),
      onProgress: (message) => console.log(`      ${message}`),
    })

    render(report)

    // Non-zero exit so this is usable as a deploy gate.
    if (!report.ok) process.exitCode = 1
  },
}

const helpCli: ModuleCli = {
  command: 'help',
  async run() {
    console.log('\nUsage: yarn mercato search_cloudflare_ai <command> [options]\n')
    console.log('Commands:')
    console.log('  doctor        Verify the instance matches what the driver requires')
    console.log('  help          Show this message')
    console.log('\nOptions:')
    console.log('  --quick       Skip the live cross-tenant isolation probe (fast, less thorough)')
    console.log('\nWhat doctor checks:')
    console.log('  - CF_AI_SEARCH_* environment is set')
    console.log('  - the instance exists and is not paused')
    console.log('  - `entity` and `org` custom metadata are declared (Cloudflare drops undeclared fields)')
    console.log('  - hybrid (vector + keyword) retrieval is on')
    console.log('  - the driver actually registered with SearchService')
    console.log('  - cross-tenant isolation still holds, measured live against a planted canary')
    console.log('')
  },
}

export default [doctorCli, helpCli]
