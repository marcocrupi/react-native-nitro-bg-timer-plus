import { NativeModules } from 'react-native'
import { BackgroundTimer } from 'react-native-nitro-bg-timer-plus'

export const SMOKE_TIMEOUT_MS = 30000

const STEP_TIMEOUT_MS = 5000
const BACKGROUND_WINDOW_TICKS = 6
const BACKGROUND_WINDOW_INTERVAL_MS = 500

export type SmokeResultStatus = 'pass' | 'fail'

export type SmokeStepResult = {
  name: string
  status: SmokeResultStatus
  reason?: string
}

export type SmokeResult = {
  runId: string
  status: SmokeResultStatus
  reason?: string
  startedAt: number
  finishedAt: number
  steps: SmokeStepResult[]
}

export type SmokeUiState = {
  status: 'idle' | 'running' | SmokeResultStatus
  runId?: string
  reason?: string
  startedAt?: number
  finishedAt?: number
}

export type BackgroundTimerSmokeOptions = {
  runId: string
  log?: (message: string) => void
}

type TimerRegistry = {
  timeouts: Set<number>
  intervals: Set<number>
}

type NitroBgSmokeLogModule = {
  log?: (message: string) => void
}

class SmokeStepError extends Error {
  stepName: string

  constructor(stepName: string, reason: string) {
    super(reason)
    this.name = 'SmokeStepError'
    this.stepName = stepName
  }
}

let activeRun: Promise<SmokeResult> | null = null
let disposedBySmoke = false

