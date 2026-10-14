/* eslint-env node, es2022 */
const assert = require('node:assert/strict')
const { spawnSync, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// Mutate only disposable copies of an actual, lifecycle-built archive.
const tarball = path.resolve(process.argv[2] || '')
assert(
  process.argv[2],
  'Usage: node scripts/check-package.test.cjs <package.tgz>'
)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-package-witness-'))
const checker = path.join(__dirname, 'check-package.cjs')
const main = 'lib/commonjs/index.js'
const moduleEntry = 'lib/module/index.js'
const types = 'lib/typescript/index.d.ts'
const spec = 'specs/NitroBackgroundTimer.nitro'
const methods = [
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
const fake = '{' + methods.map((name) => name + '() {}').join(',') + '}'
const results = []
const outside = path.join(scratch, 'outside.mjs')
fs.writeFileSync(outside, 'export const outsideWitness = true\n')

function check(name, mutate, expected, failure) {
  const directory = path.join(scratch, name)
  fs.mkdirSync(directory)
  execFileSync('tar', ['-xzf', tarball, '-C', directory])
  const root = path.join(directory, 'package')
  const write = (file, text) => fs.writeFileSync(path.join(root, file), text)
  const remove = (file) => fs.rmSync(path.join(root, file), { recursive: true })
  const metadata = (field, value) => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8')
    )
    pkg[field] = value
    write('package.json', JSON.stringify(pkg))
  }
  mutate({ root, write, remove, metadata })
  const archive = path.join(directory, 'witness.tgz')
  execFileSync('tar', ['-czf', archive, '-C', directory, 'package'])
  const result = spawnSync(process.execPath, [checker, archive], {
    encoding: 'utf8',
  })
  assert.ifError(result.error)
  assert.equal(result.signal, null, name + ' terminated by signal')
  fs.writeFileSync(
    path.join(directory, 'checker.log'),
    result.stdout + result.stderr
  )
  results.push({
    name,
    command: [process.execPath, checker, archive],
    exit: result.status,
    signal: result.signal,
    expected,
    failure: failure && failure.source,
    failureMatched: !failure || failure.test(result.stdout + result.stderr),
  })
}

