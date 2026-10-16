/* eslint-env node, es2022 */
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const script = path.join(__dirname, 'compat-matrix.sh')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-matrix-tests-'))
const bin = path.join(scratch, 'bin')
fs.mkdirSync(bin)

// All external/native commands are fixtures. Exercise the public shell entry
// point without touching an SDK, device, package registry or installed app.
const fixture = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const name = path.basename(process.argv[1])
let args = process.argv.slice(2)
const scenario = process.env.COMPAT_FIXTURE_CASE
const app = process.env.COMPAT_FIXTURE_APP
const trace = (event) => fs.appendFileSync(process.env.COMPAT_FIXTURE_TRACE,
  JSON.stringify({ name, args, pid: process.pid, event }) + '\n')
trace('called')
const fail = () => { console.error('FIXTURE_ERROR ' + scenario); process.exit(41) }
const mkdir = (p) => fs.mkdirSync(p, { recursive: true })
function marker() {
  const source = fs.readFileSync(path.join(app, 'App.tsx'), 'utf8')
  const runId = source.match(/runId: '([^']+)'/)?.[1]
  const result = {
    status: scenario === 'explicit-fail' ? 'FAIL' : 'PASS',
    runId, rn: '0.78.3', os: process.env.COMPAT_FIXTURE_PLATFORM,
    elapsed: 300, ticks: 6, clearedFired: false,
  }
  if (scenario === 'foreign-rn') result.rn = '0.88.0'
  if (scenario === 'foreign-os') result.os = 'other'
  if (scenario === 'foreign-run') result.runId = 'previous-run'
  if (scenario === 'bad-timing') result.elapsed = 1
  if (scenario === 'bad-ticks') result.ticks = 0
  if (scenario === 'cancel-fired') result.clearedFired = true
  if (scenario === 'unknown-status') result.status = 'PASSISH'
  if (scenario === 'malformed') return '[NitroBgCompat] {not-json}'
  if (!runId) return '[NitroBgCompat] ' + result.status + ' rn=' + result.rn + ' os=' + result.os
  return '[NitroBgCompat] ' + JSON.stringify(result)
}
if (name === 'npm') {
  if (args[0] === 'pack') {
    const out = args[args.indexOf('--pack-destination') + 1]
    mkdir(out); fs.writeFileSync(path.join(out, 'fixture.tgz'), 'archive')
  } else {
    if (scenario === 'npm-fail') fail()
    if (scenario === 'pinned-host' && !args.some(a => a.endsWith('.tgz')) &&
        !args.includes('@react-native/virtualized-lists@0.78.3')) fail()
    if (scenario === 'strict-peers' &&
        !['--strict-peer-deps', '--legacy-peer-deps=false', '--force=false'].every(a => args.includes(a))) fail()
    // npm resolves a relative tarball from the application's directory.
    for (const arg of args.filter(a => a.endsWith('.tgz'))) {
      if (!fs.existsSync(path.resolve(arg))) fail()
    }
  }
} else if (name === 'npx' && args.includes('patch-package@8.0.1')) {
  if (scenario === 'nitro-patch-fail') fail()
  const patchDir = args[args.indexOf('--patch-dir') + 1]
  if (!args.includes('--error-on-fail') || !fs.existsSync(path.join(patchDir, 'react-native-nitro-modules+0.37.1.patch'))) fail()
} else if (name === 'npx') {
  mkdir(path.join(app, 'android/app'))
  mkdir(path.join(app, 'ios'))
  fs.writeFileSync(path.join(app, 'package.json'), '{}')
  fs.writeFileSync(path.join(app, 'android/app/build.gradle'), 'applicationId "com.nitrobgcompat"\n')
  if (scenario === 'fmt-applies' || scenario === 'fmt-hook-missing') {
    const specs = path.join(app, 'node_modules/react-native/third-party-podspecs')
    mkdir(specs)
    fs.writeFileSync(path.join(specs, 'fmt.podspec'), 'spec.version = "11.0.2"\n')
    fs.writeFileSync(path.join(app, 'ios/Podfile'), scenario === 'fmt-applies'
      ? 'post_install do |installer|\n  react_native_post_install(installer)\nend\n'
      : 'post_install do |installer|\nend\n')
  }
  if (scenario.startsWith('nitro-')) {
    const nitro = path.join(app, 'node_modules/react-native-nitro-modules')
    mkdir(nitro)
    fs.writeFileSync(path.join(nitro, 'package.json'), JSON.stringify({ version: scenario === 'nitro-wrong-version' ? '0.36.5' : '0.37.1' }))
    const patches = path.join(app, 'node_modules/react-native-nitro-bg-timer-plus/compat')
    mkdir(patches)
    if (scenario !== 'nitro-patch-missing') fs.writeFileSync(path.join(patches, 'react-native-nitro-modules+0.37.1.patch'), 'fixture patch')
  }
  const gradle = path.join(app, 'android/gradlew')
  fs.copyFileSync(__filename, gradle); fs.chmodSync(gradle, 0o755)
  if (scenario === 'init-fail') fail()
} else if (name === 'gradlew') {
  if (scenario === 'gradle-fail') fail()
  const out = path.join(app, 'android/app/build/outputs/apk/release')
  mkdir(out); fs.writeFileSync(path.join(out, 'app-release.apk'), 'apk')
} else if (name === 'pod') {
  if (scenario === 'pod-fail') fail()
} else if (name === 'xcodebuild') {
  if (args[0] === '-version') console.log('Xcode 27.0\nBuild version Fixture')
  else {
    if (scenario === 'xcode-fail') fail()
    mkdir(path.join(app, 'ios/build/Build/Products/Release-iphonesimulator/NitroBgCompat.app'))
  }
} else if (name === 'plutil') {
  if (scenario === 'plist-fail') fail()
  console.log('com.nitrobgcompat')
} else if (name === 'adb') {
  if (args[0] === '-s') args = args.slice(2)
  if (args[0] === 'get-serialno') console.log('emulator-fixture')
  else if (args[0] === 'install') { if (scenario === 'install-fail') fail() }
  else if (args.join(' ').startsWith('shell am force-stop')) { if (scenario === 'stop-fail') fail() }
  else if (args.join(' ').startsWith('shell am start')) {
    if (scenario === 'launch-fail') fail()
    console.log('Status: ok\nActivity: com.nitrobgcompat/.MainActivity')
  } else if (args[1] === 'pidof') {
    if (scenario === 'pid-fail') fail()
    console.log('1234')
  } else if (args[0] === 'logcat' && args[1] === '-c') {
    if (scenario === 'clear-log-fail') fail()
  } else if (args[0] === 'logcat') {
    if (scenario === 'collector-fail') fail()
    const pid = scenario === 'foreign-pid' ? 9999 : 1234
    const emit = (text) => console.log('I/ReactNativeJS( ' + pid + '): ' + text)
    if (scenario !== 'no-marker') {
      const message = marker()
      if (scenario === 'contradictory') emit(message.replace('"PASS"', '"FAIL"').replace('] PASS', '] FAIL'))
      emit(message)
      if (scenario === 'duplicate') emit(message)
      if (scenario === 'late-fail') setTimeout(() => emit(message.replace('"PASS"', '"FAIL"').replace('] PASS', '] FAIL')), 100)
    }
    if (scenario === 'collector-exit') process.exit(0)
    process.on('SIGTERM', () => { trace('stopped'); process.exit(0) })
    setInterval(() => {}, 1000)
  }
} else if (name === 'xcrun') {
  if (args[1] === 'list') {
    const devices = [{ udid: 'sim-fixture', state: 'Booted', isAvailable: true }]
    if (scenario === 'multiple-sims') devices.push({ ...devices[0], udid: 'other-sim' })
    console.log(JSON.stringify({ devices: { runtime: devices } }))
  } else if (args[1] === 'install') { if (scenario === 'install-fail') fail() }
  else if (args[1] === 'launch') {
    if (scenario === 'launch-fail') fail()
    if (scenario === 'launch-slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 31000)
    console.log('com.nitrobgcompat: 1234')
    const port = process.env.COMPAT_REPORT_PORT
    const message = marker()
    const sender = [
      "const http = require('node:http')",
      "const send = body => { const req = http.request({ host: '127.0.0.1', port: " + port + ", path: '/report', method: 'POST' }, res => res.resume()); req.on('error', () => {}); req.setTimeout(1000, () => req.destroy()); req.end(body) }",
      'setTimeout(() => { send(' + JSON.stringify(message) + ');' +
        (scenario === 'late-fail' ? 'setTimeout(() => send(' + JSON.stringify(message) + '.replace(\'"PASS"\', \'"FAIL"\')), 100);' : '') +
        (scenario === 'contradictory' ? 'send(' + JSON.stringify(message) + '.replace(\'"PASS"\', \'"FAIL"\'));' : '') +
        (scenario === 'duplicate' ? 'send(' + JSON.stringify(message) + ');' : '') +
      '}, 100)',
    ].join('\n')
    spawn(process.execPath, ['-e', sender], { stdio: 'ignore', detached: true }).unref()
  }
} else { console.error('Unexpected fixture: ' + name); process.exit(99) }
`
for (const name of [
  'npm',
  'npx',
  'pod',
  'xcodebuild',
  'plutil',
  'adb',
  'xcrun',
]) {
  fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${fixture}`, {
    mode: 0o755,
  })
}

