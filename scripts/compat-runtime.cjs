/* eslint-env node, es2022 */
const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')

const TAG = '[NitroBgCompat] '
const SETTLE_MS = 500

async function main() {
  const [platform, artifact, packageName, rn, runId, capture, portText] =
    process.argv.slice(2)
  const timeoutText = process.env.COMPAT_TIMEOUT_MS || '90000'
  if (!/^(android|ios)$/.test(platform) || !runId || !capture) {
    throw new Error(
      'Expected platform, artifact, package, RN, run ID, capture and port'
    )
  }
  if (
    !/^\d+$/.test(timeoutText) ||
    +timeoutText < 1000 ||
    +timeoutText > 600000
  ) {
    throw new Error('COMPAT_TIMEOUT_MS must be an integer from 1000 to 600000')
  }
  if (!/^\d+$/.test(portText) || +portText < 1 || +portText > 65535) {
    throw new Error('COMPAT_REPORT_PORT must be an integer from 1 to 65535')
  }
  const timeoutMs = Number(timeoutText)
  const fd = fs.openSync(capture, 'w')
  const record = (data) => fs.writeSync(fd, data)
  const command = (file, args) => {
    record(`COMMAND ${JSON.stringify([file, ...args])}\n`)
    const started = process.hrtime.bigint()
    const recordResult = (details) =>
      record(
        `COMMAND_RESULT ${JSON.stringify({
          command: [file, ...args],
          elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
          ...details,
        })}\n`
      )
    try {
      const output = execFileSync(file, args, {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      })
      record(output)
      recordResult({ exitCode: 0 })
      return output.trim()
    } catch (error) {
      record(String(error.stdout || '') + String(error.stderr || ''))
      recordResult({
        exitCode: error.status ?? null,
        signal: error.signal ?? null,
        code: error.code ?? null,
      })
      throw new Error(`${file} failed: ${error.message}`)
    }
  }
  let collector, server, deadline, settlement
  let stopping = false
  let finished = false
  let candidate
  let acceptResult, rejectResult
  const result = new Promise((resolve, reject) => {
    acceptResult = resolve
    rejectResult = reject
  })
  // Setup can fail before we reach await result. Keep that rejection handled.
  result.catch(() => {})
  const fail = (error) => {
    if (finished) return
    finished = true
    rejectResult(error)
  }
  const interrupted = () => fail(new Error('Runtime check interrupted'))
  const marker = (text) => {
    if (finished) return
    try {
      if (!text.startsWith(TAG)) throw new Error('Malformed runtime marker')
      const value = JSON.parse(text.slice(TAG.length))
      if (value.runId !== runId || value.rn !== rn || value.os !== platform) {
        throw new Error(
          'Runtime marker does not belong to this run/RN/platform'
        )
      }
      if (candidate)
        throw new Error('Multiple or contradictory terminal markers')
      if (value.status !== 'PASS')
        throw new Error(`App reported ${value.status}`)
      if (
        !Number.isFinite(value.elapsed) ||
        value.elapsed < 250 ||
        value.elapsed > timeoutMs ||
        !Number.isInteger(value.ticks) ||
        value.ticks < 2 ||
        value.clearedFired !== false
      ) {
        throw new Error('PASS marker contains invalid timer observations')
      }
      candidate = value
      // Drain further reports before accepting, so FAIL+PASS and duplicate
      // reports cannot win a race against the first PASS.
      settlement = setTimeout(() => {
        if (!finished) {
          finished = true
          acceptResult(value)
        }
      }, SETTLE_MS)
    } catch (error) {
      fail(error)
    }
  }
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  try {
    let pid, target
    if (platform === 'android') {
      if (!/^[A-Za-z0-9_.]+$/.test(packageName))
        throw new Error('Invalid Android package')
      if (!fs.statSync(artifact).isFile()) throw new Error('APK is not a file')
      const selection = process.env.ANDROID_SERIAL
        ? ['-s', process.env.ANDROID_SERIAL]
        : []
      target = command('adb', [...selection, 'get-serialno'])
      if (!/^\S+$/.test(target) || target === 'unknown')
        throw new Error('No unique Android target')
      const adb = (args) => command('adb', ['-s', target, ...args])
      adb(['install', '-r', artifact])
      adb(['shell', 'am', 'force-stop', packageName])
      for (const args of [
        ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'],
        ['shell', 'wm', 'dismiss-keyguard'],
      ]) {
        try {
          adb(args)
        } catch {
          /* Optional display/keyguard support. */
        }
      }
      adb(['logcat', '-c'])
      const launch = adb([
        'shell',
        'am',
        'start',
        '-W',
        '-n',
        `${packageName}/.MainActivity`,
      ])
      if (!/^Status: ok\r?$/m.test(launch))
        throw new Error('Android did not confirm a successful launch')
      pid = adb(['shell', 'pidof', '-s', packageName])
      if (!/^[1-9]\d*$/.test(pid))
        throw new Error('Could not identify the Android app process')
      deadline = setTimeout(
        () => fail(new Error('Runtime marker timed out')),
        timeoutMs
      )
      // logcat replays its retained buffer, including the early timer result
      // emitted while am start -W was waiting. The buffer was cleared above.
      const args = [
        '-s',
        target,
        'logcat',
        `--pid=${pid}`,
        '-v',
        'brief',
        '-s',
        'ReactNativeJS:V',
      ]
      record(`COLLECTOR ${JSON.stringify(['adb', ...args])}\n`)
      collector = spawn('adb', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let buffered = ''
      collector.stdout.on('data', (chunk) => {
        record(chunk)
        buffered += chunk.toString('utf8')
        let end
        while ((end = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, end).replace(/\r$/, '')
          buffered = buffered.slice(end + 1)
          if (!line.includes(TAG)) continue
          const entry = line.match(/^[A-Z]\/ReactNativeJS\(\s*(\d+)\):\s*(.*)$/)
          if (!entry || entry[1] !== pid)
            fail(new Error('Marker has an unexpected Android process/format'))
          else marker(entry[2])
        }
        if (buffered.length > 65536) fail(new Error('Oversized logcat line'))
      })
      collector.stderr.on('data', record)
      collector.on('error', fail)
      collector.on('close', (code, signal) => {
        if (!stopping)
          fail(
            new Error(`logcat exited before completion (${code}, ${signal})`)
          )
      })
    } else {
      if (!fs.statSync(artifact).isDirectory())
        throw new Error('iOS app is not a directory')
      const bundle = command('plutil', [
        '-extract',
        'CFBundleIdentifier',
        'raw',
        '-o',
        '-',
        `${artifact}/Info.plist`,
      ])
      if (!/^[A-Za-z0-9_.-]+$/.test(bundle))
        throw new Error('Invalid iOS bundle identifier')
      const devices = JSON.parse(
        command('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'])
      )
      const booted = Object.values(devices.devices)
        .flat()
        .filter((device) => device.state === 'Booted' && device.isAvailable)
      if (booted.length !== 1) throw new Error('Boot exactly one iOS simulator')
      target = booted[0].udid
      try {
        command('xcrun', ['simctl', 'terminate', target, bundle])
      } catch {
        /* An absent process is fine. */
      }
      command('xcrun', ['simctl', 'install', target, artifact])
      deadline = setTimeout(
        () => fail(new Error('Runtime marker timed out')),
        timeoutMs
      )
      server = http.createServer((req, res) => {
        let body = ''
        req.setEncoding('utf8')
        req.on('error', fail)
        req.on('data', (chunk) => {
          body += chunk
          if (body.length > 8192) {
            fail(new Error('Oversized runtime report'))
            req.destroy()
          }
        })
        req.on('end', () => {
          record(body + '\n')
          if (req.method !== 'POST' || req.url !== '/report') {
            res.writeHead(400).end()
            fail(new Error('Unexpected runtime report request'))
            return
          }
          marker(body)
          res.end()
        })
      })
      server.on('error', fail)
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(Number(portText), '127.0.0.1', resolve)
      })
      const launch = command('xcrun', ['simctl', 'launch', target, bundle])
      const match = launch.match(/^(.+): ([1-9]\d*)$/)
      if (!match || match[1] !== bundle)
        throw new Error('Simulator did not confirm the app PID')
      pid = match[2]
    }
    record(`IDENTITY ${JSON.stringify({ platform, rn, runId, target, pid })}\n`)
    const value = await result
    console.log(TAG + JSON.stringify(value))
  } finally {
    stopping = true
    clearTimeout(deadline)
    clearTimeout(settlement)
    process.removeListener('SIGINT', interrupted)
    process.removeListener('SIGTERM', interrupted)
    if (
      collector &&
      collector.exitCode === null &&
      collector.signalCode === null
    ) {
      await new Promise((resolve) => {
        const escalation = setTimeout(() => collector.kill('SIGKILL'), 1000)
        collector.once('close', () => {
          clearTimeout(escalation)
          resolve()
        })
        collector.kill('SIGTERM')
      })
    }
    if (server) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
    fs.closeSync(fd)
  }
}

main().catch((error) => {
  console.error(`Compatibility runtime failed: ${error.message}`)
  process.exitCode = 1
})
