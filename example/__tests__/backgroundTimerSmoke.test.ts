import { verifyPendingTimeoutCancellation } from '../src/smoke/backgroundTimerSmoke';

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: {
    currentState: 'active',
    addEventListener: () => ({ remove: jest.fn() }),
  },
  NativeModules: {},
  NativeEventEmitter: jest.fn(),
}));
jest.mock(
  'react-native-nitro-bg-timer-plus',
  () => ({
    BackgroundTimer: {
      setTimeout: (callback: () => void, delay: number) =>
        setTimeout(callback, delay),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      setInterval: (callback: () => void, delay: number) =>
        setInterval(callback, delay),
      clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
      dispose: jest.fn(),
    },
  }),
  { virtual: true },
);

const realSetTimeout = setTimeout;
const realDateNow = Date.now;
const options = { runId: 'causality-witness', log: jest.fn() };

beforeEach(() => {
  expect(setTimeout).toBe(realSetTimeout);
  expect(Date.now).toBe(realDateNow);
  jest.resetModules();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  options.log.mockClear();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  jest.clearAllMocks();
  jest.resetModules();
});

test('controlled JS stall reproduces the old false after-clear verdict', async () => {
  jest.useFakeTimers();
  let fired = false;
  const events: string[] = ['scheduleAt=0'];
  const id = setTimeout(() => {
    fired = true;
    events.push(`callbackAt=${Date.now()} order=2`);
  }, 160);
  const clear = new Promise<void>(resolve => setTimeout(resolve, 25)).then(
    () => {
      events.push(`clearAt=${Date.now()} order=3`);
      clearTimeout(id);
    },
  );
  // One blocked JS turn: both timers become runnable before the await continues.
  jest.advanceTimersByTime(200);
  await clear;
  expect(fired).toBe(true); // the old boolean would falsely say "after clear"
  expect(events[1]).toContain('callbackAt=');
  expect(events[2]).toContain('clearAt=');
});

function fixture(mode: 'pending' | 'early' | 'late' | 'deadline') {
  let time = 0;
  let callback: () => void = () => {};
  const clear = jest.fn();
  return {
    clear,
    schedule: jest.fn((cb: () => void) => {
      callback = cb;
      if (mode === 'early') {
        time = 200;
        callback();
      }
      if (mode === 'deadline') time = 160;
      return 7;
    }),
    wait: async () => {
      time = 300;
      if (mode === 'late') callback();
    },
    now: () => time,
  };
}

test('cancels pending timeout before its deadline and observes the window', async () => {
  const timers = fixture('pending');
  await expect(
    verifyPendingTimeoutCancellation(options, timers),
  ).resolves.toBeUndefined();
  expect(timers.clear).toHaveBeenCalledWith(7);
  expect(options.log).toHaveBeenCalledWith(
    expect.stringContaining('status=valid'),
  );
});

test('callback before clear is a failed precondition, never callback after clear', async () => {
  await expect(
    verifyPendingTimeoutCancellation(options, fixture('early')),
  ).rejects.toThrow('clearTimeout_precondition_failed_callback_before_clear');
  expect(options.log).toHaveBeenCalledWith(
    expect.stringContaining('callbackAt=200'),
  );
});

test('clear at/after deadline without a callback still cannot PASS', async () => {
  await expect(
    verifyPendingTimeoutCancellation(options, fixture('deadline')),
  ).rejects.toThrow('clearTimeout_precondition_failed_deadline');
});

test('a real callback after valid clear fails with causality recorded', async () => {
  await expect(
    verifyPendingTimeoutCancellation(options, fixture('late')),
  ).rejects.toThrow('callback_fired_after_clearTimeout');
  expect(options.log).toHaveBeenCalledWith(
    expect.stringContaining(
      'order=schedule,clearRequested,clear,callback,observed',
    ),
  );
});

test('full core cancels before deadline; cross-run request and disposed rerun fail explicitly', async () => {
  jest.useFakeTimers();
  const {
    runBackgroundTimerSmokeTest,
  } = require('../src/smoke/backgroundTimerSmoke');
  const run = runBackgroundTimerSmokeTest({ runId: 'first' });
  const same = runBackgroundTimerSmokeTest({ runId: 'first' });
  expect(same).toBe(run);
  await expect(
    runBackgroundTimerSmokeTest({ runId: 'other' }),
  ).resolves.toMatchObject({
    runId: 'other',
    status: 'fail',
    reason: 'smoke_run_in_progress',
  });
  await jest.advanceTimersByTimeAsync(6000);
  await expect(run).resolves.toMatchObject({ runId: 'first', status: 'pass' });
  await expect(
    runBackgroundTimerSmokeTest({ runId: 'disposed-rerun' }),
  ).resolves.toMatchObject({
    runId: 'disposed-rerun',
    status: 'fail',
    reason: 'background_timer_disposed_reload_required',
  });
});

test('a callback after the clear step observation still fails the full run', async () => {
  jest.resetModules();
  jest.useFakeTimers();
  const { BackgroundTimer } = require('react-native-nitro-bg-timer-plus');
  const schedule = BackgroundTimer.setTimeout;
  jest
    .spyOn(BackgroundTimer, 'setTimeout')
    .mockImplementation((callback: unknown, delay: unknown) => {
      const cb = callback as () => void;
      const ms = delay as number;
      const id = schedule(cb, ms);
      if (ms === 160) setTimeout(cb, 450);
      return id;
    });
  const {
    runBackgroundTimerSmokeTest: runSmoke,
  } = require('../src/smoke/backgroundTimerSmoke');
  const run = runSmoke({ runId: 'late-after-step' });
  await jest.advanceTimersByTimeAsync(6000);
  await expect(run).resolves.toMatchObject({
    status: 'fail',
    reason: 'callback_fired_after_clearTimeout',
  });
});

test('real JS load boundary uses a finite deterministic deadline fixture', async () => {
  // Equivalent causal boundary: clear completes at the deadline, before callback.
  // No synchronous loop can prevent Jest from completing a negative suite.
  await expect(
    verifyPendingTimeoutCancellation(options, fixture('deadline')),
  ).rejects.toThrow('clearTimeout_precondition_failed_deadline');
  expect(options.log).toHaveBeenCalledWith(
    expect.stringContaining('status=precondition_failed'),
  );
  expect(setTimeout).toBe(realSetTimeout);
  expect(Date.now).toBe(realDateNow);
  await new Promise<void>(resolve => setTimeout(resolve, 1));
});
