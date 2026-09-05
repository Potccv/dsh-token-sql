/** SQLite storage for individual DeepSeek Harness token-usage requests. */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type UsageKind = 'session' | 'compaction' | 'session-title' | 'web-search'
export type UsageStatus = 'pending' | 'captured' | 'missing' | 'failed'

export interface TokenUsageRow {
  /** Database insertion sequence. Present on rows read from SQLite. */
  id?: number
  workspace: string
  sessionId: string
  sessionTitle: string | null
  kind: UsageKind
  turn: number | null
  step: number | null
  sourceSeq: number | null
  provider: string | null
  model: string | null
  usageStatus: UsageStatus
  uncachedInputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  sessionCreatedAt: number
  sessionUpdatedAt: number
  eventTime: number
  usageCapturedAt: number | null
  createdAt?: number
  updatedAt?: number
}

export interface SessionMetadata {
  workspace: string
  sessionId: string
  sessionTitle: string | null
  sessionCreatedAt: number
  sessionUpdatedAt: number
}

export interface UsageTotals {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  requestCount: number
  turnCount: number
  sessionCount: number
  workspaceCount: number
}

export interface UsageQueryOptions {
  id?: number
  workspace?: string
  sessionId?: string
  sessionTitle?: string
  kind?: UsageKind
  provider?: string
  model?: string
  usageStatus?: UsageStatus
  turn?: number
  step?: number
  sourceSeq?: number
  uncachedInputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  sessionCreatedAt?: number
  sessionUpdatedAt?: number
  eventTime?: number
  usageCapturedAt?: number
  createdAt?: number
  updatedAt?: number

  idMin?: number
  idMax?: number
  turnMin?: number
  turnMax?: number
  stepMin?: number
  stepMax?: number
  sourceSeqMin?: number
  sourceSeqMax?: number
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
  sessionCreatedAtMin?: number
  sessionCreatedAtMax?: number
  sessionUpdatedAtMin?: number
  sessionUpdatedAtMax?: number
  eventTimeMin?: number
  eventTimeMax?: number
  usageCapturedAtMin?: number
  usageCapturedAtMax?: number
  createdAtMin?: number
  createdAtMax?: number
  updatedAtMin?: number
  updatedAtMax?: number

  limit?: number
  offset?: number
}

export interface TokenUsageStore {
  /** Insert or update a replayable session/compaction/web-search request. */
  upsert(row: TokenUsageRow): void
  /** Insert a non-replayable session-title request. */
  insert(row: TokenUsageRow): void
  /** Run one synchronous batch atomically. */
  transaction<T>(action: () => T): T
  updateSessionMetadata(meta: SessionMetadata): void
  list(options?: UsageQueryOptions): TokenUsageRow[]
  /** Existing v1 databases require one full session rescan before legacy tables can be removed. */
  readonly needsLegacyRescan: boolean
  completeLegacyMigration(): void
  close(): void
}

