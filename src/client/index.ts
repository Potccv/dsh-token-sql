/**
 * dsh-token-sql browser half: a Settings > Plugins card with a full-scan
 * button and a switch controlling the `/api/usage` web mapping.
 */
// Type-only: pulls the settings.plugin.item SlotMap declaration.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { TokenSqlSettingsCard } from './TokenSqlSettingsCard.tsx'
import type { ClientContext } from './context-types.ts'
import { attachTokenSqlScope, type TokenSqlClientConfig } from './settings-scope.ts'

const SETTINGS_NS = 'dsh-token-sql'

/** Required services: settingsScope resolves connection/remote through this
 *  fiber, so those must be injected even though no code touches them. */
export const inject = ['slots', 'connection', 'remote', 'settingsScope']

export function apply(ctx: ClientContext): void {
  attachTokenSqlScope(ctx.settingsScope.bind<TokenSqlClientConfig>({ namespace: SETTINGS_NS }))

  ctx.slots.inject(
    'settings.plugin.item',
    () => ctx.slots.register({
      name: 'settings.plugin.item',
      key: SETTINGS_NS,
    }, TokenSqlSettingsCard),
  )
}
