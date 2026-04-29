import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Linking,
  NativeModules,
  PermissionsAndroid,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context'
import { LogProvider, useLog } from './src/context/LogContext'
import { LogView } from './src/components/LogView'
import { SetTimeoutTest } from './src/sections/SetTimeoutTest'
import { SetIntervalTest } from './src/sections/SetIntervalTest'
import { BackgroundTest } from './src/sections/BackgroundTest'
import { ConcurrentTimers } from './src/sections/ConcurrentTimers'
import { CleanupTest } from './src/sections/CleanupTest'
import { HookTest } from './src/sections/HookTest'
import { StressTest } from './src/sections/StressTest'
import { SmokeTest } from './src/sections/SmokeTest'
import {
  createSmokeRunId,
  emitSmokeMarker,
  runBackgroundTimerSmokeTest,
  type SmokeUiState,
} from './src/smoke/backgroundTimerSmoke'
import { activateUiSmokeRun } from './src/smoke/uiSmoke'

const SMOKE_RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/
const SMOKE_URL_LOG_MAX_LENGTH = 180
const NATIVE_PENDING_URL_POLL_INTERVAL_MS = 500
const NATIVE_PENDING_URL_POLL_TIMEOUT_MS = 30000

type SmokeUrlSource = 'initial' | 'event' | 'native_pending_url'

type NitroBgSmokeLogModule = {
  consumePendingSmokeUrl?: () =>
    | string
    | null
    | Promise<string | null | undefined>
    | undefined
}

type SmokeUrlParseResult =
  | {
      status: 'smoke'
      mode: 'core' | 'ui'
      runId: string
      normalizedUrl: string
    }
  | {
      status: 'ignored'
      reason: string
      runId: string | null
      normalizedUrl: string
    }

function App() {
  return (
    <SafeAreaProvider>
      <LogProvider>
        <AppContent />
      </LogProvider>
    </SafeAreaProvider>
  )
}

