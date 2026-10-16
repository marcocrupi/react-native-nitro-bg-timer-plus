/* eslint-env node, es2022 */
const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { fileURLToPath } = require('node:url')
const cjsConsumer = process.argv[2] === '--cjs-consumer'
const ts = cjsConsumer ? null : require('typescript') // Producer tool, never packed.

// Evaluate the real ESM graph without changing the package's bundler contract.
if (!cjsConsumer && typeof vm.SourceTextModule !== 'function') {
  const result = spawnSync(
    process.execPath,
    ['--experimental-vm-modules', __filename, ...process.argv.slice(2)],
    { stdio: 'inherit' }
  )
  assert.ifError(result.error)
  assert.equal(result.signal, null, 'Package checker terminated by signal')
  process.exit(result.status)
}

// Run after a normal `npm pack`: inspect the bytes actually distributed.
const tarball = process.argv[2]
assert(tarball, 'Usage: node scripts/check-package.cjs <package.tgz>')
const sourceRoot = path.resolve(__dirname, '..')
const scratch = cjsConsumer
  ? null
  : fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-package-check-'))
    )

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(file) : [file]
  })
}

const publicMethods = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'dispose',
  'configure',
  'startBackgroundMode',
  'stopBackgroundMode',
  'disableForegroundService',
]

function packedNodeFile(file, root) {
  assert(
    path.isAbsolute(file) && fs.realpathSync(file).startsWith(root + path.sep),
    'Node dependency escapes package: ' + file
  )
}

function requireCommonJSWithoutHooks(file, root) {
  // Older Node versions have async ESM hooks only. Do not accept a synchronous
  // ESM subgraph whose imports those hooks cannot observe. Ordinary CJS works.
  assert(
    !file.endsWith('.mjs'),
    'Synchronous ESM isolation needs Node module hooks'
  )
  if (['.cjs', '.json', '.node'].includes(path.extname(file))) return
  for (
    let directory = path.dirname(file);
    directory.startsWith(root);
    directory = path.dirname(directory)
  ) {
    const manifest = path.join(directory, 'package.json')
    if (file.endsWith('.js') && fs.existsSync(manifest)) {
      const type = JSON.parse(fs.readFileSync(manifest, 'utf8')).type
      assert.notEqual(
        type,
        'module',
        'Synchronous ESM isolation needs Node module hooks'
      )
      if (type === 'commonjs') return
      break
    }
  }
  // Node can detect ESM syntax in a typeless scope or an unknown extension.
  // Without synchronous hooks, gate CommonJS grammar before native execution;
  // this is a syntax check, never a replacement loader or transformation.
  const syntax = spawnSync(
    process.execPath,
    ['--input-type=commonjs', '--check'],
    { input: fs.readFileSync(file, 'utf8'), encoding: 'utf8' }
  )
  assert.ifError(syntax.error)
  assert.equal(syntax.signal, null, 'Node syntax check terminated by signal')
  assert.equal(
    syntax.status,
    0,
    'Synchronous ESM isolation needs Node module hooks\n' + syntax.stderr
  )
}

