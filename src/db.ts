/**
 * SQLite storage for per-turn DeepSeek Harness token usage.
 *
 * Each row is one workspace + session + turn, containing the aggregated
 * token usage of all steps in that turn, plus session-level metadata
 * (title, creation time, last activity time).
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface TurnTokenUsageRow {
  workspace: string
  sessionId: string
  turn: number
  sessionTitle: string | null
  sessionCreatedAt: number
  sessionUpdatedAt: number
  provider: string | null
  model: string | null
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  requestCount: number
  firstEventTime: number
  lastEventTime: number
}

export type ExtraUsageKind = 'compaction' | 'session-title' | 'web-search'

export interface ExtraUsageRow {
  workspace: string
  sessionId: string
  kind: ExtraUsageKind
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
  /** Session event seq for replayable events; null for live llm/stream captures. */
  sourceSeq: number | null
}

export interface UsageTotals {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  requestCount: number
  turnCount: number
  sessionCount: number
  workspaceCount: number
}

export interface TurnQueryOptions {
  id?: number
  workspace?: string
  sessionId?: string
  turn?: number
  sessionTitle?: string
  sessionCreatedAt?: number
  sessionUpdatedAt?: number
  provider?: string
  model?: string
  uncachedInputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  requestCount?: number
  firstEventTime?: number
  lastEventTime?: number
  createdAt?: number
  updatedAt?: number

  // Numeric range helpers (min inclusive / max inclusive).
  idMin?: number
  idMax?: number
  turnMin?: number
  turnMax?: number
  sessionCreatedAtMin?: number
  sessionCreatedAtMax?: number
  sessionUpdatedAtMin?: number
  sessionUpdatedAtMax?: number
  uncachedInputTokensMin?: number
  uncachedInputTokensMax?: number
  outputTokensMin?: number
  outputTokensMax?: number
  cacheReadTokensMin?: number
  cacheReadTokensMax?: number
  cacheWriteTokensMin?: number
  cacheWriteTokensMax?: number
  reasoningTokensMin?: number
  reasoningTokensMax?: number
  requestCountMin?: number
  requestCountMax?: number
  firstEventTimeMin?: number
  firstEventTimeMax?: number
  lastEventTimeMin?: number
  lastEventTimeMax?: number
  createdAtMin?: number
  createdAtMax?: number
  updatedAtMin?: number
  updatedAtMax?: number

  limit?: number
  offset?: number
}

export interface TokenUsageStore {
  upsertTurn(row: TurnTokenUsageRow): void
  listTurns(options?: TurnQueryOptions): TurnTokenUsageRow[]
  getTotals(options?: TurnQueryOptions): UsageTotals
  upsertExtra(row: ExtraUsageRow): void
  listExtra(options?: TurnQueryOptions): ExtraUsageRow[]
  getExtraTotals(options?: TurnQueryOptions): UsageTotals
  close(): void
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS turn_token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace TEXT NOT NULL,
    session_id TEXT NOT NULL,
    turn INTEGER NOT NULL,
    session_title TEXT,
    session_created_at INTEGER NOT NULL,
    session_updated_at INTEGER NOT NULL,
    provider TEXT,
    model TEXT,
    uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    request_count INTEGER NOT NULL DEFAULT 0,
    first_event_time INTEGER NOT NULL,
    last_event_time INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(workspace, session_id, turn)
  );

  CREATE INDEX IF NOT EXISTS idx_turn_usage_workspace
    ON turn_token_usage(workspace);

  CREATE INDEX IF NOT EXISTS idx_turn_usage_session
    ON turn_token_usage(workspace, session_id);

  CREATE INDEX IF NOT EXISTS idx_turn_usage_turn
    ON turn_token_usage(workspace, session_id, turn);

  CREATE TABLE IF NOT EXISTS extra_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace TEXT NOT NULL,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    turn INTEGER,
    provider TEXT,
    model TEXT,
    uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    request_count INTEGER NOT NULL DEFAULT 1,
    event_time INTEGER NOT NULL,
    source_seq INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(workspace, session_id, kind, source_seq)
  );

  CREATE INDEX IF NOT EXISTS idx_extra_usage_session
    ON extra_usage(workspace, session_id);

  CREATE INDEX IF NOT EXISTS idx_extra_usage_time
    ON extra_usage(event_time);