function AppContent() {
  const { addLog } = useLog()
  const [smokeState, setSmokeState] = useState<SmokeUiState>({
    status: 'idle',
  })
  const activeSmokeRef = useRef<Promise<void> | null>(null)
  const handledSmokeUrlsRef = useRef<Set<string>>(new Set())
  const handledSmokeRunIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
      ).catch(() => {})
    }
  }, [])

  const startSmoke = useCallback(
    (runId = createSmokeRunId()) => {
      if (activeSmokeRef.current) return

      const startedAt = Date.now()
      setSmokeState({ status: 'running', runId, startedAt })

      const run = runBackgroundTimerSmokeTest({
        runId,
        log: addLog,
      })
        .then((result) => {
          setSmokeState({
            status: result.status,
            runId: result.runId,
            reason: result.reason,
            startedAt: result.startedAt,
            finishedAt: result.finishedAt,
          })
        })
        .catch((error) => {
          const reason = normalizeSmokeReason(error)
          const message = `[NitroBgSmoke] RESULT FAIL runId=${runId} reason=${reason}`
          emitSmokeMarker(message, addLog)
          setSmokeState({
            status: 'fail',
            runId,
            reason,
            startedAt,
            finishedAt: Date.now(),
          })
        })
        .finally(() => {
          activeSmokeRef.current = null
        })

      activeSmokeRef.current = run
    },
    [addLog]
  )

  const handleSmokeUrl = useCallback(
    (url: string | null, source: SmokeUrlSource) => {
      if (!url) return

      const parsed = parseSmokeUrl(url)
      emitSmokeDiagnostic(
        `[NitroBgSmoke] DEEPLINK_RECEIVED runId=${parsed.runId ?? 'none'} url=${parsed.normalizedUrl} source=${source}`,
        addLog
      )

      if (parsed.status === 'ignored') {
        emitSmokeDiagnostic(
          `[NitroBgSmoke] DEEPLINK_IGNORED runId=${parsed.runId ?? 'none'} reason=${parsed.reason} url=${parsed.normalizedUrl} source=${source}`,
          addLog
        )
        return
      }

      if (
        handledSmokeUrlsRef.current.has(url) ||
        handledSmokeRunIdsRef.current.has(parsed.runId)
      ) {
        emitSmokeDiagnostic(
          `[NitroBgSmoke] DEEPLINK_IGNORED runId=${parsed.runId} reason=duplicate url=${parsed.normalizedUrl} source=${source}`,
          addLog
        )
        return
      }

      handledSmokeUrlsRef.current.add(url)
      handledSmokeRunIdsRef.current.add(parsed.runId)
      emitSmokeDiagnostic(
        `[NitroBgSmoke] RUN_REQUESTED runId=${parsed.runId} mode=${parsed.mode}`,
        addLog
      )

      if (parsed.mode === 'ui') {
        activateUiSmokeRun(parsed.runId)
        emitSmokeDiagnostic(
          `[NitroBgUiSmoke] CONTEXT runId=${parsed.runId} mode=ui`,
          addLog
        )
        return
      }

      startSmoke(parsed.runId)
    },
    [addLog, startSmoke]
  )

  useEffect(() => {
    let mounted = true
    let pendingUrlInterval: ReturnType<typeof setInterval> | undefined
    let pendingUrlTimeout: ReturnType<typeof setTimeout> | undefined
    let pendingUrlCheckInFlight = false
    let pendingUrlEmptyLogged = false

    const stopPendingUrlPolling = () => {
      if (pendingUrlInterval !== undefined) {
        clearInterval(pendingUrlInterval)
        pendingUrlInterval = undefined
      }

      if (pendingUrlTimeout !== undefined) {
        clearTimeout(pendingUrlTimeout)
        pendingUrlTimeout = undefined
      }
    }

    const checkNativePendingSmokeUrl = () => {
      if (pendingUrlCheckInFlight) return

      const smokeLog = NativeModules.NitroBgSmokeLog as
        | NitroBgSmokeLogModule
        | undefined
      const consumePendingSmokeUrl = smokeLog?.consumePendingSmokeUrl

      if (!consumePendingSmokeUrl) {
        if (!pendingUrlEmptyLogged) {
          pendingUrlEmptyLogged = true
          emitSmokeDiagnostic(
            '[NitroBgSmoke] NATIVE_PENDING_URL_EMPTY runId=none reason=module_unavailable',
            addLog
          )
        }
        stopPendingUrlPolling()
        return
      }

      pendingUrlCheckInFlight = true

      Promise.resolve(consumePendingSmokeUrl())
        .then((pendingUrl) => {
          pendingUrlCheckInFlight = false
          if (!mounted) return

          if (typeof pendingUrl !== 'string' || pendingUrl.length === 0) {
            if (!pendingUrlEmptyLogged) {
              pendingUrlEmptyLogged = true
              emitSmokeDiagnostic(
                '[NitroBgSmoke] NATIVE_PENDING_URL_EMPTY runId=none',
                addLog
              )
            }
            return
          }

          const parsed = parseSmokeUrl(pendingUrl)
          emitSmokeDiagnostic(
            `[NitroBgSmoke] NATIVE_PENDING_URL_FOUND runId=${parsed.runId ?? 'none'} url=${parsed.normalizedUrl}`,
            addLog
          )
          handleSmokeUrl(pendingUrl, 'native_pending_url')
          stopPendingUrlPolling()
        })
        .catch((error) => {
          pendingUrlCheckInFlight = false
          if (!mounted) return

          emitSmokeDiagnostic(
            `[NitroBgSmoke] NATIVE_PENDING_URL_EMPTY runId=none reason=${normalizeSmokeReason(error)}`,
            addLog
          )
          stopPendingUrlPolling()
        })
    }

    Linking.getInitialURL()
      .then((url) => {
        if (mounted) handleSmokeUrl(url, 'initial')
      })
      .catch(() => {})

    const subscription = Linking.addEventListener('url', ({ url }) => {
      handleSmokeUrl(url, 'event')
    })

    if (Platform.OS === 'ios') {
      emitSmokeDiagnostic(
        '[NitroBgSmoke] NATIVE_PENDING_URL_CHECK runId=none',
        addLog
      )
      pendingUrlInterval = setInterval(
        checkNativePendingSmokeUrl,
        NATIVE_PENDING_URL_POLL_INTERVAL_MS
      )
      pendingUrlTimeout = setTimeout(
        stopPendingUrlPolling,
        NATIVE_PENDING_URL_POLL_TIMEOUT_MS
      )
      checkNativePendingSmokeUrl()
    }

    return () => {
      mounted = false
      stopPendingUrlPolling()
      subscription.remove()
    }
  }, [addLog, handleSmokeUrl])

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>Nitro BG Timer</Text>
          <Text style={styles.subtitle}>Test Suite</Text>
        </View>

        <SetTimeoutTest />
        <SetIntervalTest />
        <BackgroundTest />
        <ConcurrentTimers />
        <CleanupTest />
        <HookTest />
        <StressTest />
        <SmokeTest state={smokeState} onRun={() => startSmoke()} />
        <LogView />
      </ScrollView>
    </SafeAreaView>
  )
}

