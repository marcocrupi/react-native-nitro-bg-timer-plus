import React, { useEffect, useRef } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Section } from '../components/Section'
import { useLog } from '../context/LogContext'
import type { SmokeUiState } from '../smoke/backgroundTimerSmoke'
import {
  failUiSmokeAction,
  passUiSmokeAction,
  startUiSmokeAction,
  type UiSmokeActionToken,
} from '../smoke/uiSmoke'

type Props = {
  state: SmokeUiState
  onRun: () => void
}

export function SmokeTest({ state, onRun }: Props) {
  const { addLog } = useLog()
  const coreRunTokenRef = useRef<UiSmokeActionToken | null>(null)
  const isRunning = state.status === 'running'
  const isTerminal = state.status === 'pass' || state.status === 'fail'
  const statusLabel = state.status.toUpperCase()
  const statusStyle =
    state.status === 'pass'
      ? styles.statusPass
      : state.status === 'fail'
        ? styles.statusFail
        : isRunning
          ? styles.statusRunning
          : styles.statusIdle

  useEffect(() => {
    if (coreRunTokenRef.current === null) return

    if (state.status === 'pass') {
      passUiSmokeAction(coreRunTokenRef.current, addLog)
      coreRunTokenRef.current = null
      return
    }

    if (state.status === 'fail') {
      failUiSmokeAction(
        coreRunTokenRef.current,
        state.reason ?? 'core_smoke_failed',
        addLog
      )
      coreRunTokenRef.current = null
    }
  }, [addLog, state.reason, state.status])

  const runCoreSmoke = () => {
    coreRunTokenRef.current = startUiSmokeAction('core-smoke', 'run', addLog)
    onRun()
  }

  return (
    <Section title="0. Automated Smoke Test">
      <View style={styles.summaryRow}>
        <Text style={styles.label}>Status</Text>
        <Text
          style={[styles.status, statusStyle]}
          testID={`ui-smoke-core-status-${state.status}`}
          accessibilityLabel={`ui-smoke-core-status-${state.status}`}
        >
          {statusLabel}
        </Text>
      </View>

      {state.runId && (
        <Text style={styles.meta} numberOfLines={1}>
          runId: {state.runId}
        </Text>
      )}

      {state.reason && (
        <Text style={styles.reason}>reason: {state.reason}</Text>
      )}

      <Pressable
        style={[styles.btn, (isRunning || isTerminal) && styles.btnDisabled]}
        onPress={runCoreSmoke}
        disabled={isRunning || isTerminal}
        testID="ui-smoke-core-run"
        accessibilityLabel="ui-smoke-core-run"
        accessibilityRole="button"
      >
        <Text style={styles.btnText}>
          {isRunning
            ? 'Running Smoke'
            : isTerminal
              ? 'Reload App to Rerun'
              : 'Run Smoke'}
        </Text>
      </Pressable>
    </Section>
  )
}

const styles = StyleSheet.create({
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  label: {
    fontSize: 13,
    color: '#333',
  },
  status: {
    fontSize: 14,
    fontWeight: '800',
  },
  statusIdle: { color: '#888' },
  statusRunning: { color: '#f39c12' },
  statusPass: { color: '#27ae60' },
  statusFail: { color: '#e74c3c' },
  meta: {
    fontSize: 12,
    color: '#666',
    marginBottom: 8,
  },
  reason: {
    fontSize: 12,
    color: '#e74c3c',
    marginBottom: 8,
  },
  btn: {
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: '#1f6feb',
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
})
