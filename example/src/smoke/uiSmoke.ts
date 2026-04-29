import { NativeModules } from 'react-native'

const UI_SMOKE_RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/
const UI_SMOKE_REASON_MAX_LENGTH = 160

type NitroBgSmokeLogModule = {
  log?: (message: string) => void
}

export type UiSmokeActionToken =
  | {
      active: true
      runId: string
      section: string
      action: string
    }
  | {
      active: false
      section: string
      action: string
    }

let activeUiSmokeRunId: string | null = null

export function createUiSmokeRunId(prefix = 'ui-manual'): string {
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${Date.now()}-${suffix}`
}

export function activateUiSmokeRun(runId: string): void {
  activeUiSmokeRunId = UI_SMOKE_RUN_ID_PATTERN.test(runId)
    ? runId
    : createUiSmokeRunId('ui-invalid')
}

export function getUiSmokeRunId(): string | null {
  return activeUiSmokeRunId
}

export function isUiSmokeActive(): boolean {
  return activeUiSmokeRunId !== null
}

export function startUiSmokeAction(
  section: string,
  action: string,
  log?: (message: string) => void
): UiSmokeActionToken {
  const runId = getUiSmokeRunId()
  if (!runId) {
    return {
      active: false,
      section,
      action,
    }
  }

  const token = {
    active: true,
    runId,
    section,
    action,
  } satisfies UiSmokeActionToken

  emitUiSmokeMarker('START', token, log)
  return token
}

export function passUiSmokeAction(
  token: UiSmokeActionToken,
  log?: (message: string) => void
): void {
  if (!token.active) return

  emitUiSmokeMarker('PASS', token, log)
}

export function failUiSmokeAction(
  token: UiSmokeActionToken,
  reason: unknown,
  log?: (message: string) => void
): void {
  if (!token.active) return

  emitUiSmokeMarker('FAIL', token, log, normalizeUiSmokeReason(reason))
}

export function runUiSmokeAction<T>(
  section: string,
  action: string,
  log: ((message: string) => void) | undefined,
  task: () => T
): T {
  const token = startUiSmokeAction(section, action, log)

  try {
    const result = task()
    passUiSmokeAction(token, log)
    return result
  } catch (error) {
    failUiSmokeAction(token, error, log)
    throw error
  }
}

function emitUiSmokeMarker(
  status: 'START' | 'PASS' | 'FAIL',
  token: Extract<UiSmokeActionToken, { active: true }>,
  log?: (message: string) => void,
  reason?: string
): void {
  const reasonPart = reason ? ` reason=${reason}` : ''
  const message = `[NitroBgUiSmoke] ${status} runId=${token.runId} section=${token.section} action=${token.action}${reasonPart}`

  console.log(message)
  mirrorUiSmokeMarkerToNative(message)
  log?.(message)
}

function mirrorUiSmokeMarkerToNative(message: string): void {
  try {
    const smokeLog = NativeModules.NitroBgSmokeLog as
      | NitroBgSmokeLogModule
      | undefined

    smokeLog?.log?.(message)
  } catch {
    // Native log mirroring is best-effort diagnostics for the example app.
  }
}

function normalizeUiSmokeReason(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  const sanitized = message
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_.:/-]/g, '_')
    .slice(0, UI_SMOKE_REASON_MAX_LENGTH)

  return sanitized || 'unknown'
}
