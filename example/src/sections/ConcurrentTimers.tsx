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

const INTERVALS = [500, 1000, 1500, 2000, 3000]

type TimerState = {
  id: number | null
  count: number
  interval: number
}

export function ConcurrentTimers() {
  const [timers, setTimers] = useState<TimerState[]>(
    INTERVALS.map((interval) => ({ id: null, count: 0, interval }))
  )
  const timersRef = useRef(timers)
  const startAllTokenRef = useRef<UiSmokeActionToken | null>(null)
  timersRef.current = timers
  const { addLog } = useLog()

  useEffect(() => {
    return () => {
      timersRef.current.forEach((t) => {
        if (t.id !== null) BackgroundTimer.clearInterval(t.id)
      })
    }
  }, [])

  const running = timers.some((t) => t.id !== null)

  const startAll = useCallback(() => {
    startAllTokenRef.current = startUiSmokeAction(
      'concurrent',
      'start-all',
      addLog
    )
    timersRef.current.forEach((t) => {
      if (t.id !== null) BackgroundTimer.clearInterval(t.id)
    })
    const newTimers = INTERVALS.map((interval, idx) => {
      const id = BackgroundTimer.setInterval(() => {
        setTimers((prev) =>
          prev.map((t, i) => (i === idx ? { ...t, count: t.count + 1 } : t))
        )
        if (startAllTokenRef.current !== null) {
          passUiSmokeAction(startAllTokenRef.current, addLog)
          startAllTokenRef.current = null
        }
      }, interval)
      return { id, count: 0, interval }
    })
    setTimers(newTimers)
    addLog(`[Concurrent] Started ${INTERVALS.length} timers`)
  }, [addLog])

  const stopAll = useCallback(() => {
    runUiSmokeAction('concurrent', 'stop-all', addLog, () => {
      timersRef.current.forEach((t) => {
        if (t.id !== null) BackgroundTimer.clearInterval(t.id)
      })
      startAllTokenRef.current = null
      setTimers(INTERVALS.map((interval) => ({ id: null, count: 0, interval })))
      addLog('[Concurrent] Stopped all timers')
    })
  }, [addLog])

  const stopRandom = useCallback(() => {
    runUiSmokeAction('concurrent', 'stop-random', addLog, () => {
      const activeIndices = timersRef.current
        .map((t, i) => (t.id !== null ? i : -1))
        .filter((i) => i >= 0)
      if (activeIndices.length === 0) return

      const idx =
        activeIndices[Math.floor(Math.random() * activeIndices.length)]!
      const timer = timersRef.current[idx]!
      if (timer.id !== null) {
        BackgroundTimer.clearInterval(timer.id)
      }
      setTimers((prev) =>
        prev.map((t, i) => (i === idx ? { ...t, id: null } : t))
      )
      addLog(`[Concurrent] Stopped timer ${timer.interval}ms`)
    })
  }, [addLog])

  return (
    <Section title="4. Concurrent Timers">
      <View style={styles.timerGrid}>
        {timers.map((t, i) => (
          <View
            key={i}
            style={[
              styles.timerBox,
              t.id === null && running && styles.timerBoxDimmed,
            ]}
          >
            <Text style={styles.timerInterval}>{t.interval}ms</Text>
            <Text
              style={styles.timerCount}
              testID={`ui-smoke-concurrent-timer-${i}-count-${t.count}`}
              accessibilityLabel={`ui-smoke-concurrent-timer-${i}-count-${t.count}`}
            >
              {t.count}
            </Text>
            <View
              style={[
                styles.dot,
                t.id !== null ? styles.dotActive : styles.dotInactive,
              ]}
            />
          </View>
        ))}
      </View>
      <View style={styles.row}>
        <Pressable
          style={[styles.btn, styles.btnGreen, running && styles.btnDisabled]}
          onPress={startAll}
          disabled={running}
          testID="ui-smoke-concurrent-start-all"
          accessibilityLabel="ui-smoke-concurrent-start-all"
          accessibilityRole="button"
        >
          <Text style={styles.btnText}>Start All</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnOrange, !running && styles.btnDisabled]}
          onPress={stopRandom}
          disabled={!running}
          testID="ui-smoke-concurrent-stop-random"
          accessibilityLabel="ui-smoke-concurrent-stop-random"
          accessibilityRole="button"
        >
          <Text style={styles.btnText}>Stop Random</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnRed, !running && styles.btnDisabled]}
          onPress={stopAll}
          disabled={!running}
          testID="ui-smoke-concurrent-stop-all"
          accessibilityLabel="ui-smoke-concurrent-stop-all"
          accessibilityRole="button"
        >
          <Text style={styles.btnText}>Stop All</Text>
        </Pressable>
      </View>
    </Section>
  )
}

const styles = StyleSheet.create({
  timerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 12,
  },
  timerBox: {
    width: 80,
    alignItems: 'center',
    padding: 8,
    backgroundColor: '#f8f8f8',
    borderRadius: 8,
  },
  timerBoxDimmed: { opacity: 0.4 },
  timerInterval: {
    fontSize: 11,
    color: '#888',
  },
  timerCount: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1a1a2e',
    marginVertical: 2,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotActive: { backgroundColor: '#27ae60' },
  dotInactive: { backgroundColor: '#ccc' },
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
