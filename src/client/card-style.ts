/**
 * Injected CSS for the Settings > Plugins card.
 *
 * The official PluginCard is not exported as a runtime value from
 * `@deepseek-ai/dsh-client-ui-settings-plugins/client`, so this plugin ships a
 * local structural copy. The styles below mirror the official
 * PluginCard.module.css 1:1, scoped with plugin-specific class names and
 * injected once into the document.
 */

const STYLE_ID = 'dsh-token-sql-card-style'

let injected = false

/** Ensure the card stylesheet is present in the document (idempotent). */
export function ensureCardStyle(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  if (document.getElementById(STYLE_ID) !== null) return

  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .dsh-token-sql-card {
      list-style: none;
      border: 1px solid var(--dsw-alias-border-l2);
      border-radius: 12px;
      background: var(--dsw-alias-bg-layer-3);
      transition: border-color .16s, background .16s;
    }

    .dsh-token-sql-card:hover {
      border-color: var(--dsw-alias-label-dimmed);
    }

    .dsh-token-sql-card-open {
      background: var(--dsw-alias-bg-layer-2);
      border-color: var(--dsw-alias-label-dimmed);
    }

    .dsh-token-sql-header {
      width: 100%;
      appearance: none;
      border: 0;
      background: none;
      font: inherit;
      color: inherit;
      text-align: left;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 16px;
      border-radius: 12px;
    }

    .dsh-token-sql-header:focus-visible {
      outline: 2px solid var(--dsw-alias-brand-primary);
      outline-offset: -2px;
    }

    .dsh-token-sql-head-text {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .dsh-token-sql-name {
      font-size: 15px;
      font-weight: 600;
      line-height: 1.4;
      color: var(--dsw-alias-label-primary);
    }

    .dsh-token-sql-description {
      font-size: 13px;
      line-height: 1.5;
      color: var(--dsw-alias-label-tertiary);
    }

    .dsh-token-sql-chevron {
      flex: none;
      color: var(--dsw-alias-label-tertiary);
      transition: transform .16s;
    }

    .dsh-token-sql-chevron-open {
      transform: rotate(180deg);
    }

    .dsh-token-sql-body {
      border-top: 1px solid var(--dsw-alias-border-l2);
      margin: 0 16px;
      padding-bottom: 8px;
    }

    .dsh-token-sql-read-only {
      margin: 12px 0 0;
      font-size: 12px;
      line-height: 1.5;
      color: var(--dsw-alias-label-tertiary);
    }

    .dsh-token-sql-pending {
      flex: none;
      border-radius: 999px;
      padding: 1px 8px;
      font-size: 11px;
      line-height: 17px;
      font-weight: 500;
      white-space: nowrap;
      background: var(--dsw-alias-bg-module-platform);
      color: var(--dsw-alias-label-secondary);
    }

    .dsh-token-sql-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      padding: 12px 0 4px;
      border-top: 1px solid var(--dsw-alias-border-l2);
    }

    .dsh-token-sql-failed {
      flex: 1;
      min-width: 0;
      margin: 0;
      font-size: 12px;
      line-height: 1.5;
      color: var(--dsw-alias-label-error);
    }

    .dsh-token-sql-discard,
    .dsh-token-sql-save {
      appearance: none;
      border: 1px solid transparent;
      border-radius: 8px;
      padding: 5px 14px;
      font: inherit;
      font-size: 13px;
      line-height: 1.5;
      cursor: pointer;
    }

    .dsh-token-sql-discard {
      border-color: var(--dsw-alias-border-l2);
      background: none;
      color: var(--dsw-alias-label-secondary);
    }

    .dsh-token-sql-discard:hover:not(:disabled) {
      color: var(--dsw-alias-label-primary);
      border-color: var(--dsw-alias-label-dimmed);
    }

    .dsh-token-sql-save {
      background: var(--dsw-alias-label-primary);
      color: var(--dsw-alias-bg-layer-3);
    }

    .dsh-token-sql-discard:disabled,
    .dsh-token-sql-save:disabled {
      opacity: 0.4;
      cursor: default;
    }

    .dsh-token-sql-discard:focus-visible,
    .dsh-token-sql-save:focus-visible {
      outline: 2px solid var(--dsw-alias-brand-primary);
      outline-offset: 1px;
    }
  `
  document.head.appendChild(style)
}