async function checkPublicJavaScript(root, entry, format, options = {}) {
  // Fresh graph and peers per format. Mocks supply only native primitives;
  // BackgroundTimer must come from the packed JS and perform its own work.
  const calls = []
  let pending = []
  let listener
  let removed = 0
  let created = 0
  const native = Object.fromEntries(
    publicMethods.map((name) => [
      name,
      (...args) => {
        calls.push([name, ...args])
      },
    ])
  )
  native.drainFiredTimers = () => {
    const events = pending
    pending = []
    return events
  }
  const emitter = {
    addListener(name, callback) {
      assert.equal(name, 'NitroBackgroundTimerTimersAvailable')
      assert.equal(listener, undefined, 'Duplicate timer subscription')
      listener = callback
      return {
        remove() {
          removed++
        },
      }
    },
  }
  const peers = {
    'react-native': {
      Platform: { OS: options.platform || 'android' },
      NativeModules: {},
      DeviceEventEmitter: emitter,
      NativeEventEmitter: class {
        constructor() {
          throw new Error('Unexpected native emitter without a native module')
        }
      },
    },
    'react-native-nitro-modules': {
      NitroModules: {
        createHybridObject(name) {
          assert.equal(name, 'NitroBackgroundTimer')
          created++
          return native
        },
      },
    },
  }
  function resolve(specifier, parent) {
    assert(specifier.startsWith('.'), 'Unexpected dependency: ' + specifier)
    const target = path.resolve(path.dirname(parent), specifier)
    const file = [target, target + '.js', path.join(target, 'index.js')].find(
      (candidate) =>
        fs.existsSync(candidate) && fs.lstatSync(candidate).isFile()
    )
    assert(
      file && file.startsWith(root + path.sep),
      'Missing packed dependency: ' + specifier
    )
    return file
  }
  const context = vm.createContext({})
  const cache = new Map()
  const loaded = new Set()
  const mockedPeers = new Set()
  function loadESM(file) {
    if (cache.has(file)) return cache.get(file)
    const mod = new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), {
      context,
      identifier: file,
    })
    cache.set(file, mod)
    loaded.add(file)
    return mod
  }
  let exported
  const entryFile = path.join(root, entry)
  if (format === 'main') {
    const consumerRequire = Module.createRequire(
      path.join(options.consumer, 'consumer.cjs')
    )
    assert.equal(
      consumerRequire.resolve(options.name),
      entryFile,
      'Node must select the declared main entry'
    )
    if (typeof Module.registerHooks === 'function') {
      // Delegate format and resolution to Node, also for import() and mixed
      // CJS/ESM graphs. Only enforce the same packed-file boundary as require.
      Module.registerHooks({
        resolve(name, hookContext, nextResolve) {
          const resolved = nextResolve(name, hookContext)
          assert(
            resolved.url.startsWith('file:'),
            'Node dependency escapes package: ' + name
          )
          const file = fileURLToPath(resolved.url)
          packedNodeFile(file, root)
          loaded.add(file)
          return resolved
        },
      })
    }
    const load = Module._load
    // This process loads only the packed graph. Never compile or force a scope.
    Module._load = function (name, parent, isMain) {
      if (Object.hasOwn(peers, name)) {
        assert(
          parent && parent.filename.startsWith(root + path.sep),
          'Peer mock requested outside packed graph'
        )
        mockedPeers.add(name)
        return peers[name]
      }
      const file = Module._resolveFilename(name, parent, isMain)
      packedNodeFile(file, root)
      if (typeof Module.registerHooks !== 'function')
        requireCommonJSWithoutHooks(file, root)
      loaded.add(file)
      return load.call(this, name, parent, isMain)
    }
    // The hook remains active through the behavior oracle; the worker exits.
    exported = consumerRequire(options.name)
  } else if (format === 'react-native') {
    const result = await bundleReactNative(root, entry, options)
    for (const file of result.loaded) loaded.add(file)
    for (const name of result.mockedPeers) mockedPeers.add(name)
    new vm.Script(result.code, {
      filename: 'packed-rn.bundle.js',
    }).runInNewContext({
      __packagePeers: peers,
      __packageResult: (api) => {
        exported = api
      },
    })
    entry = result.entry
  } else {
    const mod = loadESM(entryFile)
    await mod.link((name, parent) => {
      if (!Object.hasOwn(peers, name))
        return loadESM(resolve(name, parent.identifier))
      const peerKey = 'peer:' + name
      mockedPeers.add(name)
      if (!cache.has(peerKey)) {
        cache.set(
          peerKey,
          new vm.SyntheticModule(
            Object.keys(peers[name]),
            function () {
              for (const [exportName, value] of Object.entries(peers[name]))
                this.setExport(exportName, value)
            },
            { context }
          )
        )
      }
      return cache.get(peerKey)
    })
    await mod.evaluate()
    exported = mod.namespace
  }
  assert.deepEqual(
    Object.keys(exported).sort(),
    ['BackgroundTimer', 'NitroBackgroundTimer'],
    'Public exports'
  )
  // Metro can expose lazy re-export getters. Observe the API before counting
  // creation, so an otherwise valid forwarding entry is not rejected.
  const nativeExport = exported.NitroBackgroundTimer
  const timer = exported.BackgroundTimer
  assert.equal(created, 1, 'Hybrid object must be created by the packed entry')
  assert.equal(nativeExport, native)
  assert(timer && timer !== native, 'Missing public timer wrapper')
  assert.deepEqual(
    Object.keys(timer).sort(),
    [...publicMethods].sort(),
    'Public timer methods'
  )
  for (const method of publicMethods)
    assert.equal(typeof timer[method], 'function', method)
  assert.equal(typeof listener, 'function', 'Missing packed event handling')

  function forwarded(method, args) {
    const before = calls.length
    timer[method](...args)
    assert.equal(calls.length, before + 1, method + ' must forward once')
    assert.deepEqual(calls[before], [method, ...args])
  }
  const config = {
    notification: { title: 'Package witness', channelId: 'witness' },
  }
  timer.configure(config)
  assert.deepEqual(
    calls.pop(),
    ['configure', JSON.stringify(config)],
    'configure must serialize and forward once'
  )
  forwarded('startBackgroundMode', [])
  forwarded('stopBackgroundMode', [])
  forwarded('disableForegroundService', [])
  let timeoutFired = 0
  let intervalFired = 0
  const timeout = timer.setTimeout(() => {
    timeoutFired++
  }, 17)
  assert.equal(typeof timeout, 'number')
  assert(Number.isFinite(timeout))
  assert.deepEqual(calls.pop(), ['setTimeout', timeout, 17])
  const interval = timer.setInterval(() => {
    intervalFired++
  }, 29)
  assert.equal(typeof interval, 'number')
  assert(Number.isFinite(interval) && interval !== timeout)
  assert.deepEqual(calls.pop(), ['setInterval', interval, 29])
  function fire() {
    pending = [
      { id: timeout, type: 0, sequence: 1 },
      { id: interval, type: 1, sequence: 2 },
    ]
    listener()
    assert.equal(pending.length, 0, 'Packed wrapper must drain events')
  }
  fire()
  assert.equal(timeoutFired, 1)
  assert.equal(intervalFired, 1)
  fire()
  assert.equal(timeoutFired, 1)
  assert.equal(intervalFired, 2)
  forwarded('clearTimeout', [timeout])
  forwarded('clearInterval', [interval])
  fire()
  assert.equal(intervalFired, 2)
  forwarded('dispose', [])
  assert.equal(removed, 1, 'Dispose must remove the packed subscription')
  const before = calls.length
  timer.dispose()
  timer.clearTimeout(timeout)
  timer.clearInterval(interval)
  assert.equal(calls.length, before)
  assert.throws(() => timer.setTimeout(() => {}, 1), /disposed/)
  assert.throws(() => timer.setInterval(() => {}, 1), /disposed/)
  return {
    entry,
    exports: Object.keys(exported),
    methods: publicMethods,
    mockedPeers: [...mockedPeers],
    get loaded() {
      return [...loaded].map((file) => path.relative(root, file))
    },
  }
}

