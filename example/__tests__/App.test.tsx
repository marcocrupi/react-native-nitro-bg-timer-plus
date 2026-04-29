/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App, { parseSmokeUrl } from '../App';

jest.mock(
  'react-native-nitro-bg-timer-plus',
  () => ({
    BackgroundTimer: {
      clearInterval: jest.fn(),
      clearTimeout: jest.fn(),
      configure: jest.fn(),
      disableForegroundService: jest.fn(),
      dispose: jest.fn(),
      setInterval: jest.fn(),
      setTimeout: jest.fn(),
      startBackgroundMode: jest.fn(),
      stopBackgroundMode: jest.fn(),
    },
  }),
  { virtual: true }
);

test('renders correctly', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
});

describe('parseSmokeUrl', () => {
  it('accepts a valid smoke runId', () => {
    expect(
      parseSmokeUrl('nitrobgtimerexample://smoke?runId=ios-device-1')
    ).toMatchObject({
      status: 'smoke',
      runId: 'ios-device-1',
      normalizedUrl: 'nitrobgtimerexample://smoke?runId=ios-device-1',
    });
  });

  it('ignores an invalid smoke runId', () => {
    expect(
      parseSmokeUrl('nitrobgtimerexample://smoke?runId=bad%20id')
    ).toMatchObject({
      status: 'ignored',
      reason: 'invalid_run_id',
      runId: null,
    });
  });

  it('ignores an invalid percent-encoded smoke runId', () => {
    expect(
      parseSmokeUrl('nitrobgtimerexample://smoke?runId=%E0%A4%A')
    ).toMatchObject({
      status: 'ignored',
      reason: 'invalid_run_id',
      runId: null,
    });
  });
});