export const TOKEN_USAGE_SCHEMA_VERSION = 3
const SCHEMA_VERSION = TOKEN_USAGE_SCHEMA_VERSION

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    workspace TEXT NOT NULL,
    session_id TEXT NOT NULL,
    session_title TEXT,

    kind TEXT NOT NULL CHECK(kind IN ('session', 'compaction', 'session-title', 'web-search')),
    turn INTEGER,
    step INTEGER,
    source_seq INTEGER,

    provider TEXT,
    model TEXT,
    usage_status TEXT NOT NULL CHECK(usage_status IN ('pending', 'captured', 'missing', 'failed')),

    uncached_input_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    output_tokens INTEGER,
    reasoning_tokens INTEGER,

    session_created_at INTEGER NOT NULL,
    session_updated_at INTEGER NOT NULL,
    event_time INTEGER NOT NULL,
    usage_captured_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,

    CHECK(session_created_at >= 0),
    CHECK(session_updated_at >= 0),
    CHECK(event_time >= 0),
    CHECK(usage_captured_at IS NULL OR usage_captured_at >= 0),
    CHECK(created_at >= 0),
    CHECK(updated_at >= 0),
    CHECK(turn IS NULL OR turn >= 0),
    CHECK(step IS NULL OR step >= 0),
    CHECK(source_seq IS NULL OR source_seq >= 0),
    CHECK(kind <> 'session' OR (turn IS NOT NULL AND step IS NOT NULL)),
    CHECK(kind = 'session' OR (turn IS NULL AND step IS NULL)),
    CHECK(kind NOT IN ('compaction', 'web-search') OR source_seq IS NOT NULL),
    CHECK(uncached_input_tokens IS NULL OR uncached_input_tokens >= 0),
    CHECK(cache_read_tokens IS NULL OR cache_read_tokens >= 0),
    CHECK(cache_write_tokens IS NULL OR cache_write_tokens >= 0),
    CHECK(output_tokens IS NULL OR output_tokens >= 0),
    CHECK(reasoning_tokens IS NULL OR reasoning_tokens >= 0),
    CHECK(reasoning_tokens IS NULL OR output_tokens IS NULL OR reasoning_tokens <= output_tokens),
    CHECK(
      (usage_status = 'captured'
        AND uncached_input_tokens IS NOT NULL
        AND cache_read_tokens IS NOT NULL
        AND cache_write_tokens IS NOT NULL
        AND output_tokens IS NOT NULL
        AND reasoning_tokens IS NOT NULL
        AND usage_captured_at IS NOT NULL)
      OR
      (usage_status <> 'captured'
        AND uncached_input_tokens IS NULL
        AND cache_read_tokens IS NULL
        AND cache_write_tokens IS NULL
        AND output_tokens IS NULL
        AND reasoning_tokens IS NULL
        AND usage_captured_at IS NULL)
    )
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS uq_token_usage_session_step
    ON token_usage(session_id, turn, step)
    WHERE kind = 'session';

  CREATE UNIQUE INDEX IF NOT EXISTS uq_token_usage_source_seq
    ON token_usage(session_id, kind, source_seq)
    WHERE kind IN ('compaction', 'web-search');

  CREATE INDEX IF NOT EXISTS idx_token_usage_session_time
    ON token_usage(session_id, event_time);

  CREATE INDEX IF NOT EXISTS idx_token_usage_workspace_time
    ON token_usage(workspace, event_time);

  CREATE INDEX IF NOT EXISTS idx_token_usage_kind_time
    ON token_usage(kind, event_time);

  CREATE INDEX IF NOT EXISTS idx_token_usage_model_time
    ON token_usage(provider, model, event_time);

  CREATE INDEX IF NOT EXISTS idx_token_usage_event_time
    ON token_usage(event_time, id);
`

const INSERT = `
  INSERT INTO token_usage (
    workspace, session_id, session_title,
    kind, turn, step, source_seq,
    provider, model, usage_status,
    uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
    session_created_at, session_updated_at, event_time, usage_captured_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

const UPDATE_SESSION_REQUEST = `
  UPDATE token_usage SET
    workspace = ?, session_title = ?, source_seq = ?, provider = ?, model = ?, usage_status = ?,
    uncached_input_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
    output_tokens = ?, reasoning_tokens = ?,
    session_created_at = ?, session_updated_at = ?, event_time = ?, usage_captured_at = ?, updated_at = ?
  WHERE kind = 'session' AND session_id = ? AND turn = ? AND step = ?
`

const UPDATE_SEQUENCED_REQUEST = `
  UPDATE token_usage SET
    workspace = ?, session_title = ?, provider = ?, model = ?, usage_status = ?,
    uncached_input_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
    output_tokens = ?, reasoning_tokens = ?,
    session_created_at = ?, session_updated_at = ?, event_time = ?, usage_captured_at = ?, updated_at = ?
  WHERE session_id = ? AND kind = ? AND source_seq = ?
`

const UPDATE_SESSION_METADATA = `
  UPDATE token_usage SET
    workspace = ?, session_title = ?, session_created_at = ?, session_updated_at = ?, updated_at = ?
  WHERE session_id = ?
    AND (workspace <> ?
      OR session_title IS NOT ?
      OR session_created_at <> ?
      OR session_updated_at <> ?)
`

const LIST_BASE = `
  SELECT
    id,
    workspace,
    session_id AS sessionId,
    session_title AS sessionTitle,
    kind,
    turn,
    step,
    source_seq AS sourceSeq,
    provider,
    model,
    usage_status AS usageStatus,
    uncached_input_tokens AS uncachedInputTokens,
    cache_read_tokens AS cacheReadTokens,
    cache_write_tokens AS cacheWriteTokens,
    output_tokens AS outputTokens,
    reasoning_tokens AS reasoningTokens,
    session_created_at AS sessionCreatedAt,
    session_updated_at AS sessionUpdatedAt,
    event_time AS eventTime,
    usage_captured_at AS usageCapturedAt,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM token_usage
`

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined
}