function checkNodeConsumer(root, entry, options) {
  const report = path.join(options.consumer, 'cjs-result.json')
  const flags = ['--unhandled-rejections=strict']
  if (typeof Module.registerHooks !== 'function') {
    const guard = path.join(options.consumer, 'node-import-guard.mjs')
    fs.writeFileSync(
      guard,
      `
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = ${JSON.stringify(root + path.sep)}
const worker = ${JSON.stringify(__filename)}
export async function resolve(name, context, nextResolve) {
  const resolved = await nextResolve(name, context)
  if (!context.parentURL && resolved.url.startsWith('file:') && fileURLToPath(resolved.url) === worker) return resolved
  if (!resolved.url.startsWith('file:') || !realpathSync(fileURLToPath(resolved.url)).startsWith(root))
    throw new Error('Node dependency escapes package: ' + name)
  return resolved
}
`
    )
    flags.push('--experimental-loader', guard)
  }
  const result = spawnSync(
    process.execPath,
    [
      ...flags,
      __filename,
      '--cjs-consumer',
      root,
      entry,
      options.name,
      options.consumer,
      report,
    ],
    { encoding: 'utf8' }
  )
  assert.ifError(result.error)
  assert.equal(result.signal, null, 'CJS consumer terminated by signal')
  assert.equal(
    result.status,
    0,
    'CJS consumer\n' + result.stdout + result.stderr
  )
  return JSON.parse(fs.readFileSync(report, 'utf8'))
}

