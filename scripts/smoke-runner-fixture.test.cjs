const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const script =
  process.env.SMOKE_RUNNER_SCRIPT || path.join(__dirname, 'smoke-android.sh')
const fixture = String.raw`#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path')
let xs=process.argv.slice(2);if(xs[0]==='-s')xs=xs.slice(2)
const dir=process.env.FIXTURE_DIR, mode=process.env.FIXTURE_MODE, state=path.join(dir,'state'), calls=path.join(dir,'calls')
fs.appendFileSync(calls,JSON.stringify(xs)+'\n')
if(xs[0]==='devices'){console.log('List of devices attached\nfixture\tdevice');process.exit(0)}
if(xs[0]==='pull'){
 const counter=path.join(dir,'pulls'),count=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8'))+1:1
 fs.writeFileSync(counter,String(count));fs.writeFileSync(xs[2],'candidate-apk')
 if(count>1&&mode==='late-process-change')fs.writeFileSync(path.join(dir,'late-process'),'true')
 if(count>1&&mode==='late-capture-end')process.kill(Number(fs.readFileSync(path.join(dir,'capture-pid'),'utf8')),'SIGTERM')
 process.exit(0)
}
if(xs.includes('path')){console.log('package:/fixture/base.apk');process.exit(0)}
if(xs.includes('force-stop')){fs.writeFileSync(path.join(dir,'stopped'),'true');process.exit(0)}
if(xs.includes('keyevent')){fs.writeFileSync(path.join(dir,'home'),'true');process.exit(mode==='home-failure'?1:0)}
if(xs.includes('-n')){fs.writeFileSync(path.join(dir,'resume'),'true');process.exit(mode==='resume-failure'?1:0)}
if(xs.includes('pidof')){console.log((mode==='changed-process-bg' && fs.existsSync(path.join(dir,'home'))) || (mode==='changed-process' && fs.existsSync(path.join(dir,'emitted'))) || (mode==='late-process-change' && fs.existsSync(path.join(dir,'late-process'))) ? '4321' : '1234');process.exit(0)}
const url=xs.find(x=>x.includes('://smoke?'))
if(url){fs.writeFileSync(state,url.split('runId=')[1]);process.exit(0)}
if(xs[0]==='logcat'){
 fs.writeFileSync(path.join(dir,'capture-pid'),String(process.pid))
 const poll=setInterval(()=>{
  if(!fs.existsSync(state))return
  clearInterval(poll)
  const id=mode==='stale'?'previous-run':fs.readFileSync(state,'utf8')
  const m=(text)=>'[NitroBgSmoke] '+text+' runId='+id
  let lines=[m('START'),m('TIMER_CALLBACK')+' kind=timeout',m('STEP PASS')+' name=setTimeout',...['schedule','clearRequested','clear','observed'].map((kind,i)=>m('CLEAR_TIMEOUT_EVENT')+' seq='+(i+1)+' kind='+kind+' at='+[0,1,2,302][i]),m('CLEAR_TIMEOUT_CAUSALITY')+' scheduleAt=0 callbackAt=none clearAt=2 delayMs=160 order=schedule,clearRequested,clear,observed status=valid',m('STEP PASS')+' name=clearTimeout',m('TIMER_CALLBACK')+' kind=interval ticks=3',...['setInterval','clearInterval','batchOrdering','reentrancy','backgroundWindow','dispose'].flatMap(s=>[...(s==='backgroundWindow'?[m('BACKGROUND_READY'),...[1,2,3,4,5,6].map(tick=>m('BACKGROUND_TICK')+' tick='+tick)]:[]),m('STEP PASS')+' name='+s]),m('RESULT PASS')]
  lines.splice(1,0,m('APP_STATE')+' state=active monotonicAt=0')
  if(mode==='marker-only')lines=lines.slice(-1)
  if(mode==='no-start')lines=lines.slice(1)
  if(mode==='no-callback')lines=lines.filter(x=>!x.includes('TIMER_CALLBACK'))
  if(mode==='fail-plus-pass')lines.push(m('RESULT FAIL')+' reason=actual_failure')
  if(mode==='native-crash')lines.push('FATAL EXCEPTION: main')
  if(mode==='js-crash')lines.push('TypeError: actual JS crash')
  if(mode==='not-started')lines=[]
  if(mode.startsWith('bg-')||['home-failure','resume-failure','changed-process-bg'].includes(mode)){
   const emit=(line,pid='1234')=>console.log('10-14 12:00:00.000 '+pid+' 1234 I ReactNativeJS: '+line)
   const split=lines.findIndex(x=>x.includes('BACKGROUND_READY'))
   lines.slice(0,split+1).forEach(x=>emit(x))
   let away=false,back=false
   const handshake=setInterval(()=>{
    if(!away&&fs.existsSync(path.join(dir,'home'))){away=true
     if(mode!=='bg-active-only')emit(m('APP_STATE')+' state=background monotonicAt=10')
     let tick=m('BACKGROUND_TICK')+' tick=1 state='+(mode==='bg-active-only'?'active':'background')+' monotonicAt=20'
     if(mode==='bg-foreign-run')tick=tick.replace(id,'foreign-run')
     if(mode!=='bg-no-tick')emit(tick,mode==='bg-foreign-pid'?'5678':'1234')
     if(mode==='bg-no-tick'||mode==='bg-active-only'){
      lines.slice(split+1).filter(x=>!x.includes('BACKGROUND_TICK')||!x.includes('tick=1')).forEach(x=>emit(x));clearInterval(handshake)
     }
    }
    if(!back&&fs.existsSync(path.join(dir,'resume'))){back=true
     if(mode!=='bg-no-resume')emit(m('APP_STATE')+' state=active monotonicAt=30')
     lines.slice(split+1).filter(x=>!x.includes('BACKGROUND_TICK')||!x.includes('tick=1')).forEach(x=>emit(x));clearInterval(handshake)
    }
   },20)
   return
  }
  for(const line of lines)console.log('10-14 12:00:00.000 '+(mode==='wrong-pid'?'5678':'1234')+' 1234 I ReactNativeJS: '+line)
  fs.writeFileSync(path.join(dir,'emitted'),'true')
 },20)
 setInterval(()=>{},1000)
}
`
function run(mode, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-runner-fixture-'))
  const adb = path.join(dir, 'adb')
  fs.writeFileSync(adb, options.fixture ?? fixture, { mode: 0o755 })
  const runId = 'fixture-' + path.basename(dir)
  const args = [
    script,
    '--device',
    runId,
    '--run-id',
    runId,
    '--timeout',
    options.background ? '4' : '2',
  ]
  if (options.background) args.push('--background')
  if (options.apk) {
    const apk = path.join(dir, 'expected.apk')
    fs.writeFileSync(apk, 'wrong-apk')
    args.push('--apk', apk)
  }
  const r = spawnSync('bash', args, {
    encoding: 'utf8',
    env: { ...process.env, ADB: adb, FIXTURE_DIR: dir, FIXTURE_MODE: mode },
    timeout: 10000,
  })
  fs.writeFileSync(path.join(dir, 'runner.log'), r.stdout + r.stderr)
  fs.writeFileSync(
    path.join(dir, 'result.json'),
    JSON.stringify(
      {
        mode,
        command: ['bash', ...args],
        rawExit: r.status,
        signal: r.signal,
        source: args[0],
        environment: { FIXTURE_DIR: dir, FIXTURE_MODE: mode },
      },
      null,
      2
    )
  )
  return { ...r, dir, args, runId }
}
test('actual Android runner accepts complete control and force-stops one-shot process', () => {
  const r = run('control')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(fs.readFileSync(path.join(r.dir, 'calls'), 'utf8'), /force-stop/)
  assert.match(r.stdout, /ARTIFACT.*sha256=/)
  assert.match(r.stdout, /PASS.*pid=1234/)
})
for (const mode of [
  'marker-only',
  'no-start',
  'no-callback',
  'stale',
  'fail-plus-pass',
  'native-crash',
  'js-crash',
  'wrong-pid',
  'changed-process',
  'late-process-change',
  'late-capture-end',
])
  test(`actual runner rejects ${mode}`, () => {
    const r = run(mode)
    assert.equal(r.status, 1, r.stdout + r.stderr)
  })
