/**
 * Client-wide `settingsScope` binding for the `dsh-token-sql` namespace,
 * attached once by the client plugin's apply() and shared by the settings
 * card.
 */
import { useSyncExternalStore } from 'react'
import type { ClientSettingsScope, ClientScopeSnapshot } from './context-types.ts'

/** Client-side mirror of the host Config. */
export interface TokenSqlClientConfig {
  path: string
  backfillOnStart: boolean
  exposeWebApi: boolean
  captureWebSearchUsage: boolean
}

let scope: ClientSettingsScope<TokenSqlClientConfig> | undefined

/** Attach the namespace binding (called once from apply). */
export function attachTokenSqlScope(bound: ClientSettingsScope<TokenSqlClientConfig>): void {
  scope = bound
}

/** The raw scope, for writers (the settings card's toggle). */
export function tokenSqlScope(): ClientSettingsScope<TokenSqlClientConfig> {
  if (scope === undefined) throw new Error('dsh-token-sql: settings scope not attached')
  return scope
}

/** Stable fallback before attach / on non-loopback browsers. */
const UNAVAILABLE: ClientScopeSnapshot<TokenSqlClientConfig> = {
  status: 'unavailable',
  value: undefined,
  user: undefined,
  writable: false,
}

/** Subscribe to the live config snapshot. */
export function useTokenSqlSnapshot(): ClientScopeSnapshot<TokenSqlClientConfig> {
  return useSyncExternalStore(
    (listener) => scope?.subscribe(listener) ?? (() => undefined),
    () => scope?.getSnapshot() ?? UNAVAILABLE,
  )
}