`

const UPSERT = `
  INSERT INTO turn_token_usage (
    workspace, session_id, turn, session_title, session_created_at,
    session_updated_at, provider, model,
    uncached_input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    reasoning_tokens, request_count, first_event_time, last_event_time,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(workspace, session_id, turn) DO UPDATE SET
    session_title = excluded.session_title,
    session_created_at = excluded.session_created_at,
    session_updated_at = excluded.session_updated_at,
    provider = excluded.provider,
    model = excluded.model,
    uncached_input_tokens = excluded.uncached_input_tokens,
    output_tokens = excluded.output_tokens,
    cache_read_tokens = excluded.cache_read_tokens,
    cache_write_tokens = excluded.cache_write_tokens,
    reasoning_tokens = excluded.reasoning_tokens,
    request_count = excluded.request_count,
    first_event_time = excluded.first_event_time,
    last_event_time = excluded.last_event_time,
    updated_at = excluded.updated_at
`

const UPSERT_EXTRA = `
  INSERT INTO extra_usage (
    workspace, session_id, kind, turn, provider, model,
    uncached_input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    reasoning_tokens, request_count, event_time, source_seq,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(workspace, session_id, kind, source_seq) DO UPDATE SET
    turn = excluded.turn,
    provider = excluded.provider,
    model = excluded.model,
    uncached_input_tokens = excluded.uncached_input_tokens,
    output_tokens = excluded.output_tokens,
    cache_read_tokens = excluded.cache_read_tokens,
    cache_write_tokens = excluded.cache_write_tokens,
    reasoning_tokens = excluded.reasoning_tokens,
    request_count = excluded.request_count,
    event_time = excluded.event_time,
    updated_at = excluded.updated_at
`

const GET_EXTRA_TOTALS_BASE = `
  SELECT
    COALESCE(SUM(uncached_input_tokens), 0) AS uncachedInputTokens,
    COALESCE(SUM(output_tokens), 0) AS outputTokens,
    COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
    COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
    COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens,
    COALESCE(SUM(request_count), 0) AS requestCount,
    COUNT(*) AS turnCount,
    COUNT(DISTINCT session_id) AS sessionCount,
    COUNT(DISTINCT workspace) AS workspaceCount
  FROM extra_usage
`

const LIST_TURNS_BASE = `
  SELECT
    workspace,
    session_id AS sessionId,
    turn,
    session_title AS sessionTitle,
    session_created_at AS sessionCreatedAt,
    session_updated_at AS sessionUpdatedAt,
    provider,
    model,
    uncached_input_tokens AS uncachedInputTokens,
    output_tokens AS outputTokens,
    cache_read_tokens AS cacheReadTokens,
    cache_write_tokens AS cacheWriteTokens,
    reasoning_tokens AS reasoningTokens,
    request_count AS requestCount,
    first_event_time AS firstEventTime,
    last_event_time AS lastEventTime
  FROM turn_token_usage
`

const LIST_EXTRA_BASE = `
  SELECT
    workspace,
    session_id AS sessionId,
    kind,
    turn,
    provider,
    model,
    uncached_input_tokens AS uncachedInputTokens,
    output_tokens AS outputTokens,
    cache_read_tokens AS cacheReadTokens,
    cache_write_tokens AS cacheWriteTokens,
    reasoning_tokens AS reasoningTokens,
    request_count AS requestCount,
    event_time AS eventTime,
    source_seq AS sourceSeq
  FROM extra_usage
`

const GET_TOTALS_BASE = `
  SELECT
    COALESCE(SUM(uncached_input_tokens), 0) AS uncachedInputTokens,
    COALESCE(SUM(output_tokens), 0) AS outputTokens,
    COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
    COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
    COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens,
    COALESCE(SUM(request_count), 0) AS requestCount,
    COUNT(*) AS turnCount,
    COUNT(DISTINCT session_id) AS sessionCount,
    COUNT(DISTINCT workspace) AS workspaceCount
  FROM turn_token_usage
`

function buildTurnWhere(options?: TurnQueryOptions): { where: string; params: (string | number)[] } {
  const conditions: string[] = []
  const params: (string | number)[] = []

  const addEqual = (column: string, value: string | number | undefined): void => {
    if (value === undefined || value === '') return
    conditions.push(`${column} = ?`)
    params.push(value)
  }
  const addRange = (column: string, min: number | undefined, max: number | undefined): void => {
    if (min !== undefined) {
      conditions.push(`${column} >= ?`)
      params.push(min)
    }
    if (max !== undefined) {
      conditions.push(`${column} <= ?`)
      params.push(max)
    }
  }

  // Text / nullable fields.
  addEqual('workspace', options?.workspace)
  addEqual('session_id', options?.sessionId)
  addEqual('session_title', options?.sessionTitle)
  addEqual('provider', options?.provider)
  addEqual('model', options?.model)

  // Numeric exact fields.
  addEqual('id', options?.id)
  addEqual('turn', options?.turn)
  addEqual('session_created_at', options?.sessionCreatedAt)
  addEqual('session_updated_at', options?.sessionUpdatedAt)
  addEqual('uncached_input_tokens', options?.uncachedInputTokens)
  addEqual('output_tokens', options?.outputTokens)
  addEqual('cache_read_tokens', options?.cacheReadTokens)
  addEqual('cache_write_tokens', options?.cacheWriteTokens)
  addEqual('reasoning_tokens', options?.reasoningTokens)
  addEqual('request_count', options?.requestCount)
  addEqual('first_event_time', options?.firstEventTime)
  addEqual('last_event_time', options?.lastEventTime)
  addEqual('created_at', options?.createdAt)
  addEqual('updated_at', options?.updatedAt)

  // Numeric range helpers.
  addRange('id', options?.idMin, options?.idMax)
  addRange('turn', options?.turnMin, options?.turnMax)
  addRange('session_created_at', options?.sessionCreatedAtMin, options?.sessionCreatedAtMax)
  addRange('session_updated_at', options?.sessionUpdatedAtMin, options?.sessionUpdatedAtMax)
  addRange('uncached_input_tokens', options?.uncachedInputTokensMin, options?.uncachedInputTokensMax)
  addRange('output_tokens', options?.outputTokensMin, options?.outputTokensMax)
  addRange('cache_read_tokens', options?.cacheReadTokensMin, options?.cacheReadTokensMax)
  addRange('cache_write_tokens', options?.cacheWriteTokensMin, options?.cacheWriteTokensMax)
  addRange('reasoning_tokens', options?.reasoningTokensMin, options?.reasoningTokensMax)
  addRange('request_count', options?.requestCountMin, options?.requestCountMax)
  addRange('first_event_time', options?.firstEventTimeMin, options?.firstEventTimeMax)
  addRange('last_event_time', options?.lastEventTimeMin, options?.lastEventTimeMax)
  addRange('created_at', options?.createdAtMin, options?.createdAtMax)
  addRange('updated_at', options?.updatedAtMin, options?.updatedAtMax)

  return { where: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '', params }
}

function buildExtraWhere(options?: TurnQueryOptions): { where: string; params: (string | number)[] } {
  const conditions: string[] = []
  const params: (string | number)[] = []

  const addEqual = (column: string, value: string | number | undefined): void => {
    if (value === undefined || value === '') return
    conditions.push(`${column} = ?`)
    params.push(value)
  }
  const addRange = (column: string, min: number | undefined, max: number | undefined): void => {
    if (min !== undefined) {
      conditions.push(`${column} >= ?`)
      params.push(min)
    }
    if (max !== undefined) {
      conditions.push(`${column} <= ?`)
      params.push(max)
    }
  }

  addEqual('workspace', options?.workspace)
  addEqual('session_id', options?.sessionId)
  addEqual('provider', options?.provider)
  addEqual('model', options?.model)
  addEqual('turn', options?.turn)

  addRange('turn', options?.turnMin, options?.turnMax)
  // The convenience since/until filters map onto lastEventTime; apply the
  // same bounds to extra_usage.event_time so auxiliary calls honor them.
  addRange('event_time', options?.firstEventTimeMin, options?.firstEventTimeMax)
  addRange('event_time', options?.lastEventTimeMin, options?.lastEventTimeMax)
  addRange('event_time', options?.createdAtMin, options?.createdAtMax)
  addRange('event_time', options?.updatedAtMin, options?.updatedAtMax)

  return { where: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '', params }
}

export function openTokenUsageStore(filePath: string): TokenUsageStore {
  const absolutePath = resolve(filePath)
  mkdirSync(dirname(absolutePath), { recursive: true })
  const db = new DatabaseSync(absolutePath)

  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec(SCHEMA)

  const upsert = db.prepare(UPSERT)
  const upsertExtra = db.prepare(UPSERT_EXTRA)

  return {
    upsertTurn(row) {
      const now = Date.now()
      upsert.run(
        row.workspace,
        row.sessionId,
        row.turn,
        row.sessionTitle,
        row.sessionCreatedAt,
        row.sessionUpdatedAt,
        row.provider,
        row.model,
        row.uncachedInputTokens,
        row.outputTokens,
        row.cacheReadTokens,
        row.cacheWriteTokens,
        row.reasoningTokens,
        row.requestCount,
        row.firstEventTime,
        row.lastEventTime,
        now,
        now,
      )
    },
    listTurns(options) {
      const { where, params } = buildTurnWhere(options)
      let sql = `${LIST_TURNS_BASE}${where} ORDER BY workspace, session_id, turn`
      if (options?.limit !== undefined || options?.offset !== undefined) {
        sql += ' LIMIT ?'
        params.push(options.limit ?? -1)
        if (options?.offset !== undefined) {
          sql += ' OFFSET ?'
          params.push(options.offset)
        }
      }
      return db.prepare(sql).all(...params) as unknown as TurnTokenUsageRow[]
    },
    getTotals(options) {
      const { where, params } = buildTurnWhere(options)
      return db.prepare(`${GET_TOTALS_BASE}${where}`).get(...params) as unknown as UsageTotals
    },
    listExtra(options) {
      const { where, params } = buildExtraWhere(options)
      let sql = `${LIST_EXTRA_BASE}${where} ORDER BY workspace, session_id, event_time`
      if (options?.limit !== undefined || options?.offset !== undefined) {
        sql += ' LIMIT ?'
        params.push(options.limit ?? -1)
        if (options?.offset !== undefined) {
          sql += ' OFFSET ?'
          params.push(options.offset)
        }
      }
      return db.prepare(sql).all(...params) as unknown as ExtraUsageRow[]
    },
    upsertExtra(row) {
      const now = Date.now()
      upsertExtra.run(
        row.workspace,
        row.sessionId,
        row.kind,
        row.turn,
        row.provider,
        row.model,
        row.uncachedInputTokens,
        row.outputTokens,
        row.cacheReadTokens,
        row.cacheWriteTokens,
        row.reasoningTokens,
        row.requestCount,
        row.eventTime,
        row.sourceSeq,
        now,
        now,
      )
    },
    getExtraTotals(options) {
      const { where, params } = buildExtraWhere(options)
      return db.prepare(`${GET_EXTRA_TOTALS_BASE}${where}`).get(...params) as unknown as UsageTotals
    },
    close() {
      db.close()
    },
  }
}
