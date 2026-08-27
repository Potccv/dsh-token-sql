/**
 * dsh-token-sql: persist DeepSeek Harness token usage into SQLite,
 * aggregated per turn.
 *
 * Only turns that actually reported provider usage produce a row.
 * The database hierarchy is:
 *
 *   workspace -> session_id -> turn
 *
 * For each turn, token usage from every step is summed into one row.
 * `assistant/chunk` provides an early per-step sample; `assistant/message`
 * is authoritative for the same step and replaces the chunk sample, so a
 * step is never double counted.
 *
 * The plugin also exposes:
 * - startup backfill of currently loaded sessions
 * - a host HTTP route `POST /dsh-token-sql/api/scan` to run a full scan of
 *   all persisted sessions (the Settings > Plugins button calls this)
 * - a host HTTP route `GET /api/usage` to read the SQLite usage data back
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { settingsNamespace, type SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { Session, SessionEvent, SessionHeader, SessionStore } from '@deepseek-ai/dsh-session'
// Type-only: merges the `session/title` SessionEventMap variant.
import type {} from '@deepseek-ai/dsh-session-title'
// Type-only: merges the `compaction/summary` and `web/deepseek-search-llm-request`
// SessionEventMap variants used by the extended usage accounting.
import type {} from '@deepseek-ai/dsh-compaction/types'
import type {} from '@deepseek-ai/dsh-web-search-deepseek'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { openTokenUsageStore, type ExtraUsageKind, type TokenUsageStore, type TurnQueryOptions, type UsageTotals } from './db.ts'

export const name = 'dsh-token-sql'
export const SETTINGS_NS = settingsNamespace('dsh-token-sql')

/** Host services this plugin consumes directly at apply time. */
export const inject = ['settings', 'webServer', 'sessions', 'sessionPersistence']

export interface Config {
  /** SQLite database file path. Empty string means the default DSH storages path. */
  path: string
  /** Whether to backfill already-live sessions when the plugin starts. */
  backfillOnStart: boolean
  /** Whether to expose the read-only web API mapping at `/api/usage`. */
  exposeWebApi: boolean
  /**
   * Whether to install a runtime fetch interceptor that parses DeepSeek web
   * search response usage. This avoids modifying DSH source, but monkey-patches
   * global fetch while enabled.
   */
  captureWebSearchUsage: boolean
}

export const Config = z.object({
  path: z.string().default(''),
  backfillOnStart: z.boolean().default(true),
  exposeWebApi: z.boolean().default(true),
  captureWebSearchUsage: z.boolean().default(false),
})

/** Minimal host context face this plugin consumes. */
export interface PluginContext extends Context {
  sessions: SessionStore
  sessionPersistence: SessionPersistence
  settings: SettingsProvider
  webServer: WebServer
}

/** A structural session face used for both live Session and persisted inspection. */
interface SessionLike {
  id: string
  header: SessionHeader
  events: readonly SessionEvent[]
}

/** One step's authoritative usage sample while a turn is being accumulated. */
interface StepUsage {
  usage: TokenUsage
  provider: string | null
  model: string | null
  time: number
}

/** Unified usage record returned by the default /api/usage view. */
interface UnifiedUsageRecord {
  kind: 'session' | ExtraUsageKind
  workspace: string
  sessionId: string
  turn: number | null
  provider: string | null
  model: string | null
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  requestCount: number
  eventTime: number
  sourceSeq: number | null
  sessionTitle: string | null
  sessionCreatedAt: number | null
  sessionUpdatedAt: number | null
  firstEventTime: number | null
  lastEventTime: number | null
}

/** Per-session metadata tracked while folding events. */
interface SessionMeta {
  title: string | null
  createdAt: number
  updatedAt: number
}

/** Per-session accumulator: turn -> step -> usage sample. */
type SessionTurnAccumulator = Map<number, Map<number, StepUsage>>

function defaultDatabasePath(): string {
  if (process.env.DSH_HOME) return `${process.env.DSH_HOME}/storages/token-usage.sqlite`
  if (process.env.HOME) return `${process.env.HOME}/.dsh/storages/token-usage.sqlite`
  // DSH itself resolves the home with Node's os.homedir() when HOME is unset;
  // mirror that so the plugin can start even in service/PM2 environments that
  // do not export HOME.
  return `${homedir()}/.dsh/storages/token-usage.sqlite`
}

function workspaceOf(session: SessionLike): string {
  const cwd = session.header.cwd
  return cwd === undefined || cwd === '' ? '_no-cwd' : basename(cwd)
}

function aggregateStepUsages(steps: Map<number, StepUsage>): {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  requestCount: number
  firstEventTime: number
  lastEventTime: number
  provider: string | null
  model: string | null
} {
  let uncachedInputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let reasoningTokens = 0
  let requestCount = 0
  let firstEventTime = 0
  let lastEventTime = 0
  let provider: string | null = null
  let model: string | null = null

  for (const sample of steps.values()) {
    uncachedInputTokens += sample.usage.inputTokens
    outputTokens += sample.usage.outputTokens
    cacheReadTokens += sample.usage.cacheReadTokens ?? 0
    cacheWriteTokens += sample.usage.cacheWriteTokens ?? 0
    reasoningTokens += sample.usage.reasoningTokens ?? 0
    requestCount += 1
    if (firstEventTime === 0 || sample.time < firstEventTime) firstEventTime = sample.time
    if (sample.time > lastEventTime) lastEventTime = sample.time
    if (sample.provider !== null) provider = sample.provider
    if (sample.model !== null) model = sample.model
  }

  return {
    uncachedInputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    requestCount,
    firstEventTime,
    lastEventTime,
    provider,
    model,
  }
}

