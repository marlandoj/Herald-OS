import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackendManager } from './manager.ts'
import { registerCredentialsIpc } from '../ipc/credentials.ts'
import { rendererIndex } from '../paths.ts'
import { IPC } from '../../shared/ipc.ts'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, handler) } }))
const python = process.env.TEST_HERMES_PYTHON
const source = process.env.TEST_HERMES_SOURCE
const project = path.resolve(process.cwd(), '../..')
let home: string
let file: string
let backend: BackendManager
let requests: number
const shellEvent = () => {
  const frame = { url: pathToFileURL(rendererIndex()).href }
  return { senderFrame: frame, sender: { mainFrame: frame } }
}
const invoke = (name: string, ...args: unknown[]) => handlers.get(name)!(shellEvent(), ...args)
const mode = (target = file) => fs.statSync(target).mode & 0o777

describe.skipIf(!python || !source)('real Hermes lifecycle via trusted IPC/backend facade', () => {
  it('persists custom names through fresh public API processes with duplicate/update/remove semantics', async () => {
    const value = (await import('node:crypto')).randomBytes(24).toString('hex')
    fs.writeFileSync(file, '# retained\nUNRELATED=left=right\n', { mode: 0o644 })
    expect(await invoke(IPC.credentialsSave, 'ACME_API_KEY', value, 'add')).toEqual({ ok: true, data: null })
    expect(mode()).toBe(0o600)
    const listing = await invoke(IPC.credentialsList) as { ok: boolean; data: { name: string; isConfigured: boolean }[] }
    expect(listing.data.find(row => row.name === 'ACME_API_KEY')).toEqual({ name: 'ACME_API_KEY', isConfigured: true })
    expect(JSON.stringify(listing).includes(value)).toBe(false)
    const before = fs.readFileSync(file, 'utf8')
    expect(await invoke(IPC.credentialsSave, 'ACME_API_KEY', value, 'add')).toEqual({ ok: false, code: 'duplicate' })
    expect(fs.readFileSync(file, 'utf8') === before).toBe(true)
    expect(await invoke(IPC.credentialsSave, 'ACME_API_KEY', value, 'update')).toEqual({ ok: true, data: null })
    expect(await invoke(IPC.credentialsRemove, 'ACME_API_KEY', false)).toEqual({ ok: false })
    expect(fs.readFileSync(file, 'utf8').includes(value)).toBe(true)
    expect(await invoke(IPC.credentialsRemove, 'ACME_API_KEY', true)).toEqual({ ok: true, data: null })
    expect(fs.readFileSync(file, 'utf8') === '# retained\nUNRELATED=left=right\n').toBe(true)
    expect(mode()).toBe(0o600)
  }, 90000)
  beforeEach(() => {
    const base = path.join(project, 'node_modules/.cache/credential-ipc-integration')
    fs.mkdirSync(base, { recursive: true })
    home = fs.mkdtempSync(path.join(base, 'fixture-'))
    file = path.join(home, '.env')
    vi.stubEnv('HERMES_HOME', home)
    requests = 0
    handlers.clear()
    backend = new BackendManager()
    Object.assign(backend, { state: { phase: 'ready', runtime: { kind: 'managed' }, baseUrl: 'http://127.0.0.1:1' },
      child: { pid: process.pid, exitCode: null, killed: false }, ownedCredentialHome: home, startGeneration: 1 })
    vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
      requests++
      const query = Object.fromEntries(url.searchParams.entries())
      const result = spawnSync(python!, [path.join(project, 'scripts/credential-api-fixture.py')], {
        input: JSON.stringify({ method: init.method, path: url.pathname,
          ...(init.body ? { body: JSON.parse(String(init.body)) } : {}), query }),
        env: { HOME: home, HERMES_HOME: home, TEST_HERMES_SOURCE: source!, PATH: '/usr/bin:/bin' },
        encoding: 'utf8', timeout: 30000
      })
      if (result.status !== 0) throw new Error('Isolated fixture transport failed')
      const response = JSON.parse(result.stdout) as { status: number; body: unknown }
      return new Response(JSON.stringify(response.body), { status: response.status })
    }))
    registerCredentialsIpc(backend)
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); fs.rmSync(home, { recursive: true, force: true }) })

  it('repairs 0644 before real save/remove and preserves atomic replacement/unrelated content', async () => {
    fs.writeFileSync(file, '# retained\nUNRELATED=left=right\n', { mode: 0o644 })
    const first = fs.statSync(file).ino
    expect(await invoke(IPC.credentialsSave, 'VOICE_TOOLS_OPENAI_KEY', 'synthetic-first', 'add')).toEqual({ ok: true, data: null })
    expect(mode()).toBe(0o600)
    expect(fs.statSync(file).ino !== first).toBe(true)
    fs.chmodSync(file, 0o644)
    const second = fs.statSync(file).ino
    expect(await invoke(IPC.credentialsRemove, 'VOICE_TOOLS_OPENAI_KEY', true)).toEqual({ ok: true, data: null })
    expect(mode()).toBe(0o600)
    expect(fs.statSync(file).ino !== second).toBe(true)
    expect(fs.readFileSync(file, 'utf8') === '# retained\nUNRELATED=left=right\n').toBe(true)
  }, 60000)

  it('creates a new file only through Hermes atomic lifecycle', async () => {
    expect(await invoke(IPC.credentialsSave, 'VOICE_TOOLS_OPENAI_KEY', 'synthetic-new', 'add')).toEqual({ ok: true, data: null })
    expect(mode()).toBe(0o600)
  }, 60000)

  it('protects real config mirrors and auth pools before public rotation/removal', async () => {
    const config = path.join(home, 'config.yaml')
    const auth = path.join(home, 'auth.json')
    fs.writeFileSync(file, 'OPENAI_API_KEY=synthetic-old\n', { mode: 0o644 })
    fs.writeFileSync(config, 'auxiliary:\n  vision:\n    api_key: synthetic-old\n', { mode: 0o644 })
    fs.writeFileSync(auth, JSON.stringify({ credential_pool: { openai: [
      { id: 'fixture', source: 'env:OPENAI_API_KEY', access_token: 'synthetic-old' },
      { id: 'unrelated', source: 'manual', access_token: 'synthetic-unrelated' }
    ] } }), { mode: 0o644 })
    expect(await invoke(IPC.credentialsSave, 'OPENAI_API_KEY', 'synthetic-new')).toEqual({ ok: true, data: null })
    expect(mode(config)).toBe(0o600)
    expect(mode(auth)).toBe(0o600)
    expect(fs.readFileSync(config, 'utf8').includes('synthetic-new')).toBe(true)
    // The upstream pool load is additive on save; test storage protection, not a new pool policy.
    expect(fs.readFileSync(auth, 'utf8').includes('synthetic-unrelated')).toBe(true)
    for (const target of [file, config, auth]) fs.chmodSync(target, 0o644)
    expect(await invoke(IPC.credentialsRemove, 'OPENAI_API_KEY', true)).toEqual({ ok: true, data: null })
    expect([mode(file), mode(config), mode(auth)]).toEqual([0o600, 0o600, 0o600])
    const pool = JSON.parse(fs.readFileSync(auth, 'utf8')).credential_pool?.openai ?? []
    expect(pool.some((row: { source: string }) => row.source === 'env:OPENAI_API_KEY')).toBe(false)
    expect(fs.readFileSync(auth, 'utf8').includes('synthetic-unrelated')).toBe(true)
  }, 90000)

  it.each(['config.yaml', 'auth.json'].flatMap(name =>
    ['symlink', 'hardlink', 'directory'].map(kind => ({ name, kind }))))('refuses real lifecycle $name $kind before any public request', async ({ name, kind }) => {
    const target = path.join(home, 'outside-target')
    const guarded = path.join(home, name)
    fs.writeFileSync(target, 'unchanged\n', { mode: 0o644 })
    if (kind === 'symlink') fs.symlinkSync(target, guarded)
    if (kind === 'hardlink') fs.linkSync(target, guarded)
    if (kind === 'directory') fs.mkdirSync(guarded)
    expect(await invoke(IPC.credentialsSave, 'OPENAI_API_KEY', 'synthetic')).toEqual({ ok: false })
    expect(await invoke(IPC.credentialsRemove, 'OPENAI_API_KEY', true)).toEqual({ ok: false })
    expect(requests).toBe(0)
    expect(mode(target)).toBe(0o644)
    expect(fs.readFileSync(target, 'utf8') === 'unchanged\n').toBe(true)
  })

  it.each(['stt.local.model', 'stt.local.initial_prompt', 'model.default'])('rejects %s environment-reference write through real API facade', async field => {
    fs.writeFileSync(file, 'OPENAI_API_KEY=synthetic-canary\n', { mode: 0o600 })
    const patch = (value: string) => field.split('.').reverse().reduce<Record<string, unknown>>((body, key, index) =>
      ({ [key]: index === 0 ? value : body }), {})
    // Positive upstream control proves the actual API expands this reference.
    await backend.rest({ method: 'PUT', path: '/api/config', body: { config: patch('${OPENAI_API_KEY}') } })
    const raw = await backend.rest({ method: 'GET', path: '/api/config' })
    expect(JSON.stringify(raw).includes('synthetic-canary')).toBe(true)
    // Read before resetting: existing CLI/other-client references are the disclosure case.
    const immediatelySafe = await backend.restForRenderer({ method: 'GET', path: '/api/config' })
    expect(JSON.stringify(immediatelySafe).includes('synthetic-canary')).toBe(false)
    const unexpanded = await backend.rest({ method: 'GET', path: '/api/config', query: { include_defaults: false } })
    expect(JSON.stringify(unexpanded)).toContain('${OPENAI_API_KEY}')
    expect(JSON.stringify(unexpanded)).not.toContain('synthetic-canary')
    await backend.rest({ method: 'PUT', path: '/api/config', body: { config: patch('fixture-model') } })
    const before = requests
    for (const ref of ['${OPENAI_API_KEY}', '${env:OPENAI_API_KEY}', 'prefix-${OPENAI_API_KEY}']) {
      let denied = false
      try { await backend.restForRenderer({ method: 'PUT', path: '/api/config', body: { config: patch(ref) } }) } catch { denied = true }
      expect(denied).toBe(true)
    }
    expect(requests).toBe(before)
    const safe = await backend.restForRenderer({ method: 'GET', path: '/api/config' })
    expect(JSON.stringify(safe).includes('synthetic-canary')).toBe(false)
    expect(await backend.restForRenderer({ method: 'PUT', path: '/api/config', body: { config: patch('fixture-model') } })).toEqual({ ok: true })
  }, 90000)

  it.each(['symlink', 'dangling', 'hardlink', 'directory'])('denies %s through actual IPC without any backend request', async kind => {
    const target = path.join(home, 'unrelated')
    fs.writeFileSync(target, 'unchanged\n', { mode: 0o644 })
    if (kind === 'symlink') fs.symlinkSync(target, file)
    if (kind === 'dangling') fs.symlinkSync(path.join(home, 'missing'), file)
    if (kind === 'hardlink') fs.linkSync(target, file)
    if (kind === 'directory') fs.mkdirSync(file)
    expect(await invoke(IPC.credentialsSave, 'OPENAI_API_KEY', 'synthetic')).toEqual({ ok: false })
    expect(await invoke(IPC.credentialsRemove, 'OPENAI_API_KEY', true)).toEqual({ ok: false })
    expect(requests).toBe(0)
    expect(mode(target)).toBe(0o644)
    expect(fs.readFileSync(target, 'utf8') === 'unchanged\n').toBe(true)
  })

  it('allows only metadata for an attached backend, with no local chmod or credential writes', async () => {
    fs.writeFileSync(file, 'UNRELATED=fixture\n', { mode: 0o644 })
    Object.assign(backend, { state: { phase: 'ready', runtime: { kind: 'attached' }, baseUrl: 'http://127.0.0.1:1' } })
    expect(await invoke(IPC.credentialsSave, 'OPENAI_API_KEY', 'synthetic')).toEqual({ ok: false })
    expect(await invoke(IPC.credentialsRemove, 'OPENAI_API_KEY', true)).toEqual({ ok: false })
    expect(requests).toBe(0)
    expect(mode()).toBe(0o644)
    const metadata = await invoke(IPC.credentialsList)
    expect(Object.keys(metadata as object)).toEqual(['ok', 'data'])
  }, 60000)

  it('rotates real config mirrors but never returns them or resolved references to renderer', async () => {
    fs.writeFileSync(file, 'OPENAI_API_KEY=synthetic-old\n', { mode: 0o644 })
    fs.writeFileSync(path.join(home, 'config.yaml'), 'auxiliary:\n  vision:\n    api_key: synthetic-old\nproviders:\n  fixture:\n    api_key: ${OPENAI_API_KEY}\ncustom_providers:\n  - name: fixture\n    api_key: synthetic-old\n', { mode: 0o600 })
    expect(await invoke(IPC.credentialsSave, 'OPENAI_API_KEY', 'synthetic-rotated')).toEqual({ ok: true, data: null })
    const raw = await backend.rest<Record<string, unknown>>({ method: 'GET', path: '/api/config' })
    // Establish the leak still exists upstream: this isn't a mock response or a changed runtime.
    expect(JSON.stringify(raw).includes('synthetic-rotated')).toBe(true)
    const safe = await backend.restForRenderer({ method: 'GET', path: '/api/config' })
    expect(JSON.stringify(safe).includes('synthetic-')).toBe(false)
    expect(Object.hasOwn(safe as object, 'auxiliary')).toBe(false)
    expect(Object.hasOwn(safe as object, 'providers')).toBe(false)
    expect(Object.hasOwn(safe as object, 'custom_providers')).toBe(false)
    await expect(backend.restForRenderer({ method: 'GET', path: '/api/config/raw' })).rejects.toThrow('REST request not allowed')
    const metadata = await invoke(IPC.credentialsList)
    expect(JSON.stringify(metadata).includes('synthetic-')).toBe(false)
  }, 90000)
})
