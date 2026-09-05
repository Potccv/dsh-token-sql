/**
 * dsh-token-sql: persist individual DeepSeek Harness token-usage requests
 * into SQLite.
 *
 * Main conversation requests are identified by session + turn + step.
 * Compaction and web-search requests are identified by their persisted
 * session event seq. Session-title calls are live-only independent rows.
 *
 * The plugin also exposes:
 * - startup backfill of currently loaded sessions
 * - a host HTTP route `POST /dsh-token-sql/api/scan` to run a full scan of
 *   all persisted sessions (the Settings > Plugins button calls this)
 * - a host HTTP route `GET /api/usage` to read the SQLite usage data back
 * - a host HTTP route `GET /api/usage/schema` to describe that data source
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { Session, SessionEvent, SessionHeader, SessionStore } from '@deepseek-ai/dsh-session'
// Type-only: merges the `session/title` SessionEventMap variant.
import type {} from '@deepseek-ai/dsh-session-title'
// Type-only: merges the `compaction/summary` and `web/deepseek-search-llm-request`
// SessionEventMap variants used by the extended usage accounting.
import type {} from '@deepseek-ai/dsh-compaction/types'
import type {} from '@deepseek-ai/dsh-web-search-deepseek'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  openTokenUsageStore,
  TOKEN_USAGE_SCHEMA_VERSION,
  type TokenUsageRow,
  type TokenUsageStore,
  type UsageQueryOptions,
  type UsageTotals,
} from './db.ts'

export const name = 'dsh-token-sql'
export const SETTINGS_NS = 'dsh-token-sql'

const USAGE_HTTP_SCHEMA = {
  schemaVersion: TOKEN_USAGE_SCHEMA_VERSION,
  source: 'DeepSeek Harness token usage',
  table: 'token_usage',
  timeUnit: 'Unix milliseconds',
  primaryKey: {
    columns: ['id'],
    autoincrement: true,
  },
  businessUniqueKeys: [
    {
      columns: ['session_id', 'turn', 'step'],
      appliesWhen: "kind = 'session'",
    },
    {
      columns: ['session_id', 'kind', 'source_seq'],
      appliesWhen: "kind IN ('compaction', 'web-search')",
    },
  ],
  defaultOrder: [
    { column: 'event_time', direction: 'ASC' },
    { column: 'id', direction: 'ASC' },
  ],
  enums: {
    kind: ['session', 'compaction', 'session-title', 'web-search'],
    usage_status: ['pending', 'captured', 'missing', 'failed'],
  },
  columns: [
    { name: 'id', jsonName: 'id', sqliteType: 'INTEGER', nullable: false, description: '自增主键和入库顺序' },
    { name: 'workspace', jsonName: 'workspace', sqliteType: 'TEXT', nullable: false, description: '会话 cwd 的目录名' },
    { name: 'session_id', jsonName: 'sessionId', sqliteType: 'TEXT', nullable: false, description: 'DSH 会话 ID' },
    { name: 'session_title', jsonName: 'sessionTitle', sqliteType: 'TEXT', nullable: true, description: '会话最新标题' },
    { name: 'kind', jsonName: 'kind', sqliteType: 'TEXT', nullable: false, description: '请求类型' },
    { name: 'turn', jsonName: 'turn', sqliteType: 'INTEGER', nullable: true, description: '主对话轮次；额外请求为空' },
    { name: 'step', jsonName: 'step', sqliteType: 'INTEGER', nullable: true, description: 'turn 内的模型请求序号；额外请求为空' },
    { name: 'source_seq', jsonName: 'sourceSeq', sqliteType: 'INTEGER', nullable: true, description: '对应的 DSH session 事件序号' },
    { name: 'provider', jsonName: 'provider', sqliteType: 'TEXT', nullable: true, description: '模型供应商' },
    { name: 'model', jsonName: 'model', sqliteType: 'TEXT', nullable: true, description: '模型名称' },
    { name: 'usage_status', jsonName: 'usageStatus', sqliteType: 'TEXT', nullable: false, description: 'Token usage 获取状态' },
    { name: 'uncached_input_tokens', jsonName: 'uncachedInputTokens', sqliteType: 'INTEGER', nullable: true, description: '未缓存输入 Token' },
    { name: 'cache_read_tokens', jsonName: 'cacheReadTokens', sqliteType: 'INTEGER', nullable: true, description: '缓存读取 Token' },
    { name: 'cache_write_tokens', jsonName: 'cacheWriteTokens', sqliteType: 'INTEGER', nullable: true, description: '缓存写入 Token' },
    { name: 'output_tokens', jsonName: 'outputTokens', sqliteType: 'INTEGER', nullable: true, description: '输出 Token' },
    { name: 'reasoning_tokens', jsonName: 'reasoningTokens', sqliteType: 'INTEGER', nullable: true, description: '输出中的推理 Token' },
    { name: 'session_created_at', jsonName: 'sessionCreatedAt', sqliteType: 'INTEGER', nullable: false, description: '会话创建时间' },
    { name: 'session_updated_at', jsonName: 'sessionUpdatedAt', sqliteType: 'INTEGER', nullable: false, description: '会话最后活动时间' },
    { name: 'event_time', jsonName: 'eventTime', sqliteType: 'INTEGER', nullable: false, description: '请求对应的 DSH 事件时间' },
    { name: 'usage_captured_at', jsonName: 'usageCapturedAt', sqliteType: 'INTEGER', nullable: true, description: '实际取得 usage 的时间' },
    { name: 'created_at', jsonName: 'createdAt', sqliteType: 'INTEGER', nullable: false, description: '记录首次入库时间' },
    { name: 'updated_at', jsonName: 'updatedAt', sqliteType: 'INTEGER', nullable: false, description: '记录最后更新时间' },
  ],
} as const

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
  events?: readonly SessionEvent[]
  snapshotEvents?: () => readonly SessionEvent[]
}

/** Per-session metadata tracked while folding events. */
interface SessionMeta {
  title: string | null
  createdAt: number
  updatedAt: number
}

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