/** Minimal loopback/CSRF fence for local dsh-token-sql routes.
 *  POST routes still require a JSON content type; GET read routes skip that
 *  requirement so they can be called from a browser or curl without a body. */
function tokenSqlFence(req: IncomingMessage, opts: { allowGet?: boolean } = {}): boolean {
  const host = req.headers.host
  if (host === undefined) return false
  try {
    const url = new URL(`http://${host}`)
    const hostname = url.hostname
    const loopback = hostname === 'localhost'
      || hostname === '[::1]'
      || hostname === '::1'
      || /^127(\.\d{1,3}){3}$/.test(hostname)
    if (!loopback) return false
  } catch {
    return false
  }
  const secFetchSite = req.headers['sec-fetch-site']
  if (secFetchSite !== undefined
    && secFetchSite !== 'same-origin'
    && secFetchSite !== 'same-site'
    && secFetchSite !== 'none') return false
  if (opts.allowGet === true && req.method === 'GET') return true
  const contentType = req.headers['content-type']
  if (contentType === undefined || !contentType.startsWith('application/json')) return false
  return true
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function writeOk(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

function writeError(res: ServerResponse, status: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, status, { ok: false, error: { code: 'error', message } })
}

type UsageQueryResult = { query: TurnQueryOptions } | { error: string }

const TIME_FIELD_KEYS: Record<string, { minKey: keyof TurnQueryOptions; maxKey: keyof TurnQueryOptions }> = {
  last_event_time: { minKey: 'lastEventTimeMin', maxKey: 'lastEventTimeMax' },
  lastEventTime: { minKey: 'lastEventTimeMin', maxKey: 'lastEventTimeMax' },
  first_event_time: { minKey: 'firstEventTimeMin', maxKey: 'firstEventTimeMax' },
  firstEventTime: { minKey: 'firstEventTimeMin', maxKey: 'firstEventTimeMax' },
  session_created_at: { minKey: 'sessionCreatedAtMin', maxKey: 'sessionCreatedAtMax' },
  sessionCreatedAt: { minKey: 'sessionCreatedAtMin', maxKey: 'sessionCreatedAtMax' },
  session_updated_at: { minKey: 'sessionUpdatedAtMin', maxKey: 'sessionUpdatedAtMax' },
  sessionUpdatedAt: { minKey: 'sessionUpdatedAtMin', maxKey: 'sessionUpdatedAtMax' },
  created_at: { minKey: 'createdAtMin', maxKey: 'createdAtMax' },
  createdAt: { minKey: 'createdAtMin', maxKey: 'createdAtMax' },
  updated_at: { minKey: 'updatedAtMin', maxKey: 'updatedAtMax' },
  updatedAt: { minKey: 'updatedAtMin', maxKey: 'updatedAtMax' },
}

const DURATION_RE = /^(\d+)([smhdw])$/

function parseDurationToMs(value: string): number | undefined {
  const match = DURATION_RE.exec(value.trim())
  if (!match) return undefined
  const amount = Number(match[1])
  const unit = match[2]
  const multiplier = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit]
  if (multiplier === undefined) return undefined
  return amount * multiplier
}

