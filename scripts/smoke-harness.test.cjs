const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-validator-witness-'))
const script =
  process.env.SMOKE_VALIDATOR_SCRIPT || path.join(__dirname, 'smoke-android.sh')
const id = 'current-run'
const steps = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'batchOrdering',
  'reentrancy',
  'backgroundWindow',
  'dispose',
]
const marker = (text) => `[NitroBgSmoke] ${text} runId=${id}`
const core = () => [
  marker('START'),
  marker('TIMER_CALLBACK') + ' kind=timeout',
  marker('STEP PASS') + ' name=setTimeout',
  ...[
    ['schedule', 0],
    ['clearRequested', 1],
    ['clear', 2],
    ['observed', 302],
  ].map(
    ([kind, at], i) =>
      marker('CLEAR_TIMEOUT_EVENT') + ` seq=${i + 1} kind=${kind} at=${at}`
  ),
  marker('CLEAR_TIMEOUT_CAUSALITY') +
    ' scheduleAt=0 callbackAt=none clearAt=2 delayMs=160 order=schedule,clearRequested,clear,observed status=valid',
  marker('STEP PASS') + ' name=clearTimeout',
  marker('TIMER_CALLBACK') + ' kind=interval ticks=3',
  ...steps
    .slice(2)
    .flatMap((s) => [
      ...(s === 'backgroundWindow'
        ? [
            marker('BACKGROUND_READY'),
            ...[1, 2, 3, 4, 5, 6].map(
              (tick) => marker('BACKGROUND_TICK') + ' tick=' + tick
            ),
          ]
        : []),
      marker('STEP PASS') + ' name=' + s,
    ]),
  marker('RESULT PASS'),
]
const line = (s, platform = 'android', pid = 1234) =>
  platform === 'android'
    ? `10-14 12:00:00.000 ${pid} 1234 I ReactNativeJS: ${s}`
    : `2026-10-14 12:00:00.000 Df NitroBgTimerExample[${pid}:abcd] (Foundation) ${s}`