async function bundleReactNative(root, entry, options) {
  const metro = require('metro')
  const {
    getDefaultConfig,
    mergeConfig,
  } = require('@react-native/metro-config')
  const runtimeRoot = fs.realpathSync(
    path.dirname(require.resolve('metro-runtime/package.json'))
  )
  const consumer = options.consumer
  const fixture = path.join(consumer, 'rn-' + options.platform)
  fs.mkdirSync(fixture)
  fs.mkdirSync(path.join(fixture, 'cache'))
  const consumerEntry = path.join(fixture, 'entry.js')
  fs.writeFileSync(
    consumerEntry,
    'globalThis.__packageResult(require(' +
      JSON.stringify(options.name) +
      '));\n'
  )
  const peerFiles = new Map()
  for (const name of ['react-native', 'react-native-nitro-modules']) {
    const directory = path.join(consumer, 'node_modules', name)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({ name, main: 'index.js' })
    )
    const file = path.join(directory, 'index.js')
    fs.writeFileSync(
      file,
      'module.exports = globalThis.__packagePeers[' +
        JSON.stringify(name) +
        '];\n'
    )
    peerFiles.set(name, file)
  }
  const loaded = new Set()
  const mockedPeers = new Set()
  let selectedEntry
  const declared = path.resolve(root, entry)
  assert(
    declared.startsWith(root + path.sep),
    'react-native escapes the package'
  )
  const config = mergeConfig(getDefaultConfig(consumer), {
    projectRoot: consumer,
    watchFolders: [consumer, runtimeRoot],
    maxWorkers: 1,
    cacheStores: [],
    fileMapCacheDirectory: path.join(fixture, 'cache'),
    reporter: { update() {} },
    resolver: {
      useWatchman: false,
      disableHierarchicalLookup: true,
      nodeModulesPaths: [path.join(consumer, 'node_modules')],
      extraNodeModules: {},
      resolveRequest(context, name, platform) {
        // Resolve first: RN/browser remapping of a peer to a packed module
        // must execute that module, not silently substitute our peer mock.
        const resolved = context.resolveRequest(context, name, platform)
        assert.equal(
          resolved.type,
          'sourceFile',
          'RN dependency must be a source module: ' + name
        )
        const file = fs.realpathSync(resolved.filePath)
        if ([...peerFiles.values()].includes(file)) {
          assert(
            peerFiles.get(name) === file &&
              context.originModulePath.startsWith(root + path.sep),
            'Peer mock requested outside packed graph'
          )
          mockedPeers.add(name)
          return resolved
        }
        const toolingOrigin =
          path.resolve(context.originModulePath) === consumer ||
          context.originModulePath.startsWith(runtimeRoot + path.sep)
        assert(
          file.startsWith(root + path.sep) ||
            (toolingOrigin && file.startsWith(runtimeRoot + path.sep)),
          'RN dependency escapes package: ' + name
        )
        if (
          context.originModulePath === consumerEntry &&
          name === options.name
        ) {
          const declaredResolution = context.resolveRequest(
            context,
            declared,
            platform
          )
          assert.equal(
            declaredResolution.type,
            'sourceFile',
            'Missing declared RN entry'
          )
          assert.equal(
            file,
            fs.realpathSync(declaredResolution.filePath),
            'RN resolution must select the declared react-native entry'
          )
          selectedEntry = file
        }
        if (file.startsWith(root + path.sep)) loaded.add(file)
        return resolved
      },
    },
    serializer: {
      getModulesRunBeforeMainModule: () => [],
      getPolyfills: () => [],
    },
    transformer: { enableBabelRCLookup: false },
  })
  const bundle = await metro.runBuild(config, {
    entry: consumerEntry,
    platform: options.platform,
    dev: false,
    minify: false,
  })
  assert(selectedEntry, 'Metro did not resolve the packed public entry')
  return {
    code: bundle.code,
    entry: path.relative(root, selectedEntry),
    loaded,
    mockedPeers,
  }
}

