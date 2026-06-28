import React, { useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Section } from '../components/Section'
import { useLog } from '../context/LogContext'
import { useBackgroundTimer } from '../hooks/useBackgroundTimer'
import {
  passUiSmokeAction,
  runUiSmokeAction,
  startUiSmokeAction,
  type UiSmokeActionToken,
} from '../smoke/uiSmoke'

export function HookTest() {
  const [count, setCount] = useState(0)
  const [hookTickObserved, setHookTickObserved] = useState(false)
  const [hookRestartTickObserved, setHookRestartTickObserved] = useState(false)
  const countRef = useRef(0)
  const startTokenRef = useRef<UiSmokeActionToken | null>(null)
  const restartTokenRef = useRef<UiSmokeActionToken | null>(null)
  const { addLog } = useLog()
  const hookTickObservedTestId = hookRestartTickObserved
    ? 'ui-smoke-hook-restart-tick-observed'
    : 'ui-smoke-hook-tick-observed'

  const { start, stop, restart, isRunning } = useBackgroundTimer(
    () => {
      countRef.current += 1
      const next = countRef.current
      setCount(next)
      setHookTickObserved(true)
      if (restartTokenRef.current !== null) {
        setHookRestartTickObserved(true)
      }
      addLog(`[Hook] Tick #${next}`)
      if (startTokenRef.current !== null) {
        passUiSmokeAction(startTokenRef.current, addLog)
        startTokenRef.current = null
      }
      if (restartTokenRef.current !== null) {
        passUiSmokeAction(restartTokenRef.current, addLog)
        restartTokenRef.current = null
      }
    },
    1000,
    false
  )

  const startWithSmoke = () => {
    startTokenRef.current = startUiSmokeAction('hook', 'start', addLog)
    setHookTickObserved(false)
    setHookRestartTickObserved(false)
    start()
  }

  const stopWithSmoke = () => {
    runUiSmokeAction('hook', 'stop', addLog, () => {
      startTokenRef.current = null
      restartTokenRef.current = null
      stop()
    })
  }

  const restartWithSmoke = () => {
    restartTokenRef.current = startUiSmokeAction('hook', 'restart', addLog)
    startTokenRef.current = null
    countRef.current = 0
    setCount(0)
    setHookTickObserved(false)
    setHookRestartTickObserved(false)
    restart()
  }

  return (
    <Section title="6. useBackgroundTimer Hook">
      <Text
        style={styles.counter}
        testID={`ui-smoke-hook-count-${count}`}
        accessibilityLabel={`ui-smoke-hook-count-${count}`}
      >
        {count}
      </Text>
      {hookTickObserved && (
        <View
          style={styles.tickObserved}
          testID={hookTickObservedTestId}
          accessibilityLabel={hookTickObservedTestId}
          accessible
        >
          <Text style={styles.tickObservedText}>Hook tick observed</Text>
        </View>
      )}
      <View style={styles.statusRow}>
        <View
          style={[
            styles.indicator,
            isRunning ? styles.indicatorActive : styles.indicatorInactive,
          ]}
        />
        <Text
          style={styles.statusText}
          testID={`ui-smoke-hook-status-${isRunning ? 'running' : 'stopped'}`}
          accessibilityLabel={`ui-smoke-hook-status-${isRunning ? 'running' : 'stopped'}`}
        >
          {isRunning ? 'Running' : 'Stopped'}
        </Text>
      </View>
      <View style={styles.row}>
        <Pressable
          style={[styles.btn, styles.btnGreen, isRunning && styles.btnDisabled]}
          onPress={startWithSmoke}
          disabled={isRunning}
          testID="ui-smoke-hook-start"
          accessibilityLabel="ui-smoke-hook-start"
          accessibilityRole="button"
        >
          <Text style={styles.btnText}>Start</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnOrange, !isRunning && styles.btnDisabled]}
          onPress={stopWithSmoke}
          disabled={!isRunning}
          testID="ui-smoke-hook-stop"
          accessibilityLabel="ui-smoke-hook-stop"
          accessibilityRole="button"
        >
          <Text style={styles.btnText}>Stop</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnBlue]}
          onPress={restartWithSmoke}
          testID="ui-smoke-hook-restart"
          accessibilityLabel="ui-smoke-hook-restart"
          accessibilityRole="button"
        >
          <Text style={styles.btnText}>Restart</Text>
        </Pressable>
      </View>
    </Section>
  )
}

const styles = StyleSheet.create({
  counter: {
    fontSize: 36,
    fontWeight: '700',
    textAlign: 'center',
    color: '#1a1a2e',
    marginBottom: 8,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    gap: 6,
  },
  indicator: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  indicatorActive: { backgroundColor: '#27ae60' },
  indicatorInactive: { backgroundColor: '#ccc' },
  statusText: {
    fontSize: 13,
    color: '#666',
  },
  tickObserved: {
    backgroundColor: '#eef7ff',
    borderColor: '#3498db',
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 10,
    padding: 8,
  },
  tickObservedText: {
    color: '#1f5f8f',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  btn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  btnGreen: { backgroundColor: '#27ae60' },
  btnOrange: { backgroundColor: '#f39c12' },
  btnBlue: { backgroundColor: '#3498db' },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
})