test('actual runner cannot PASS when app did not start', () =>
  assert.equal(run('not-started').status, 124))
test('actual runner rejects installed artifact mismatch and releases its lock', () => {
  const r = run('control', { apk: true })
  assert.equal(r.status, 2, r.stdout + r.stderr)
  const again = spawnSync('bash', r.args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      ADB: path.join(r.dir, 'adb'),
      FIXTURE_DIR: r.dir,
      FIXTURE_MODE: 'control',
    },
  })
  assert.match(again.stderr, /reused runId/)
  assert.doesNotMatch(again.stderr, /target busy/)
})

const iosFixture = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path')
const xs=process.argv.slice(2),dir=process.env.FIXTURE_DIR,mode=process.env.FIXTURE_MODE,cmd=path.basename(process.argv[1]),state=path.join(dir,'launched'),url=path.join(dir,'url'),isUI=process.env.FIXTURE_UI==='1'
fs.appendFileSync(path.join(dir,'calls'),JSON.stringify([cmd,...xs])+'\n')
if(cmd==='ps'){if(xs[0]==='-axo'){const r=require('node:child_process').spawnSync('/bin/ps',xs,{encoding:'utf8'});process.stdout.write(r.stdout);process.exit(r.status)}console.log(path.join(dir,'installed/NitroBgTimerExample'));process.exit(0)}
if(cmd==='maestro'){if(xs.at(-1).includes('ui-smoke-'))fs.writeFileSync(path.join(dir,'maestro'),'true');process.exit(0)}
if(xs.includes('list')){console.log(JSON.stringify({devices:{ios:[{udid:process.env.FIXTURE_TARGET,state:'Booted'}]}}));process.exit(0)}
if(xs.includes('get_app_container')){console.log(path.join(dir,'installed'));process.exit(0)}
if(xs.includes('appinfo'))process.exit(0)
if(xs.includes('launch')){fs.writeFileSync(state,String(process.ppid));console.log('org.reactjs.native.example.NitroBgTimerExample: '+process.ppid);process.exit(0)}
if(xs.includes('openurl')){fs.writeFileSync(url,xs.at(-1));process.exit(0)}
if(xs.includes('stream')){
 let sent=false,uiSent=false
 const poll=setInterval(()=>{
  if(!fs.existsSync(state)||!fs.existsSync(url))return
  const pid=mode==='wrong-pid'?'99999':fs.readFileSync(state,'utf8'),id=mode==='stale'?'previous-run':fs.readFileSync(url,'utf8').split('runId=')[1].split('&')[0]
  const emit=x=>console.log('2026-10-14 12:00:00.000 Df NitroBgTimerExample['+pid+':abcd] (Foundation) '+x)
  const m=t=>'[NitroBgSmoke] '+t+' runId='+id
  if(!sent){sent=true
   if(isUI){
    if(mode==='stale-before-ui')emit('[NitroBgSmoke] START runId=stale-core')
    emit('[NitroBgUiSmoke] CONTEXT runId='+id+' mode=ui')
   }else{
    let lines=[m('START'),m('IOS_ARCH')+' newArch=true',m('IOS_EVENT_MODULE')+' nativeModulePresent=true',m('IOS_EVENT_LISTENER')+' installed=true',m('STEP PASS')+' name=iosEventDiagnostics',m('IOS_TIMER')+' marker=ios-timeout-fired',m('TIMER_CALLBACK')+' kind=timeout',m('STEP PASS')+' name=setTimeout',...['schedule','clearRequested','clear','observed'].map((kind,i)=>m('CLEAR_TIMEOUT_EVENT')+' seq='+(i+1)+' kind='+kind+' at='+[0,1,2,302][i]),m('CLEAR_TIMEOUT_CAUSALITY')+' scheduleAt=0 callbackAt=none clearAt=2 delayMs=160 order=schedule,clearRequested,clear,observed status=valid',m('STEP PASS')+' name=clearTimeout',m('IOS_TIMER')+' marker=ios-interval-fired',m('TIMER_CALLBACK')+' kind=interval ticks=3',m('STEP PASS')+' name=setInterval',m('IOS_EVENT_DELIVERY')+' timeoutFired=true intervalFired=true status=ok',m('IOS_EVENT_DELIVERY_OK'),...['iosEventDelivery','clearInterval','batchOrdering','reentrancy','backgroundWindow','dispose'].flatMap(s=>[...(s==='backgroundWindow'?[m('BACKGROUND_READY'),...[1,2,3,4,5,6].map(tick=>m('BACKGROUND_TICK')+' tick='+tick)]:[]),m('STEP PASS')+' name='+s]),m('RESULT PASS')]
    if(mode==='marker-only')lines=lines.slice(-1)
    if(mode==='no-callback')lines=lines.filter(x=>!x.includes('TIMER_CALLBACK'))
    for(const l of lines)emit(l)
    if(mode==='native-crash')emit("Terminating app due to uncaught exception 'NSInvalidArgumentException'")
    if(mode==='js-crash')emit('TypeError: actual JS crash')
    if(mode==='control')emit('NativeEventEmitter RCTEventEmitter module registered')
   }
  }
  if(isUI&&!uiSent&&fs.existsSync(path.join(dir,'maestro'))){uiSent=true
   if(mode!=='no-handler')emit('[NitroBgUiSmoke] START runId='+id+' section=background action=disable-fgs')
   emit('[NitroBgUiSmoke] PASS runId='+id+' section=background action=disable-fgs')
  }
 },20)
}
`
function runIos(mode, ui = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-runner-fixture-')),
    bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  for (const cmd of ['xcrun', 'ps', 'maestro'])
    fs.writeFileSync(path.join(bin, cmd), iosFixture, { mode: 0o755 })
  const app = path.join(
    dir,
    'dd/Build/Products/Release-iphonesimulator/NitroBgTimerExample.app'
  )
  fs.mkdirSync(app, { recursive: true })
  fs.mkdirSync(path.join(dir, 'installed'))
  for (const filename of ['NitroBgTimerExample', 'Info.plist']) {
    fs.writeFileSync(path.join(app, filename), 'candidate-app')
    fs.writeFileSync(path.join(dir, 'installed', filename), 'candidate-app')
  }
  if (mode === 'artifact-mismatch')
    fs.writeFileSync(path.join(dir, 'installed/Info.plist'), 'wrong-app')
  const target = path.basename(dir),
    runId = 'run-' + target
  const args = [
    path.join(__dirname, ui ? 'ui-smoke-ios.sh' : 'smoke-ios.sh'),
    '--simulator',
    target,
    '--run-id',
    runId,
    '--configuration',
    'Release',
    '--skip-build',
    '--skip-install',
    '--derived-data',
    path.join(dir, 'dd'),
    '--timeout',
    '2',
  ]
  if (ui) args.push('--flow', 'fgs-optout')
  const r = spawnSync('bash', args, {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      PATH: bin + ':' + process.env.PATH,
      FIXTURE_DIR: dir,
      FIXTURE_TARGET: target,
      FIXTURE_MODE: mode,
      FIXTURE_UI: ui ? '1' : '0',
    },
  })
  fs.writeFileSync(path.join(dir, 'runner.log'), r.stdout + r.stderr)
  fs.writeFileSync(
    path.join(dir, 'result.json'),
    JSON.stringify(
      {
        mode,
        command: ['bash', ...args],
        rawExit: r.status,
        signal: r.signal,
        source: args[0],
        environment: { FIXTURE_DIR: dir, FIXTURE_MODE: mode },
      },
      null,
      2
    )
  )
  return { ...r, dir }
}
test('actual iOS runner control accepts informational emitter names', () => {
  const r = runIos('control')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(
    fs.readFileSync(path.join(r.dir, 'calls'), 'utf8'),
    /terminate-running-process/
  )
})
for (const mode of [
  'marker-only',
  'no-callback',
  'wrong-pid',
  'stale',
  'native-crash',
  'js-crash',
])
  test(`actual iOS runner rejects ${mode}`, () => {
    const r = runIos(mode)
    assert.equal(r.status, 1, r.stdout + r.stderr)
  })
test('actual iOS runner rejects installed artifact mismatch', () =>
  assert.equal(runIos('artifact-mismatch').status, 2))
test('actual iOS UI runner requires context and observable handler START/PASS after Maestro', () => {
  const r = runIos('control', true)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
test('Maestro exit 0 without handler START cannot PASS', () => {
  const r = runIos('no-handler', true)
  assert.equal(r.status, 1, r.stdout + r.stderr)
})
test('stale core is rejected before UI taps, not called a library regression', () => {
  const r = runIos('stale-before-ui', true)
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /stale_core_disposed_before_UI/)
  assert.doesNotMatch(
    fs.readFileSync(path.join(r.dir, 'calls'), 'utf8'),
    /ui-smoke-fgs-optout.yaml/
  )
})

test(
  'target lock rejects concurrent runners and a fresh run works after release',
  { timeout: 5000 },
  async () => {
    const { spawn } = require('node:child_process')
    const target = 'concurrency-' + Date.now()
    const holder = spawn(
      'bash',
      [
        '-c',
        'source "$1"; trap harness_unlock EXIT; harness_lock android "$2"; echo LOCKED; sleep 1',
        'fixture',
        script,
        target,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    await new Promise((resolve) => holder.stdout.once('data', resolve))
    const contender = spawnSync(
      'bash',
      [
        '-c',
        'source "$1"; trap harness_unlock EXIT; harness_lock android "$2"',
        'fixture',
        script,
        target,
      ],
      { encoding: 'utf8' }
    )
    assert.equal(contender.status, 2)
    assert.match(contender.stderr, /HARNESS\/TOOLING target busy/)
    await new Promise((resolve) => holder.once('exit', resolve))
    const fresh = spawnSync(
      'bash',
      [
        '-c',
        'source "$1"; trap harness_unlock EXIT; harness_lock android "$2"',
        'fixture',
        script,
        target,
      ],
      { encoding: 'utf8' }
    )
    assert.equal(fresh.status, 0, fresh.stderr)
  }
)

test(
  'Maestro driver lock rejects overlap across different targets',
  { timeout: 5000 },
  async () => {
    const { spawn } = require('node:child_process')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-lock-fixture-'))
    fs.writeFileSync(
      path.join(dir, 'maestro'),
      '#!/bin/bash\necho LOCKED\nsleep 1\n',
      { mode: 0o755 }
    )
    const env = { ...process.env, PATH: dir + ':' + process.env.PATH }
    const args = ['-c', 'source "$1"; harness_maestro test', 'fixture', script]
    const holder = spawn('bash', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await new Promise((resolve) => holder.stdout.once('data', resolve))
    const contender = spawnSync('bash', args, { env, encoding: 'utf8' })
    assert.equal(contender.status, 2)
    assert.match(contender.stderr, /Maestro driver busy/)
    await new Promise((resolve) => holder.once('exit', resolve))
    assert.equal(spawnSync('bash', args, { env }).status, 0)
  }
)

test('UI YAML rejects duplicate keys and keeps command options in their own command', () => {
  const yaml = require('yaml')
  const file = path.join(__dirname, '..', '.maestro', 'ui-smoke-main.yaml')
  const docs = yaml.parseAllDocuments(fs.readFileSync(file, 'utf8'), {
    uniqueKeys: true,
  })
  for (const doc of docs) assert.deepEqual(doc.errors, [])
  const commands = docs[1].toJSON()
  for (const command of commands) {
    assert.equal(Object.keys(command).length, 1)
    if (command.scrollUntilVisible)
      assert.ok(command.scrollUntilVisible.direction)
    if (command.extendedWaitUntil)
      assert.deepEqual(Object.keys(command.extendedWaitUntil).sort(), [
        'timeout',
        'visible',
      ])
  }
  const mutant = yaml.parseAllDocuments(
    'appId: app\n---\n- extendedWaitUntil:\n    timeout: 5\n    timeout: 10\n',
    { uniqueKeys: true }
  )
  assert.ok(mutant[1].errors.length)
})

test('a hung Maestro command times out, settles its process and releases the driver lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-timeout-fixture-'))
  const mock = path.join(dir, 'maestro')
  fs.writeFileSync(
    mock,
    '#!/bin/bash\necho $$ > "$FIXTURE_PID_FILE"\nsleep 4\n',
    { mode: 0o755 }
  )
  const pidFile = path.join(dir, 'pid')
  const r = spawnSync(
    'bash',
    [
      '-c',
      'source "$1"; TIMEOUT_SECONDS=1; harness_maestro test',
      'fixture',
      script,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: dir + ':' + process.env.PATH,
        FIXTURE_PID_FILE: pidFile,
      },
      timeout: 8000,
    }
  )
  assert.equal(r.status, 124, r.stdout + r.stderr)
  const pid = Number(fs.readFileSync(pidFile, 'utf8'))
  assert.throws(() => process.kill(pid, 0))
  fs.writeFileSync(mock, '#!/bin/bash\nexit 0\n', { mode: 0o755 })
  const fresh = spawnSync(
    'bash',
    ['-c', 'source "$1"; harness_maestro test', 'fixture', script],
    { env: { ...process.env, PATH: dir + ':' + process.env.PATH } }
  )
  assert.equal(fresh.status, 0)
})

function runPhases(failPhase = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-phase-fixture-'))
  const bin = path.join(dir, 'maestro')
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs=require('node:fs'); const xs=process.argv.slice(2)
fs.appendFileSync(process.env.FIXTURE_PHASE_CALLS,JSON.stringify(xs)+'\\n')
if(process.env.FIXTURE_FAIL_PHASE && xs.at(-1).endsWith(process.env.FIXTURE_FAIL_PHASE+'.yaml'))process.exit(7)
`,
    { mode: 0o755 }
  )
  const flow = path.join(__dirname, '..', '.maestro/ui-smoke-main.yaml')
  const r = spawnSync(
    'bash',
    [
      '-c',
      'source "$1"; TIMEOUT_SECONDS=2; validate_ui_progress() { echo checked >> "$FIXTURE_PHASE_CHECKS"; }; harness_ui_flow test -e APP_ID=fixture "$2"',
      'fixture',
      script,
      flow,
    ],
    {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        PATH: dir + ':' + process.env.PATH,
        FIXTURE_PHASE_CALLS: path.join(dir, 'calls'),
        FIXTURE_PHASE_CHECKS: path.join(dir, 'checks'),
        FIXTURE_FAIL_PHASE: failPhase,
      },
    }
  )
  const calls = fs.existsSync(path.join(dir, 'calls'))
    ? fs
        .readFileSync(path.join(dir, 'calls'), 'utf8')
        .trim()
        .split('\n')
        .map((x) => JSON.parse(x))
    : []
  return { ...r, dir, flow, calls }
}
test('main flow phases preserve every YAML command and validate process progress after each phase', () => {
  const yaml = require('yaml'),
    r = runPhases()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(r.calls.length, 8)
  const commands = (file) =>
    yaml.parseAllDocuments(fs.readFileSync(file, 'utf8'))[1].toJSON()
  assert.deepEqual(
    r.calls.flatMap((xs) => commands(xs.at(-1))),
    commands(r.flow)
  )
  assert.equal(
    fs.readFileSync(path.join(r.dir, 'checks'), 'utf8').trim().split('\n')
      .length,
    8
  )
  for (const xs of r.calls)
    assert.deepEqual(xs.slice(0, -1), ['test', '-e', 'APP_ID=fixture'])
})
test('phase failure stops the flow before later actions and never manufactures PASS', () => {
  const r = runPhases('02')
  assert.equal(r.status, 7, r.stdout + r.stderr)
  assert.equal(r.calls.length, 2)
  assert.doesNotMatch(r.stdout, /RESULT PASS|^PASS/m)
})