try {
  check('valid', () => {}, 0)
  check(
    'cjs-module-scope',
    ({ write }) => write('lib/commonjs/package.json', '{"type":"module"}'),
    1,
    /CJS consumer[\s\S]*(exports is not defined|ERR_REQUIRE_ESM|Synchronous ESM isolation)/
  )
  check(
    'cjs-dependency-module-scope',
    ({ write }) =>
      write('lib/commonjs/specs/package.json', '{"type":"module"}'),
    1,
    /CJS consumer[\s\S]*(exports is not defined|ERR_REQUIRE_ESM|Synchronous ESM isolation)/
  )
  check(
    'rn-repointed-spec',
    ({ metadata }) => metadata('react-native', 'src/' + spec),
    1,
    /RN consumer android[\s\S]*Public exports/
  )
  for (const [name, code, failure] of [
    ['empty', 'export {}', /Public exports/],
    [
      'missing-export',
      "export { NitroBackgroundTimer } from './index'",
      /Public exports/,
    ],
    [
      'wrong-shape',
      "export { NitroBackgroundTimer } from './index'; export const BackgroundTimer = { setTimeout: 1 }",
      /Public timer methods/,
    ],
    [
      'noop',
      "export { NitroBackgroundTimer } from './index'; export const BackgroundTimer = " +
        fake,
      /configure must serialize/,
    ],
  ]) {
    check(
      'rn-' + name,
      ({ write, metadata }) => {
        write('src/consumer-entry.ts', code)
        metadata('react-native', 'src/consumer-entry')
      },
      1,
      new RegExp('RN consumer android[\\s\\S]*' + failure.source)
    )
  }
  // Adversarial cases added after the first GREEN. No byte-equality asset
  // failure can stand in for exercising the selected public module.
  check(
    'cjs-inherited-module-scope',
    ({ write, remove }) => {
      remove('lib/commonjs/package.json')
      write('lib/package.json', '{"type":"module"}')
    },
    1,
    /CJS consumer[\s\S]*(exports is not defined|ERR_REQUIRE_ESM|Synchronous ESM isolation)/
  )
  check(
    'cjs-local-scope-override',
    ({ metadata }) => metadata('type', 'module'),
    0
  )
  check(
    'cjs-explicit-extension-valid',
    ({ root, write, metadata }) => {
      write(
        'lib/commonjs/public.cjs',
        fs.readFileSync(path.join(root, main), 'utf8')
      )
      write('lib/commonjs/package.json', '{"type":"module"}')
      write('lib/commonjs/specs/package.json', '{"type":"commonjs"}')
      metadata('main', 'lib/commonjs/public.cjs')
    },
    0
  )
  check(
    'cjs-dynamic-import-external',
    ({ root, write }) =>
      write(
        main,
        'import(' +
          JSON.stringify(pathToFileURL(outside).href) +
          ');\n' +
          fs.readFileSync(path.join(root, main), 'utf8')
      ),
    1,
    /CJS consumer[\s\S]*Node dependency escapes package/
  )
  check(
    'cjs-mjs-incompatible',
    ({ root, write, metadata }) => {
      write(
        'lib/commonjs/public.mjs',
        fs.readFileSync(path.join(root, main), 'utf8')
      )
      metadata('main', 'lib/commonjs/public.mjs')
    },
    1,
    /CJS consumer[\s\S]*(exports is not defined|ERR_REQUIRE_ESM|Synchronous ESM isolation)/
  )
  check(
    'cjs-auto-esm-external',
    ({ root, write }) => {
      fs.mkdirSync(path.join(root, 'lib/commonjs/automatic'))
      write('lib/commonjs/automatic/package.json', '{"name":"automatic-scope"}')
      write(
        'lib/commonjs/automatic/helper.js',
        'import ' + JSON.stringify(pathToFileURL(outside).href) + '; export {};'
      )
      write(
        main,
        "const extra = './automatic/helper.js'; require(extra);\n" +
          fs.readFileSync(path.join(root, main), 'utf8')
      )
    },
    1,
    /CJS consumer[\s\S]*(Node dependency escapes package|Synchronous ESM isolation)/
  )
  check(
    'cjs-implicit-scope-valid',
    ({ remove }) => remove('lib/commonjs/package.json'),
    0
  )
  for (const [name, code, expected] of [
    ['nonstandard-extension-valid', 'module.exports = {}', 0],
    [
      'nonstandard-extension-external',
      'import ' + JSON.stringify(pathToFileURL(outside).href) + '; export {};',
      1,
    ],
  ]) {
    check(
      'cjs-' + name,
      ({ root, write }) => {
        write('lib/commonjs/helper.custom', code)
        write(
          main,
          "const extra = './helper.custom'; require(extra);\n" +
            fs.readFileSync(path.join(root, main), 'utf8')
        )
      },
      expected,
      expected === 1
        ? /CJS consumer[\s\S]*(Node dependency escapes package|Synchronous ESM isolation)/
        : undefined
    )
  }
  for (const platform of ['android', 'ios', 'native']) {
    check(
      'rn-' + platform + '-precedence',
      ({ write }) => write('src/index.' + platform + '.ts', 'export {}'),
      1,
      new RegExp(
        'RN consumer ' +
          (platform === 'ios' ? 'ios' : 'android') +
          '[\\s\\S]*Public exports'
      )
    )
  }
  check(
    'rn-alternate-valid',
    ({ write, metadata }) => {
      write('src/public.ts', "export * from './index.ts'")
      metadata('react-native', 'src/public')
    },
    0
  )
  check(
    'rn-source-field-conflict',
    ({ metadata }) => metadata('source', 'src/' + spec),
    0
  )
  check(
    'rn-directory-valid',
    ({ root, write, metadata }) => {
      fs.mkdirSync(path.join(root, 'src/public'))
      write('src/public/index.ts', "export * from '../index.ts'")
      metadata('react-native', 'src/public')
    },
    0
  )
  check(
    'rn-extension-precedence',
    ({ write, metadata }) => {
      write('src/public.ts', "export * from './index.ts'")
      write('src/public.js', 'export {}')
      metadata('react-native', 'src/public')
    },
    1,
    /RN consumer android[\s\S]*Public exports/
  )
  check(
    'rn-browser-redirect',
    ({ metadata }) =>
      metadata('browser', { './src/index': './src/' + spec + '.ts' }),
    1,
    /RN consumer android[\s\S]*Public exports/
  )
  for (const [name, declared, exported, expected] of [
    ['valid', 'src/index', './src/index.ts', 0],
    ['wrong', 'src/index', './src/' + spec + '.ts', 1],
    ['masks-declaration', 'src/empty', './src/index.ts', 1],
  ]) {
    check(
      'rn-exports-' + name,
      ({ write, metadata }) => {
        write('src/empty.ts', 'export {}')
        metadata('react-native', declared)
        metadata('exports', {
          '.': {
            'react-native': exported,
            'require': './' + main,
            'default': './' + main,
          },
        })
      },
      expected,
      expected === 1
        ? /RN consumer android[\s\S]*must select the declared react-native entry/
        : undefined
    )
  }
  check(
    'cjs-exports-repoint',
    ({ metadata }) =>
      metadata('exports', {
        '.': {
          'require': './lib/commonjs/' + spec + '.js',
          'react-native': './src/index.ts',
        },
      }),
    1,
    /CJS consumer[\s\S]*Node must select the declared main entry/
  )
  check(
    'rn-import-external',
    ({ write, metadata }) => {
      write(
        'src/public.ts',
        'import ' + JSON.stringify(outside) + "; export * from './index.ts'"
      )
      metadata('react-native', 'src/public')
    },
    1,
    /RN consumer android[\s\S]*(escapes package|Unable to resolve)/
  )
  check(
    'rn-runtime-import-external',
    ({ write, metadata }) => {
      const runtime = path.join(
        path.dirname(require.resolve('metro-runtime/package.json')),
        'src/modules/empty-module.js'
      )
      write(
        'src/public.ts',
        'import ' + JSON.stringify(runtime) + "; export * from './index.ts'"
      )
      metadata('react-native', 'src/public')
    },
    1,
    /RN consumer android[\s\S]*RN dependency escapes package/
  )
  check(
    'rn-peer-browser-redirect',
    ({ write, metadata }) => {
      write(
        'src/unexpected-nitro.ts',
        'throw new Error("PACKED_PEER_REDIRECT_EXECUTED"); export const NitroModules = {}'
      )
      metadata('browser', {
        'react-native-nitro-modules': './src/unexpected-nitro.ts',
      })
    },
    1,
    /RN consumer android[\s\S]*PACKED_PEER_REDIRECT_EXECUTED/
  )
  for (const method of methods) {
    check(
      'noop-rn-' + method,
      ({ write, metadata }) => {
        write(
          'src/public.ts',
          "import { BackgroundTimer as base, NitroBackgroundTimer } from './index.ts'; export { NitroBackgroundTimer }; export const BackgroundTimer = { ...base, " +
            method +
            ': () => {} }'
        )
        metadata('react-native', 'src/public')
      },
      1,
      /RN consumer android[\s\S]*AssertionError/
    )
  }
  check(
    'main-repointed-spec',
    ({ remove, metadata }) => {
      remove(main)
      metadata('main', 'lib/commonjs/' + spec + '.js')
    },
    1
  )
  check('empty-cjs', ({ write }) => write(main, 'module.exports = {}\n'), 1)
  check(
    'fake-cjs',
    ({ write }) => write(main, 'exports.BackgroundTimer = ' + fake),
    1
  )
  check(
    'noop-cjs-with-hybrid',
    ({ write }) =>
      write(
        main,
        "exports.NitroBackgroundTimer = require('react-native-nitro-modules').NitroModules.createHybridObject('NitroBackgroundTimer'); exports.BackgroundTimer = " +
          fake
      ),
    1
  )
  check(
    'hybrid-as-wrapper',
    ({ write }) =>
      write(
        main,
        "exports.NitroBackgroundTimer = require('react-native-nitro-modules').NitroModules.createHybridObject('NitroBackgroundTimer'); exports.BackgroundTimer = exports.NitroBackgroundTimer"
      ),
    1
  )
  check(
    'module-repointed-spec',
    ({ remove, metadata }) => {
      remove(moduleEntry)
      metadata('module', 'lib/module/' + spec + '.js')
    },
    1
  )
  check('empty-esm', ({ write }) => write(moduleEntry, 'export {}\n'), 1)
  for (const [format, file, object] of [
    ['cjs', main, 'exports.BackgroundTimer'],
    ['esm', moduleEntry, 'BackgroundTimer'],
  ]) {
    for (const method of methods) {
      check(
        'noop-' + format + '-' + method,
        ({ root, write }) => {
          write(
            file,
            fs.readFileSync(path.join(root, file), 'utf8') +
              '\n' +
              object +
              '.' +
              method +
              ' = () => {}\n'
          )
        },
        1
      )
    }
  }
  for (const kind of ['any', 'never', '0']) {
    check(
      kind + '-fired-kind',
      ({ root, write }) => {
        const file = 'lib/typescript/' + spec + '.d.ts'
        const text = fs.readFileSync(path.join(root, file), 'utf8')
        assert(text.includes('type: FiredTimerType'), 'Mutation target missing')
        write(file, text.replace('type: FiredTimerType', 'type: ' + kind))
      },
      1
    )
  }
  check(
    'noop-esm-with-hybrid',
    ({ write }) =>
      write(
        moduleEntry,
        "import { NitroModules } from 'react-native-nitro-modules'; export const NitroBackgroundTimer = NitroModules.createHybridObject('NitroBackgroundTimer'); export const BackgroundTimer = " +
          fake
      ),
    1
  )
  check(
    'types-repointed-spec',
    ({ metadata }) => metadata('types', 'lib/typescript/' + spec + '.d.ts'),
    1
  )
  check('empty-types', ({ write }) => write(types, 'export {}\n'), 1)
  check(
    'any-types',
    ({ write }) =>
      write(
        types,
        'export declare const BackgroundTimer: any; export declare const NitroBackgroundTimer: any; export type BackgroundTimerConfig = any; export type BackgroundTimerNotificationConfig = any;'
      ),
    1
  )
  check(
    'widened-config',
    ({ root, write }) =>
      write(
        types,
        fs
          .readFileSync(path.join(root, types), 'utf8')
          .replace('title?: string', 'title?: any')
      ),
    1
  )
  for (const file of [
    main,
    moduleEntry,
    types,
    'lib/commonjs/' + spec + '.js',
    'lib/module/' + spec + '.js',
    'lib/typescript/' + spec + '.d.ts',
    'src/specs/NitroBackgroundTimer.nitro.ts',
    'nitrogen/generated/android/NitroBackgroundTimer+autolinking.cmake',
    'nitrogen/generated/ios/NitroBackgroundTimer+autolinking.rb',
    'android/src/main/AndroidManifest.xml',
    'ios/NitroBackgroundTimer.swift',
  ])
    check(
      'missing-' + file.replace(/[^a-zA-Z0-9]/g, '-'),
      ({ remove }) => remove(file),
      1
    )
  check('build-cache', ({ write }) => write('lib/cache.tsbuildinfo', '{}'), 1)
  check(
    'built-tests',
    ({ root, write }) => {
      fs.mkdirSync(path.join(root, 'lib/__tests__'))
      write('lib/__tests__/index.js', '')
    },
    1
  )
  check(
    'symlink-entry',
    ({ root, remove }) => {
      remove(main)
      fs.symlinkSync(
        'specs/NitroBackgroundTimer.nitro.js',
        path.join(root, main)
      )
    },
    1
  )
  check(
    'consumer-postinstall',
    ({ root, write }) => {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(root, 'package.json'), 'utf8')
      )
      pkg.scripts.postinstall = 'tsc'
      write('package.json', JSON.stringify(pkg))
    },
    1
  )
  check(
    'symlink-root',
    ({ root }) => {
      fs.rmSync(root, { recursive: true })
      fs.symlinkSync(path.join(scratch, 'valid/package'), root, 'dir')
    },
    1
  )
  check('valid-after-negatives', () => {}, 0)
  console.log(JSON.stringify({ scratch, results }, null, 2))
  fs.writeFileSync(
    path.join(scratch, 'results.json'),
    JSON.stringify(results, null, 2)
  )
  assert(
    results.every(
      ({ exit, expected, failureMatched }) =>
        exit === expected && failureMatched
    ),
    'Witness mismatch; inspect checker.log in ' + scratch
  )
} finally {
  // Preserve logs/archives for independent review; never touch the source tree.
  console.log('Witness evidence: ' + scratch)
}
