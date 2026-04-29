import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { BackgroundTimer } from 'react-native-nitro-bg-timer-plus'
import { Section } from '../components/Section'
import { useLog } from '../context/LogContext'
import {
  failUiSmokeAction,
  passUiSmokeAction,
  runUiSmokeAction,
  startUiSmokeAction,
  type UiSmokeActionToken,
} from '../smoke/uiSmoke'

const INTERVAL = 1000

// Mirrors every Alert to the JS console so Metro / Flipper / Chrome
// DevTools surface the same content as the on-screen dialog. Useful for
// capturing the result of manual device-side test runs without screenshots.
function alertAndLog(title: string, message: string) {
  console.log(`[Alert] ${title}: ${message}`)
  Alert.alert(title, message)
}

export function BackgroundTest() {
  const [nativeTicks, setNativeTicks] = useState(0)
  const [jsTicks, setJsTicks] = useState(0)
  const [running, setRunning] = useState(false)
  const [showJs, setShowJs] = useState(true)
  const [lastExpected, setLastExpected] = useState(0)
  const startTimeRef = useRef<number>(0)
  const nativeIdRef = useRef<number | null>(null)
  const jsIdRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const nativeTicksRef = useRef(0)
  const jsTicksRef = useRef(0)
  const startTokenRef = useRef<UiSmokeActionToken | null>(null)
  const { addLog } = useLog()

  const expectedTicks = running
    ? Math.floor((Date.now() - startTimeRef.current) / INTERVAL)
    : lastExpected

  const nativeMatch =
    nativeTicks === 0 && !running
      ? true
      : Math.abs(nativeTicks - expectedTicks) <= 2

  const start = useCallback(() => {
    const startToken = startUiSmokeAction('background', 'start', addLog)
    startTokenRef.current = startToken

    try {
      nativeTicksRef.current = 0
      jsTicksRef.current = 0
      setNativeTicks(0)
      setJsTicks(0)
      setLastExpected(0)
      startTimeRef.current = Date.now()
      setRunning(true)
      addLog('[Background] Started — put app in background now!')

      nativeIdRef.current = BackgroundTimer.setInterval(() => {
        nativeTicksRef.current += 1
        setNativeTicks(nativeTicksRef.current)
        if (startTokenRef.current !== null) {
          passUiSmokeAction(startTokenRef.current, addLog)
          startTokenRef.current = null
        }
      }, INTERVAL)

      if (showJs) {
        jsIdRef.current = setInterval(() => {
          jsTicksRef.current += 1
          setJsTicks(jsTicksRef.current)
        }, INTERVAL)
      }
    } catch (error) {
      startTokenRef.current = null
      setRunning(false)
      failUiSmokeAction(startToken, error, addLog)
      throw error
    }
  }, [showJs, addLog])

  const stop = useCallback(() => {
    runUiSmokeAction('background', 'stop', addLog, () => {
      const finalExpected = Math.floor(
        (Date.now() - startTimeRef.current) / INTERVAL
      )
      if (nativeIdRef.current !== null) {
        BackgroundTimer.clearInterval(nativeIdRef.current)
        nativeIdRef.current = null
      }
      if (jsIdRef.current !== null) {
        clearInterval(jsIdRef.current)
        jsIdRef.current = null
      }
      startTokenRef.current = null
      setLastExpected(finalExpected)
      setRunning(false)
      addLog(
        `[Background] Stopped — Native: ${nativeTicksRef.current}, JS: ${jsTicksRef.current}, Expected: ~${finalExpected}`
      )
    })
  }, [addLog])

  const toggleJsComparison = useCallback(() => {
    runUiSmokeAction('background', 'js-comparison', addLog, () => {
      setShowJs((v) => !v)
    })
  }, [addLog])

  const disableForegroundService = useCallback(() => {
    const token = startUiSmokeAction('background', 'disable-fgs', addLog)
    try {
      BackgroundTimer.disableForegroundService()
      addLog('[Background] Foreground service disabled (opt-out)')
      passUiSmokeAction(token, addLog)
      if (!token.active) {
        alertAndLog(
          'FGS disabled',
          'Foreground service opt-out active. Timers will run in wake-lock-only mode with ~10% background drift.'
        )
      }
    } catch (error) {
      failUiSmokeAction(token, error, addLog)
      if (!token.active) {
        alertAndLog(
          'Cannot disable',
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  }, [addLog])

  const startBackgroundMode = useCallback(() => {
    const token = startUiSmokeAction('background', 'start-mode', addLog)
    try {
      BackgroundTimer.startBackgroundMode()
      addLog('[Background] Background mode started')
      passUiSmokeAction(token, addLog)
    } catch (error) {
      failUiSmokeAction(token, error, addLog)
      if (!token.active) {
        alertAndLog('startBackgroundMode error', String(error))
      }
    }
  }, [addLog])

  const stopBackgroundMode = useCallback(() => {
    const token = startUiSmokeAction('background', 'stop-mode', addLog)
    try {
      BackgroundTimer.stopBackgroundMode()
      addLog('[Background] Background mode stopped')
      passUiSmokeAction(token, addLog)
    } catch (error) {
      failUiSmokeAction(token, error, addLog)
      if (!token.active) {
        alertAndLog('stopBackgroundMode error', String(error))
      }
    }
  }, [addLog])

  const configureNotification = useCallback(() => {
    const token = startUiSmokeAction(
      'background',
      'configure-notification',
      addLog
    )

    try {
      BackgroundTimer.configure({
        notification: {
          title: 'Workout in progress',
          text: 'Background timers running',
          channelId: 'nitro_bg_timer_example_channel',
          channelName: 'BgTimer Example',
        },
      })
      addLog('[Background] Notification configured')
      passUiSmokeAction(token, addLog)
      if (!token.active) {
        alertAndLog(
          'Configure Notification',
          'Custom notification config applied. It will be used the next time the foreground service starts.'
        )
      }
    } catch (error) {
      failUiSmokeAction(token, error, addLog)
      if (!token.active) {
        const message = String(error)
        if (message.includes('background mode session is active')) {
          alertAndLog(
            'Configure Notification',
            'Cannot change the notification while timers are running or background mode is active. Press Stop (and Stop BG Mode if active), then try again.'
          )
        } else {
          alertAndLog('configure error', message)
        }
      }
    }
  }, [addLog])

  useEffect(() => {
    return () => {
      if (nativeIdRef.current !== null) {
        BackgroundTimer.clearInterval(nativeIdRef.current)
      }
      if (jsIdRef.current !== null) {
        clearInterval(jsIdRef.current)
      }
    }
  }, [])

  return (
    <Section title="3. Background Test">
      <Text style={styles.instructions}>
        Press Start, then put the app in background for 30+ seconds, then come
        back.
      </Text>

      <View style={styles.statsRow}>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>Native</Text>
          <Text
            style={[
              styles.statValue,
              nativeMatch ? styles.statValueMatch : styles.statValueMismatch,
            ]}
            testID={`ui-smoke-background-native-${nativeTicks}`}
            accessibilityLabel={`ui-smoke-background-native-${nativeTicks}`}
          >
            {nativeTicks}
          </Text>
        </View>
        {showJs && (
          <View style={styles.stat}>
            <Text style={styles.statLabel}>JS</Text>
            <Text style={[styles.statValue, styles.statValueJs]}>
              {jsTicks}
            </Text>
          </View>
        )}
        <View style={styles.stat}>
          <Text style={styles.statLabel}>Expected</Text>
          <Text style={styles.statValue}>{expectedTicks}</Text>
        </View>
      </View>

      {(running || lastExpected > 0) && (
        <Text
          style={[
            styles.matchIndicator,
            nativeMatch
              ? styles.matchIndicatorMatch
              : styles.matchIndicatorMismatch,
          ]}
        >
          {nativeMatch ? 'MATCH' : 'MISMATCH'}
        </Text>
      )}

      <View style={styles.row}>
        <Pressable
          style={[styles.btn, styles.btnGreen, running && styles.btnDisabled]}
          onPress={start}
          disabled={running}
          testID="ui-smoke-background-start"
          accessibilityLabel="ui-smoke-background-start"
          accessibilityRole="button"
        >
          <Text style={styles.btnText}>Start</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnRed, !running && styles.btnDisabled]}
          onPress={stop}
          disabled={!running}
          testID="ui-smoke-background-stop"
          accessibilityLabel="ui-smoke-background-stop"
          accessibilityRole="button"
        >
          <Text style={styles.btnText}>Stop</Text>
        </Pressable>
      </View>

      <Pressable
        style={[styles.toggleBtn, running && styles.btnDisabled]}
        onPress={toggleJsComparison}
        disabled={running}
        testID="ui-smoke-background-js-comparison"
        accessibilityLabel="ui-smoke-background-js-comparison"
        accessibilityRole="button"
      >
        <Text style={styles.toggleText}>
          JS Comparison: {showJs ? 'ON' : 'OFF'}
        </Text>
      </Pressable>

      {/* B9 — background mode controls (Android foreground service). */}
      <View style={styles.bgModeRow}>
        <Pressable
          style={[styles.btn, styles.btnGrey]}
          onPress={disableForegroundService}
          testID="ui-smoke-background-disable-fgs"
          accessibilityLabel="ui-smoke-background-disable-fgs"
          accessibilityRole="button"
        >
          <Text style={styles.btnText}>Disable FGS (opt-out)</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnBlue]}
          onPress={startBackgroundMode}
          testID="ui-smoke-background-start-mode"
          accessibilityLabel="ui-smoke-background-start-mode"
          accessibilityRole="button"
        >
          <Text style={styles.btnText}>Start BG Mode</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnGrey]}
          onPress={stopBackgroundMode}
          testID="ui-smoke-background-stop-mode"
          accessibilityLabel="ui-smoke-background-stop-mode"
          accessibilityRole="button"
        >
          <Text style={styles.btnText}>Stop BG Mode</Text>
        </Pressable>
      </View>
      <Pressable
        style={styles.toggleBtn}
        onPress={configureNotification}
        testID="ui-smoke-background-configure-notification"
        accessibilityLabel="ui-smoke-background-configure-notification"
        accessibilityRole="button"
      >
        <Text style={styles.toggleText}>Configure Notification</Text>
      </Pressable>

    </Section>
  )
}