export function createSmokeRunId(prefix = 'manual'): string {
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${Date.now()}-${suffix}`
}

export function emitSmokeMarker(
  message: string,
  log?: (message: string) => void
): void {
  console.log(message)
  mirrorSmokeMarkerToNative(message)
  log?.(message)
}

export function runBackgroundTimerSmokeTest(
  options: BackgroundTimerSmokeOptions
): Promise<SmokeResult> {
  if (activeRun) return activeRun

  if (disposedBySmoke) {
    return Promise.resolve(
      failWithoutStartingTimers(
        options,
        'background_timer_disposed_reload_required'
      )
    )
  }

  activeRun = executeSmoke(options).finally(() => {
    activeRun = null
  })
  return activeRun
}

function executeSmoke(options: BackgroundTimerSmokeOptions): Promise<SmokeResult> {
  return runSmoke(options)
}

async function runSmoke(
  options: BackgroundTimerSmokeOptions
): Promise<SmokeResult> {
  const startedAt = Date.now()
  const deadline = startedAt + SMOKE_TIMEOUT_MS
  const steps: SmokeStepResult[] = []
  const registry: TimerRegistry = {
    timeouts: new Set(),
    intervals: new Set(),
  }
  let intervalIdForClear: number | null = null
  let intervalTicks = 0
  let disposed = false
  let status: SmokeResultStatus = 'pass'
  let reason: string | undefined

  emit(options, `[NitroBgSmoke] START runId=${options.runId}`)

  const runStep = async (
    name: string,
    task: () => void | Promise<void>,
    timeoutMs = STEP_TIMEOUT_MS
  ) => {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      const timeoutReason = 'global_timeout'
      steps.push({ name: 'globalTimeout', status: 'fail', reason: timeoutReason })
      emit(
        options,
        `[NitroBgSmoke] STEP FAIL runId=${options.runId} name=globalTimeout reason=${timeoutReason}`
      )
      throw new SmokeStepError('globalTimeout', timeoutReason)
    }

    try {
      await withTimeout(
        Promise.resolve().then(task),
        Math.min(timeoutMs, remainingMs),
        name
      )
      steps.push({ name, status: 'pass' })
      emit(
        options,
        `[NitroBgSmoke] STEP PASS runId=${options.runId} name=${name}`
      )
    } catch (error) {
      const stepReason = reasonFromError(error)
      steps.push({ name, status: 'fail', reason: stepReason })
      emit(
        options,
        `[NitroBgSmoke] STEP FAIL runId=${options.runId} name=${name} reason=${stepReason}`
      )
      throw new SmokeStepError(name, stepReason)
    }
  }

  try {
    await runStep('setTimeout', () => {
      return new Promise<void>((resolve) => {
        scheduleBackgroundTimeout(registry, resolve, 100)
      })
    })

    await runStep('clearTimeout', async () => {
      let fired = false
      const id = scheduleBackgroundTimeout(
        registry,
        () => {
          fired = true
        },
        160
      )
      await sleep(25)
      clearBackgroundTimeout(registry, id)
      await sleep(300)
      if (fired) {
        throw new Error('callback_fired_after_clearTimeout')
      }
    })

    await runStep('setInterval', () => {
      return new Promise<void>((resolve) => {
        intervalIdForClear = scheduleBackgroundInterval(
          registry,
          () => {
            intervalTicks += 1
            if (intervalTicks >= 3) resolve()
          },
          80
        )
      })
    })

    await runStep('clearInterval', async () => {
      if (intervalIdForClear === null) {
        throw new Error('missing_interval_id')
      }
      clearBackgroundInterval(registry, intervalIdForClear)
      intervalIdForClear = null
      const ticksAfterClear = intervalTicks
      await sleep(260)
      if (intervalTicks !== ticksAfterClear) {
        throw new Error('callback_fired_after_clearInterval')
      }
    })

    await runStep('batchOrdering', () => {
      const seen: string[] = []
      return new Promise<void>((resolve) => {
        const record = (label: string) => {
          seen.push(label)
          if (seen.length === 3) resolve()
        }

        scheduleBackgroundTimeout(registry, () => record('a'), 60)
        scheduleBackgroundTimeout(registry, () => record('b'), 120)
        scheduleBackgroundTimeout(registry, () => record('c'), 180)
      }).then(() => {
        if (seen.join(',') !== 'a,b,c') {
          throw new Error(`unexpected_order_${seen.join('-')}`)
        }
      })
    })

    await runStep('reentrancy', () => {
      const seen: string[] = []
      return new Promise<void>((resolve) => {
        scheduleBackgroundTimeout(
          registry,
          () => {
            seen.push('outer')
            scheduleBackgroundTimeout(
              registry,
              () => {
                seen.push('inner')
                resolve()
              },
              0
            )
          },
          60
        )
      }).then(() => {
        if (seen.join(',') !== 'outer,inner') {
          throw new Error(`unexpected_reentrancy_${seen.join('-')}`)
        }
      })
    })

    await runStep(
      'backgroundWindow',
      () => {
        let ticks = 0
        let backgroundIntervalId: number | null = null

        return new Promise<void>((resolve) => {
          backgroundIntervalId = scheduleBackgroundInterval(
            registry,
            () => {
              ticks += 1
              if (ticks >= BACKGROUND_WINDOW_TICKS) resolve()
            },
            BACKGROUND_WINDOW_INTERVAL_MS
          )
          emit(
            options,
            `[NitroBgSmoke] BACKGROUND_READY runId=${options.runId}`
          )
        }).then(() => {
          if (backgroundIntervalId !== null) {
            clearBackgroundInterval(registry, backgroundIntervalId)
          }
          if (ticks < BACKGROUND_WINDOW_TICKS) {
            throw new Error(`background_window_ticks_${ticks}`)
          }
        })
      },
      8000
    )

    await runStep('dispose', () => {
      cleanupTimers(registry)
      BackgroundTimer.dispose()
      disposed = true
      disposedBySmoke = true
    })
  } catch (error) {
    status = 'fail'
    reason =
      error instanceof SmokeStepError ? error.message : reasonFromError(error)
  } finally {
    if (!disposed) {
      cleanupTimers(registry)
      try {
        BackgroundTimer.dispose()
        disposedBySmoke = true
        steps.push({ name: 'dispose', status: 'pass' })
        emit(
          options,
          `[NitroBgSmoke] STEP PASS runId=${options.runId} name=dispose`
        )
      } catch (error) {
        const disposeReason = reasonFromError(error)
        steps.push({ name: 'dispose', status: 'fail', reason: disposeReason })
        emit(
          options,
          `[NitroBgSmoke] STEP FAIL runId=${options.runId} name=dispose reason=${disposeReason}`
        )
        if (status === 'pass') {
          status = 'fail'
          reason = disposeReason
        }
      }
    }
  }

  const finishedAt = Date.now()
  const result: SmokeResult = {
    runId: options.runId,
    status,
    reason,
    startedAt,
    finishedAt,
    steps,
  }

  emitResult(options, result)
  return result
}

function failWithoutStartingTimers(
  options: BackgroundTimerSmokeOptions,
  reason: string
): SmokeResult {
  const now = Date.now()
  const result: SmokeResult = {
    runId: options.runId,
    status: 'fail',
    reason,
    startedAt: now,
    finishedAt: now,
    steps: [{ name: 'preflight', status: 'fail', reason }],
  }

  emit(options, `[NitroBgSmoke] START runId=${options.runId}`)
  emit(
    options,
    `[NitroBgSmoke] STEP FAIL runId=${options.runId} name=preflight reason=${reason}`
  )
  emitResult(options, result)

  return result
}

function emitResult(
  options: BackgroundTimerSmokeOptions,
  result: SmokeResult
): void {
  if (result.status === 'pass') {
    emit(options, `[NitroBgSmoke] RESULT PASS runId=${options.runId}`)
    return
  }

  emit(
    options,
    `[NitroBgSmoke] RESULT FAIL runId=${options.runId} reason=${result.reason ?? 'unknown'}`
  )
}

function emit(options: BackgroundTimerSmokeOptions, message: string): void {
  emitSmokeMarker(message, options.log)
}

function mirrorSmokeMarkerToNative(message: string): void {
  try {
    const smokeLog = NativeModules.NitroBgSmokeLog as
      | NitroBgSmokeLogModule
      | undefined

    smokeLog?.log?.(message)
  } catch {
    // Native smoke logging is diagnostics-only and must never affect smoke flow.
  }
}

function scheduleBackgroundTimeout(
  registry: TimerRegistry,
  callback: () => void,
  delayMs: number
): number {
  let id = -1
  id = BackgroundTimer.setTimeout(() => {
    registry.timeouts.delete(id)
    callback()
  }, delayMs)
  registry.timeouts.add(id)
  return id
}

function clearBackgroundTimeout(registry: TimerRegistry, id: number): void {
  registry.timeouts.delete(id)
  BackgroundTimer.clearTimeout(id)
}

function scheduleBackgroundInterval(
  registry: TimerRegistry,
  callback: () => void,
  intervalMs: number
): number {
  const id = BackgroundTimer.setInterval(callback, intervalMs)
  registry.intervals.add(id)
  return id
}

function clearBackgroundInterval(registry: TimerRegistry, id: number): void {
  registry.intervals.delete(id)
  BackgroundTimer.clearInterval(id)
}

function cleanupTimers(registry: TimerRegistry): void {
  for (const id of Array.from(registry.timeouts)) {
    try {
      BackgroundTimer.clearTimeout(id)
    } catch {
      // Cleanup is best-effort; the final result is driven by smoke steps.
    }
  }
  registry.timeouts.clear()

  for (const id of Array.from(registry.intervals)) {
    try {
      BackgroundTimer.clearInterval(id)
    } catch {
      // Cleanup is best-effort; the final result is driven by smoke steps.
    }
  }
  registry.intervals.clear()
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stepName: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${stepName}_timeout_${timeoutMs}ms`))
    }, timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function reasonFromError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const sanitized = message
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_.:/-]/g, '_')
    .slice(0, 160)

  return sanitized || 'unknown'
}
