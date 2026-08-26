/**
 * Plugin settings card chrome, mirroring the official
 * `@deepseek-ai/dsh-client-ui-settings-plugins` PluginCard 1:1.
 *
 * The official component is not exposed as a runtime export from the client
 * bundle, so this local copy keeps the exact same structure and CSS tokens.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CardShell } from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { ensureCardStyle } from './card-style.ts'

export interface PluginCardProps {
  /** Plugin display name shown in the card header. */
  title: string
  /** One-line description shown under the name. */
  description: string
  /** Shared form state used by every plugin card. */
  state: CardShell
  /** Write every staged edit. */
  onSave: () => void
  /** Drop every staged edit. */
  onDiscard: () => void
  /** The plugin's controls. */
  children: ReactNode
}

/**
 * Render one plugin card.
 * @param props - the plugin's copy, its form state, and its controls.
 * @returns the card, or nothing when the namespace is unavailable.
 */
export function PluginCard(props: PluginCardProps) {
  const [open, setOpen] = useState(false)
  const { state } = props
  useEffect(() => { ensureCardStyle() }, [])
  if (!state.available) return null
  const title = props.title
  const blocked = !state.dirty || state.invalid || state.saving
  return (
    <li className={`dsh-token-sql-card${open ? ' dsh-token-sql-card-open' : ''}`}>
      <button
        type="button"
        className="dsh-token-sql-header"
        aria-expanded={open}
        aria-label={`${open ? '收起' : '展开'}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className="dsh-token-sql-head-text">
          <span className="dsh-token-sql-name">{title}</span>
          <span className="dsh-token-sql-description">{props.description}</span>
        </span>
        {state.dirty ? <span className="dsh-token-sql-pending">未保存</span> : null}
        <IconChevronDownOutline14 className={`dsh-token-sql-chevron${open ? ' dsh-token-sql-chevron-open' : ''}`} />
      </button>
      {open
        ? (
          <div className="dsh-token-sql-body">
            {!state.writable ? <p className="dsh-token-sql-read-only" role="status">当前为只读模式，无法修改设置</p> : null}
            {props.children}
            <div className="dsh-token-sql-footer">
              {state.failed ? <p className="dsh-token-sql-failed" role="status">保存失败</p> : null}
              <button
                type="button"
                className="dsh-token-sql-discard"
                disabled={!state.dirty || state.saving}
                onClick={props.onDiscard}
              >
                恢复默认
              </button>
              <button
                type="button"
                className="dsh-token-sql-save"
                disabled={blocked}
                onClick={props.onSave}
              >
                {state.saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}