function tokenUsageHasId(db: DatabaseSync): boolean {
  if (!tableExists(db, 'token_usage')) return false
  const columns = db.prepare('PRAGMA table_info(token_usage)').all() as unknown as { name: string }[]
  return columns.some((column) => column.name === 'id')
}

/** Rebuild schema-v2 rows in event order so their generated ids are chronological. */
function ensureCurrentSchema(db: DatabaseSync): void {
  if (!tableExists(db, 'token_usage') || tokenUsageHasId(db)) {
    db.exec(SCHEMA)
    return
  }

  db.exec(`
    ALTER TABLE token_usage RENAME TO token_usage_without_id;
    DROP INDEX IF EXISTS uq_token_usage_session_step;
    DROP INDEX IF EXISTS uq_token_usage_source_seq;
    DROP INDEX IF EXISTS idx_token_usage_session_time;
    DROP INDEX IF EXISTS idx_token_usage_workspace_time;
    DROP INDEX IF EXISTS idx_token_usage_kind_time;
    DROP INDEX IF EXISTS idx_token_usage_model_time;
    DROP INDEX IF EXISTS idx_token_usage_event_time;
  `)
  db.exec(SCHEMA)
  db.exec(`
    INSERT INTO token_usage (
      workspace, session_id, session_title,
      kind, turn, step, source_seq,
      provider, model, usage_status,
      uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
      session_created_at, session_updated_at, event_time, usage_captured_at, created_at, updated_at
    )
    SELECT
      workspace, session_id, session_title,
      kind, turn, step, source_seq,
      provider, model, usage_status,
      uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
      session_created_at, session_updated_at, event_time, usage_captured_at, created_at, updated_at
    FROM token_usage_without_id
    ORDER BY
      event_time,
      created_at,
      session_id,
      kind,
      COALESCE(turn, -1),
      COALESCE(step, -1),
      COALESCE(source_seq, -1),
      rowid;

    DROP TABLE token_usage_without_id;
  `)
}