/** Locate each complete frame in the JSONL backend's concatenated Zstandard file. */
function zstdFrameRanges(buffer: Buffer): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 5 || buffer.readUInt32LE(offset) !== 0xFD2FB528) {
      throw new Error(`invalid Zstandard session frame at byte ${offset}`)
    }
    offset += 4
    const descriptor = buffer.readUInt8(offset++)
    if ((descriptor & 0x18) !== 0) throw new Error(`invalid Zstandard frame header at byte ${offset - 1}`)

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) throw new Error(`incomplete Zstandard frame at byte ${start}`)
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) throw new Error(`incomplete Zstandard frame at byte ${start}`)
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`invalid Zstandard block at byte ${offset - 3}`)
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) throw new Error(`incomplete Zstandard frame at byte ${start}`)
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) throw new Error(`incomplete Zstandard checksum at byte ${start}`)
      offset += 4
    }
    ranges.push({ start, end: offset })
  }
  return ranges
}

/**
 * Token accounting can safely read otherwise-refused v0 events because it only
 * consumes stable request/usage fields and does not replay session behavior.
 */
async function readRefusedV0Events(error: unknown): Promise<readonly SessionEvent[] | undefined> {
  if (typeof error !== 'object' || error === null) return undefined
  const refusal = error as {
    name?: unknown
    message?: unknown
    location?: { kind?: unknown; path?: unknown }
  }
  const message = typeof refusal.message === 'string' ? refusal.message : ''
  if (!message.includes('source v0 artifact remains unchanged')) return undefined
  const path = refusal.location?.kind === 'jsonl' && typeof refusal.location.path === 'string'
    ? refusal.location.path
    : /\(raw log: (.+)\)$/.exec(message)?.[1]
  if (path === undefined) return undefined
  const source = await readFile(path)
  const plaintext = path.endsWith('.zstd')
    ? Buffer.concat(zstdFrameRanges(source).map(({ start, end }) => zstdDecompressSync(source.subarray(start, end))))
    : source
  const records = plaintext.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown)
  const header = records.shift()
  if (typeof header !== 'object' || header === null
    || (header as { type?: unknown }).type !== 'session'
    || (header as { version?: unknown }).version !== 0) return undefined

  const tokenEventTypes = new Set([
    'session/title',
    'request/context',
    'request/header',
    'assistant/message',
    'step/end',
    'compaction/summary',
    'web/deepseek-search-llm-request',
    'turn/end',
  ])
  const events: SessionEvent[] = []
  for (const record of records) {
    if (typeof record !== 'object' || record === null) throw new Error(`invalid v0 event in ${path}`)
    const value = record as { type?: unknown; seq?: unknown; time?: unknown }
    if (typeof value.type !== 'string') throw new Error(`invalid v0 event in ${path}`)
    if (!tokenEventTypes.has(value.type)) continue
    if (!Number.isInteger(value.seq) || !Number.isInteger(value.time)) {
      throw new Error(`invalid v0 event in ${path}`)
    }
    events.push(record as SessionEvent)
  }
  return events
}

