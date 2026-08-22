/**
 * Minimal local client-context face (structural mirror of the client
 * runtime's services), following the reference third-party plugin pattern.
 */
import type { Context } from '@deepseek-ai/cordis'

/** The slots service face this plugin uses. */
export interface ClientSlotsService {
  inject(name: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** Client plugin context (structural subset of the runtime's ClientContext). */
export type ClientContext = Omit<Context, 'slots' | 'settingsScope'> & {
  slots: ClientSlotsService
  settingsScope: ClientSettingsScopeBinder
}

/** Snapshot of one settings-namespace binding. */
export interface ClientScopeSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  /** Last accepted schema-resolved section (the effective config). */
  value: T | undefined
  /** Raw user layer; a field's PRESENCE here marks it overridden. */
  user: unknown
  /** Whether the Host document accepts writes (false for remote browsers). */
  writable: boolean
}

/** Reactive binding over one settings namespace. */
export interface ClientSettingsScope<T> {
  getSnapshot(): ClientScopeSnapshot<T>
  subscribe(listener: () => void): () => void
  /** Queue one top-level field write; a rejected write re-reads instead of
   *  throwing — confirm by re-inspecting the user layer after settlement. */
  set(field: string, value: unknown): Promise<void>
}

/** The settingsScope service: binds namespaces, resolving connection/remote
 *  through the caller's fiber (hence the plugin's own inject list). */
export interface ClientSettingsScopeBinder {
  bind<T>(spec: { namespace: string }): ClientSettingsScope<T>
}
