/**
 * Minimal REST client for Cloudflare AI Search (the product formerly called AutoRAG).
 *
 * Scope is deliberately narrow: only the Search and Items operations the
 * `FullTextSearchDriver` spike needs. Everything else (instance CRUD, sync jobs,
 * chat completions) is done out-of-band with `wrangler ai-search`.
 *
 * Docs: https://developers.cloudflare.com/ai-search/
 */

import { fetchWithTimeout, resolveTimeoutMs } from '@open-mercato/shared/lib/http/fetchWithTimeout'

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'
const DEFAULT_TIMEOUT_MS = 15_000

export type AiSearchClientConfig = {
  accountId: string
  apiToken: string
  /** Instance name/id, e.g. `lts-erp-spike`. */
  instanceId: string
  /** Optional namespace. When omitted the account's `default` namespace is used implicitly. */
  namespace?: string | null
  baseUrl?: string
  timeoutMs?: number
}

export class AiSearchApiError extends Error {
  readonly status: number
  readonly path: string
  readonly body: string

  constructor(path: string, status: number, body: string) {
    // The raw body is kept in the message on purpose: during the spike the
    // Cloudflare error payload is the fastest way to learn an undocumented
    // contract detail (see the metadata note in the driver).
    super(`Cloudflare AI Search ${status} on ${path}: ${body.slice(0, 800)}`)
    this.name = 'AiSearchApiError'
    this.status = status
    this.path = path
    this.body = body
  }
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export type AiSearchRetrievalFilters = Record<string, unknown>

export type AiSearchRetrievalOptions = {
  retrieval_type?: 'vector' | 'keyword' | 'hybrid'
  match_threshold?: number
  /** Hard capped at 50 by Cloudflare. */
  max_num_results?: number
  filters?: AiSearchRetrievalFilters
  keyword_match_mode?: 'and' | 'or'
  fusion_method?: 'rrf' | 'max'
  metadata_only?: boolean
  return_on_failure?: boolean
}

export type AiSearchChunk = {
  id?: string
  type?: string
  score?: number
  text?: string
  instance_id?: string
  item?: {
    key?: string
    timestamp?: number
    metadata?: Record<string, unknown> | null
  } | null
  scoring_details?: {
    vector_score?: number
    keyword_score?: number
    vector_rank?: number
    keyword_rank?: number
    reranking_score?: number
    fusion_method?: string
  } | null
}

export type AiSearchSearchResponse = {
  search_query?: string
  chunks?: AiSearchChunk[]
  errors?: unknown[]
}

export type AiSearchItem = {
  id: string
  key: string
  status?: 'queued' | 'running' | 'completed' | 'error' | 'skipped' | 'outdated'
  chunks_count?: number
  file_size?: number
  source_id?: string
  metadata?: Record<string, unknown> | null
  created_at?: string
  last_seen_at?: string
}

type CloudflareEnvelope<T> = {
  success?: boolean
  errors?: Array<{ code?: number; message?: string }>
  messages?: unknown[]
  result?: T
  result_info?: { cursor?: string | null; count?: number; total_count?: number } | null
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class AiSearchClient {
  private readonly accountId: string
  private readonly apiToken: string
  private readonly instanceId: string
  private readonly namespace: string | null
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(config: AiSearchClientConfig) {
    this.accountId = config.accountId
    this.apiToken = config.apiToken
    this.instanceId = config.instanceId
    this.namespace = config.namespace?.trim() || null
    this.baseUrl = (config.baseUrl ?? CLOUDFLARE_API_BASE).replace(/\/+$/, '')
    this.timeoutMs = resolveTimeoutMs(config.timeoutMs, DEFAULT_TIMEOUT_MS)
  }

  /** `/accounts/{acct}/ai-search[/namespaces/{ns}]/instances/{id}` */
  private instancePath(suffix = ''): string {
    const root = this.namespace
      ? `/accounts/${this.accountId}/ai-search/namespaces/${encodeURIComponent(this.namespace)}/instances/${encodeURIComponent(this.instanceId)}`
      : `/accounts/${this.accountId}/ai-search/instances/${encodeURIComponent(this.instanceId)}`
    return `${root}${suffix}`
  }

  private async request<T>(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<{ result: T; resultInfo: CloudflareEnvelope<T>['result_info'] }> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.apiToken}`)
    // Content-Type is intentionally left to the caller: multipart uploads must
    // let fetch set the boundary itself.

    const response = await fetchWithTimeout(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      timeoutMs: init.timeoutMs ?? this.timeoutMs,
    })

    const raw = await response.text()
    if (!response.ok) throw new AiSearchApiError(path, response.status, raw)

    if (!raw) return { result: undefined as T, resultInfo: null }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new AiSearchApiError(path, response.status, `non-JSON response: ${raw.slice(0, 200)}`)
    }

    // Most endpoints wrap in the standard Cloudflare envelope, but the search
    // endpoint has been observed returning the payload directly. Accept both.
    const envelope = parsed as CloudflareEnvelope<T>
    if (envelope && typeof envelope === 'object' && 'result' in envelope) {
      if (envelope.success === false) {
        throw new AiSearchApiError(path, response.status, JSON.stringify(envelope.errors ?? []))
      }
      return { result: envelope.result as T, resultInfo: envelope.result_info ?? null }
    }
    return { result: parsed as T, resultInfo: null }
  }

  // -- Search ---------------------------------------------------------------

  async search(body: {
    query: string
    ai_search_options?: { retrieval?: AiSearchRetrievalOptions }
  }): Promise<AiSearchSearchResponse> {
    const { result } = await this.request<AiSearchSearchResponse>(this.instancePath('/search'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return result ?? {}
  }

  // -- Items ----------------------------------------------------------------

  /**
   * Upload (or overwrite) an item in built-in storage. Built-in storage items
   * are indexed immediately rather than on a sync schedule, but the call itself
   * returns as soon as the document is queued.
   *
   * UNVERIFIED: the Workers binding documents `options.metadata`, but the REST
   * multipart equivalent is not specified in the docs. We send a JSON `metadata`
   * part, which is the most likely encoding. If Cloudflare rejects it, the raw
   * error body surfaces through `AiSearchApiError` — that is the first thing
   * this spike is meant to find out.
   */
  async uploadItem(
    key: string,
    content: string,
    metadata?: Record<string, string>,
  ): Promise<AiSearchItem | undefined> {
    const form = new FormData()
    form.append('file', new File([content], key, { type: 'text/markdown' }))
    if (metadata && Object.keys(metadata).length > 0) {
      form.append('metadata', JSON.stringify(metadata))
    }

    const { result } = await this.request<AiSearchItem>(this.instancePath('/items'), {
      method: 'POST',
      body: form,
    })
    return result
  }

  /** Exact-key lookup. Keys are unique per source, hence the `source=builtin` scope. */
  async findItemByKey(key: string): Promise<AiSearchItem | null> {
    const query = new URLSearchParams({ key, source: 'builtin' })
    try {
      const { result } = await this.request<AiSearchItem[] | AiSearchItem | null>(
        this.instancePath(`/items?${query.toString()}`),
      )
      if (!result) return null
      return Array.isArray(result) ? (result[0] ?? null) : result
    } catch (error) {
      if (error instanceof AiSearchApiError && error.status === 404) return null
      throw error
    }
  }

  /** `perPage` is clamped to 50: Cloudflare rejects anything larger with 400 code 7001. */
  async listItems(params: { cursor?: string | null; perPage?: number } = {}): Promise<{
    items: AiSearchItem[]
    cursor: string | null
  }> {
    const query = new URLSearchParams({ source: 'builtin' })
    if (params.cursor) query.set('cursor', params.cursor)
    if (params.perPage) query.set('per_page', String(Math.min(params.perPage, 50)))

    const { result, resultInfo } = await this.request<AiSearchItem[] | null>(
      this.instancePath(`/items?${query.toString()}`),
    )
    return { items: result ?? [], cursor: resultInfo?.cursor ?? null }
  }

  async deleteItem(id: string): Promise<void> {
    try {
      await this.request<unknown>(this.instancePath(`/items/${encodeURIComponent(id)}`), {
        method: 'DELETE',
      })
    } catch (error) {
      if (error instanceof AiSearchApiError && error.status === 404) return
      throw error
    }
  }

  /** Cheap liveness probe. Never used on the search hot path — see the driver. */
  async ping(): Promise<boolean> {
    try {
      await this.request<unknown>(this.instancePath(`/items?${new URLSearchParams({ per_page: '1' })}`))
      return true
    } catch {
      return false
    }
  }
}
