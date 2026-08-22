import { useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings.plugin.item SlotMap declaration.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { triggerFullScan } from './api.ts'
import { tokenSqlScope, useTokenSqlSnapshot } from './settings-scope.ts'

type Props = PropsRuntime<'settings.plugin.item'>

/* Card chrome mirrors the harness's native PluginCard, following the same
   layout/tokens as dsh-meter's settings card. */
const cardStyle: React.CSSProperties = {
  listStyle: 'none',
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-3)',
  borderRadius: 12,
  transition: 'border-color 160ms cubic-bezier(0.2, 0, 0, 1), background 160ms cubic-bezier(0.2, 0, 0, 1)',
}

const cardHoverStyle: React.CSSProperties = {
  borderColor: 'var(--dsw-alias-label-dimmed)',
}

const cardOpenStyle: React.CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-2)',
  borderColor: 'var(--dsw-alias-label-dimmed)',
}

const headerStyle: React.CSSProperties = {
  appearance: 'none',
  width: '100%',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  background: 'none',
  border: 0,
  borderRadius: 12,
  alignItems: 'center',
  gap: 12,
  padding: '14px 16px',
  display: 'flex',
}

const headTextStyle: React.CSSProperties = {
  flexDirection: 'column',
  flex: 1,
  gap: 4,
  minWidth: 0,
  display: 'flex',
}

const nameStyle: React.CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 15,
  fontWeight: 600,
  lineHeight: 1.4,
  margin: 0,
}

const descriptionStyle: React.CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 13,
  lineHeight: 1.5,
  margin: 0,
}

const chevronStyle: React.CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  flex: 'none',
}

const bodyStyle: React.CSSProperties = {
  borderTop: '1px solid var(--dsw-alias-border-l2)',
  margin: '0 16px',
  paddingBottom: 8,
}

const readOnlyStyle: React.CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  margin: '12px 0 0',
  fontSize: 12,
  lineHeight: 1.5,
}

const buttonStyle: React.CSSProperties = {
  appearance: 'none',
  font: 'inherit',
  cursor: 'pointer',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  padding: '5px 14px',
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-secondary)',
  background: 'none',
}

const buttonDisabledStyle: React.CSSProperties = {
  opacity: 0.4,
  cursor: 'default',
}

const switchRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '12px 0 8px',
}

const switchLabelStyle: React.CSSProperties = {
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 13,
  lineHeight: 1.5,
}

const switchStyle: React.CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  flex: 'none',
  cursor: 'pointer',
  userSelect: 'none',
}

const switchInputStyle: React.CSSProperties = {
  position: 'absolute',
  opacity: 0,
  width: 0,
  height: 0,
}

const switchTrackStyle: React.CSSProperties = {
  position: 'relative',
  width: 36,
  height: 20,
  borderRadius: 999,
  background: 'var(--dsw-alias-bg-layer-3)',
  border: '1px solid var(--dsw-alias-border-l2)',
  transition: 'background 120ms cubic-bezier(0.2, 0, 0, 1), border-color 120ms cubic-bezier(0.2, 0, 0, 1)',
  flex: 'none',
  overflow: 'hidden',
}

const switchThumbStyle: React.CSSProperties = {
  position: 'absolute',
  top: 2,
  left: 2,
  width: 16,
  height: 16,
  borderRadius: '50%',
  background: 'var(--dsw-alias-label-tertiary)',
  transition: 'transform 120ms cubic-bezier(0.2, 0, 0, 1), background 120ms cubic-bezier(0.2, 0, 0, 1)',
}

const messageStyle: React.CSSProperties = {
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
  lineHeight: 1.5,
  margin: '12px 0 0',
}

export function TokenSqlSettingsCard(_props: Props) {
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)

  const snapshot = useTokenSqlSnapshot()
  const config = snapshot.status === 'ready' ? snapshot.value : undefined
  const exposeWebApi = config?.exposeWebApi ?? true
  const writable = snapshot.status === 'ready' && snapshot.writable

  const handleScan = async (): Promise<void> => {
    setScanning(true)
    setMessage(undefined)
    try {
      const result = await triggerFullScan()
      setMessage(`扫描完成：${result.scanned} 个会话，写入/更新 ${result.writtenTurns} 个 turn`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setScanning(false)
    }
  }

  const handleToggleWebApi = async (): Promise<void> => {
    if (!writable) return
    setToggling(true)
    setMessage(undefined)
    try {
      await tokenSqlScope().set('exposeWebApi', !exposeWebApi)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setToggling(false)
    }
  }

  const trackStyle: React.CSSProperties = {
    ...switchTrackStyle,
    ...(exposeWebApi ? {
      background: 'var(--dsw-alias-state-business-primary)',
      borderColor: 'var(--dsw-alias-state-business-primary)',
    } : {}),
    ...(!writable || toggling ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
  }

  const thumbStyle: React.CSSProperties = {
    ...switchThumbStyle,
    ...(exposeWebApi ? { transform: 'translateX(16px)', background: '#fff' } : {}),
  }

  const currentCardStyle: React.CSSProperties = {
    ...cardStyle,
    ...(hovered ? cardHoverStyle : {}),
    ...(open ? cardOpenStyle : {}),
  }

  return (
    <li
      style={currentCardStyle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        style={headerStyle}
        aria-expanded={open}
        onClick={() => { setOpen(current => !current) }}
      >
        <span style={headTextStyle}>
          <strong style={nameStyle}>Token SQL</strong>
          <span style={descriptionStyle}>将 token usage 按 turn 写入 SQLite</span>
        </span>
        <span style={chevronStyle}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={bodyStyle}>
          {snapshot.status !== 'ready' ? (
            <p style={readOnlyStyle}>
              {snapshot.status === 'unavailable' ? '当前环境不可用' : '加载中…'}
            </p>
          ) : !snapshot.writable ? (
            <p style={readOnlyStyle}>当前为只读模式，无法修改设置</p>
          ) : null}

          <div style={switchRowStyle}>
            <span style={switchLabelStyle}>网页 API 映射（/api/usage）</span>
            <label style={switchStyle}>
              <input
                type="checkbox"
                style={switchInputStyle}
                checked={exposeWebApi}
                disabled={!writable || toggling}
                onChange={() => { void handleToggleWebApi() }}
                aria-label="网页 API 映射开关"
              />
              <span style={trackStyle} aria-hidden="true">
                <span style={thumbStyle} />
              </span>
            </label>
          </div>

          <button
            type="button"
            style={{
              ...buttonStyle,
              ...(scanning ? buttonDisabledStyle : {}),
            }}
            disabled={scanning}
            onClick={() => { void handleScan() }}
          >
            {scanning ? '扫描中…' : '全量扫描所有历史会话'}
          </button>
          {message !== undefined && <p style={messageStyle}>{message}</p>}
        </div>
      )}
    </li>
  )
}