function checkPublicDeclarations(root, entry) {
  // Compile an independent strict consumer against ONLY packed declarations.
  // The peer stub models the inherited native disposal contract, never the
  // public wrapper/config. Exact types reject any, widened types and no-op API.
  const consumer = path.join(scratch, 'consumer.ts')
  const peer = path.join(scratch, 'peer.d.ts')
  fs.writeFileSync(
    peer,
    "declare module 'react-native-nitro-modules' { export interface HybridObject<T> { dispose(): void } }\n"
  )
  fs.writeFileSync(
    consumer,
    `
import { BackgroundTimer, NitroBackgroundTimer, type BackgroundTimerConfig, type BackgroundTimerNotificationConfig } from 'packed-public'
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T
type Public = {
  setTimeout(callback: () => void, duration: number): number
  clearTimeout(id: number): void
  setInterval(callback: () => void, interval: number): number
  clearInterval(id: number): void
  dispose(): void
  configure(config: BackgroundTimerConfig): void
  startBackgroundMode(): void
  stopBackgroundMode(): void
  disableForegroundService(): void
}
type Wrapper = Assert<Equal<typeof BackgroundTimer, Public>>
type Notification = Assert<Equal<BackgroundTimerNotificationConfig, {
  title?: string; text?: string; channelId?: string; channelName?: string; iconResourceName?: string
}>>
type Config = Assert<Equal<BackgroundTimerConfig, { notification?: BackgroundTimerNotificationConfig }>>
type NotAny = Assert<Equal<0 extends (1 & typeof NitroBackgroundTimer) ? true : false, false>>
type Native = {
  setTimeout(id: number, duration: number): void
  clearTimeout(id: number): void
  setInterval(id: number, interval: number): void
  clearInterval(id: number): void
  dispose(): void
  configure(configJson: string): void
  startBackgroundMode(): void
  stopBackgroundMode(): void
  disableForegroundService(): void
}
type NativeMethods = Assert<Equal<Pick<typeof NitroBackgroundTimer, keyof Native>, Native>>
type Fired = ReturnType<typeof NitroBackgroundTimer.drainFiredTimers>[number]
type Event = Assert<Equal<Pick<Fired, 'id' | 'sequence'>, { id: number; sequence: number }>>
type EventArray = Assert<Equal<ReturnType<typeof NitroBackgroundTimer.drainFiredTimers>, Fired[]>>
type KindNotAny = Assert<Equal<0 extends (1 & Fired['type']) ? true : false, false>>
type KindValues = Assert<Fired['type'] extends 0 | 1 ? true : false>
type KindCoverage = Assert<0 | 1 extends Fired['type'] ? true : false>
const notification: BackgroundTimerNotificationConfig = { title: 'Consumer', text: 'Timer', channelId: 'id', channelName: 'Timers', iconResourceName: 'icon' }
BackgroundTimer.configure({ notification })
const timeout: number = BackgroundTimer.setTimeout(() => {}, 17)
const interval: number = BackgroundTimer.setInterval(() => {}, 29)
BackgroundTimer.clearTimeout(timeout)
BackgroundTimer.clearInterval(interval)
BackgroundTimer.startBackgroundMode()
BackgroundTimer.stopBackgroundMode()
BackgroundTimer.disableForegroundService()
BackgroundTimer.dispose()
// @ts-expect-error Duration must be numeric.
BackgroundTimer.setTimeout(() => {}, '17')
// @ts-expect-error Public scheduling takes a callback, not the native numeric ID.
BackgroundTimer.setInterval(1, 29)
// @ts-expect-error Config properties cannot be any.
BackgroundTimer.configure({ notification: { title: 42 } })
// @ts-expect-error Native ID cannot be any.
NitroBackgroundTimer.setTimeout('1', 17)
`
  )
  const options = {
    strict: true,
    skipLibCheck: false,
    noEmit: true,
    types: [],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    paths: { 'packed-public': [path.join(root, entry)] },
  }
  const host = ts.createCompilerHost(options)
  const read = host.readFile
  const exists = host.fileExists
  const compilerLib = path.dirname(ts.getDefaultLibFilePath(options)) + path.sep
  const allowed = (file) =>
    [consumer, peer].includes(file) ||
    (file.startsWith(root + path.sep) && file.endsWith('.d.ts')) ||
    file.startsWith(compilerLib)
  host.readFile = (file) => (allowed(file) ? read(file) : undefined)
  host.fileExists = (file) => allowed(file) && exists(file)
  const program = ts.createProgram([consumer, peer], options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => scratch,
      getCanonicalFileName: (file) => file,
      getNewLine: () => '\n',
    })
  )
  assert(
    program.getSourceFile(path.join(root, entry)),
    'Packed declaration entry was not checked'
  )
}

