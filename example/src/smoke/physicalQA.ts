import { AppState, DeviceEventEmitter, NativeModules, Platform } from 'react-native'
import { createOwnedRawTimers } from './physicalQAResources'
import { BackgroundTimer, NitroBackgroundTimer } from 'react-native-nitro-bg-timer-plus'

export const QA_SCENARIOS = ['timers', 'backlog', 'short-intervals', 'recreate', 'reload',
  'fgs', 'notification', 'optout', 'multi-owner', 'background', 'long-run', 'expiration', 'retry'] as const
export type QAScenario = (typeof QA_SCENARIOS)[number]
type RawTimer = typeof NitroBackgroundTimer
type Snapshot = { pid: number; activity?: number; context?: number; workers?: {id: number}[];
  notifications?: {title: string; text: string}[]; reloads?: number; previousRuntime?: string;
  previousContext?: number; previousWorkers?: {id: number}[] }
const runtime = `rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let used = false
export let physicalQAActive = false
const monotonicNow = () => (globalThis as unknown as {performance: {now: () => number}}).performance.now()
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export function parsePhysicalQAUrl(url: string): {runId: string; scenario: QAScenario; deviceId: string} | null {
  if (!/^nitrobgtimerexample:\/\/smoke\?/.test(url)) return null
  let entries: string[][]
  try { entries = url.split('?')[1]?.split('&').map(x => {
    const i = x.indexOf('=')
    return [x.slice(0, i), decodeURIComponent(x.slice(i + 1))]
  }) ?? [] } catch { return null }
  if (new Set(entries.map(x => x[0])).size !== entries.length) return null
  const params = Object.fromEntries(entries)
  if (params.mode !== 'qa' || !/^[A-Za-z0-9._-]{1,80}$/.test(params.runId ?? '') ||
    !QA_SCENARIOS.includes(params.scenario as QAScenario) || !/^[A-Za-z0-9:._-]{1,100}$/.test(params.deviceId ?? '')) return null
  return {runId: params.runId!, scenario: params.scenario as QAScenario, deviceId: params.deviceId!}
}

/** Explicit raw API adapter. It does not replace or instrument the library wrapper. */
function rawTimer(): RawTimer {
  const { NitroModules } = require('react-native-nitro-modules')
  return NitroModules.createHybridObject('NitroBackgroundTimer') as RawTimer
}

export async function runPhysicalQA(request: NonNullable<ReturnType<typeof parsePhysicalQAUrl>>): Promise<void> {
  if (used) throw new Error('QA requires a fresh process')
  used = true
  physicalQAActive = true
  const {runId, scenario, deviceId} = request
  const control = NativeModules.NitroBgPhysicalQA
  const snapshot = (): Snapshot => JSON.parse(Platform.OS === 'android'
    ? control.snapshot(runId) : NativeModules.NitroBgSmokeLog.physicalSnapshot())
  if (Platform.OS === 'android') control.activate(runId)
  const pid = snapshot().pid
  let seq = 0
  const emit = (event: string, data: Record<string, unknown> = {}) => {
    const row = {runId, scenario, platform: Platform.OS, deviceId, os: String(Platform.Version), pid,
      runtime, seq: ++seq, event, wall: Date.now(), mono: monotonicNow(), state: AppState.currentState, ...data}
    const message = '[NitroBgPhysical] ' + JSON.stringify(row)
    console.log(message)
    NativeModules.NitroBgSmokeLog?.log?.(message)
  }
  const check = (name: string, condition: boolean, data: Record<string, unknown> = {}) => {
    emit('CHECK', {name, outcome: condition ? 'PASS' : 'FAIL', ...data})
    if (!condition) throw new Error(name)
  }
  const raw = createOwnedRawTimers<RawTimer>()
  const makeRaw = () => raw.track(rawTimer())
  const subscription = AppState.addEventListener('change', state => emit('APP_STATE', {observed: state}))
  const started = monotonicNow()
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let outcome = 'PASS'
  let reason = ''
  const wait = async (ms: number) => { await pause(ms); if (stopped) throw new Error('scenario_cancelled') }
  const probeSubscriptions = new Set<{remove(): void}>()
  const budget = scenario === 'retry' ? 60000 : scenario === 'long-run' ? 330000 : scenario === 'expiration' ? 100000 : 45000
  const deadline = new Promise<never>((_, reject) => {
    watchdog = setTimeout(() => { stopped = true; reject(new Error('scenario_timeout')) }, budget)
  })
  const alive = () => { if (stopped) throw new Error('scenario_cancelled') }
  const drain = (timer: RawTimer) => {
    alive()
    const events = timer.drainFiredTimers()
    for (const event of events) {
      emit('NATIVE_EVENT', {timerId: event.id, timerType: event.type, nativeSequence: event.sequence})
      callback(event.id, {adapter: 'raw-dispatch'})
    }
    return events
  }
  const callback = (timerId: number, extra: Record<string, unknown> = {}) => emit('CALLBACK', {timerId, ...extra})
  emit('START', {architecture: 'new', hermes: !!(globalThis as {HermesInternal?: unknown}).HermesInternal})
  emit('APP_STATE', {observed: AppState.currentState})
  const nativeProbe = async (delayMs: number, phase: string) => {
    await new Promise<void>(resolve => {
      const listener = DeviceEventEmitter.addListener('NitroBgPhysicalProbe', (id: string) => {
        if (id !== runId || stopped) return
        listener.remove(); probeSubscriptions.delete(listener)
        emit('NATIVE_PROBE', {phase}); resolve()
      })
      probeSubscriptions.add(listener)
      control.scheduleProbe(runId, delayMs)
    })
    alive()
  }
  const tasks = async () => {
    if (scenario === 'timers') {
      let fired = 0, cancelled = 0, ticks = 0, reentrant = 0
      const order: number[] = []
      const t = BackgroundTimer.setTimeout(() => { fired++; callback(t) }, 80)
      const c = BackgroundTimer.setTimeout(() => { cancelled++; callback(c, {forbidden: true}) }, 250)
      BackgroundTimer.clearTimeout(c)
      emit('CLEAR', {timerId: c, kind: 'timeout', delay: 250})
      const i = BackgroundTimer.setInterval(() => {
        ticks++; callback(i, {tick: ticks})
        if (ticks === 3) BackgroundTimer.clearInterval(i)
      }, 40)
      for (let n = 0; n < 8; n++) {
        const id = BackgroundTimer.setTimeout(() => { order.push(n); callback(id, {order: n}) }, 120 + n * 15)
      }
      const r = BackgroundTimer.setTimeout(() => {
        const inner = BackgroundTimer.setTimeout(() => { reentrant++; callback(inner, {reentrant: true}) }, 20)
      }, 100)
      emit('SCHEDULE', {timeout: t, cancelled: c, interval: i, reentrant: r})
      await wait(650)
      check('timers', fired === 1 && cancelled === 0 && ticks === 3 && reentrant === 1 && order.join() === '0,1,2,3,4,5,6,7',
        {fired, cancelled, ticks, reentrant, order: order.join()})
      let late = 0
      BackgroundTimer.setTimeout(() => { late++; emit('FORBIDDEN_CALLBACK') }, 150)
      BackgroundTimer.setInterval(() => { late++; emit('FORBIDDEN_CALLBACK') }, 70)
      BackgroundTimer.dispose(); BackgroundTimer.dispose()
      let rejects = 0
      for (const action of [() => BackgroundTimer.setTimeout(() => {}, 1), () => BackgroundTimer.setInterval(() => {}, 1),
        () => BackgroundTimer.configure({}), () => BackgroundTimer.startBackgroundMode()]) {
        try { action() } catch { rejects++ }
      }
      await wait(350)
      check('terminal-dispose', rejects === 4 && late === 0, {rejects, late})
    } else if (scenario === 'backlog') {
      const timer = makeRaw()
      const callbacks = new Map<number, () => void>()
      const delivered: number[] = []
      const ids = new Set<number>()
      let count = 0
      for (let n = 1; n <= 1500; n++) {
        callbacks.set(n, () => { count++; delivered.push(n) })
        timer.setTimeout(n, 20)
      }
      emit('BACKLOG_ARMED', {count: 1500, drainCalls: 0})
      const blocked = monotonicNow()
      // Finite JS blockage; the independent native worker/main RunLoop can expire all timers.
      while (monotonicNow() - blocked < 350) { /* bounded */ }
      emit('BLOCK_ENDED', {duration: monotonicNow() - blocked, drainCalls: 0})
      await wait(1000)
      const events = timer.drainFiredTimers() // First and only qualifying drain.
      for (let offset = 0; offset < events.length; offset += 20) {
        emit('NATIVE_BATCH', {events: events.slice(offset, offset + 20).map(e => [e.id, e.type, e.sequence])})
        await wait(2)
      }
      emit('DRAIN', {count: events.length, drainCalls: 1})
      for (const e of events) {
        checkDuplicate(e.id, ids)
        callbacks.get(e.id)?.()
      }
      for (let offset = 0; offset < delivered.length; offset += 40) {
        emit('CALLBACK_BATCH', {timerIds: delivered.slice(offset, offset + 40), adapter: 'raw-dispatch'})
        await wait(2)
      }
      check('backlog-1500', events.length === 1500 && count === 1500 && ids.size === 1500,
        {expired: events.length, callbacks: count, unique: ids.size, drainCalls: 1})
      function checkDuplicate(id: number, seen: Set<number>) {
        if (seen.has(id)) throw new Error('duplicate_native_timeout')
        seen.add(id)
      }
    } else if (scenario === 'short-intervals') {
      const values = [0, 0.1, 0.5, 0.999, 1, 1.5, 2, 10]
      for (const value of values) {
        alive()
        let ticks = 0
        const id = BackgroundTimer.setInterval(() => { ticks++; callback(id, {value, tick: ticks}) }, value)
        await wait(90)
        BackgroundTimer.clearInterval(id)
        const atClear = ticks
        emit('CLEAR', {timerId: id, value, ticks})
        await wait(60)
        check(`interval-${value}`, ticks > 0 && ticks < 1000 && ticks === atClear, {value, ticks, atClear})
      }
      let late = 0
      BackgroundTimer.setInterval(() => { late++; emit('FORBIDDEN_CALLBACK') }, 0)
      BackgroundTimer.dispose()
      await wait(180)
      check('short-dispose', late === 0, {late})
    } else if (scenario === 'recreate') {
      const hybrid = NitroBackgroundTimer
      const baseline = BackgroundTimer.setTimeout(() => callback(baseline, {baseline: true}), 40)
      await wait(150)
      const before = snapshot()
      emit('SNAPSHOT', {stage: 'before', ...before})
      control.recreate(runId)
      for (let n = 0; n < 40 && snapshot().activity === before.activity; n++) await wait(100)
      const after = snapshot()
      emit('SNAPSHOT', {stage: 'after', ...after})
      let ticks = 0, fired = 0
      const i = BackgroundTimer.setInterval(() => { ticks++; callback(i) }, 50)
      BackgroundTimer.setTimeout(() => { fired++ }, 80)
      await wait(260)
      BackgroundTimer.clearInterval(i)
      check('recreate', before.pid === after.pid && before.context === after.context && before.activity !== after.activity &&
        after.activity !== 0 && hybrid === NitroBackgroundTimer && fired === 1 && ticks >= 3,
        {sameHybrid: hybrid === NitroBackgroundTimer, ticks, fired})
    } else if (scenario === 'reload') {
      const hybridName = NitroBackgroundTimer.name
      await wait(150)
      const current = snapshot()
      emit('HYBRID', {name: hybridName})
      emit('SNAPSHOT', {stage: current.reloads ? 'new-runtime' : 'old-runtime', ...current})
      if (!current.reloads) {
        BackgroundTimer.startBackgroundMode()
        BackgroundTimer.setInterval(() => callback(1), 100)
        await wait(250)
        emit('RELOAD_REQUEST', {context: current.context, workers: snapshot().workers})
        control.reload(runId, runtime, `nitrobgtimerexample://smoke?runId=${runId}&mode=qa&scenario=reload&deviceId=${deviceId}`)
        // This promise is abandoned by a real runtime destruction, never completed as PASS.
        await wait(40000)
        throw new Error('runtime_not_reloaded')
      }
      check('runtime-replaced', current.previousRuntime !== runtime && current.previousContext !== current.context &&
        !current.workers?.some(w => current.previousWorkers?.some(old => old.id === w.id)),
        {previousRuntime: current.previousRuntime, previousContext: current.previousContext, context: current.context})
      emit('RELOAD_CLEAN_READY')
      await wait(3500)
      emit('RELOAD_NEW_TIMER_REQUEST')
      let ticks = 0
      const i = BackgroundTimer.setInterval(() => { ticks++; callback(i) }, 60)
      await wait(300)
      BackgroundTimer.clearInterval(i)
      check('reload-timers', ticks >= 3, {ticks})
    } else if (scenario === 'notification') {
      const note = async (title: string, implicit: boolean) => {
        BackgroundTimer.configure({notification: {title, text: `${title}-text`}})
        let id: number | undefined
        if (implicit) id = BackgroundTimer.setInterval(() => {}, 1000)
        else BackgroundTimer.startBackgroundMode()
        await wait(450)
        const snap = snapshot()
        emit('SNAPSHOT', {stage: title, ...snap})
        check(title, !!snap.notifications?.some(n => n.title === title && n.text === `${title}-text`))
        if (id !== undefined) BackgroundTimer.clearInterval(id)
        BackgroundTimer.stopBackgroundMode()
        await wait(250)
      }
      await note('QA-A', false); await note('QA-B', false)
      await note('QA-C', true); await note('QA-D', true)
      // Request/stop/reconfigure without waiting for promotion, then observe the current session.
      BackgroundTimer.configure({notification: {title: 'QA-Pending', text: 'old'}})
      BackgroundTimer.startBackgroundMode(); BackgroundTimer.stopBackgroundMode()
      await note('QA-E', false)
    } else if (scenario === 'optout') {
      BackgroundTimer.disableForegroundService()
      let ticks = 0
      const i = BackgroundTimer.setInterval(() => { ticks++; callback(i) }, 60)
      BackgroundTimer.disableForegroundService()
      const other = makeRaw()
      other.disableForegroundService(); other.setTimeout(9001, 50)
      await wait(400)
      const events = drain(other)
      emit('SNAPSHOT', {stage: 'optout-active', ...snapshot()})
      await wait(2000)
      check('optout', ticks >= 3 && events.some(e => e.id === 9001) && snapshot().notifications?.length === 0, {ticks})
      BackgroundTimer.clearInterval(i)
    } else if (scenario === 'multi-owner') {
      const a = makeRaw(), b = makeRaw()
      check('distinct-owners', a !== b)
      a.configure(JSON.stringify({notification: {title: 'QA-Owner-A', text: 'A'}}))
      b.configure(JSON.stringify({notification: {title: 'QA-Owner-B', text: 'B'}}))
      const waitForNotification = async (title: string) => {
        for (let n = 0; n < 120; n++) {
          if (snapshot().notifications?.some(note => note.title === title)) return
          await wait(100)
        }
        throw new Error(`notification_not_observed:${title}`)
      }
      a.startBackgroundMode(); b.startBackgroundMode()
      a.setInterval(101, 80); b.setInterval(202, 80)
      await waitForNotification('QA-Owner-A')
      let aTicks = 0, bTicks = 0
      for (let n = 0; n < 8; n++) {
        await wait(50); aTicks += drain(a).length; bTicks += drain(b).length
      }
      check('both-owners', aTicks >= 2 && bTicks >= 2, {aTicks, bTicks})
      emit('SNAPSHOT', {stage: 'both-owners', ...snapshot()})
      a.clearInterval(101); a.stopBackgroundMode()
      await waitForNotification('QA-Owner-B')
      let afterStop = 0
      for (let n = 0; n < 6; n++) { await wait(50); afterStop += drain(b).length }
      check('owner-b-after-stop-a', afterStop >= 2 && !!snapshot().notifications?.some(n => n.title === 'QA-Owner-B'))
      raw.release(a)
      let afterDispose = 0
      for (let n = 0; n < 6; n++) { await wait(50); afterDispose += drain(b).length }
      check('owner-b-after-dispose-a', afterDispose >= 2)
      emit('SNAPSHOT', {stage: 'owner-b-only', ...snapshot()})
      b.clearInterval(202); b.stopBackgroundMode(); raw.release(b)
    } else if (scenario === 'expiration') {
      let ticks = 0
      const i = BackgroundTimer.setInterval(() => { ticks++; callback(i, {tick: ticks}) }, 1000)
      const pending = BackgroundTimer.setTimeout(() => emit('FORBIDDEN_CALLBACK'), 150000)
      emit('READY', {duration: 75000})
      let observedBackground = false
      for (let n = 0; n < 450; n++) {
        await wait(200)
        if (AppState.currentState === 'background') observedBackground = true
        if (observedBackground && AppState.currentState === 'active') break
      }
      const resumedTicks = ticks
      await wait(2200)
      BackgroundTimer.clearTimeout(pending); BackgroundTimer.clearInterval(i)
      check('expiration-resume-timers', observedBackground && AppState.currentState === 'active' && ticks > resumedTicks,
        {ticks, resumedTicks})
    } else if (['background', 'long-run', 'fgs'].includes(scenario)) {
      if (Platform.OS === 'android') BackgroundTimer.startBackgroundMode()
      let ticks = 0, backgroundCallbacks = 0
      const duration = scenario === 'long-run' ? 300000 : 25000
      const i = BackgroundTimer.setInterval(() => { ticks++; callback(i, {tick: ticks}) }, 1000)
      const t = BackgroundTimer.setTimeout(() => {
        if (AppState.currentState === 'background') backgroundCallbacks++
        callback(t, {qualifying: true})
      }, duration)
      emit('READY', {duration})
      await wait(duration + 1000)
      for (let n = 0; n < 100 && AppState.currentState !== 'active'; n++) await wait(100)
      BackgroundTimer.clearInterval(i)
      check('background-delivery', backgroundCallbacks === 1 && ticks >= 2 && AppState.currentState === 'active', {backgroundCallbacks, ticks})
      if (scenario === 'long-run') check('five-minutes', monotonicNow() - started >= 300000, {duration: monotonicNow() - started})
    } else if (scenario === 'retry') {
      // Safe real-OS refusal only. No failed-promotion fault injection on a physical phone.
      emit('READY', {duration: 20000})
      await nativeProbe(20000, 'request')
      check('retry-background-precondition', AppState.currentState === 'background')
      BackgroundTimer.startBackgroundMode()
      emit('RETRY_ATTEMPT', {phase: 'background'})
      await nativeProbe(2000, 'settle')
      emit('RESUME_READY')
      for (let n = 0; n < 100 && AppState.currentState !== 'active'; n++) await wait(100)
      BackgroundTimer.startBackgroundMode()
      for (let n = 0; n < 120 && !snapshot().notifications?.length; n++) await wait(100)
      emit('SNAPSHOT', {stage: 'retry-foreground', ...snapshot()})
      check('retry-foreground', AppState.currentState === 'active' && !!snapshot().notifications?.length)
    }
  }
  try {
    await Promise.race([tasks(), deadline])
  } catch (error) {
    outcome = 'FAIL'; reason = error instanceof Error ? error.message : String(error)
    emit('FAILURE', {reason})
  } finally {
    stopped = true
    for (const listener of probeSubscriptions) listener.remove()
    if (Platform.OS === 'android') control.cancelProbe(runId)
    if (watchdog) clearTimeout(watchdog)
    let cleaned = true
    try { BackgroundTimer.stopBackgroundMode(); BackgroundTimer.dispose() }
    catch (error) { cleaned = false; outcome = 'FAIL'; reason = String(error) }
    try { raw.disposeRemaining() }
    catch (error) { cleaned = false; outcome = 'FAIL'; reason = String(error) }
    if (!cleaned) emit('FAILURE', {reason: `cleanup: ${reason}`})
    await pause(500)
    emit('CLEANUP', {disposed: cleaned, ...snapshot()})
    subscription.remove()
    emit('RESULT', {outcome, reason, duration: monotonicNow() - started})
  }
}