test('background UI callback observation accepts every positive tick count and rejects zero', () => {
  const yaml = require('yaml')
  const commands = yaml
    .parseAllDocuments(
      fs.readFileSync(
        path.join(__dirname, '..', '.maestro/ui-smoke-main.yaml'),
        'utf8'
      )
    )[1]
    .toJSON()
  const selector = commands.find((x) =>
    x.extendedWaitUntil?.visible?.id?.startsWith('ui-smoke-background-native-')
  ).extendedWaitUntil.visible.id
  const pattern = new RegExp('^(?:' + selector + ')$')
  for (const count of [1, 2, 10, 99])
    assert.ok(pattern.test('ui-smoke-background-native-' + count))
  assert.equal(pattern.test('ui-smoke-background-native-0'), false)
})

for (const mode of [
  'control',
  'home-failure',
  'bg-active-only',
  'bg-no-tick',
  'bg-foreign-run',
  'bg-foreign-pid',
  'changed-process-bg',
  'bg-no-resume',
  'resume-failure',
]) {
  test(`background prerequisite rejects ${mode} through the actual entry point`, () => {
    const r = run(mode, { background: true })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.doesNotMatch(r.stdout, /^PASS runId=/m)
    if (mode === 'control') {
      assert.doesNotMatch(
        fs.readFileSync(path.join(r.dir, 'calls'), 'utf8'),
        /keyevent/
      )
      assert.match(r.stdout, /core_completed_before_HOME/)
    }
  })
}
test('background handshake accepts ordered HOME, AppState, callback and resume in the same process', () => {
  const r = run('bg-control', { background: true })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const calls = fs.readFileSync(path.join(r.dir, 'calls'), 'utf8')
  assert.match(calls, /keyevent.*HOME/)
  assert.match(calls, /MainActivity/)
})