async function checkPackage() {
  try {
    execFileSync('tar', ['-xzf', path.resolve(tarball), '-C', scratch])
    const root = path.join(scratch, 'package')
    assert(
      fs.lstatSync(root).isDirectory(),
      'Non-directory package root (symlinks forbidden)'
    )
    for (const file of filesUnder(root)) {
      assert(fs.lstatSync(file).isFile(), 'Non-regular package file: ' + file)
    }
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8')
    )
    const entryPoints = {}

    assert.equal(
      typeof pkg['react-native'],
      'string',
      'Missing react-native metadata'
    )
    for (const field of ['main', 'module', 'types']) {
      assert.equal(typeof pkg[field], 'string', `Missing ${field} metadata`)
      const resolved = path.resolve(root, pkg[field])
      assert(
        fs.existsSync(resolved) && fs.statSync(resolved).isFile(),
        `Missing declared ${field} entry point: ${pkg[field]}`
      )
      assert(resolved, `Missing declared ${field} entry point: ${pkg[field]}`)
      assert(
        resolved.startsWith(root + path.sep),
        `${field} escapes the package`
      )
      entryPoints[field] = path.relative(root, resolved)
    }

    assert.equal(
      path.extname(entryPoints.types),
      '.ts',
      'Expected declarations'
    )
    assert(
      entryPoints.types.endsWith('.d.ts'),
      'types must resolve to a .d.ts file'
    )
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
      assert(
        !(pkg.scripts && pkg.scripts[hook]),
        `Unexpected consumer lifecycle hook: ${hook}`
      )
    }

    const builds = filesUnder(path.join(root, 'lib'))
    assert(
      !builds.some((file) => file.endsWith('.tsbuildinfo')),
      'Packed build cache'
    )
    assert(
      !builds.some((file) => file.includes('/__tests__/')),
      'Packed test build'
    )

    // Parse both JS formats and resolve their internal imports inside the tarball.
    for (const field of ['main', 'module']) {
      const visited = new Set()
      function checkJavaScript(file) {
        if (visited.has(file)) return
        visited.add(file)
        const text = fs.readFileSync(file, 'utf8')
        execFileSync(
          process.execPath,
          [
            '--input-type=' + (field === 'main' ? 'commonjs' : 'module'),
            '--check',
          ],
          { input: text }
        )
        const imports = text.matchAll(
          /(?:from\s*|require\s*\()(['"])(\.[^'"]+)\1/g
        )
        for (const [, , specifier] of imports) {
          const target = path.resolve(path.dirname(file), specifier)
          const resolved = [
            target,
            target + '.js',
            path.join(target, 'index.js'),
          ].find(
            (candidate) =>
              fs.existsSync(candidate) && fs.statSync(candidate).isFile()
          )
          assert(resolved, `Missing JS dependency: ${specifier}`)
          assert(
            resolved.startsWith(root + path.sep),
            'JS dependency escapes package'
          )
          checkJavaScript(resolved)
        }
      }
      checkJavaScript(path.join(root, entryPoints[field]))
    }

    // Validate the declaration dependency graph, including the Nitro spec.
    const declarations = new Set()
    function checkDeclaration(file) {
      if (declarations.has(file)) return
      declarations.add(file)
      const text = fs.readFileSync(file, 'utf8')
      const imports = text.matchAll(
        /(?:from\s*|import\s*\()(['"])(\.[^'"]+)\1/g
      )
      for (const [, , specifier] of imports) {
        const target = path.resolve(path.dirname(file), specifier)
        const resolved = [
          target,
          target + '.d.ts',
          path.join(target, 'index.d.ts'),
        ].find(
          (candidate) =>
            fs.existsSync(candidate) && fs.statSync(candidate).isFile()
        )
        assert(resolved, `Missing declaration dependency: ${specifier}`)
        assert(
          resolved.startsWith(root + path.sep),
          'Declaration escapes package'
        )
        checkDeclaration(resolved)
      }
    }
    checkDeclaration(path.join(root, entryPoints.types))

    const api = {}
    assert(
      /^(?:@[a-z0-9._~-]+\/)?[a-z0-9_~-][a-z0-9._~-]*$/i.test(pkg.name),
      'Invalid consumer package name'
    )
    assert(
      !['react-native', 'react-native-nitro-modules'].includes(pkg.name),
      'Packed package cannot be a peer mock'
    )
    const consumer = path.join(scratch, 'consumer')
    const installed = path.join(consumer, 'node_modules', pkg.name)
    fs.mkdirSync(path.dirname(installed), { recursive: true })
    fs.cpSync(root, installed, { recursive: true })
    const options = { name: pkg.name, consumer }
    api.main = checkNodeConsumer(installed, entryPoints.main, options)
    api.module = await checkPublicJavaScript(root, entryPoints.module, 'module')
    api['react-native'] = {}
    for (const platform of ['android', 'ios']) {
      try {
        api['react-native'][platform] = await checkPublicJavaScript(
          installed,
          pkg['react-native'],
          'react-native',
          { ...options, platform }
        )
      } catch (error) {
        throw new Error('RN consumer ' + platform + '\n' + error.stack)
      }
    }
    entryPoints['react-native'] = api['react-native'].android.entry
    checkPublicDeclarations(root, entryPoints.types)

    const assets = [
      'src/index.ts',
      'src/specs/NitroBackgroundTimer.nitro.ts',
      'react-native.config.js',
      'nitro.json',
      'NitroBackgroundTimer.podspec',
      'compat/react-native-nitro-modules+0.37.1.patch',
      'compat/README.md',
      'android/build.gradle',
      'android/gradle.properties',
      'android/CMakeLists.txt',
      ...['android/src', 'ios', 'nitrogen/generated'].flatMap((directory) =>
        filesUnder(path.join(sourceRoot, directory)).map((file) =>
          path.relative(sourceRoot, file)
        )
      ),
    ]
    for (const asset of assets) {
      const packed = path.join(root, asset)
      assert(fs.existsSync(packed), `Missing package asset: ${asset}`)
      assert.deepEqual(
        fs.readFileSync(packed),
        fs.readFileSync(path.join(sourceRoot, asset)),
        `Package asset differs from source: ${asset}`
      )
    }
    console.log(
      JSON.stringify(
        {
          entryPoints,
          api,
          declarationAPI: 'strict packed consumer PASS',
          declarations: [...declarations].map((file) =>
            path.relative(root, file)
          ),
          assets,
        },
        null,
        2
      )
    )
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

const checking = cjsConsumer
  ? checkPublicJavaScript(process.argv[3], process.argv[4], 'main', {
      name: process.argv[5],
      consumer: process.argv[6],
    }).then((result) => {
      // Let native import jobs settle before reporting the complete graph.
      process.once('beforeExit', () => {
        fs.writeFileSync(process.argv[7], JSON.stringify(result))
      })
    })
  : checkPackage()
checking.catch((error) => {
  console.error(error)
  process.exitCode = 1
})