function migrateLegacyExtraUsage(db: DatabaseSync): void {
  if (!tableExists(db, 'extra_usage')) return
  const hasTurns = tableExists(db, 'turn_token_usage')
  const titleExpr = hasTurns
    ? `(SELECT t.session_title FROM turn_token_usage t
        WHERE t.session_id = ranked.session_id
        ORDER BY t.session_updated_at DESC, t.id DESC LIMIT 1)`
    : 'NULL'
  const createdExpr = hasTurns
    ? `COALESCE((SELECT t.session_created_at FROM turn_token_usage t
        WHERE t.session_id = ranked.session_id
        ORDER BY t.session_updated_at DESC, t.id DESC LIMIT 1), 0)`
    : '0'
  const updatedExpr = hasTurns
    ? `COALESCE((SELECT t.session_updated_at FROM turn_token_usage t
        WHERE t.session_id = ranked.session_id
        ORDER BY t.session_updated_at DESC, t.id DESC LIMIT 1), ranked.event_time)`
    : 'ranked.event_time'

  db.exec(`
    WITH ranked AS (
      SELECT e.*,
        ROW_NUMBER() OVER (
          PARTITION BY session_id, kind, source_seq
          ORDER BY
            (uncached_input_tokens + cache_read_tokens + cache_write_tokens + output_tokens) DESC,
            updated_at DESC,
            id DESC
        ) AS duplicate_rank
      FROM extra_usage e
    )
    INSERT OR IGNORE INTO token_usage (
      workspace, session_id, session_title,
      kind, turn, step, source_seq,
      provider, model, usage_status,
      uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
      session_created_at, session_updated_at, event_time, usage_captured_at, created_at, updated_at
    )
    SELECT
      workspace,
      session_id,
      ${titleExpr},
      kind,
      NULL,
      NULL,
      source_seq,
      provider,
      model,
      CASE
        WHEN uncached_input_tokens + cache_read_tokens + cache_write_tokens + output_tokens > 0
          THEN 'captured'
        ELSE 'missing'
      END,
      CASE WHEN uncached_input_tokens + cache_read_tokens + cache_write_tokens + output_tokens > 0
        THEN uncached_input_tokens ELSE NULL END,
      CASE WHEN uncached_input_tokens + cache_read_tokens + cache_write_tokens + output_tokens > 0
        THEN cache_read_tokens ELSE NULL END,
      CASE WHEN uncached_input_tokens + cache_read_tokens + cache_write_tokens + output_tokens > 0
        THEN cache_write_tokens ELSE NULL END,
      CASE WHEN uncached_input_tokens + cache_read_tokens + cache_write_tokens + output_tokens > 0
        THEN output_tokens ELSE NULL END,
      CASE WHEN uncached_input_tokens + cache_read_tokens + cache_write_tokens + output_tokens > 0
        THEN reasoning_tokens ELSE NULL END,
      ${createdExpr},
      ${updatedExpr},
      event_time,
      CASE WHEN uncached_input_tokens + cache_read_tokens + cache_write_tokens + output_tokens > 0
        THEN updated_at ELSE NULL END,
      created_at,
      updated_at
    FROM ranked
    WHERE source_seq IS NULL OR duplicate_rank = 1;
  `)
}

function buildWhere(options?: UsageQueryOptions): { where: string; params: (string | number)[] } {
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

  addEqual('id', options?.id)
  addEqual('workspace', options?.workspace)
  addEqual('session_id', options?.sessionId)
  addEqual('session_title', options?.sessionTitle)
  addEqual('kind', options?.kind)
  addEqual('turn', options?.turn)
  addEqual('step', options?.step)
  addEqual('source_seq', options?.sourceSeq)
  addEqual('provider', options?.provider)
  addEqual('model', options?.model)
  addEqual('usage_status', options?.usageStatus)
  addEqual('uncached_input_tokens', options?.uncachedInputTokens)
  addEqual('cache_read_tokens', options?.cacheReadTokens)
  addEqual('cache_write_tokens', options?.cacheWriteTokens)
  addEqual('output_tokens', options?.outputTokens)
  addEqual('reasoning_tokens', options?.reasoningTokens)
  addEqual('session_created_at', options?.sessionCreatedAt)
  addEqual('session_updated_at', options?.sessionUpdatedAt)
  addEqual('event_time', options?.eventTime)
  addEqual('usage_captured_at', options?.usageCapturedAt)
  addEqual('created_at', options?.createdAt)
  addEqual('updated_at', options?.updatedAt)

  addRange('id', options?.idMin, options?.idMax)
  addRange('turn', options?.turnMin, options?.turnMax)
  addRange('step', options?.stepMin, options?.stepMax)
  addRange('source_seq', options?.sourceSeqMin, options?.sourceSeqMax)
  addRange('uncached_input_tokens', options?.uncachedInputTokensMin, options?.uncachedInputTokensMax)
  addRange('cache_read_tokens', options?.cacheReadTokensMin, options?.cacheReadTokensMax)
  addRange('cache_write_tokens', options?.cacheWriteTokensMin, options?.cacheWriteTokensMax)
  addRange('output_tokens', options?.outputTokensMin, options?.outputTokensMax)
  addRange('reasoning_tokens', options?.reasoningTokensMin, options?.reasoningTokensMax)
  addRange('session_created_at', options?.sessionCreatedAtMin, options?.sessionCreatedAtMax)
  addRange('session_updated_at', options?.sessionUpdatedAtMin, options?.sessionUpdatedAtMax)
  addRange('event_time', options?.eventTimeMin, options?.eventTimeMax)
  addRange('usage_captured_at', options?.usageCapturedAtMin, options?.usageCapturedAtMax)
  addRange('created_at', options?.createdAtMin, options?.createdAtMax)
  addRange('updated_at', options?.updatedAtMin, options?.updatedAtMax)

  return { where: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '', params }
}

