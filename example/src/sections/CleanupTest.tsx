import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { BackgroundTimer } from 'react-native-nitro-bg-timer-plus'
import { Section } from '../components/Section'
import { useLog } from '../context/LogContext'
import {
  failUiSmokeAction,
  passUiSmokeAction,
  startUiSmokeAction,
  type UiSmokeActionToken,
} from '../smoke/uiSmoke'

const INTERVALS = [800, 1200, 2000]

function TimerChild({
  onLog,
}: {
  onLog: (msg: string) => void
}) {
  const idsRef = useRef<number[]>([])
  const onLogRef = useRef(onLog)
  useEffect(() => {
    onLogRef.current = onLog
  }, [onLog])

  useEffect(() => {
    const ids = INTERVALS.map((ms, i) => {
      const id = BackgroundTimer.setInterval(() => {
        onLogRef.current(`Timer ${i + 1} (${ms}ms) fired`)
      }, ms)
      return id
    })
    idsRef.current = ids
    onLogRef.current(`Mounted — started ${ids.length} intervals`)

    return () => {
      ids.forEach((id) => BackgroundTimer.clearInterval(id))
      onLogRef.current('Unmounted — cleanup called, all intervals cleared')
    }
  }, [])

  return (
    <View style={styles.childBox}>
      <Text style={styles.childText}>
        Child mounted with {INTERVALS.length} intervals
      </Text>
    </View>
  )
}

export function CleanupTest() {
  const [mounted, setMounted] = useState(false)
  const [localLogs, setLocalLogs] = useState<{ id: number; msg: string }[]>([])
  const cleanupTickCount = localLogs.filter((entry) =>
    entry.msg.startsWith('Timer ')
  ).length
  const cleanupTickStateId =
    cleanupTickCount > 0
      ? 'ui-smoke-cleanup-tick-observed'
      : 'ui-smoke-cleanup-waiting'
  const localLogIdRef = useRef(0)
  const { addLog } = useLog()
  const scrollRef = useRef<ScrollView>(null)
  const mountTokenRef = useRef<UiSmokeActionToken | null>(null)
  const unmountTokenRef = useRef<UiSmokeActionToken | null>(null)
  const unmountVerificationRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )

  const handleLog = useCallback(
    (msg: string) => {
      localLogIdRef.current += 1
      const id = localLogIdRef.current
      setLocalLogs((prev) => [...prev.slice(-49), { id, msg }])
      addLog(`[Cleanup] ${msg}`)
      if (msg.startsWith('Timer ') && mountTokenRef.current !== null) {
        passUiSmokeAction(mountTokenRef.current, addLog)
        mountTokenRef.current = null
      }
      if (msg.startsWith('Timer ') && unmountTokenRef.current !== null) {
        failUiSmokeAction(
          unmountTokenRef.current,
          'tick_after_unmount',
          addLog
        )
        unmountTokenRef.current = null
      }
    },
    [addLog]
  )

  const toggleMounted = useCallback(() => {
    if (mounted) {
      const unmountToken = startUiSmokeAction('cleanup', 'unmount', addLog)
      unmountTokenRef.current = unmountToken
      mountTokenRef.current = null
      setMounted(false)

      if (unmountVerificationRef.current !== null) {
        clearTimeout(unmountVerificationRef.current)
      }

      unmountVerificationRef.current = setTimeout(() => {
        if (unmountTokenRef.current === unmountToken) {
          passUiSmokeAction(unmountToken, addLog)
          unmountTokenRef.current = null
        }
        unmountVerificationRef.current = null
      }, 750)
      return
    }

    if (unmountVerificationRef.current !== null) {
      clearTimeout(unmountVerificationRef.current)
      unmountVerificationRef.current = null
    }
    mountTokenRef.current = startUiSmokeAction('cleanup', 'mount', addLog)
    setMounted(true)
  }, [addLog, mounted])

  useEffect(() => {
    return () => {
      if (unmountVerificationRef.current !== null) {
        clearTimeout(unmountVerificationRef.current)
      }
    }
  }, [])

  return (
    <Section title="5. Cleanup on Unmount">
      <Text style={styles.desc}>
        Mount/unmount a child component that creates 3 intervals. Verify that
        after unmount, no more ticks appear.
      </Text>
      <Pressable
        style={[styles.btn, mounted ? styles.btnRed : styles.btnGreen]}
        onPress={toggleMounted}
        testID={mounted ? 'ui-smoke-cleanup-unmount' : 'ui-smoke-cleanup-mount'}
        accessibilityLabel={
          mounted ? 'ui-smoke-cleanup-unmount' : 'ui-smoke-cleanup-mount'
        }
        accessibilityRole="button"
      >
        <Text style={styles.btnText}>
          {mounted ? 'Unmount Component' : 'Mount Component'}
        </Text>
      </Pressable>
      {mounted && <TimerChild onLog={handleLog} />}
      <ScrollView
        ref={scrollRef}
        style={styles.logBox}
        nestedScrollEnabled
        testID={cleanupTickStateId}
        accessibilityLabel={cleanupTickStateId}
        onContentSizeChange={() =>
          scrollRef.current?.scrollToEnd({ animated: false })
        }
      >
        {localLogs.length === 0 ? (
          <Text style={styles.logEmpty}>No events yet</Text>
        ) : (
          localLogs.map((entry) => (
            <Text key={entry.id} style={styles.logLine}>
              {entry.msg}
            </Text>
          ))
        )}
      </ScrollView>
    </Section>
  )
}

const styles = StyleSheet.create({
  desc: {
    fontSize: 13,
    color: '#666',
    marginBottom: 10,
    lineHeight: 18,
  },
  btn: {
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 10,
  },
  btnGreen: { backgroundColor: '#27ae60' },
  btnRed: { backgroundColor: '#e74c3c' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  childBox: {
    backgroundColor: '#e8f5e9',
    padding: 10,
    borderRadius: 8,
    marginBottom: 10,
  },
  childText: {
    fontSize: 13,
    color: '#27ae60',
    textAlign: 'center',
  },
  logBox: {
    maxHeight: 120,
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    padding: 8,
  },
  logEmpty: {
    fontSize: 11,
    color: '#999',
    fontFamily: 'monospace',
  },
  logLine: {
    fontSize: 11,
    color: '#333',
    fontFamily: 'monospace',
    lineHeight: 16,
  },
})
