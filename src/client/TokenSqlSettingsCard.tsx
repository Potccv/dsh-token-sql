import { useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings.plugin.item SlotMap declaration.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { CardShell } from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { triggerFullScan } from './api.ts'
import { tokenSqlScope, useTokenSqlSnapshot } from './settings-scope.ts'
import { PluginCard } from './PluginCard.tsx'

type Props = PropsRuntime<'settings.plugin.item'>

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
  margin: '12px 0 12px',
}

const buttonStyle: React.CSSProperties = {
  appearance: 'none',
  font: 'inherit',
  cursor: 'pointer',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  padding: '5px 14px',
  marginBottom: 12,
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-secondary)',
  background: 'none',
}

const buttonDisabledStyle: React.CSSProperties = {
  opacity: 0.4,
  cursor: 'default',
}

export function TokenSqlSettingsCard(_props: Props) {
  const [scanning, setScanning] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [draftExposeWebApi, setDraftExposeWebApi] = useState<boolean | undefined>(undefined)
  const [draftCaptureWebSearchUsage, setDraftCaptureWebSearchUsage] = useState<boolean | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  const snapshot = useTokenSqlSnapshot()
  const config = snapshot.status === 'ready' ? snapshot.value : undefined
  const currentExposeWebApi = config?.exposeWebApi ?? true
  const exposeWebApi = draftExposeWebApi ?? currentExposeWebApi
  const currentCaptureWebSearchUsage = config?.captureWebSearchUsage ?? false
  const captureWebSearchUsage = draftCaptureWebSearchUsage ?? currentCaptureWebSearchUsage
  const dirty = (draftExposeWebApi !== undefined && draftExposeWebApi !== currentExposeWebApi)
    || (draftCaptureWebSearchUsage !== undefined && draftCaptureWebSearchUsage !== currentCaptureWebSearchUsage)
  const writable = snapshot.status === 'ready' && snapshot.writable

  const state: CardShell = {
    available: snapshot.status === 'ready',
    writable,
    dirty,
    invalid: false,
    saving,
    failed,
  }

  const handleToggleExpose = (): void => {
    setDraftExposeWebApi(!exposeWebApi)
    setFailed(false)
  }

  const handleToggleCapture = (): void => {
    setDraftCaptureWebSearchUsage(!captureWebSearchUsage)
    setFailed(false)
  }

  const handleSave = async (): Promise<void> => {
    if ((draftExposeWebApi === undefined && draftCaptureWebSearchUsage === undefined) || saving) return
    setSaving(true)
    setFailed(false)
    try {
      if (draftExposeWebApi !== undefined) {
        await tokenSqlScope().set('exposeWebApi', draftExposeWebApi)
      }
      if (draftCaptureWebSearchUsage !== undefined) {
        await tokenSqlScope().set('captureWebSearchUsage', draftCaptureWebSearchUsage)
      }
      const next = tokenSqlScope().getSnapshot()
      const user = next.user as Record<string, unknown> | undefined
      const landed = next.status === 'ready'
        && (draftExposeWebApi === undefined || user?.['exposeWebApi'] === draftExposeWebApi)
        && (draftCaptureWebSearchUsage === undefined || user?.['captureWebSearchUsage'] === draftCaptureWebSearchUsage)
      if (landed) {
        setDraftExposeWebApi(undefined)
        setDraftCaptureWebSearchUsage(undefined)
      }
      setFailed(!landed)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const handleDiscard = (): void => {
    setDraftExposeWebApi(undefined)
    setDraftCaptureWebSearchUsage(undefined)
    setFailed(false)
  }

  const handleScan = async (): Promise<void> => {
    setScanning(true)
    setMessage(undefined)
    try {
      const result = await triggerFullScan()
      const recovered = result.recoveredV0Sessions > 0
        ? `，兼容读取 ${result.recoveredV0Sessions} 个旧版会话`
        : ''
      const reconciled = result.removedStaleRequests > 0
        ? `，清理 ${result.removedStaleRequests} 条格式转换产生的陈旧记录`
        : ''
      setMessage(`扫描完成：${result.scanned} 个会话，写入/更新 ${result.writtenRequests} 条请求${reconciled}${recovered}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setScanning(false)
    }
  }

  const trackStyleFor = (active: boolean): React.CSSProperties => ({
    ...switchTrackStyle,
    ...(active ? {
      background: 'var(--dsw-alias-state-business-primary)',
      borderColor: 'var(--dsw-alias-state-business-primary)',
    } : {}),
    ...(!writable || saving ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
  })

  const thumbStyleFor = (active: boolean): React.CSSProperties => ({
    ...switchThumbStyle,
    ...(active ? { transform: 'translateX(16px)', background: '#fff' } : {}),
  })

  return (
    <PluginCard
      title="Token SQL"
      description="将每次 DSH token usage 写入 SQLite"
      state={state}
      onSave={() => { void handleSave() }}
      onDiscard={handleDiscard}
    >
      <div style={switchRowStyle}>
        <span style={switchLabelStyle}>网页 API 映射（/api/usage）</span>
        <label style={switchStyle}>
          <input
            type="checkbox"
            style={switchInputStyle}
            checked={exposeWebApi}
            disabled={!writable || saving}
            onChange={handleToggleExpose}
            aria-label="网页 API 映射开关"
          />
          <span style={trackStyleFor(exposeWebApi)} aria-hidden="true">
            <span style={thumbStyleFor(exposeWebApi)} />
          </span>
        </label>
      </div>

      <div style={switchRowStyle}>
        <span style={switchLabelStyle}>捕获 Web 搜索 tokens（运行时注入 fetch 拦截）</span>
        <label style={switchStyle}>
          <input
            type="checkbox"
            style={switchInputStyle}
            checked={captureWebSearchUsage}
            disabled={!writable || saving}
            onChange={handleToggleCapture}
            aria-label="捕获 Web 搜索 tokens 开关"
          />
          <span style={trackStyleFor(captureWebSearchUsage)} aria-hidden="true">
            <span style={thumbStyleFor(captureWebSearchUsage)} />
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
    </PluginCard>
  )
}