function insertParams(row: TokenUsageRow, now: number): (string | number | null)[] {
  return [
    row.workspace,
    row.sessionId,
    row.sessionTitle,
    row.kind,
    row.turn,
    row.step,
    row.sourceSeq,
    row.provider,
    row.model,
    row.usageStatus,
    row.uncachedInputTokens,
    row.cacheReadTokens,
    row.cacheWriteTokens,
    row.outputTokens,
    row.reasoningTokens,
    row.sessionCreatedAt,
    row.sessionUpdatedAt,
    row.eventTime,
    row.usageCapturedAt,
    row.createdAt ?? now,
    row.updatedAt ?? now,
  ]
}

export function openTokenUsageStore(filePath: string): TokenUsageStore {
  const absolutePath = resolve(filePath)
  mkdirSync(dirname(absolutePath), { recursive: true })
  const db = new DatabaseSync(absolutePath)

  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec('PRAGMA busy_timeout = 5000;')

  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (version > SCHEMA_VERSION) {
    db.close()
    throw new Error(`token usage database schema ${version} is newer than supported schema ${SCHEMA_VERSION}`)
  }
  const hasLegacyTurns = tableExists(db, 'turn_token_usage')
  let needsLegacyRescan = version < SCHEMA_VERSION && hasLegacyTurns

  db.exec('BEGIN IMMEDIATE;')
  try {
    ensureCurrentSchema(db)
    if (version === 0 && (hasLegacyTurns || tableExists(db, 'extra_usage'))) {
      migrateLegacyExtraUsage(db)
    }
    if (needsLegacyRescan) {
      db.exec('PRAGMA user_version = 1;')
    } else {
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
      db.exec('DROP TABLE IF EXISTS turn_token_usage;')
      db.exec('DROP TABLE IF EXISTS extra_usage;')
    }
    db.exec('COMMIT;')
  } catch (error) {
    db.exec('ROLLBACK;')
    db.close()
    throw error
  }

  const insert = db.prepare(INSERT)
  const updateSessionRequest = db.prepare(UPDATE_SESSION_REQUEST)
  const updateSequencedRequest = db.prepare(UPDATE_SEQUENCED_REQUEST)
  const updateMetadata = db.prepare(UPDATE_SESSION_METADATA)
  const findSessionRequest = db.prepare(`
    SELECT usage_status AS usageStatus FROM token_usage
    WHERE kind = 'session' AND session_id = ? AND turn = ? AND step = ?
  `)
  const findSequencedRequest = db.prepare(`
    SELECT usage_status AS usageStatus FROM token_usage
    WHERE session_id = ? AND kind = ? AND source_seq = ?
  `)

  const updateSessionRow = (row: TokenUsageRow, now: number): void => {
    updateSessionRequest.run(
      row.workspace, row.sessionTitle, row.sourceSeq, row.provider, row.model, row.usageStatus,
      row.uncachedInputTokens, row.cacheReadTokens, row.cacheWriteTokens,
      row.outputTokens, row.reasoningTokens,
      row.sessionCreatedAt, row.sessionUpdatedAt, row.eventTime, row.usageCapturedAt, row.updatedAt ?? now,
      row.sessionId, row.turn, row.step,
    )
  }
  const updateSequencedRow = (row: TokenUsageRow, now: number): void => {
    updateSequencedRequest.run(
      row.workspace, row.sessionTitle, row.provider, row.model, row.usageStatus,
      row.uncachedInputTokens, row.cacheReadTokens, row.cacheWriteTokens,
      row.outputTokens, row.reasoningTokens,
      row.sessionCreatedAt, row.sessionUpdatedAt, row.eventTime, row.usageCapturedAt, row.updatedAt ?? now,
      row.sessionId, row.kind, row.sourceSeq,
    )
  }
  const updateSessionMetadata = (meta: SessionMetadata): void => {
    const now = Date.now()
    updateMetadata.run(
      meta.workspace, meta.sessionTitle, meta.sessionCreatedAt, meta.sessionUpdatedAt, now,
      meta.sessionId,
      meta.workspace, meta.sessionTitle, meta.sessionCreatedAt, meta.sessionUpdatedAt,
    )
  }

  return {
    upsert(row) {
      if (row.kind === 'session' && (row.turn === null || row.step === null)) {
        throw new Error('session usage requires turn and step')
      }
      if ((row.kind === 'compaction' || row.kind === 'web-search') && row.sourceSeq === null) {
        throw new Error(`${row.kind} usage requires sourceSeq`)
      }
      if (row.kind === 'session-title') {
        insert.run(...insertParams(row, Date.now()))
        return
      }

      const existing = row.kind === 'session'
        ? findSessionRequest.get(row.sessionId, row.turn, row.step) as { usageStatus: UsageStatus } | undefined
        : findSequencedRequest.get(row.sessionId, row.kind, row.sourceSeq) as { usageStatus: UsageStatus } | undefined
      const now = Date.now()
      if (existing === undefined) {
        insert.run(...insertParams(row, now))
        return
      }

      // Historical replay cannot recover response-only usage. Keep an already
      // captured row instead of replacing it with a weaker observation.
      if (existing.usageStatus === 'captured' && row.usageStatus !== 'captured') {
        updateSessionMetadata(row)
        return
      }
      if (row.kind === 'session') updateSessionRow(row, now)
      else updateSequencedRow(row, now)
    },
    insert(row) {
      insert.run(...insertParams(row, Date.now()))
    },
    transaction(action) {
      db.exec('BEGIN IMMEDIATE;')
      try {
        const result = action()
        db.exec('COMMIT;')
        return result
      } catch (error) {
        db.exec('ROLLBACK;')
        throw error
      }
    },
    updateSessionMetadata,
    list(options) {
      const { where, params } = buildWhere(options)
      let sql = `${LIST_BASE}${where} ORDER BY event_time, id`
      if (options?.limit !== undefined || options?.offset !== undefined) {
        sql += ' LIMIT ?'
        params.push(options.limit ?? -1)
        if (options?.offset !== undefined) {
          sql += ' OFFSET ?'
          params.push(options.offset)
        }
      }
      return db.prepare(sql).all(...params) as unknown as TokenUsageRow[]
    },
    get needsLegacyRescan() {
      return needsLegacyRescan
    },
    completeLegacyMigration() {
      if (!needsLegacyRescan) return
      db.exec('BEGIN IMMEDIATE;')
      try {
        db.exec('DROP TABLE IF EXISTS turn_token_usage;')
        db.exec('DROP TABLE IF EXISTS extra_usage;')
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
        db.exec('COMMIT;')
        needsLegacyRescan = false
      } catch (error) {
        db.exec('ROLLBACK;')
        throw error
      }
    },
    close() {
      db.close()
    },
  }
}