export function parseSmokeUrl(url: string): SmokeUrlParseResult {
  const normalizedUrl = normalizeSmokeUrlForLog(url)

  if (!url.startsWith('nitrobgtimerexample:/')) {
    return {
      status: 'ignored',
      reason: 'unsupported_scheme',
      runId: null,
      normalizedUrl,
    }
  }

  const [rawRoutePart, queryPart = ''] = url.split('?')
  const routePart = rawRoutePart ?? ''
  const route = routePart
    .replace(/^nitrobgtimerexample:\/+/, '')
    .replace(/^\/+/, '')

  if (!route) {
    return {
      status: 'ignored',
      reason: 'missing_route',
      runId: null,
      normalizedUrl,
    }
  }

  if (route !== 'smoke') {
    return {
      status: 'ignored',
      reason: 'not_smoke_route',
      runId: null,
      normalizedUrl,
    }
  }

  const query = queryPart.split('#')[0] ?? ''
  const mode = parseSmokeMode(findSmokeQueryParam(query, 'mode'))
  if (mode === null) {
    return {
      status: 'ignored',
      reason: 'unsupported_mode',
      runId: null,
      normalizedUrl,
    }
  }

  const rawRunId = findSmokeQueryParam(query, 'runId')

  if (rawRunId === undefined) {
    const runId = createSmokeRunId(mode === 'ui' ? 'ui-deeplink' : 'deeplink')
    return {
      status: 'smoke',
      mode,
      runId,
      normalizedUrl: buildSmokeUrlForLog(runId, mode),
    }
  }

  const runId = parseSmokeRunId(rawRunId)
  if (runId) {
    return {
      status: 'smoke',
      mode,
      runId,
      normalizedUrl: buildSmokeUrlForLog(runId, mode),
    }
  }

  return {
    status: 'ignored',
    reason: 'invalid_run_id',
    runId: null,
    normalizedUrl,
  }
}

function findSmokeQueryParam(
  query: string,
  paramName: string
): string | undefined {
  const queryParam = query.split('&').find((part) => {
    const separatorIndex = part.indexOf('=')
    const key = separatorIndex === -1 ? part : part.slice(0, separatorIndex)
    return key === paramName
  })

  if (queryParam === undefined) return undefined

  const separatorIndex = queryParam.indexOf('=')
  return separatorIndex === -1 ? '' : queryParam.slice(separatorIndex + 1)
}

function parseSmokeRunId(rawRunId: string): string | null {
  try {
    const runId = decodeURIComponent(rawRunId)
    return SMOKE_RUN_ID_PATTERN.test(runId) ? runId : null
  } catch {
    return null
  }
}

function parseSmokeMode(rawMode: string | undefined): 'core' | 'ui' | null {
  if (rawMode === undefined || rawMode.length === 0) return 'core'

  try {
    const mode = decodeURIComponent(rawMode)
    return mode === 'ui' ? 'ui' : null
  } catch {
    return null
  }
}

function buildSmokeUrlForLog(runId: string, mode: 'core' | 'ui'): string {
  const modePart = mode === 'ui' ? '&mode=ui' : ''
  return `nitrobgtimerexample://smoke?runId=${runId}${modePart}`
}

function normalizeSmokeUrlForLog(url: string): string {
  const normalized = url
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_.:/?&=%+-]/g, '_')
    .slice(0, SMOKE_URL_LOG_MAX_LENGTH)

  return normalized || 'empty'
}

function emitSmokeDiagnostic(
  message: string,
  log: (message: string) => void
): void {
  emitSmokeMarker(message, log)
}

function normalizeSmokeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const sanitized = message
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_.:/-]/g, '_')
    .slice(0, 160)

  return sanitized || 'unknown'
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  header: {
    alignItems: 'center',
    marginBottom: 20,
    paddingTop: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: '#1a1a2e',
  },
  subtitle: {
    fontSize: 14,
    color: '#888',
    marginTop: 2,
  },
})

export default App
