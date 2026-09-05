/** Client-side API wrapper for dsh-token-sql host routes. */

export interface FullScanResult {
  scanned: number
  writtenRequests: number
  recoveredV0Sessions: number
}

export async function triggerFullScan(): Promise<FullScanResult> {
  let response: Response
  try {
    response = await fetch('/dsh-token-sql/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }

  const parsed: {
    ok?: boolean
    value?: FullScanResult
    error?: { message?: string }
  } | null = await response.json().catch(() => null)

  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`)
  }

  return parsed.value
}