// Each row changes ONLY the first active marker's clock field in bg-control.
// Later background/callback/resume clocks remain 10/20/30, respectively.
for (const [name, initial, reason] of [
  ['missing', 'state=active', 'initial_active_clock_invalid'],
  ['empty', 'state=active monotonicAt=', 'initial_active_clock_invalid'],
  [
    'empty duplicate',
    'state=active monotonicAt= monotonicAt=0',
    'initial_active_clock_invalid',
  ],
  ['NaN', 'state=active monotonicAt=NaN', 'initial_active_clock_invalid'],
  [
    'Infinity',
    'state=active monotonicAt=Infinity',
    'initial_active_clock_invalid',
  ],
  [
    '-Infinity',
    'state=active monotonicAt=-Infinity',
    'initial_active_clock_invalid',
  ],
  [
    'nonnumeric',
    'state=active monotonicAt=clock',
    'initial_active_clock_invalid',
  ],
  ['partial', 'state=active monotonicAt=0ms', 'initial_active_clock_invalid'],
  [
    'overflow',
    'state=active monotonicAt=1e309',
    'initial_active_clock_invalid',
  ],
  [
    'after background',
    'state=active monotonicAt=15',
    'background_clock_invalid',
  ],
  ['after callback', 'state=active monotonicAt=25', 'background_clock_invalid'],
  ['after resume', 'state=active monotonicAt=35', 'background_clock_invalid'],
]) {
  test(`R08 actual background runner rejects initial clock ${name}`, () => {
    const r = run('bg-control', {
      background: true,
      fixture: fixture.replace('state=active monotonicAt=0', initial),
    })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stdout, new RegExp('background_precondition:' + reason))
    assert.doesNotMatch(r.stdout, /^PASS runId=/m)
  })
}
for (const [name, from, to, reason] of [
  // Only the background clock changes: 0 -> 21 -> 20 -> 30.
  [
    'background after callback',
    'state=background monotonicAt=10',
    'state=background monotonicAt=21',
    'background_clock_invalid',
  ],
  // Only the callback clock changes: 0 -> 10 -> 31 -> 30.
  [
    'callback after resume',
    'monotonicAt=20',
    'monotonicAt=31',
    'resume_clock_invalid',
  ],
  // An empty clock field followed by a numeric duplicate must not recover a
  // valid value through the general marker parser. Only that token is inserted.
  [
    'background duplicate clock',
    'state=background monotonicAt=10',
    'state=background monotonicAt= monotonicAt=10',
    'background_clock_invalid',
  ],
  [
    'callback duplicate clock',
    'monotonicAt=20',
    'monotonicAt= monotonicAt=20',
    'background_clock_invalid',
  ],
  [
    'resumed duplicate clock',
    'state=active monotonicAt=30',
    'state=active monotonicAt= monotonicAt=30',
    'resume_clock_invalid',
  ],
  // Only the initial marker's runId or source PID changes; no own initial remains.
  [
    'foreign initial runId',
    "lines.splice(1,0,m('APP_STATE')+' state=active monotonicAt=0')",
    "lines.splice(1,0,(m('APP_STATE')+' state=active monotonicAt=0').replace(id,'foreign-initial-run'))",
    'initial_active_missing',
  ],
  [
    'foreign initial PID',
    'lines.slice(0,split+1).forEach(x=>emit(x))',
    "lines.slice(0,split+1).forEach(x=>emit(x,x.includes('APP_STATE')?'5678':'1234'))",
    'marker_process_mismatch',
  ],
  // Only extra active markers are inserted. A later valid clock cannot replace
  // the first qualifying marker, even when the invalid payload has a mirror.
  [
    'later active masks missing clock',
    "lines.splice(1,0,m('APP_STATE')+' state=active monotonicAt=0')",
    "lines.splice(1,0,m('APP_STATE')+' state=active',m('APP_STATE')+' state=active monotonicAt=0')",
    'initial_active_clock_invalid',
  ],
  [
    'later active masks NaN mirror',
    "lines.splice(1,0,m('APP_STATE')+' state=active monotonicAt=0')",
    "lines.splice(1,0,m('APP_STATE')+' state=active monotonicAt=NaN',m('APP_STATE')+' state=active monotonicAt=NaN',m('APP_STATE')+' state=active monotonicAt=0')",
    'initial_active_clock_invalid',
  ],
  [
    'later active masks backward clock',
    "lines.splice(1,0,m('APP_STATE')+' state=active monotonicAt=0')",
    "lines.splice(1,0,m('APP_STATE')+' state=active monotonicAt=15',m('APP_STATE')+' state=active monotonicAt=0')",
    'background_clock_invalid',
  ],
]) {
  test(`R08 actual background runner rejects ${name}`, () => {
    assert.ok(fixture.includes(from), 'fixture mutation must apply')
    const r = run('bg-control', {
      background: true,
      fixture: fixture.replace(from, to),
    })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stdout, new RegExp(reason))
    assert.doesNotMatch(r.stdout, /^PASS runId=/m)
  })
}
for (const [name, code] of [
  // Equal clocks are valid because event positions and action byte boundaries
  // still establish initial -> background -> callback -> resumed active. Use
  // the app's existing wall-clock field to distinguish active publications
  // from byte-identical diagnostic mirrors; no validator rule consumes `at`.
  [
    'equal clocks',
    fixture
      .replace(
        'state=active monotonicAt=0',
        'state=active at=100 monotonicAt=0'
      )
      .replace('monotonicAt=10', 'monotonicAt=0')
      .replace('monotonicAt=20', 'monotonicAt=0')
      .replace(
        'state=active monotonicAt=30',
        'state=active at=101 monotonicAt=0'
      ),
  ],
  [
    'equal initial and background clocks',
    fixture.replace(
      'state=active monotonicAt=0',
      'state=active monotonicAt=10'
    ),
  ],
  [
    'equal background, callback and resume clocks',
    fixture
      .replace('monotonicAt=20', 'monotonicAt=10')
      .replace('monotonicAt=30', 'monotonicAt=10'),
  ],
  [
    'fractional initial clock',
    fixture.replace(
      'state=active monotonicAt=0',
      'state=active monotonicAt=0.125'
    ),
  ],
  [
    'exponent initial clock',
    fixture.replace(
      'state=active monotonicAt=0',
      'state=active monotonicAt=+0e-3'
    ),
  ],
]) {
  test(`R08 actual background runner accepts ${name}`, () => {
    const r = run('bg-control', { background: true, fixture: code })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /BACKGROUND_VALIDATED/)
  })
}