function validate(lines, platform = 'android', flow = 'core') {
  const file = path.join(dir, 'fixture.log')
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return spawnSync(
    'bash',
    [script, '--validate-log', file, id, platform, '1234', flow, 'final'],
    { encoding: 'utf8' }
  )
}
test('complete ordered control, including diagnostic mirrors, is accepted', () => {
  const lines = core().flatMap((m) => [line(m), line(m)])
  const r = validate(lines)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
for (const [name, mutate] of [
  ['PASS without START', (xs) => xs.slice(1)],
  ['marker-only PASS', (xs) => xs.slice(-1)],
  [
    'missing callback',
    (xs) =>
      xs.filter((x) => !x.includes('TIMER_CALLBACK') || !x.includes('timeout')),
  ],
  [
    'missing required step',
    (xs) => xs.filter((x) => !x.includes('name=batchOrdering')),
  ],
  ['wrong runId', (xs) => xs.map((x) => x.replaceAll(id, 'old-run'))],
  ['prefix runId', (xs) => xs.map((x) => x.replaceAll(id, id + '-old'))],
  [
    'late clear precondition',
    (xs) =>
      xs.map((x) => x.replace('status=valid', 'status=precondition_failed')),
  ],
  [
    'FAIL plus PASS',
    (xs) => [...xs, marker('RESULT FAIL') + ' reason=actual_failure'],
  ],
  [
    'STEP FAIL plus PASS',
    (xs) => [...xs, marker('STEP FAIL') + ' name=clearTimeout'],
  ],
  [
    'out-of-order steps',
    (xs) => [xs[0], ...xs.slice(1, -1).reverse(), xs.at(-1)],
  ],
  ['result before steps', (xs) => [xs[0], xs.at(-1), ...xs.slice(1, -1)]],
])
  test(`rejects ${name}`, () =>
    assert.equal(validate(mutate(core()).map((x) => line(x))).status, 1))
for (const platform of ['android', 'ios']) {
  test(`${platform} rejects PID mismatch and PID-less marker`, () => {
    assert.equal(
      validate(
        core().map((x) => line(x, platform, 4321)),
        platform
      ).status,
      1
    )
    assert.equal(validate(core(), platform).status, 1)
  })
  test(`${platform} rejects crash after PASS`, () => {
    const crash =
      platform === 'android'
        ? 'FATAL EXCEPTION: main'
        : "Terminating app due to uncaught exception 'NSInvalidArgumentException'"
    assert.equal(
      validate(
        [...core().map((x) => line(x, platform)), line(crash, platform)],
        platform
      ).status,
      1
    )
  })
}
test('informational iOS names/predicate are not crash evidence', () => {
  const lines = core().map((x) => line(x))
  lines.push(line('NativeEventEmitter listener installed=true'))
  lines.push(line('RCTEventEmitter module registered'))
  const r = validate(lines)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
test('unrelated Android crash does not poison the app run', () => {
  assert.equal(
    validate([
      ...core().map((x) => line(x)),
      line('FATAL EXCEPTION: main', 'android', 5678),
    ]).status,
    0
  )
})
test('pending log has distinct poll status and cannot final PASS', () => {
  assert.equal(validate([line(marker('START'))]).status, 1)
})

function iosCore() {
  const xs = core()
  xs.splice(
    1,
    0,
    marker('IOS_ARCH') + ' newArch=true',
    marker('IOS_EVENT_MODULE') + ' nativeModulePresent=true',
    marker('IOS_EVENT_LISTENER') + ' installed=true',
    marker('STEP PASS') + ' name=iosEventDiagnostics',
    marker('IOS_TIMER') + ' marker=ios-timeout-fired'
  )
  const index = xs.findIndex((x) => x.includes('kind=interval'))
  xs.splice(index, 0, marker('IOS_TIMER') + ' marker=ios-interval-fired')
  const delivery = xs.findIndex((x) => x.includes('name=clearInterval'))
  xs.splice(
    delivery,
    0,
    marker('IOS_EVENT_DELIVERY') +
      ' timeoutFired=true intervalFired=true status=ok',
    marker('IOS_EVENT_DELIVERY_OK'),
    marker('STEP PASS') + ' name=iosEventDelivery'
  )
  return xs
}
test('iOS positive and module-name informational records are accepted', () => {
  const lines = iosCore().flatMap((x) => [line(x, 'ios'), line(x, 'ios')])
  lines.unshift(
    'Filtering the log data using "NativeEventEmitter OR Fatal error"'
  )
  lines.push(
    line('NativeEventEmitter module registered', 'ios'),
    line('RCTEventEmitter listener installed', 'ios')
  )
  assert.equal(validate(lines, 'ios').status, 0)
})
for (const token of [
  'IOS_ARCH',
  'IOS_EVENT_MODULE',
  'IOS_EVENT_LISTENER',
  'ios-timeout-fired',
  'ios-interval-fired',
  'IOS_EVENT_DELIVERY_OK',
  'name=iosEventDelivery',
]) {
  test(`iOS rejects missing ${token}`, () =>
    assert.equal(
      validate(
        iosCore()
          .filter((x) => !x.includes(token))
          .map((x) => line(x, 'ios')),
        'ios'
      ).status,
      1
    ))
}
for (const text of [
  'Fatal error: actual crash',
  'TypeError: actual JS failure',
  'RCTFatal actual native failure',
  'SIGABRT',
]) {
  test(`iOS rejects ${text} after complete PASS`, () =>
    assert.equal(
      validate(
        [...iosCore().map((x) => line(x, 'ios')), line(text, 'ios')],
        'ios'
      ).status,
      1
    ))
}
for (const [name, mutate] of [
  [
    'missing events',
    (xs) => xs.filter((x) => !x.includes('CLEAR_TIMEOUT_EVENT')),
  ],
  [
    'forged timestamps',
    (xs) => xs.map((x) => x.replace('clearAt=2', 'clearAt=200')),
  ],
  [
    'callback after clear',
    (xs) => [
      ...xs,
      marker('CLEAR_TIMEOUT_EVENT') + ' seq=5 kind=callback at=350',
    ],
  ],
  ['short observation', (xs) => xs.map((x) => x.replace('at=302', 'at=30'))],
])
  test(`rejects ${name}`, () =>
    assert.equal(validate(mutate(core()).map((x) => line(x))).status, 1))
const ui = (status, section, action) =>
  `[NitroBgUiSmoke] ${status} runId=${id} section=${section} action=${action}`
const optout = () => [
  `[NitroBgUiSmoke] CONTEXT runId=${id} mode=ui`,
  ui('START', 'background', 'disable-fgs'),
  ui('PASS', 'background', 'disable-fgs'),
]
test('UI positive context/handler START/PASS accepts diagnostic mirrors', () =>
  assert.equal(
    validate(
      optout().flatMap((x) => [line(x), line(x)]),
      'android',
      'fgs-optout'
    ).status,
    0
  ))
for (const [name, mutate] of [
  ['missing handler', (xs) => xs.filter((x) => !x.includes('START'))],
  ['missing context', (xs) => xs.slice(1)],
  ['wrong context', (xs) => xs.map((x) => x.replace(id, 'old-ui'))],
  [
    'stale core disposes before UI',
    (xs) => [
      marker('START').replace(id, 'stale-core'),
      marker('STEP PASS').replace(id, 'stale-core') + ' name=dispose',
      ...xs,
    ],
  ],
  ['PASS before START', (xs) => [xs[0], xs[2], xs[1]]],
])
  test(`UI rejects ${name}`, () =>
    assert.equal(
      validate(
        mutate(optout()).map((x) => line(x)),
        'android',
        'fgs-optout'
      ).status,
      1
    ))

test('bracketed and PID-less real JS errors cannot be hidden by PASS', () => {
  assert.equal(
    validate([
      ...core().map((x) => line(x)),
      line('[TypeError: actual failure]'),
    ]).status,
    1
  )
  assert.equal(
    validate([
      ...core().map((x) => line(x)),
      'TypeError: uncorrelated actual failure',
    ]).status,
    1
  )
})
test('background callbacks must occur between READY and their step', () => {
  const xs = core()
  const ticks = xs.filter((x) => x.includes('BACKGROUND_TICK'))
  assert.equal(
    validate(
      [...xs.filter((x) => !x.includes('BACKGROUND_TICK')), ...ticks].map((x) =>
        line(x)
      )
    ).status,
    1
  )
})

test('stale core is the cause of a later disposed UI failure', () => {
  const xs = [
    marker('START').replace(id, 'old-core'),
    ...optout(),
    ui('FAIL', 'background', 'disable-fgs') +
      ' reason=background_timer_disposed',
  ]
  const r = validate(
    xs.map((x) => line(x)),
    'android',
    'fgs-optout'
  )
  assert.equal(r.status, 1)
  assert.match(r.stdout, /stale_core_disposed_before_UI/)
})

function mainUi() {
  const actions = [
    'set-timeout/schedule',
    'set-timeout/cancel',
    'set-interval/start',
    'set-interval/stop',
    'set-interval/reset',
    'background/js-comparison',
    'background/configure-notification',
    'background/start-mode',
    'background/stop-mode',
    'background/start',
    'background/stop',
    'concurrent/start-all',
    'concurrent/stop-all',
    'cleanup/mount',
    'cleanup/unmount',
    'hook/start',
    'hook/restart',
    'hook/stop',
    'stress/create-100',
    'core-smoke/run',
  ]
  return [
    `[NitroBgUiSmoke] CONTEXT runId=${id} mode=ui`,
    ...actions.flatMap((action) => {
      const [section, name] = action.split('/')
      return [
        ui('START', section, name),
        ...(section === 'core-smoke'
          ? [
              marker('UI_CORE_BINDING') + ' coreRunId=manual-current',
              ...core().map((x) => x.replaceAll(id, 'manual-current')),
            ]
          : []),
        ui('PASS', section, name),
      ]
    }),
  ]
}
test('full UI control binds its own core execution', () =>
  assert.equal(
    validate(
      mainUi().map((x) => line(x)),
      'android',
      'main'
    ).status,
    0
  ))
test('an unbound/stale core cannot satisfy the UI action by position alone', () => {
  const r = validate(
    mainUi()
      .filter((x) => !x.includes('UI_CORE_BINDING'))
      .map((x) => line(x)),
    'android',
    'main'
  )
  assert.equal(r.status, 1, r.stdout)
})

for (const [name, mutate] of [
  [
    'wrong core binding',
    (xs) =>
      xs.map((x) =>
        x.replace('coreRunId=manual-current', 'coreRunId=previous-core')
      ),
  ],
  [
    'stale UI binding',
    (xs) =>
      xs.map((x) =>
        x.includes('UI_CORE_BINDING') ? x.replace(id, 'old-ui') : x
      ),
  ],
])
  test(`UI rejects ${name}`, () =>
    assert.equal(
      validate(
        mutate(mainUi()).map((x) => line(x)),
        'android',
        'main'
      ).status,
      1
    ))

test('missing background callbacks cannot be hidden by a STEP PASS', () => {
  assert.equal(
    validate(
      core()
        .filter((x) => !x.includes('BACKGROUND_TICK'))
        .map((x) => line(x))
    ).status,
    1
  )
})

for (const crash of [
  'Unhandled JS Exception: callback crashed',
  'Exception in HostFunction: native call failed',
]) {
  test(`rejects actual React Native fatal record: ${crash}`, () => {
    assert.equal(
      validate([...core().map((x) => line(x)), line(crash)]).status,
      1
    )
  })
}
test('ambiguous duplicate marker fields cannot supply current-run authority', () => {
  const xs = core().map((x) =>
    x.replace(`runId=${id}`, `runId=previous-run runId=${id}`)
  )
  assert.equal(validate(xs.map((x) => line(x))).status, 1)
})
test('callback evidence must belong to its step window', () => {
  const xs = core()
  const interval = xs.find(
    (x) => x.includes('TIMER_CALLBACK') && x.includes('interval')
  )
  assert.equal(
    validate(
      [xs[0], interval, ...xs.slice(1).filter((x) => x !== interval)].map((x) =>
        line(x)
      )
    ).status,
    1
  )
})

for (const platform of ['android', 'ios']) {
  test(`${platform} rejects a foreign PID copy mixed into a valid current run`, () => {
    const valid = (platform === 'ios' ? iosCore() : core()).map((x) =>
      line(x, platform)
    )
    assert.equal(
      validate(
        [...valid, line(marker('RESULT PASS'), platform, 4321)],
        platform
      ).status,
      1
    )
  })
}

test('internally consistent late-clear timestamps still fail the pending precondition', () => {
  const late = core().map((x) =>
    x
      .replace('kind=clear at=2', 'kind=clear at=200')
      .replace('clearAt=2', 'clearAt=200')
  )
  assert.equal(validate(late.map((x) => line(x))).status, 1)
})

test('UI-bound core rejects a foreign PID copy even beside its valid own-process result', () => {
  const xs = mainUi().map((x) => line(x))
  xs.push(
    line(marker('RESULT PASS').replace(id, 'manual-current'), 'android', 4321)
  )
  assert.equal(validate(xs, 'android', 'main').status, 1)
})

test('foreign accessibility diagnostics quoting a current marker are not publications', () => {
  const diagnostic = line(
    'Skipping invisible child: text: [12:00:00.000] ' + marker('START'),
    'android',
    4321
  ).replace('I ReactNativeJS:', 'I Maestro :')
  assert.equal(validate([...core().map((x) => line(x)), diagnostic]).status, 0)
})
test('own-process diagnostic text cannot substitute for published smoke markers', () => {
  assert.equal(
    validate(core().map((x) => line('Diagnostic text: ' + x))).status,
    1
  )
})
test('iOS native UI mirror prefix remains a published marker with the same PID', () => {
  const xs = optout().map((x) => line('[NitroBgSmoke] ' + x, 'ios'))
  assert.equal(validate(xs, 'ios', 'fgs-optout').status, 0)
})

for (const platform of ['android', 'ios']) {
  test(`${platform} rejects an error-priority JS record with a primitive throwable`, () => {
    const xs = (platform === 'ios' ? iosCore() : core()).map((x) =>
      line(x, platform)
    )
    const failure = line('undefined', platform)
      .replace(' I ReactNativeJS:', ' E ReactNativeJS:')
      .replace(' Df ', ' E ')
      .replace('(Foundation)', '[com.facebook.react.log:javascript]')
    assert.equal(validate([...xs, failure], platform).status, 1)
  })
}
