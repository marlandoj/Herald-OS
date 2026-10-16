// Compiled shell/preload + real project-isolated backend regression. No provider probes.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const project = path.resolve(__dirname, '..')
const home = process.env.HERMES_HOME
const ownedDirectory = (directory, privateLeaf = false) => {
  if (!directory || !path.isAbsolute(directory) || fs.realpathSync(directory) !== directory) throw new Error('Canonical fixture directory required')
  for (let current = directory; ; current = path.dirname(current)) {
    const info = fs.lstatSync(current)
    const sharedTemporaryAncestor = current !== directory && Boolean(info.mode & 0o1000)
    if (!info.isDirectory() || ![0, process.getuid()].includes(info.uid) || ((info.mode & 0o022) && !sharedTemporaryAncestor)) throw new Error('Unsafe fixture ancestor')
    if (current === path.dirname(current)) break
  }
  const info = fs.lstatSync(directory)
  if (info.uid !== process.getuid() || (privateLeaf && (info.mode & 0o777) !== 0o700)) throw new Error('Owned private fixture directory required')
}
if (project !== process.env.CREDENTIAL_FIXTURE_PROJECT) throw new Error('Explicit portable fixture project required')
ownedDirectory(project)
ownedDirectory(home, true)
ownedDirectory(process.env.HERALD_OS_HERMES_ROOT)
if (process.env.HOME !== home) throw new Error('Fixture home mismatch')
const marker = fs.openSync(path.join(home, '.fixture-owner'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
try {
  const info = fs.fstatSync(marker)
  if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 ||
      !process.env.CREDENTIAL_FIXTURE_TOKEN || fs.readFileSync(marker, 'utf8') !== process.env.CREDENTIAL_FIXTURE_TOKEN) throw new Error('Fixture ownership marker required')
} finally { fs.closeSync(marker) }
// No Electron import until the portable project/home ownership guard succeeds.
const { app, BrowserWindow } = require('electron')
app.setPath('userData', path.join(home, 'electron-userdata-credential-regression'))
app.on('browser-window-created', (_event, win) => { win.show = () => {}; win.setFullScreen = () => {} })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const check = (condition, label) => { if (!condition) throw new Error(label) }
const envFile = path.join(home, '.env')
const configFile = path.join(home, 'config.yaml')
const rotated = crypto.randomBytes(24).toString('hex')
const customValue = crypto.randomBytes(24).toString('hex')
const outsideFile = path.join(home, 'credential-outside-fixture')
let win
let checkpoint = 'boot'
const evaluate = code => win.webContents.executeJavaScript(code, true)
async function ready() {
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    win = BrowserWindow.getAllWindows()[0]
    if (win && await evaluate('(async () => Boolean(window.heraldOS) && (await window.heraldOS.backend.getState()).phase === "ready")()').catch(() => false)) return
    await pause(200)
  }
  throw new Error('Backend not ready')
}
;(async () => {
  try {
    await import(pathToFileURL(path.join(project, 'apps/desktop/dist/electron/main.mjs')).href)
    await app.whenReady()
    await ready()
    checkpoint = 'rotate-mirrors'
    check((await evaluate(`window.heraldOS.credentials.save('OPENAI_API_KEY', ${JSON.stringify(rotated)}, 'update')`)).ok, 'Save failed')
    check((await evaluate(`window.heraldOS.credentials.save('ACME_API_KEY', ${JSON.stringify(customValue)}, 'add')`)).ok, 'Custom save failed')
    check((fs.statSync(envFile).mode & 0o777) === 0o600, 'Mode incorrect')
    for (const name of ['config.yaml', 'auth.json']) check((fs.statSync(path.join(home, name)).mode & 0o777) === 0o600, 'Associated storage mode incorrect')
    check(fs.readFileSync(configFile, 'utf8').includes(rotated), 'Real mirror not rotated')
    checkpoint = 'renderer-config-disclosure'
    const config = await evaluate('window.heraldOS.backend.rest({method:"GET",path:"/api/config"})')
    check(!JSON.stringify(config).includes(rotated) && !JSON.stringify(config).includes(customValue), 'Renderer received credential')
    check(!['auxiliary', 'providers', 'custom_providers'].some(key => Object.hasOwn(config, key)), 'Raw config returned')
    const blocked = code => evaluate(`(async () => { try { await ${code}; return false } catch { return true } })()`)
    check(await blocked('window.heraldOS.backend.rest({method:"GET",path:"/api/config/raw"})'), 'Raw config bypass')
    check(await blocked('window.heraldOS.backend.rest({method:"PUT",path:"/api/config",body:{config:{auxiliary:{vision:{api_key:"redacted-placeholder"}}}}})'), 'Credential config write bypass')
    for (const field of ['stt.local.model', 'stt.local.initial_prompt', 'model.default']) {
      const configPatch = field.split('.').reverse().reduce((value, key) => ({[key]:value}), '${OPENAI_API_KEY}')
      check(await blocked(`window.heraldOS.backend.rest(${JSON.stringify({method:'PUT',path:'/api/config',body:{config:configPatch}})})`), 'Reference config write bypass')
    }
    checkpoint = 'direct-renderer-http'
    // Return booleans only: neither a token nor fixture credential leaves the page.
    const directCode = `(async () => {
      const state = await window.heraldOS.backend.getState()
      const token = new URL(state.wsUrl).searchParams.get('token')
      if (!token) return { hasToken: false }
      const request = async (route, options = {}, host) => {
        try {
          const base = new URL(state.baseUrl)
          if (host) base.hostname = host
          const response = await fetch(base.origin + route, {
            ...options, headers: {'X-Hermes-Session-Token': token, 'Content-Type': 'application/json'}
          })
          const text = await response.text()
          return { blocked: false, receivedValue: text.includes(${JSON.stringify(rotated)}) || text.includes(${JSON.stringify(customValue)}), ok: response.ok }
        } catch { return { blocked: true, receivedValue: false, ok: false } }
      }
      return { hasToken: true, reveal: await request('/api/env/reveal', {method:'POST', body:JSON.stringify({key:'OPENAI_API_KEY'})}),
        custom: await request('/api/env/reveal', {method:'POST', body:JSON.stringify({key:'ACME_API_KEY'})}),
        config: await request('/api/config'), raw: await request('/api/config/raw'), status: await request('/api/status'),
        aliases: await Promise.all(['localhost','localhost.','127.1'].map(host => request('/api/env/reveal',
          {method:'POST',body:JSON.stringify({key:'OPENAI_API_KEY'})}, host))) }
    })()`
    const desktop = win
    for (const surface of ['desktop', 'panel', 'new-partition']) {
      checkpoint = 'direct-renderer-http-' + surface
      if (surface !== 'desktop') {
        win = new BrowserWindow({ show: false, webPreferences: {
          preload: path.join(project, 'apps/desktop/dist/electron/preload.cjs'),
          contextIsolation: true, sandbox: true, nodeIntegration: false,
          ...(surface === 'new-partition' ? { partition: 'credential-fixture' } : {}),
          additionalArguments: ['--hermes-surface=panel', '--hermes-shell-mode=panels']
        } })
        await win.loadFile(path.join(project, 'apps/desktop/dist/renderer/index.html'), { query: { surface: 'panel' } })
      }
      const direct = await evaluate(directCode)
      check(direct.hasToken, 'Missing positive-control session token')
      check(direct.reveal.blocked && !direct.reveal.receivedValue, 'Direct reveal allowed')
      check(direct.custom.blocked && !direct.custom.receivedValue, 'Direct custom reveal allowed')
      check(direct.config.blocked && !direct.config.receivedValue, 'Direct config allowed')
      check(direct.raw.blocked, 'Direct raw config allowed')
      check(direct.aliases.every(result => result.blocked && !result.receivedValue), 'Loopback alias reveal allowed')
      check(direct.status.ok, 'Nonsensitive transport broken')
      if (win !== desktop) win.destroy()
    }
    win = desktop
    checkpoint = 'untrusted-page-credential-ipc'
    const untrusted = new BrowserWindow({ show: false, webPreferences: {
      preload: path.join(project, 'apps/desktop/dist/electron/preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false
    } })
    await untrusted.loadURL('about:blank')
    check(await untrusted.webContents.executeJavaScript(`(async () => {
      if (!window.heraldOS) return false
      const results = await Promise.all([
        window.heraldOS.credentials.list(),
        window.heraldOS.credentials.save('ACME_API_KEY', 'invalid', 'add'),
        window.heraldOS.credentials.remove('ACME_API_KEY', true)
      ])
      return results.every(result => result.ok === false && Object.keys(result).length === 1)
    })()`), 'Untrusted page credential IPC allowed')
    untrusted.destroy()
    checkpoint = 'trusted-main-and-websocket-controls'
    const connection = await evaluate('(async () => { const s = await window.heraldOS.backend.getState(); return {baseUrl:s.baseUrl,wsUrl:s.wsUrl} })()')
    const response = await fetch(connection.baseUrl + '/api/env/reveal', { method: 'POST',
      headers: { 'X-Hermes-Session-Token': new URL(connection.wsUrl).searchParams.get('token'), 'Content-Type': 'application/json' },
      body: JSON.stringify({key:'OPENAI_API_KEY'}) })
    check(response.ok && (await response.json()).value === rotated, 'Trusted main fetch broken')
    check(await evaluate(`(async () => {
      const state = await window.heraldOS.backend.getState()
      const audio = await window.heraldOS.voice.audioWsUrl('speak-stream')
      const connect = url => new Promise(resolve => {
        const ws = new WebSocket(url)
        const timer = setTimeout(() => { ws.close(); resolve(false) }, 10000)
        ws.onopen = () => { clearTimeout(timer); ws.close(); resolve(true) }
        ws.onerror = () => { clearTimeout(timer); resolve(false) }
      })
      return (await connect(state.wsUrl)) && (await connect(audio))
    })()`), 'WebSocket/audio handshake broken')
    checkpoint = 'remove'
    fs.chmodSync(envFile, 0o644)
    check((await evaluate('window.heraldOS.credentials.remove("OPENAI_API_KEY", true)')).ok, 'Remove failed')
    check((fs.statSync(envFile).mode & 0o777) === 0o600, 'Removal mode incorrect')
    check((await evaluate('window.heraldOS.credentials.remove("ACME_API_KEY", true)')).ok, 'Custom remove failed')
    checkpoint = 'unsafe-file'
    fs.writeFileSync(outsideFile, 'UNRELATED=unchanged\n', { mode: 0o644, flag: 'wx' })
    fs.unlinkSync(envFile)
    fs.symlinkSync(outsideFile, envFile)
    check(!(await evaluate('window.heraldOS.credentials.save("OPENAI_API_KEY", "synthetic-rejected")')).ok, 'Symlink save allowed')
    check(!(await evaluate('window.heraldOS.credentials.remove("OPENAI_API_KEY", true)')).ok, 'Symlink remove allowed')
    check((fs.statSync(outsideFile).mode & 0o777) === 0o644, 'Unrelated file chmod')
    check(fs.readFileSync(outsideFile, 'utf8') === 'UNRELATED=unchanged\n', 'Unrelated file write')
    console.log('PASS: compiled credential IPC all-store 0600, config/reference denial, desktop/panel/new-partition direct HTTP denial, trusted-main fetch and WebSocket/audio controls, symlink refusal')
  } catch {
    console.error(`FAIL: compiled credential regression at ${checkpoint}`)
    process.exitCode = 1
  } finally {
    // The Python owner removes this unique home after namespace teardown.
    // Do not restore/truncate stores or follow a possibly replaced HOME here.
    app.quit()
  }
})()