async function run(scenario, platform = 'android', options = {}) {
  const dir = fs.mkdtempSync(path.join(scratch, `${scenario}-`))
  const work = path.join(dir, 'work')
  const server = http.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  if (!options.occupied) await new Promise((resolve) => server.close(resolve))
  const env = {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    COMPAT_FIXTURE_CASE: scenario,
    COMPAT_FIXTURE_APP: path.join(work, 'rn-0.78.3'),
    COMPAT_FIXTURE_TRACE: path.join(dir, 'trace.jsonl'),
    COMPAT_FIXTURE_PLATFORM: platform,
    COMPAT_REPORT_PORT: String(port),
    COMPAT_TIMEOUT_MS: String(options.timeoutMs || 2000),
  }
  try {
    const args = [
      script,
      '--platform',
      platform,
      '--keep',
      '--work-dir',
      options.relative ? 'work' : work,
    ]
    if (options.nitroCompat) args.push('--nitro-ios-compat')
    if (!options.buildOnly) args.push('--run')
    args.push('0.78.3')
    const result = spawnSync('bash', args, {
      cwd: dir,
      env,
      encoding: 'utf8',
      timeout: options.processTimeoutMs || 8000,
    })
    assert.ifError(result.error)
    assert.equal(result.signal, null)
    fs.writeFileSync(
      path.join(dir, 'runner.log'),
      result.stdout + result.stderr
    )
    const events = fs
      .readFileSync(env.COMPAT_FIXTURE_TRACE, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    return { ...result, events, work, dir }
  } finally {
    if (options.occupied) await new Promise((resolve) => server.close(resolve))
  }
}

for (const platform of ['android', 'ios']) {
  // Shell/native orchestration is host-independent; the shell's macOS gate is
  // exercised naturally on macOS and iOS fixture cases run there as well.
  const skip = platform === 'ios' && process.platform !== 'darwin'
  test(`${platform}: valid control`, { skip }, async () => {
    const result = await run('control', platform)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(
      fs.readFileSync(path.join(result.work, 'summary.txt'), 'utf8'),
      /PASS 0.78.3 .*run/
    )
    const capture = fs.readFileSync(
      path.join(result.work, `rn-0.78.3-${platform}-runtime.log`),
      'utf8'
    )
    assert.match(capture, /IDENTITY.*"pid":"1234"/)
    assert.match(capture, /"runId":"[a-f0-9-]+"/)
    if (platform === 'android') {
      assert(
        result.events.some((e) => e.name === 'adb' && e.event === 'stopped')
      )
      assert(
        result.events.some(
          (e) =>
            e.args.includes('--pid=1234') && e.args[1] === 'emulator-fixture'
        )
      )
    }
  })
  for (const scenario of [
    'install-fail',
    'launch-fail',
    'foreign-rn',
    'foreign-os',
    'foreign-run',
    'malformed',
    'explicit-fail',
    'late-fail',
    'contradictory',
    'duplicate',
  ]) {
    test(`${platform}: rejects ${scenario}`, { skip }, async () => {
      const result = await run(scenario, platform)
      assert.equal(result.status, 1, result.stdout + result.stderr)
      assert.doesNotMatch(
        fs.readFileSync(path.join(result.work, 'summary.txt'), 'utf8'),
        /PASS 0.78.3 .*run/
      )
      if (scenario.startsWith('foreign-'))
        assert.match(result.stdout, /does not belong to this run/)
      if (scenario === 'explicit-fail')
        assert.match(result.stdout, /App reported FAIL/)
      if (['late-fail', 'contradictory', 'duplicate'].includes(scenario)) {
        assert.match(
          result.stdout,
          /Multiple or contradictory|App reported FAIL/
        )
      }
    })
  }
}

for (const scenario of [
  'init-fail',
  'npm-fail',
  'gradle-fail',
  'stop-fail',
  'pid-fail',
  'clear-log-fail',
  'collector-fail',
  'collector-exit',
  'foreign-pid',
  'no-marker',
  'bad-timing',
  'bad-ticks',
  'cancel-fired',
  'unknown-status',
]) {
  test(`android: rejects ${scenario}`, async () => {
    const result = await run(scenario)
    assert.equal(result.status, 1, result.stdout + result.stderr)
    if (['bad-timing', 'bad-ticks', 'cancel-fired'].includes(scenario)) {
      assert.match(result.stdout, /invalid timer observations/)
    }
    if (scenario === 'foreign-pid')
      assert.match(result.stdout, /unexpected Android process/)
    if (scenario === 'no-marker') assert.match(result.stdout, /timed out/)
    if (['collector-exit', 'collector-fail'].includes(scenario)) {
      assert.match(result.stdout, /logcat exited before completion/)
    }
    if (
      [
        'foreign-pid',
        'no-marker',
        'bad-timing',
        'bad-ticks',
        'cancel-fired',
        'unknown-status',
      ].includes(scenario)
    ) {
      assert(result.events.some((e) => e.event === 'stopped'))
    }
  })
}
for (const scenario of [
  'pod-fail',
  'xcode-fail',
  'plist-fail',
  'multiple-sims',
]) {
  test(
    `ios: rejects ${scenario}`,
    { skip: process.platform !== 'darwin' },
    async () => {
      const result = await run(scenario, 'ios')
      assert.equal(result.status, 1, result.stdout + result.stderr)
      if (scenario === 'pod-fail') {
        assert(
          !result.events.some(
            (e) => e.name === 'xcodebuild' && e.args[0] !== '-version'
          )
        )
      }
    }
  )
}
test(
  'ios: occupied report port fails before launch',
  { skip: process.platform !== 'darwin' },
  async () => {
    const result = await run('control', 'ios', { occupied: true })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert(
      !result.events.some((e) => e.name === 'xcrun' && e.args[1] === 'launch')
    )
  }
)
test('installs with explicit strict peer flags', async () => {
  const result = await run('strict-peers', 'android', { buildOnly: true })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
test('anchors the host transitive RN peer to the requested version', async () => {
  const result = await run('pinned-host', 'android', { buildOnly: true })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
test(
  'ios: applies the fmt workaround with the real Ruby interpreter',
  { skip: process.platform !== 'darwin' },
  async () => {
    const result = await run('fmt-applies', 'ios', { buildOnly: true })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const podfile = fs.readFileSync(
      path.join(result.work, 'rn-0.78.3/ios/Podfile'),
      'utf8'
    )
    assert.match(podfile, /CLANG_CXX_LANGUAGE_STANDARD.*c\+\+17/)
    assert.equal(podfile.match(/t.name == "fmt"/g)?.length, 1)
  }
)
test(
  'ios: rejects a missing fmt post-install hook before Pods or build',
  { skip: process.platform !== 'darwin' },
  async () => {
    const result = await run('fmt-hook-missing', 'ios', { buildOnly: true })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stdout, /react_native_post_install hook not found/)
    assert(!result.events.some((event) => event.name === 'pod'))
    assert(
      !result.events.some(
        (event) => event.name === 'xcodebuild' && event.args[0] !== '-version'
      )
    )
  }
)
test('accepts a relative work directory', async () => {
  const result = await run('control', 'android', {
    relative: true,
    buildOnly: true,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

for (const scenario of [
  'nitro-control',
  'nitro-wrong-version',
  'nitro-patch-missing',
  'nitro-patch-fail',
]) {
  test(
    'ios: explicit Nitro workaround ' + scenario,
    { skip: process.platform !== 'darwin' },
    async () => {
      const result = await run(scenario, 'ios', {
        buildOnly: true,
        nitroCompat: true,
      })
      const success = scenario === 'nitro-control'
      assert.equal(
        result.status,
        success ? 0 : 1,
        result.stdout + result.stderr
      )
      assert.equal(
        result.events.some((e) => e.name === 'pod'),
        success
      )
      const patcher = result.events.findIndex(
        (e) => e.name === 'npx' && e.args.includes('patch-package@8.0.1')
      )
      if (success) {
        assert(patcher >= 0)
        assert(patcher < result.events.findIndex((e) => e.name === 'pod'))
      }
      if (
        scenario === 'nitro-wrong-version' ||
        scenario === 'nitro-patch-missing'
      )
        assert.equal(patcher, -1)
      assert.match(
        fs.readFileSync(path.join(result.work, 'summary.txt'), 'utf8'),
        success ? /PASS 0.78.3 ios-build/ : /FAIL 0.78.3 ios-build/
      )
    }
  )
}
test(
  'Nitro workaround stays opt-in',
  { skip: process.platform !== 'darwin' },
  async () => {
    const result = await run('nitro-control', 'ios', { buildOnly: true })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert(
      !result.events.some(
        (e) => e.name === 'npx' && e.args.includes('patch-package@8.0.1')
      )
    )
  }
)

test(
  'ios: launch honors a configured timeout beyond 30 seconds',
  { skip: process.platform !== 'darwin' },
  async () => {
    const result = await run('launch-slow', 'ios', {
      timeoutMs: 45000,
      processTimeoutMs: 50000,
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(
      fs.readFileSync(path.join(result.work, 'summary.txt'), 'utf8'),
      /PASS 0.78.3 ios-run/
    )
  }
)
test(
  'ios: launch remains bounded by the configured timeout',
  { skip: process.platform !== 'darwin' },
  async () => {
    const result = await run('launch-slow', 'ios', { timeoutMs: 1000 })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stdout, /ETIMEDOUT/)
    assert.doesNotMatch(
      fs.readFileSync(path.join(result.work, 'summary.txt'), 'utf8'),
      /PASS 0.78.3 ios-run/
    )
  }
)
