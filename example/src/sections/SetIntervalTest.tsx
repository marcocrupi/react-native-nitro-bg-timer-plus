import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { BackgroundTimer } from 'react-native-nitro-bg-timer-plus'
import { Section } from '../components/Section'
import { useLog } from '../context/LogContext'
import {
  passUiSmokeAction,
  runUiSmokeAction,
  startUiSmokeAction,
  type UiSmokeActionToken,
} from '../smoke/uiSmoke'

export function SetIntervalTest() {
  const [seconds, setSeconds] = useState(0)
  const [running, setRunning] = useState(false)
  const intervalRef = useRef<number | null>(null)
  const startTokenRef = useRef<UiSmokeActionToken | null>(null)
  const { addLog } = useLog()

  const start = useCallback(() => {
    if (intervalRef.current) return
    startTokenRef.current = startUiSmokeAction(
      'set-interval',
      'start',
      addLog
    )
    setRunning(true)
    addLog('[setInterval] Started counter')
    intervalRef.current = BackgroundTimer.setInterval(() => {
      setSeconds((prev) => prev + 1)
      if (startTokenRef.current !== null) {
        passUiSmokeAction(startTokenRef.current, addLog)
        startTokenRef.current = null
      }
    }, 1000)
  }, [addLog])

  const stop = useCallback(() => {
    runUiSmokeAction('set-interval', 'stop', addLog, () => {
      if (intervalRef.current) {
        BackgroundTimer.clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      startTokenRef.current = null
      setRunning(false)
      addLog('[setInterval] Stopped counter')
    })
  }, [addLog])

  const reset = useCallback(() => {
    runUiSmokeAction('set-interval', 'reset', addLog, () => {
      if (intervalRef.current) {
        BackgroundTimer.clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      startTokenRef.current = null
      setRunning(false)
      setSeconds(0)
      addLog('[setInterval] Reset counter')
    })
  }, [addLog])

  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        BackgroundTimer.clearInterval(intervalRef.current)
      }
    }
  }, [])

  return (
    <Section title="2. setInterval Counter">
      <Text
        style={styles.counter}
        testID={`ui-smoke-set-interval-seconds-${seconds}`}
        accessibilityLabel={`ui-smoke-set-interval-seconds-${seconds}`}
      >
        {seconds}s
      </Text>
      <View style={styles.row}>
        <Pressable
          style={[styles.btn, styles.btnGreen, running && styles.btnDisabled]}
          onPress={start}
          disabled={running}
          testID="ui-smoke-set-interval-start"
          accessibilityLabel="ui-smoke-set-interval-start"
          accessibilityRole="button"
        >
          <Text style={styles.btnText}>Start</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnOrange, !running && styles.btnDisabled]}
          onPress={stop}
          disabled={!running}
          testID="ui-smoke-set-interval-stop"
          accessibilityLabel="ui-smoke-set-interval-stop"
          accessibilityRole="button"
        >
          <Text style={styles.btnText}>Stop</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnRed]}
          onPress={reset}
          testID="ui-smoke-set-interval-reset"
          accessibilityLabel="ui-smoke-set-interval-reset"
          accessibilityRole="button"
        >
          <Text style={styles.btnText}>Reset</Text>
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
    marginBottom: 12,
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
  btnRed: { backgroundColor: '#e74c3c' },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
})