/** Whether one trustedHosts entry matches a request's Host authority.
 *  A port-less entry matches the hostname on any port; an entry with a port
 *  must match exactly (mirrors the Harness /api browser-trust fence). */
function trustedAuthorityMatches(hostUrl: URL, entry: string): boolean {
  try {
    const entryUrl = new URL(`http://${entry}`)
    return entryUrl.port === ''
      ? hostUrl.hostname === entryUrl.hostname
      : hostUrl.host === entryUrl.host
  } catch {
    return false
  }
}

/** Minimal loopback/trusted-host + CSRF fence for dsh-token-sql routes.
 *  The loopback-only behavior is extended with the Harness web runtime's
 *  trustedHosts so `/api/usage` and the scan route work when the GUI is
 *  reached through a trusted host / reverse proxy.
 *  POST routes still require a JSON content type; GET read routes skip that
 *  requirement so they can be called from a browser or curl without a body. */
function tokenSqlFence(req: IncomingMessage, opts: {
  allowGet?: boolean
  trustedHosts?: readonly string[]
} = {}): boolean {
  const host = req.headers.host
  if (host === undefined) return false
  try {
    const url = new URL(`http://${host}`)
    const hostname = url.hostname
    const loopback = hostname === 'localhost'
      || hostname === '[::1]'
      || hostname === '::1'
      || /^127(\.\d{1,3}){3}$/.test(hostname)
    const trusted = (opts.trustedHosts ?? []).some(entry => trustedAuthorityMatches(url, entry))
    if (!loopback && !trusted) return false
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

type UsageQueryResult = { query: UsageQueryOptions } | { error: string }

const TIME_FIELD_KEYS: Record<string, { minKey: keyof UsageQueryOptions; maxKey: keyof UsageQueryOptions }> = {
  event_time: { minKey: 'eventTimeMin', maxKey: 'eventTimeMax' },
  eventTime: { minKey: 'eventTimeMin', maxKey: 'eventTimeMax' },
  // Backward-compatible aliases from the previous turn-level API.
  last_event_time: { minKey: 'eventTimeMin', maxKey: 'eventTimeMax' },
  lastEventTime: { minKey: 'eventTimeMin', maxKey: 'eventTimeMax' },
  first_event_time: { minKey: 'eventTimeMin', maxKey: 'eventTimeMax' },
  firstEventTime: { minKey: 'eventTimeMin', maxKey: 'eventTimeMax' },
  session_created_at: { minKey: 'sessionCreatedAtMin', maxKey: 'sessionCreatedAtMax' },
  sessionCreatedAt: { minKey: 'sessionCreatedAtMin', maxKey: 'sessionCreatedAtMax' },
  session_updated_at: { minKey: 'sessionUpdatedAtMin', maxKey: 'sessionUpdatedAtMax' },
  sessionUpdatedAt: { minKey: 'sessionUpdatedAtMin', maxKey: 'sessionUpdatedAtMax' },
  usage_captured_at: { minKey: 'usageCapturedAtMin', maxKey: 'usageCapturedAtMax' },
  usageCapturedAt: { minKey: 'usageCapturedAtMin', maxKey: 'usageCapturedAtMax' },
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
  const query: UsageQueryOptions = {}

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
    const stringFields: { key: keyof UsageQueryOptions; names: string[] }[] = [
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

    const kind = readString('kind')
    if (kind !== undefined) {
      if (kind !== 'session' && kind !== 'compaction' && kind !== 'session-title' && kind !== 'web-search') {
        throw new Error('invalid "kind": expected session, compaction, session-title, or web-search')
      }
      query.kind = kind
    }
    const usageStatus = readStringFrom(['usageStatus', 'usage_status'])
    if (usageStatus !== undefined) {
      if (usageStatus !== 'pending' && usageStatus !== 'captured'
        && usageStatus !== 'missing' && usageStatus !== 'failed') {
        throw new Error('invalid "usage_status": expected pending, captured, missing, or failed')
      }
      query.usageStatus = usageStatus
    }

    const intFields: { key: keyof UsageQueryOptions; names: string[] }[] = [
      { key: 'id', names: ['id'] },
      { key: 'turn', names: ['turn'] },
      { key: 'step', names: ['step'] },
      { key: 'sourceSeq', names: ['sourceSeq', 'source_seq'] },
      { key: 'uncachedInputTokens', names: ['uncachedInputTokens', 'uncached_input_tokens'] },
      { key: 'outputTokens', names: ['outputTokens', 'output_tokens'] },
      { key: 'cacheReadTokens', names: ['cacheReadTokens', 'cache_read_tokens'] },
      { key: 'cacheWriteTokens', names: ['cacheWriteTokens', 'cache_write_tokens'] },
      { key: 'reasoningTokens', names: ['reasoningTokens', 'reasoning_tokens'] },
      { key: 'sessionCreatedAt', names: ['sessionCreatedAt', 'session_created_at'] },
      { key: 'sessionUpdatedAt', names: ['sessionUpdatedAt', 'session_updated_at'] },
      { key: 'eventTime', names: ['eventTime', 'event_time', 'firstEventTime', 'first_event_time', 'lastEventTime', 'last_event_time'] },
      { key: 'usageCapturedAt', names: ['usageCapturedAt', 'usage_captured_at'] },
      { key: 'createdAt', names: ['createdAt', 'created_at'] },
      { key: 'updatedAt', names: ['updatedAt', 'updated_at'] },
    ]
    for (const field of intFields) {
      const value = readIntFrom(field.names)
      if (value !== undefined) query[field.key] = value as never
    }

    const rangeFields: { minKey: keyof UsageQueryOptions; maxKey: keyof UsageQueryOptions; minNames: string[]; maxNames: string[] }[] = [
      { minKey: 'idMin', maxKey: 'idMax', minNames: ['idMin', 'id_min'], maxNames: ['idMax', 'id_max'] },
      { minKey: 'turnMin', maxKey: 'turnMax', minNames: ['turnMin', 'turn_min'], maxNames: ['turnMax', 'turn_max'] },
      { minKey: 'stepMin', maxKey: 'stepMax', minNames: ['stepMin', 'step_min'], maxNames: ['stepMax', 'step_max'] },
      { minKey: 'sourceSeqMin', maxKey: 'sourceSeqMax', minNames: ['sourceSeqMin', 'source_seq_min'], maxNames: ['sourceSeqMax', 'source_seq_max'] },
      { minKey: 'uncachedInputTokensMin', maxKey: 'uncachedInputTokensMax', minNames: ['uncachedInputTokensMin', 'uncached_input_tokens_min'], maxNames: ['uncachedInputTokensMax', 'uncached_input_tokens_max'] },
      { minKey: 'outputTokensMin', maxKey: 'outputTokensMax', minNames: ['outputTokensMin', 'output_tokens_min'], maxNames: ['outputTokensMax', 'output_tokens_max'] },
      { minKey: 'cacheReadTokensMin', maxKey: 'cacheReadTokensMax', minNames: ['cacheReadTokensMin', 'cache_read_tokens_min'], maxNames: ['cacheReadTokensMax', 'cache_read_tokens_max'] },
      { minKey: 'cacheWriteTokensMin', maxKey: 'cacheWriteTokensMax', minNames: ['cacheWriteTokensMin', 'cache_write_tokens_min'], maxNames: ['cacheWriteTokensMax', 'cache_write_tokens_max'] },
      { minKey: 'reasoningTokensMin', maxKey: 'reasoningTokensMax', minNames: ['reasoningTokensMin', 'reasoning_tokens_min'], maxNames: ['reasoningTokensMax', 'reasoning_tokens_max'] },
      { minKey: 'sessionCreatedAtMin', maxKey: 'sessionCreatedAtMax', minNames: ['sessionCreatedAtMin', 'session_created_at_min'], maxNames: ['sessionCreatedAtMax', 'session_created_at_max'] },
      { minKey: 'sessionUpdatedAtMin', maxKey: 'sessionUpdatedAtMax', minNames: ['sessionUpdatedAtMin', 'session_updated_at_min'], maxNames: ['sessionUpdatedAtMax', 'session_updated_at_max'] },
      { minKey: 'eventTimeMin', maxKey: 'eventTimeMax', minNames: ['eventTimeMin', 'event_time_min', 'firstEventTimeMin', 'first_event_time_min', 'lastEventTimeMin', 'last_event_time_min'], maxNames: ['eventTimeMax', 'event_time_max', 'firstEventTimeMax', 'first_event_time_max', 'lastEventTimeMax', 'last_event_time_max'] },
      { minKey: 'usageCapturedAtMin', maxKey: 'usageCapturedAtMax', minNames: ['usageCapturedAtMin', 'usage_captured_at_min'], maxNames: ['usageCapturedAtMax', 'usage_captured_at_max'] },
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
      const timeField = timeFieldRaw ?? 'event_time'
      const keys = TIME_FIELD_KEYS[timeField]
      if (!keys) {
        throw new Error('invalid "time_field": expected event_time, usage_captured_at, session_created_at, session_updated_at, created_at, or updated_at')
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

function totalsFromRecords(records: TokenUsageRow[]): UsageTotals {
  const totals: UsageTotals = {
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    requestCount: 0,
    turnCount: 0,
    sessionCount: 0,
    workspaceCount: 0,
  }
  const sessions = new Set<string>()
  const workspaces = new Set<string>()
  const turns = new Set<string>()
  for (const record of records) {
    totals.uncachedInputTokens += record.uncachedInputTokens ?? 0
    totals.outputTokens += record.outputTokens ?? 0
    totals.cacheReadTokens += record.cacheReadTokens ?? 0
    totals.cacheWriteTokens += record.cacheWriteTokens ?? 0
    totals.reasoningTokens += record.reasoningTokens ?? 0
    totals.requestCount += 1
    if (record.kind === 'session' && record.turn !== null) {
      turns.add(`${record.sessionId}\u0000${record.turn}`)
    }
    sessions.add(record.sessionId)
    workspaces.add(record.workspace)
  }
  totals.turnCount = turns.size
  totals.sessionCount = sessions.size
  totals.workspaceCount = workspaces.size
  return totals
}

interface UsageGroup {
  key: Record<string, string | number | null>
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  requestCount: number
  sessionCount: number
}

function groupsFromRecords(records: TokenUsageRow[], groupBy: string): UsageGroup[] {
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
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          requestCount: 0,
          sessionCount: 0,
        },
        sessions: new Set(),
      }
      buckets.set(id, bucket)
    }
    const group = bucket.group
    group.uncachedInputTokens += record.uncachedInputTokens ?? 0
    group.outputTokens += record.outputTokens ?? 0
    group.cacheReadTokens += record.cacheReadTokens ?? 0
    group.cacheWriteTokens += record.cacheWriteTokens ?? 0
    group.reasoningTokens += record.reasoningTokens ?? 0
    group.requestCount += 1
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

  // Harness web runtime exposes the authorities accepted by the /api browser
  // trust fence. Reuse them so this plugin's routes work behind the same
  // trusted-host/reverse-proxy deployments while staying loopback-only in
  // plain local profiles where webRuntime is absent.
  const webTrustedHosts = (): readonly string[] =>
    (ctx.get('webRuntime') as { trustedHosts?: readonly string[] } | undefined)?.trustedHosts ?? []

  // Latest provider/model per session; used when the final message does not
  // carry an explicit model source.
  const routeBySession = new Map<SessionLike, { provider?: string; model?: string }>()
  // Steps already seen while folding one live or persisted session.
  const stepsBySession = new Map<SessionLike, Map<number, Set<number>>>()
  // Per-session metadata (title, created/updated timestamps).
  const metaBySession = new Map<SessionLike, SessionMeta>()
  // Pending DeepSeek web-search requests awaiting their fetch response, keyed by
  // exact request body. Used only when captureWebSearchUsage is enabled.
  const pendingWebSearches = new Map<string, Array<{
    session: SessionLike
    sourceSeq: number
    model: string
    eventTime: number
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

  const sessionFieldsOf = (session: SessionLike): Pick<TokenUsageRow,
    'workspace' | 'sessionId' | 'sessionTitle' | 'sessionCreatedAt' | 'sessionUpdatedAt'> => {
    const meta = metaOf(session)
    return {
      workspace: workspaceOf(session),
      sessionId: session.id,
      sessionTitle: meta.title,
      sessionCreatedAt: meta.createdAt,
      sessionUpdatedAt: meta.updatedAt,
    }
  }

  const markStep = (session: SessionLike, turn: number, step: number): boolean => {
    let turns = stepsBySession.get(session)
    if (turns === undefined) {
      turns = new Map()
      stepsBySession.set(session, turns)
    }
    let steps = turns.get(turn)
    if (steps === undefined) {
      steps = new Set()
      turns.set(turn, steps)
    }
    const isNew = !steps.has(step)
    steps.add(step)
    return isNew
  }

  interface ProcessStats {
    writtenRequests: number
    removedStaleRequests: number
  }
  interface SequencedKeys {
    compactionSourceSeqs: Set<number>
    webSearchSourceSeqs: Set<number>
  }
  interface ProcessOptions {
    replay?: boolean
    stats?: ProcessStats
    sequencedKeys?: SequencedKeys
  }

  const processEvent = (
    session: SessionLike,
    event: SessionEvent,
    options: ProcessOptions = {},
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
      store.updateSessionMetadata(sessionFieldsOf(session))
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

    if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      const source = event.data.message.source
      const provider = source?.kind === 'model' ? source.provider : route.provider
      const model = source?.kind === 'model' ? source.model : route.model
      const isNew = markStep(session, event.data.turn, event.data.step)
      store.upsert({
        ...sessionFieldsOf(session),
        kind: 'session',
        turn: event.data.turn,
        step: event.data.step,
        sourceSeq: event.seq,
        provider: provider ?? null,
        model: model ?? null,
        usageStatus: 'captured',
        uncachedInputTokens: event.data.usage.inputTokens,
        cacheReadTokens: event.data.usage.cacheReadTokens ?? 0,
        cacheWriteTokens: event.data.usage.cacheWriteTokens ?? 0,
        outputTokens: event.data.usage.outputTokens,
        reasoningTokens: event.data.usage.reasoningTokens ?? 0,
        eventTime: event.time,
        usageCapturedAt: event.time,
      })
      if (isNew && options.stats !== undefined) options.stats.writtenRequests += 1
      return
    }

    if (event.type === 'step/end') {
      // A step without usage is a known request with unknown token counts.
      if (markStep(session, event.data.turn, event.data.step)) {
        store.upsert({
          ...sessionFieldsOf(session),
          kind: 'session',
          turn: event.data.turn,
          step: event.data.step,
          sourceSeq: event.seq,
          provider: route.provider ?? null,
          model: route.model ?? null,
          usageStatus: 'missing',
          uncachedInputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          outputTokens: null,
          reasoningTokens: null,
          eventTime: event.time,
          usageCapturedAt: null,
        })
        if (options.stats !== undefined) options.stats.writtenRequests += 1
      }
      return
    }

    if (event.type === 'compaction/summary') {
      options.sequencedKeys?.compactionSourceSeqs.add(event.seq)
      const usage = event.data.usage
      store.upsert({
        ...sessionFieldsOf(session),
        kind: 'compaction',
        turn: null,
        step: null,
        sourceSeq: event.seq,
        provider: event.data.provider,
        model: event.data.model,
        usageStatus: usage === undefined ? 'missing' : 'captured',
        uncachedInputTokens: usage?.inputTokens ?? null,
        cacheReadTokens: usage === undefined ? null : usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage === undefined ? null : usage.cacheWriteTokens ?? 0,
        outputTokens: usage?.outputTokens ?? null,
        reasoningTokens: usage === undefined ? null : usage.reasoningTokens ?? 0,
        eventTime: event.time,
        usageCapturedAt: usage === undefined ? null : event.time,
      })
      if (options.stats !== undefined) options.stats.writtenRequests += 1
      return
    }

    if (event.type === 'web/deepseek-search-llm-request') {
      options.sequencedKeys?.webSearchSourceSeqs.add(event.seq)
      const awaitingCapture = options.replay !== true && settings.get().captureWebSearchUsage
      store.upsert({
        ...sessionFieldsOf(session),
        kind: 'web-search',
        turn: null,
        step: null,
        sourceSeq: event.seq,
        provider: 'deepseek-official',
        model: event.data.body.model,
        usageStatus: awaitingCapture ? 'pending' : 'missing',
        uncachedInputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        eventTime: event.time,
        usageCapturedAt: null,
      })
      if (options.stats !== undefined) options.stats.writtenRequests += 1
      if (awaitingCapture) {
        const key = JSON.stringify(event.data.body)
        const queue = pendingWebSearches.get(key) ?? []
        queue.push({
          session,
          sourceSeq: event.seq,
          model: event.data.body.model,
          eventTime: event.time,
        })
        pendingWebSearches.set(key, queue)
      }
      return
    }

    if (event.type === 'turn/end') {
      store.updateSessionMetadata(sessionFieldsOf(session))
      stepsBySession.get(session)?.delete(event.data.turn)
    }
  }

  const processSession = (
    session: SessionLike,
    stats?: ProcessStats,
    reconcile = false,
    scanStartedAt = Date.now(),
    allowLegacyCapturedTimeMatch = false,
  ): void => {
    const events = session.events ?? session.snapshotEvents?.() ?? []
    const sequencedKeys: SequencedKeys = {
      compactionSourceSeqs: new Set(),
      webSearchSourceSeqs: new Set(),
    }
    for (const event of events) processEvent(session, event, { replay: true, stats, sequencedKeys })
    store.updateSessionMetadata(sessionFieldsOf(session))
    if (reconcile) {
      const removed = store.reconcileSequencedRequests(
        session.id,
        sequencedKeys,
        scanStartedAt,
        allowLegacyCapturedTimeMatch,
      )
      if (stats !== undefined) stats.removedStaleRequests += removed
    }
  }

  const scanAllSessions = async (): Promise<{
    scanned: number
    writtenRequests: number
    removedStaleRequests: number
    recoveredV0Sessions: number
  }> => {
    const allowLegacyCapturedTimeMatch = store.needsFullRescan
    const headers = await ctx.sessionPersistence.list()
    let scanned = 0
    let writtenRequests = 0
    let removedStaleRequests = 0
    let recoveredV0Sessions = 0

    for (const snapshot of headers) {
      let handle: SessionHandle | undefined
      let ephemeral = false
      try {
        const liveSession = ctx.sessions.list().find(session => session.id === snapshot.header.id)
        let sessionLike: SessionLike
        const scanStartedAt = Date.now()
        if (liveSession !== undefined) {
          sessionLike = liveSession
        } else {
          let events: readonly SessionEvent[]
          try {
            handle = await ctx.sessionPersistence.open(snapshot.header.id, 'read')
            events = await handle.read()
          } catch (error) {
            const recovered = await readRefusedV0Events(error)
            if (recovered === undefined) throw error
            events = recovered
            recoveredV0Sessions += 1
            ctx.logger.warn(`dsh-token-sql: token-only fallback read for refused v0 session ${snapshot.header.id}`)
          }
          sessionLike = {
            id: handle?.id ?? snapshot.header.id,
            header: handle?.header ?? snapshot.header,
            events,
          }
          ephemeral = true
        }
        const stats = { writtenRequests: 0, removedStaleRequests: 0 }
        store.transaction(() => processSession(
          sessionLike,
          stats,
          true,
          scanStartedAt,
          allowLegacyCapturedTimeMatch,
        ))
        writtenRequests += stats.writtenRequests
        removedStaleRequests += stats.removedStaleRequests
        scanned += 1
        if (ephemeral) {
          stepsBySession.delete(sessionLike)
          routeBySession.delete(sessionLike)
          metaBySession.delete(sessionLike)
        }
      } finally {
        await handle?.close()
      }
    }

    store.completeFullRescan()
    return { scanned, writtenRequests, removedStaleRequests, recoveredV0Sessions }
  }

  if (config.backfillOnStart) {
    for (const session of ctx.sessions.list()) {
      store.transaction(() => processSession(session))
    }
  }

  if (store.needsFullRescan) {
    void scanAllSessions().then(({ scanned, writtenRequests, removedStaleRequests, recoveredV0Sessions }) => {
      ctx.logger.info(`dsh-token-sql: migrated ${scanned} sessions and ${writtenRequests} requests; removed ${removedStaleRequests} stale requests (${recoveredV0Sessions} refused v0 sessions read with token-only fallback)`)
    }).catch(error => ctx.logger.error(error))
  }

  ctx.on('session/created', (session) => {
    processSession(session)
  })

  ctx.on('session/event', (session, event) => {
    processEvent(session, event)
  })

  ctx.on('session/disposed', (session) => {
    store.updateSessionMetadata(sessionFieldsOf(session))
    stepsBySession.delete(session)
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
    let failed = false
    const stream = next()
    return (async function* () {
      try {
        for await (const chunk of stream) {
          if (chunk.type === 'usage') usage = chunk.usage
          yield chunk
        }
      } catch (error) {
        failed = true
        throw error
      } finally {
        const eventTime = Date.now()
        store.insert({
          ...sessionFieldsOf(session),
          kind: 'session-title',
          turn: null,
          step: null,
          sourceSeq: null,
          provider: options.provider,
          model: options.model,
          usageStatus: usage !== undefined ? 'captured' : failed ? 'failed' : 'missing',
          uncachedInputTokens: usage?.inputTokens ?? null,
          cacheReadTokens: usage === undefined ? null : usage.cacheReadTokens ?? 0,
          cacheWriteTokens: usage === undefined ? null : usage.cacheWriteTokens ?? 0,
          outputTokens: usage?.outputTokens ?? null,
          reasoningTokens: usage === undefined ? null : usage.reasoningTokens ?? 0,
          eventTime,
          usageCapturedAt: usage === undefined ? null : eventTime,
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
        let matched: { session: SessionLike; sourceSeq: number; model: string; eventTime: number } | undefined
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
            let captured = false
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
                store.upsert({
                  ...sessionFieldsOf(matched.session),
                  kind: 'web-search',
                  turn: null,
                  step: null,
                  sourceSeq: matched.sourceSeq,
                  provider: 'deepseek-official',
                  model: matched.model,
                  usageStatus: 'captured',
                  uncachedInputTokens: inputTokens,
                  cacheReadTokens: cacheRead,
                  cacheWriteTokens: cacheWrite,
                  outputTokens: usage.output_tokens ?? 0,
                  reasoningTokens: 0,
                  eventTime: matched.eventTime,
                  usageCapturedAt: Date.now(),
                })
                captured = true
              }
            } catch {
              // Response parsing failure is non-fatal; record missing usage.
            }
            if (!captured) {
              store.upsert({
                ...sessionFieldsOf(matched.session),
                kind: 'web-search',
                turn: null,
                step: null,
                sourceSeq: matched.sourceSeq,
                provider: 'deepseek-official',
                model: matched.model,
                usageStatus: 'missing',
                uncachedInputTokens: null,
                cacheReadTokens: null,
                cacheWriteTokens: null,
                outputTokens: null,
                reasoningTokens: null,
                eventTime: matched.eventTime,
                usageCapturedAt: null,
              })
            }
          }
          return response
        } catch (error) {
          if (matched) {
            store.upsert({
              ...sessionFieldsOf(matched.session),
              kind: 'web-search',
              turn: null,
              step: null,
              sourceSeq: matched.sourceSeq,
              provider: 'deepseek-official',
              model: matched.model,
              usageStatus: 'failed',
              uncachedInputTokens: null,
              cacheReadTokens: null,
              cacheWriteTokens: null,
              outputTokens: null,
              reasoningTokens: null,
              eventTime: matched.eventTime,
              usageCapturedAt: null,
            })
          }
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
      if (!tokenSqlFence(req, { trustedHosts: webTrustedHosts() })) {
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

  // GET /api/usage — read the unified token_usage table back as JSON.
  // Registered on the harness web server itself, so it is reachable at
  // http://127.0.0.1:3080/api/usage when the host is running on port 3080.
  // Controlled by the `exposeWebApi` setting (Settings > Plugins switch), so
  // the route is mounted/unmounted reactively when the setting changes.
  ctx.effect(() => {
    let disposeUsageRoute: (() => void) | undefined
    let disposeSchemaRoute: (() => void) | undefined

    const mountUsageRoute = (): void => {
      disposeUsageRoute?.()
      disposeSchemaRoute?.()
      disposeUsageRoute = undefined
      disposeSchemaRoute = undefined
      if (!settings.get().exposeWebApi) return
      disposeSchemaRoute = ctx.webServer.register({
        kind: 'exact',
        path: '/api/usage/schema',
        handler: (req: IncomingMessage, res: ServerResponse) => {
          if (!tokenSqlFence(req, { allowGet: true, trustedHosts: webTrustedHosts() })) {
            writeError(res, 403, 'forbidden')
            return
          }
          if (req.method !== 'GET') {
            writeError(res, 405, 'method not allowed')
            return
          }
          writeOk(res, USAGE_HTTP_SCHEMA)
        },
      })
      disposeUsageRoute = ctx.webServer.register({
        kind: 'exact',
        path: '/api/usage',
        handler: (req: IncomingMessage, res: ServerResponse) => {
          if (!tokenSqlFence(req, { allowGet: true, trustedHosts: webTrustedHosts() })) {
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
            const records = store.list(baseQuery)
            const totals = totalsFromRecords(records)
            const start = offset ?? 0
            const paged = limit === undefined
              ? records.slice(start)
              : records.slice(start, start + limit)

            if (groupBy !== undefined) {
              const groups = groupsFromRecords(records, groupBy)
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
      disposeSchemaRoute?.()
      disposeUsageRoute = undefined
      disposeSchemaRoute = undefined
    }
  }, 'dsh-token-sql: usage HTTP routes')

  ctx.effect(() => () => {
    stepsBySession.clear()
    routeBySession.clear()
    metaBySession.clear()
    store.close()
  }, 'dsh-token-sql: close sqlite store')
}