const styles = StyleSheet.create({
  instructions: {
    fontSize: 13,
    color: '#666',
    marginBottom: 12,
    lineHeight: 18,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 12,
  },
  stat: {
    alignItems: 'center',
  },
  statLabel: {
    fontSize: 12,
    color: '#888',
    marginBottom: 4,
  },
  statValue: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1a1a2e',
  },
  statValueMatch: { color: '#27ae60' },
  statValueMismatch: { color: '#e74c3c' },
  statValueJs: { color: '#f39c12' },
  matchIndicator: {
    textAlign: 'center',
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
    paddingVertical: 6,
    borderRadius: 8,
    marginBottom: 12,
    overflow: 'hidden',
  },
  matchIndicatorMatch: { backgroundColor: '#27ae60' },
  matchIndicatorMismatch: { backgroundColor: '#e74c3c' },
  row: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  btn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  btnGreen: { backgroundColor: '#27ae60' },
  btnRed: { backgroundColor: '#e74c3c' },
  btnBlue: { backgroundColor: '#2980b9' },
  btnGrey: { backgroundColor: '#7f8c8d' },
  bgModeRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
    marginBottom: 8,
  },
  btnDisabled: { opacity: 0.5 },
  btnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
    textAlign: 'center',
  },
  toggleBtn: {
    alignItems: 'center',
    paddingVertical: 8,
    backgroundColor: '#f0f0f0',
    borderRadius: 8,
  },
  toggleText: {
    fontSize: 13,
    color: '#333',
  },
})