const { spawn } = require('node:child_process')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await delay(20)
  }
  assert.fail('fixture did not reach its process boundary')
}
const liveGroup = (pgid) => {
  const r = spawnSync('/bin/ps', ['-axo', 'pid=,pgid=,stat='], {
    encoding: 'utf8',
  })
  assert.equal(r.status, 0)
  return r.stdout.split('\n').some((line) => {
    const [pid, group, state] = line.trim().split(/\s+/)
    return Number(group) === pgid && !state?.startsWith('Z')
  })
}
function driverFixture(mode = 'hold') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cancel-fixture-'))
  const lock = path.join(dir, 'nitro-maestro-driver.lock')
  const bin = path.join(dir, 'maestro')
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs=require('node:fs'),{spawn}=require('node:child_process')
fs.writeFileSync(process.env.FIXTURE_DIR+'/driver',String(process.pid))
if(process.env.DRIVER_MODE==='success')process.exit(0)
process.on('SIGTERM',()=>{})
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'})
fs.writeFileSync(process.env.FIXTURE_DIR+'/grandchild',String(child.pid))
if(process.env.DRIVER_MODE==='orphan')setTimeout(()=>process.exit(0),100)
setInterval(()=>{},1000)
`,
    { mode: 0o755 }
  )
  const env = {
    ...process.env,
    TMPDIR: dir,
    PATH: dir + ':' + process.env.PATH,
    FIXTURE_DIR: dir,
    DRIVER_MODE: mode,
  }
  const args = [
    '-c',
    'source "$1"; TIMEOUT_SECONDS=10; harness_maestro test',
    'fixture',
    script,
  ]
  return { dir, lock, env, args, bin }
}
for (const boundary of [
  'supervisor-TERM',
  'supervisor-INT',
  'wrapper-TERM',
  'wrapper-INT',
  'supervisor-KILL',
  'foreign-owner',
]) {
  test(`Maestro cancellation settles owned grandchildren and preserves lock authority: ${boundary}`, async () => {
    const f = driverFixture(),
      holder = spawn('bash', f.args, {
        env: f.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    let output = ''
    holder.stdout.on('data', (x) => (output += x))
    holder.stderr.on('data', (x) => (output += x))
    const done = new Promise((resolve) =>
      holder.once('exit', (code, signal) => resolve({ code, signal }))
    )
    let pgid
    try {
      await until(() => fs.existsSync(path.join(f.dir, 'grandchild')))
      pgid = Number(fs.readFileSync(path.join(f.dir, 'driver'), 'utf8'))
      const tree = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
        encoding: 'utf8',
      }).stdout
      const supervisor = Number(
        fs.readFileSync(path.join(f.lock, 'supervisor'), 'utf8')
      )
      const parents = new Map(
        tree
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [pid, ppid] = line.trim().split(/\s+/)
            return [Number(pid), Number(ppid)]
          })
      )
      let ancestor = supervisor
      const visited = new Set()
      while (
        ancestor !== holder.pid &&
        parents.has(ancestor) &&
        !visited.has(ancestor)
      ) {
        visited.add(ancestor)
        ancestor = parents.get(ancestor)
      }
      assert.equal(
        ancestor,
        holder.pid,
        'supervisor must belong to this disposable wrapper'
      )
      const overlap = spawnSync('bash', f.args, {
        env: f.env,
        encoding: 'utf8',
      })
      assert.equal(overlap.status, 2, overlap.stdout + overlap.stderr)
      if (boundary === 'foreign-owner')
        fs.writeFileSync(path.join(f.lock, 'owner'), 'foreign-owner')
      const target = boundary.startsWith('wrapper') ? holder.pid : supervisor
      const signalAt = Date.now()
      process.kill(
        target,
        boundary.endsWith('INT')
          ? 'SIGINT'
          : boundary.endsWith('KILL')
            ? 'SIGKILL'
            : 'SIGTERM'
      )
      const result = await done
      fs.writeFileSync(
        path.join(f.dir, 'result.json'),
        JSON.stringify(
          {
            boundary,
            wrapperPid: holder.pid,
            supervisorPid: supervisor,
            maestroGroup: pgid,
            rawExit: result.code,
            signal: result.signal,
            groupLive: liveGroup(pgid),
            lockExists: fs.existsSync(f.lock),
            milliseconds: Date.now() - signalAt,
            output,
          },
          null,
          2
        )
      )
      assert.ok(
        Date.now() - signalAt < 3000,
        'cancellation exceeded bounded settlement: ' + output
      )
      assert.equal(
        result.code,
        boundary.endsWith('INT')
          ? 130
          : boundary === 'supervisor-KILL' || boundary === 'foreign-owner'
            ? 2
            : 143,
        output
      )
      if (boundary === 'supervisor-KILL') {
        assert.ok(fs.existsSync(f.lock), output)
        assert.equal(spawnSync('bash', f.args, { env: f.env }).status, 2)
      } else {
        assert.equal(liveGroup(pgid), false, output)
        if (boundary === 'foreign-owner') {
          assert.equal(
            fs.readFileSync(path.join(f.lock, 'owner'), 'utf8'),
            'foreign-owner'
          )
        } else {
          assert.equal(fs.existsSync(f.lock), false, output)
          fs.writeFileSync(f.bin, '#!/bin/bash\nexit 0\n')
          assert.equal(spawnSync('bash', f.args, { env: f.env }).status, 0)
        }
      }
    } finally {
      if (pgid && liveGroup(pgid)) process.kill(-pgid, 'SIGKILL')
      if (holder.exitCode === null && holder.signalCode === null)
        holder.kill('SIGKILL')
    }
  })
}
test('unverifiable process group keeps the driver lock fail-closed', () => {
  const f = driverFixture('success')
  fs.writeFileSync(path.join(f.dir, 'ps'), '#!/bin/bash\nexit 1\n', {
    mode: 0o755,
  })
  const r = spawnSync('bash', f.args, { env: f.env, encoding: 'utf8' })
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.ok(fs.existsSync(f.lock))
  assert.match(r.stderr, /manual|unverifiable|unsettled/)
  assert.equal(spawnSync('bash', f.args, { env: f.env }).status, 2)
})

test('successful Maestro leader cannot release the lock while its grandchild lives', () => {
  const f = driverFixture('orphan')
  const r = spawnSync('bash', f.args, { env: f.env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const group = Number(fs.readFileSync(path.join(f.dir, 'driver'), 'utf8'))
  assert.equal(liveGroup(group), false)
  assert.equal(fs.existsSync(f.lock), false)
  assert.match(r.stderr, /MAESTRO_ESCALATION/)
})
test('cancellation before command spawn never admits a driver and restores acquisition', async () => {
  const f = driverFixture()
  const args = [
    '-c',
    'source "$1"; delayed() { echo WAITING; sleep 0.2; harness_maestro_command test; }; harness_with_maestro_lock delayed',
    'fixture',
    script,
  ]
  const p = spawn('bash', args, {
    env: f.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const done = new Promise((resolve) => p.once('exit', resolve))
  await new Promise((resolve) => p.stdout.once('data', resolve))
  p.kill('SIGTERM')
  assert.equal(await done, 143)
  assert.equal(fs.existsSync(path.join(f.dir, 'driver')), false)
  assert.equal(fs.existsSync(f.lock), false)
  fs.writeFileSync(f.bin, '#!/bin/bash\nexit 0\n')
  assert.equal(spawnSync('bash', f.args, { env: f.env }).status, 0)
})
test('lock ownership write failure remains fail-closed before spawn', () => {
  const f = driverFixture('success')
  fs.writeFileSync(
    path.join(f.dir, 'mkdir'),
    '#!/bin/bash\n/bin/mkdir "$@" || exit $?\n/bin/mkdir "$1/owner"\n',
    { mode: 0o755 }
  )
  const r = spawnSync('bash', f.args, { env: f.env, encoding: 'utf8' })
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.ok(fs.existsSync(f.lock))
  assert.equal(fs.existsSync(path.join(f.dir, 'driver')), false)
  assert.equal(spawnSync('bash', f.args, { env: f.env }).status, 2)
})
test('preexisting foreign driver lock is never reclaimed', () => {
  const f = driverFixture('success')
  fs.mkdirSync(f.lock)
  fs.writeFileSync(path.join(f.lock, 'owner'), 'external-owner')
  const r = spawnSync('bash', f.args, { env: f.env, encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.equal(
    fs.readFileSync(path.join(f.lock, 'owner'), 'utf8'),
    'external-owner'
  )
  assert.equal(fs.existsSync(path.join(f.dir, 'driver')), false)
})