function parseAbsoluteTime(value: string): number | undefined {
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** Resolve `since` / `until` values to epoch milliseconds. */
function resolveTimeParam(value: string, kind: 'since' | 'until'): number | undefined {
  if (value.trim() === 'now') return Date.now()
  const absolute = parseAbsoluteTime(value)
  if (absolute !== undefined) return absolute
  if (kind === 'since') {
    const duration = parseDurationToMs(value)
    if (duration !== undefined) return Date.now() - duration
  }
  return undefined
}

/** Parse /api/usage query parameters into typed SQL filters. */
function parseUsageQuery(url: URL): UsageQueryResult {
  const query: TurnQueryOptions = {}

  const readString = (name: string): string | undefined => {
    const value = url.searchParams.get(name)
    return value === null || value === '' ? undefined : value
  }
  const readInt = (name: string): number | undefined => {
    const value = url.searchParams.get(name)
    if (value === null || value === '') return undefined
    const parsed = Number(value)
    if (!Number.isInteger(parsed)) throw new Error(`invalid "${name}": expected an integer`)
    return parsed
  }
  const readNonNegativeInt = (name: string): number | undefined => {
    const value = readInt(name)
    if (value !== undefined && value < 0) throw new Error(`invalid "${name}": expected a non-negative integer`)
    return value
  }
  const readStringFrom = (names: string[]): string | undefined => {
    for (const name of names) {
      const value = readString(name)
      if (value !== undefined) return value
    }
    return undefined
  }
  const readIntFrom = (names: string[]): number | undefined => {
    for (const name of names) {
      const value = url.searchParams.get(name)
      if (value !== null && value !== '') return readInt(name)
    }
    return undefined
  }

  try {
    const stringFields: { key: keyof TurnQueryOptions; names: string[] }[] = [
      { key: 'workspace', names: ['workspace'] },
      { key: 'sessionId', names: ['sessionId', 'session_id'] },
      { key: 'sessionTitle', names: ['sessionTitle', 'session_title'] },
      { key: 'provider', names: ['provider'] },
      { key: 'model', names: ['model'] },
    ]
    for (const field of stringFields) {
      const value = readStringFrom(field.names)
      if (value !== undefined) query[field.key] = value as never
    }

    const intFields: { key: keyof TurnQueryOptions; names: string[] }[] = [
      { key: 'id', names: ['id'] },
      { key: 'turn', names: ['turn'] },
      { key: 'sessionCreatedAt', names: ['sessionCreatedAt', 'session_created_at'] },
      { key: 'sessionUpdatedAt', names: ['sessionUpdatedAt', 'session_updated_at'] },
      { key: 'uncachedInputTokens', names: ['uncachedInputTokens', 'uncached_input_tokens'] },
      { key: 'outputTokens', names: ['outputTokens', 'output_tokens'] },
      { key: 'cacheReadTokens', names: ['cacheReadTokens', 'cache_read_tokens'] },
      { key: 'cacheWriteTokens', names: ['cacheWriteTokens', 'cache_write_tokens'] },
      { key: 'reasoningTokens', names: ['reasoningTokens', 'reasoning_tokens'] },
      { key: 'requestCount', names: ['requestCount', 'request_count'] },
      { key: 'firstEventTime', names: ['firstEventTime', 'first_event_time'] },
      { key: 'lastEventTime', names: ['lastEventTime', 'last_event_time'] },
      { key: 'createdAt', names: ['createdAt', 'created_at'] },
      { key: 'updatedAt', names: ['updatedAt', 'updated_at'] },
    ]
    for (const field of intFields) {
      const value = readIntFrom(field.names)
      if (value !== undefined) query[field.key] = value as never
    }

    const rangeFields: { minKey: keyof TurnQueryOptions; maxKey: keyof TurnQueryOptions; minNames: string[]; maxNames: string[] }[] = [
      { minKey: 'idMin', maxKey: 'idMax', minNames: ['idMin', 'id_min'], maxNames: ['idMax', 'id_max'] },
      { minKey: 'turnMin', maxKey: 'turnMax', minNames: ['turnMin', 'turn_min'], maxNames: ['turnMax', 'turn_max'] },
      { minKey: 'sessionCreatedAtMin', maxKey: 'sessionCreatedAtMax', minNames: ['sessionCreatedAtMin', 'session_created_at_min'], maxNames: ['sessionCreatedAtMax', 'session_created_at_max'] },
      { minKey: 'sessionUpdatedAtMin', maxKey: 'sessionUpdatedAtMax', minNames: ['sessionUpdatedAtMin', 'session_updated_at_min'], maxNames: ['sessionUpdatedAtMax', 'session_updated_at_max'] },
      { minKey: 'uncachedInputTokensMin', maxKey: 'uncachedInputTokensMax', minNames: ['uncachedInputTokensMin', 'uncached_input_tokens_min'], maxNames: ['uncachedInputTokensMax', 'uncached_input_tokens_max'] },
      { minKey: 'outputTokensMin', maxKey: 'outputTokensMax', minNames: ['outputTokensMin', 'output_tokens_min'], maxNames: ['outputTokensMax', 'output_tokens_max'] },
      { minKey: 'cacheReadTokensMin', maxKey: 'cacheReadTokensMax', minNames: ['cacheReadTokensMin', 'cache_read_tokens_min'], maxNames: ['cacheReadTokensMax', 'cache_read_tokens_max'] },
      { minKey: 'cacheWriteTokensMin', maxKey: 'cacheWriteTokensMax', minNames: ['cacheWriteTokensMin', 'cache_write_tokens_min'], maxNames: ['cacheWriteTokensMax', 'cache_write_tokens_max'] },
      { minKey: 'reasoningTokensMin', maxKey: 'reasoningTokensMax', minNames: ['reasoningTokensMin', 'reasoning_tokens_min'], maxNames: ['reasoningTokensMax', 'reasoning_tokens_max'] },
      { minKey: 'requestCountMin', maxKey: 'requestCountMax', minNames: ['requestCountMin', 'request_count_min'], maxNames: ['requestCountMax', 'request_count_max'] },
      { minKey: 'firstEventTimeMin', maxKey: 'firstEventTimeMax', minNames: ['firstEventTimeMin', 'first_event_time_min'], maxNames: ['firstEventTimeMax', 'first_event_time_max'] },
      { minKey: 'lastEventTimeMin', maxKey: 'lastEventTimeMax', minNames: ['lastEventTimeMin', 'last_event_time_min'], maxNames: ['lastEventTimeMax', 'last_event_time_max'] },
      { minKey: 'createdAtMin', maxKey: 'createdAtMax', minNames: ['createdAtMin', 'created_at_min'], maxNames: ['createdAtMax', 'created_at_max'] },
      { minKey: 'updatedAtMin', maxKey: 'updatedAtMax', minNames: ['updatedAtMin', 'updated_at_min'], maxNames: ['updatedAtMax', 'updated_at_max'] },
    ]
    for (const field of rangeFields) {
      const min = readIntFrom(field.minNames)
      const max = readIntFrom(field.maxNames)
      if (min !== undefined) query[field.minKey] = min as never
      if (max !== undefined) query[field.maxKey] = max as never
    }

    // Convenience time-range filters: since / until (or from / to).
    const sinceRaw = url.searchParams.get('since') ?? url.searchParams.get('from')
    const untilRaw = url.searchParams.get('until') ?? url.searchParams.get('to')
    const timeFieldRaw = url.searchParams.get('time_field') ?? url.searchParams.get('timeField')
    if (sinceRaw !== null || untilRaw !== null) {
      const timeField = timeFieldRaw ?? 'last_event_time'
      const keys = TIME_FIELD_KEYS[timeField]
      if (!keys) {
        throw new Error('invalid "time_field": expected last_event_time, first_event_time, session_created_at, session_updated_at, created_at, or updated_at')
      }
      if (sinceRaw !== null) {
        const since = resolveTimeParam(sinceRaw, 'since')
        if (since === undefined) {
          throw new Error('invalid "since": expected epoch ms, ISO date, "now", or relative like "7d"')
        }
        query[keys.minKey] = since as never
      }
      if (untilRaw !== null) {
        const until = resolveTimeParam(untilRaw, 'until')
        if (until === undefined) {
          throw new Error('invalid "until": expected epoch ms, ISO date, or "now"')
        }
        query[keys.maxKey] = until as never
      }
    }

    query.limit = readNonNegativeInt('limit')
    query.offset = readNonNegativeInt('offset')

    return { query }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function totalsFromRecords(records: UnifiedUsageRecord[]): UsageTotals {
  const totals: UsageTotals = {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    requestCount: 0,
    turnCount: 0,
    sessionCount: 0,
    workspaceCount: 0,
  }
  const sessions = new Set<string>()
  const workspaces = new Set<string>()
  for (const record of records) {
    totals.uncachedInputTokens += record.uncachedInputTokens
    totals.outputTokens += record.outputTokens
    totals.cacheReadTokens += record.cacheReadTokens
    totals.cacheWriteTokens += record.cacheWriteTokens
    totals.reasoningTokens += record.reasoningTokens
    totals.requestCount += record.requestCount
    if (record.kind === 'session') totals.turnCount += 1
    sessions.add(record.sessionId)
    workspaces.add(record.workspace)
  }
  totals.sessionCount = sessions.size
  totals.workspaceCount = workspaces.size
  return totals
}

interface UsageGroup {
  key: Record<string, string | number | null>
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  requestCount: number
  recordCount: number
  sessionCount: number
}

function groupsFromRecords(records: UnifiedUsageRecord[], groupBy: string): UsageGroup[] {
  const buckets = new Map<string, { group: UsageGroup; sessions: Set<string> }>()
  for (const record of records) {
    let key: Record<string, string | number | null>
    switch (groupBy) {
      case 'model':
        key = { provider: record.provider, model: record.model }
        break
      case 'session':
        key = { workspace: record.workspace, sessionId: record.sessionId }
        break
      case 'day':
        key = { day: new Date(record.eventTime).toISOString().slice(0, 10) }
        break
      case 'kind':
        key = { kind: record.kind }
        break
      case 'workspace':
        key = { workspace: record.workspace }
        break
      default:
        throw new Error(`invalid "group_by": expected model, session, day, kind, or workspace`)
    }
    const id = JSON.stringify(key)
    let bucket = buckets.get(id)
    if (bucket === undefined) {
      bucket = {
        group: {
          key,
          uncachedInputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          requestCount: 0,
          recordCount: 0,
          sessionCount: 0,
        },
        sessions: new Set(),
      }
      buckets.set(id, bucket)
    }
    const group = bucket.group
    group.uncachedInputTokens += record.uncachedInputTokens
    group.outputTokens += record.outputTokens
    group.cacheReadTokens += record.cacheReadTokens
    group.cacheWriteTokens += record.cacheWriteTokens
    group.reasoningTokens += record.reasoningTokens
    group.requestCount += record.requestCount
    group.recordCount += 1
    bucket.sessions.add(record.sessionId)
  }
  for (const bucket of buckets.values()) {
    bucket.group.sessionCount = bucket.sessions.size
  }
  return [...buckets.values()].map(bucket => bucket.group)
}

export function apply(ctx: PluginContext, config: Config): void {
  const configuredPath = config.path.trim()
  let dbPath: string
  if (configuredPath) {
    dbPath = configuredPath
  } else {
    dbPath = defaultDatabasePath()
  }
  const store: TokenUsageStore = openTokenUsageStore(dbPath)

  // Register the settings namespace so Settings > Plugins shows this plugin's card.
  const settings = ctx.settings.register(SETTINGS_NS, Config, { base: config })

  // Latest provider/model per session; used to enrich assistant/chunk usage.
  const routeBySession = new Map<SessionLike, { provider?: string; model?: string }>()
  // Per-session turn accumulator.
  const turnsBySession = new Map<SessionLike, SessionTurnAccumulator>()
  // Per-session metadata (title, created/updated timestamps).
  const metaBySession = new Map<SessionLike, SessionMeta>()
  // Pending DeepSeek web-search requests awaiting their fetch response, keyed by
  // exact request body. Used only when captureWebSearchUsage is enabled.
  const pendingWebSearches = new Map<string, Array<{
    session: SessionLike
    sourceSeq: number
    model: string
  }>>()

  const metaOf = (session: SessionLike): SessionMeta => {
    let meta = metaBySession.get(session)
    if (meta === undefined) {
      meta = {
        title: null,
        createdAt: session.header.createdAt ?? 0,
        updatedAt: 0,
      }
      metaBySession.set(session, meta)
    }
    return meta
  }

  const accumulatorOf = (session: SessionLike): SessionTurnAccumulator => {
    let turns = turnsBySession.get(session)
    if (turns === undefined) {
      turns = new Map()
      turnsBySession.set(session, turns)
    }
    return turns
  }

  const flushTurn = (session: SessionLike, turn: number): boolean => {
    const turns = turnsBySession.get(session)
    if (turns === undefined) return false
    const steps = turns.get(turn)
    if (steps === undefined || steps.size === 0) return false

    const aggregated = aggregateStepUsages(steps)
    const meta = metaOf(session)
    store.upsertTurn({
      workspace: workspaceOf(session),
      sessionId: session.id,
      turn,
      sessionTitle: meta.title,
      sessionCreatedAt: meta.createdAt,
      sessionUpdatedAt: meta.updatedAt,
      provider: aggregated.provider,
      model: aggregated.model,
      uncachedInputTokens: aggregated.uncachedInputTokens,
      outputTokens: aggregated.outputTokens,
      cacheReadTokens: aggregated.cacheReadTokens,
      cacheWriteTokens: aggregated.cacheWriteTokens,
      reasoningTokens: aggregated.reasoningTokens,
      requestCount: aggregated.requestCount,
      firstEventTime: aggregated.firstEventTime,
      lastEventTime: aggregated.lastEventTime,
    })

    turns.delete(turn)
    return true
  }

  /** Write all currently-open turns without deleting the accumulator. */
  const persistOpenTurns = (session: SessionLike): number => {
    const turns = turnsBySession.get(session)
    if (turns === undefined) return 0
    let count = 0
    for (const turn of [...turns.keys()]) {
      const steps = turns.get(turn)
      if (steps === undefined || steps.size === 0) continue
      const aggregated = aggregateStepUsages(steps)
      const meta = metaOf(session)
      store.upsertTurn({
        workspace: workspaceOf(session),
        sessionId: session.id,
        turn,
        sessionTitle: meta.title,
        sessionCreatedAt: meta.createdAt,
        sessionUpdatedAt: meta.updatedAt,
        provider: aggregated.provider,
        model: aggregated.model,
        uncachedInputTokens: aggregated.uncachedInputTokens,
        outputTokens: aggregated.outputTokens,
        cacheReadTokens: aggregated.cacheReadTokens,
        cacheWriteTokens: aggregated.cacheWriteTokens,
        reasoningTokens: aggregated.reasoningTokens,
        requestCount: aggregated.requestCount,
        firstEventTime: aggregated.firstEventTime,
        lastEventTime: aggregated.lastEventTime,
      })
      count += 1
    }
    return count
  }

  const flushSession = (session: SessionLike): void => {
    const turns = turnsBySession.get(session)
    if (turns === undefined) return
    for (const turn of [...turns.keys()]) flushTurn(session, turn)
    turnsBySession.delete(session)
  }

  const processEvent = (
    session: SessionLike,
    event: SessionEvent,
    stats?: { writtenTurns: number },
  ): void => {
    let route = routeBySession.get(session)
    if (route === undefined) {
      route = {}
      routeBySession.set(session, route)
    }

    const meta = metaOf(session)
    if (event.time > meta.updatedAt) meta.updatedAt = event.time
    if (event.type === 'session/title') {
      meta.title = event.data.title
    }

    if (event.type === 'request/context') {
      route.provider = event.data.provider
      route.model = event.data.model
      return
    }

    if (event.type === 'request/header') {
      const { provider, model } = event.data.header.config
      route.provider = provider
      route.model = model
      return
    }

    if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
      const turns = accumulatorOf(session)
      let steps = turns.get(event.data.turn)
      if (steps === undefined) {
        steps = new Map()
        turns.set(event.data.turn, steps)
      }
      steps.set(event.data.step, {
        usage: event.data.chunk.usage,
        provider: route.provider ?? null,
        model: route.model ?? null,
        time: event.time,
      })
      return
    }

    if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      const source = event.data.message.source
      const provider = source?.kind === 'model' ? source.provider : route.provider
      const model = source?.kind === 'model' ? source.model : route.model
      const turns = accumulatorOf(session)
      let steps = turns.get(event.data.turn)
      if (steps === undefined) {
        steps = new Map()
        turns.set(event.data.turn, steps)
      }
      // assistant/message is authoritative for the step: it replaces the
      // earlier assistant/chunk sample for the same (turn, step).
      steps.set(event.data.step, {
        usage: event.data.usage,
        provider: provider ?? null,
        model: model ?? null,
        time: event.time,
      })
      return
    }

    if (event.type === 'step/end') {
      const turns = accumulatorOf(session)
      let steps = turns.get(event.data.turn)
      if (steps === undefined) {
        steps = new Map()
        turns.set(event.data.turn, steps)
      }
      // A step that never reported usage is still a real model request.
      // Count it as one request with zero known tokens; a later
      // assistant/message usage (if any) will replace this zero sample.
      if (!steps.has(event.data.step)) {
        steps.set(event.data.step, {
          usage: { inputTokens: 0, outputTokens: 0 },
          provider: route.provider ?? null,
          model: route.model ?? null,
          time: event.time,
        })
      }
      return
    }

    if (event.type === 'compaction/summary') {
      const usage = event.data.usage
      store.upsertExtra({
        workspace: workspaceOf(session),
        sessionId: session.id,
        kind: 'compaction',
        turn: null,
        provider: event.data.provider,
        model: event.data.model,
        uncachedInputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheReadTokens: usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
        reasoningTokens: usage?.reasoningTokens ?? 0,
        requestCount: 1,
        eventTime: event.time,
        sourceSeq: event.seq,
      })
      return
    }

    if (event.type === 'web/deepseek-search-llm-request') {
      store.upsertExtra({
        workspace: workspaceOf(session),
        sessionId: session.id,
        kind: 'web-search',
        turn: null,
        provider: 'deepseek-official',
        model: event.data.body.model,
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        requestCount: 1,
        eventTime: event.time,
        sourceSeq: event.seq,
      })
      if (settings.get().captureWebSearchUsage) {
        const key = JSON.stringify(event.data.body)
        const queue = pendingWebSearches.get(key) ?? []
        queue.push({
          session,
          sourceSeq: event.seq,
          model: event.data.body.model,
        })
        pendingWebSearches.set(key, queue)
      }
      return
    }

    if (event.type === 'turn/end') {
      if (flushTurn(session, event.data.turn) && stats !== undefined) {
        stats.writtenTurns += 1
      }
    }
  }

  const processSession = (session: SessionLike, stats?: { writtenTurns: number }): void => {
    for (const event of session.events) processEvent(session, event, stats)
  }

  const scanAllSessions = async (): Promise<{ scanned: number; writtenTurns: number }> => {
    const headers = await ctx.sessionPersistence.list()
    let scanned = 0
    let writtenTurns = 0

    for (const header of headers) {
      const inspection = await ctx.sessionPersistence.inspect(header.id)
      const sessionLike: SessionLike = {
        id: header.id,
        header: inspection.meta,
        events: inspection.events,
      }
      const stats = { writtenTurns: 0 }
      processSession(sessionLike, stats)
      writtenTurns += stats.writtenTurns
      writtenTurns += persistOpenTurns(sessionLike)
      scanned += 1
      // The inspected object is ephemeral; do not keep it in memory.
      turnsBySession.delete(sessionLike)
      routeBySession.delete(sessionLike)
      metaBySession.delete(sessionLike)
    }

    return { scanned, writtenTurns }
  }

  if (config.backfillOnStart) {
    for (const session of ctx.sessions.list()) {
      processSession(session)
      // Persist any currently-open turns so live usage is visible even
      // before the turn ends or the session is disposed.
      persistOpenTurns(session)
    }
  }

  ctx.on('session/created', (session) => {
    processSession(session)
    persistOpenTurns(session)
  })

  ctx.on('session/event', (session, event) => {
    processEvent(session, event)
    // Keep in-progress turns visible in /api/usage after each completed step.
    if (event.type === 'step/end') persistOpenTurns(session)
  })

  ctx.on('session/disposed', (session) => {
    flushSession(session)
    routeBySession.delete(session)
    metaBySession.delete(session)
  })

  // Session-title generation goes through ctx.llm.stream() but does not
  // persist its usage into the session log; capture it at the LLM seam so the
  // auxiliary title request is still counted.
  ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
    if (options.purpose !== 'session-title' || options.sessionId === undefined) return next()
    const session = ctx.sessions.get(options.sessionId)
    if (session === undefined) return next()

    let usage: TokenUsage | undefined
    const stream = next()
    return (async function* () {
      try {
        for await (const chunk of stream) {
          if (chunk.type === 'usage') usage = chunk.usage
          yield chunk
        }
      } finally {
        store.upsertExtra({
          workspace: workspaceOf(session),
          sessionId: session.id,
          kind: 'session-title',
          turn: null,
          provider: options.provider,
          model: options.model,
          uncachedInputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          cacheReadTokens: usage?.cacheReadTokens ?? 0,
          cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
          reasoningTokens: usage?.reasoningTokens ?? 0,
          requestCount: 1,
          eventTime: Date.now(),
          sourceSeq: null,
        })
      }
    })()
  })

  // Optional runtime capture of DeepSeek web-search response usage. This is a
  // fetch interceptor rather than a DSH source patch: it lets the plugin parse
  // Anthropic usage from the search provider's HTTP response without changing
  // the web-search-deepseek package.
  ctx.effect(() => {
    let originalFetch: typeof globalThis.fetch | undefined
    let wrappedFetch: typeof globalThis.fetch | undefined
    let installed = false

    const uninstall = (): void => {
      if (installed && originalFetch && globalThis.fetch === wrappedFetch) {
        globalThis.fetch = originalFetch
      }
      installed = false
      originalFetch = undefined
      wrappedFetch = undefined
      pendingWebSearches.clear()
    }

    const install = (): void => {
      if (installed) return
      originalFetch = globalThis.fetch
      if (originalFetch === undefined) return
      wrappedFetch = async (input, init) => {
        const url = typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        const method = (init?.method
          ?? (typeof input !== 'string' && 'method' in input ? input.method : 'GET')
        )?.toUpperCase()
        let matched: { session: SessionLike; sourceSeq: number; model: string } | undefined
        if (method === 'POST' && url.includes('/messages')) {
          const bodyText = typeof init?.body === 'string' ? init.body : undefined
          if (bodyText) {
            const queue = pendingWebSearches.get(bodyText)
            matched = queue?.shift()
            if (queue !== undefined && queue.length === 0) pendingWebSearches.delete(bodyText)
          }
        }
        try {
          const response = await originalFetch!(input, init)
          if (matched) {
            const clone = response.clone()
            try {
              const data = await clone.json() as { usage?: {
                input_tokens?: number
                output_tokens?: number
                cache_read_input_tokens?: number
                cache_creation_input_tokens?: number
              } }
              const usage = data.usage
              if (usage) {
                const cacheRead = usage.cache_read_input_tokens ?? 0
                const cacheWrite = usage.cache_creation_input_tokens ?? 0
                const inputTokens = Math.max(0, (usage.input_tokens ?? 0) - cacheRead - cacheWrite)
                store.upsertExtra({
                  workspace: workspaceOf(matched.session),
                  sessionId: matched.session.id,
                  kind: 'web-search',
                  turn: null,
                  provider: 'deepseek-official',
                  model: matched.model,
                  uncachedInputTokens: inputTokens,
                  outputTokens: usage.output_tokens ?? 0,
                  cacheReadTokens: cacheRead,
                  cacheWriteTokens: cacheWrite,
                  reasoningTokens: 0,
                  requestCount: 1,
                  eventTime: Date.now(),
                  sourceSeq: matched.sourceSeq,
                })
              }
            } catch {
              // Response parsing failure is non-fatal; keep the zero-token row.
            }
          }
          return response
        } catch (error) {
          throw error
        }
      }
      globalThis.fetch = wrappedFetch
      installed = true
    }

    const mount = (): void => {
      uninstall()
      if (settings.get().captureWebSearchUsage) install()
    }

    mount()
    const disposeWatcher = settings.watch(() => mount())
    return () => {
      disposeWatcher()
      uninstall()
    }
  }, 'dsh-token-sql: web search usage capture')

  // POST /dsh-token-sql/api/scan — full scan of every persisted session.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-token-sql/api',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!tokenSqlFence(req)) {
        writeError(res, 403, 'forbidden')
        return
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method not allowed')
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      if (pathname !== '/dsh-token-sql/api/scan') {
        writeError(res, 404, 'not found')
        return
      }
      try {
        writeOk(res, await scanAllSessions())
      } catch (error) {
        writeError(res, 500, error)
      }
    },
  }), 'dsh-token-sql: /api routes')

  // GET /api/usage — read the SQLite turn_token_usage data back as JSON.
  // Registered on the harness web server itself, so it is reachable at
  // http://127.0.0.1:3080/api/usage when the host is running on port 3080.
  // Controlled by the `exposeWebApi` setting (Settings > Plugins switch), so
  // the route is mounted/unmounted reactively when the setting changes.
  ctx.effect(() => {
    let disposeUsageRoute: (() => void) | undefined

    const mountUsageRoute = (): void => {
      disposeUsageRoute?.()
      disposeUsageRoute = undefined
      if (!settings.get().exposeWebApi) return
      disposeUsageRoute = ctx.webServer.register({
        kind: 'exact',
        path: '/api/usage',
        handler: (req: IncomingMessage, res: ServerResponse) => {
          if (!tokenSqlFence(req, { allowGet: true })) {
            writeError(res, 403, 'forbidden')
            return
          }
          if (req.method !== 'GET') {
            writeError(res, 405, 'method not allowed')
            return
          }
          try {
            const url = new URL(req.url ?? '/', 'http://dsh.internal')
            const raw = url.searchParams.get('raw') === '1'
              || url.searchParams.get('raw') === 'true'
            const legacy = url.searchParams.get('legacy') === '1'
              || url.searchParams.get('legacy') === 'true'
            const includeExtra = url.searchParams.get('include_extra') === '1'
              || url.searchParams.get('include_extra') === 'true'
              || url.searchParams.get('includeExtra') === '1'
              || url.searchParams.get('includeExtra') === 'true'
            const kind = url.searchParams.get('kind') ?? undefined
            const groupBy = url.searchParams.get('group_by') ?? url.searchParams.get('groupBy') ?? undefined
            if (groupBy !== undefined
              && groupBy !== 'model' && groupBy !== 'session'
              && groupBy !== 'day' && groupBy !== 'kind' && groupBy !== 'workspace') {
              writeError(res, 400, `invalid "group_by": expected model, session, day, kind, or workspace`)
              return
            }

            const parsed = parseUsageQuery(url)
            if ('error' in parsed) {
              writeError(res, 400, parsed.error)
              return
            }
            const { query } = parsed
            const { limit, offset, ...baseQuery } = query

            const rows = store.listTurns(baseQuery)
            const extraRows = store.listExtra(baseQuery)
            const mainTotals = store.getTotals(baseQuery)
            const extraTotals = store.getExtraTotals(baseQuery)
            const mergedTotals = {
              uncachedInputTokens: mainTotals.uncachedInputTokens + extraTotals.uncachedInputTokens,
              outputTokens: mainTotals.outputTokens + extraTotals.outputTokens,
              cacheReadTokens: mainTotals.cacheReadTokens + extraTotals.cacheReadTokens,
              cacheWriteTokens: mainTotals.cacheWriteTokens + extraTotals.cacheWriteTokens,
              reasoningTokens: mainTotals.reasoningTokens + extraTotals.reasoningTokens,
              requestCount: mainTotals.requestCount + extraTotals.requestCount,
              turnCount: mainTotals.turnCount,
              sessionCount: mainTotals.sessionCount + extraTotals.sessionCount,
              workspaceCount: mainTotals.workspaceCount + extraTotals.workspaceCount,
            }

            if (legacy) {
              if (raw) {
                if (includeExtra) {
                  writeJson(res, 200, { rows, extraRows })
                } else {
                  writeJson(res, 200, rows)
                }
                return
              }
              writeOk(res, {
                rows,
                ...(includeExtra ? { extraRows } : {}),
                totals: mergedTotals,
              })
              return
            }

            const records: UnifiedUsageRecord[] = [
              ...rows.map((row): UnifiedUsageRecord => ({
                kind: 'session',
                workspace: row.workspace,
                sessionId: row.sessionId,
                turn: row.turn,
                provider: row.provider,
                model: row.model,
                uncachedInputTokens: row.uncachedInputTokens,
                outputTokens: row.outputTokens,
                cacheReadTokens: row.cacheReadTokens,
                cacheWriteTokens: row.cacheWriteTokens,
                reasoningTokens: row.reasoningTokens,
                requestCount: row.requestCount,
                eventTime: row.lastEventTime,
                sourceSeq: null,
                sessionTitle: row.sessionTitle,
                sessionCreatedAt: row.sessionCreatedAt,
                sessionUpdatedAt: row.sessionUpdatedAt,
                firstEventTime: row.firstEventTime,
                lastEventTime: row.lastEventTime,
              })),
              ...extraRows.map((row): UnifiedUsageRecord => ({
                kind: row.kind,
                workspace: row.workspace,
                sessionId: row.sessionId,
                turn: row.turn,
                provider: row.provider,
                model: row.model,
                uncachedInputTokens: row.uncachedInputTokens,
                outputTokens: row.outputTokens,
                cacheReadTokens: row.cacheReadTokens,
                cacheWriteTokens: row.cacheWriteTokens,
                reasoningTokens: row.reasoningTokens,
                requestCount: row.requestCount,
                eventTime: row.eventTime,
                sourceSeq: row.sourceSeq,
                sessionTitle: null,
                sessionCreatedAt: null,
                sessionUpdatedAt: null,
                firstEventTime: null,
                lastEventTime: null,
              })),
            ]

            const filtered = kind === undefined
              ? records
              : records.filter(record => record.kind === kind)
            filtered.sort((a, b) => a.eventTime - b.eventTime || a.sessionId.localeCompare(b.sessionId))

            const totals = totalsFromRecords(filtered)
            const start = offset ?? 0
            const paged = limit === undefined
              ? filtered.slice(start)
              : filtered.slice(start, start + limit)

            if (groupBy !== undefined) {
              const groups = groupsFromRecords(filtered, groupBy)
              if (raw) {
                writeJson(res, 200, groups)
              } else {
                writeOk(res, { groups, totals })
              }
              return
            }

            if (raw) {
              writeJson(res, 200, paged)
              return
            }
            writeOk(res, { records: paged, totals })
          } catch (error) {
            writeError(res, 500, error)
          }
        },
      })
    }

    mountUsageRoute()
    const disposeWatcher = settings.watch(() => mountUsageRoute())
    return () => {
      disposeWatcher()
      disposeUsageRoute?.()
      disposeUsageRoute = undefined
    }
  }, 'dsh-token-sql: /api/usage route')

  ctx.effect(() => () => {
    // Flush any still-open turns before the database handle closes.
    for (const session of [...turnsBySession.keys()]) flushSession(session)
    metaBySession.clear()
    store.close()
  }, 'dsh-token-sql: close sqlite store')
}
