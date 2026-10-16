import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HeraldOSApi } from '../../preload/index.ts'
import type { RestRequest } from '../../shared/ipc.ts'
import type { ProviderChoice } from '../lib/model-provider.ts'
import { IPC } from '../../shared/ipc.ts'
import { BackendManager } from '../../electron/backend/manager.ts'
import { registerCredentialsIpc } from '../../electron/ipc/credentials.ts'
import { rendererIndex } from '../../electron/paths.ts'
import { loadEndpointKeys, loadKeyCatalog, readProviderChoices, saveProviderKey } from './model-provider.ts'

const seam = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), api: null as unknown as HeraldOSApi, invoke: vi.fn(), gateway: vi.fn(), refresh: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => seam.handlers.set(channel, handler) },
  ipcRenderer: { invoke: (...args: unknown[]) => seam.invoke(...args) },
  contextBridge: { exposeInMainWorld: (_: string, api: HeraldOSApi) => { seam.api = api } }, webUtils: {}
}))
vi.mock('./gateway.ts', () => ({ gatewayRequest: (...args: unknown[]) => seam.gateway(...args) }))
vi.mock('./chat.ts', () => ({ $activeChat: atom({ sessionId: 'fixture-chat' }) }))
vi.mock('./hermes-auth.ts', () => ({ $hermesAuth: atom({ checked: true, providers: [] }), refreshHermesAuth: () => seam.refresh() }))

let backend: BackendManager
let home: string
let configured: boolean
let rawConfig: Record<string, unknown>
let catalog: Record<string, unknown>
let envResponse: unknown
let onEnvGet: (() => void) | undefined
let failPut: boolean
let onPut: (() => void) | undefined
let stored: Set<string>
let submissions: Array<{ key: string; value: unknown }>
let targetSlug: string
let modelSetResult: Record<string, unknown> | undefined
let trace: string[]
const choice: ProviderChoice = { slug: 'openai-api', name: 'OpenAI', current: false, ready: false, setup: 'key', keyEnv: 'OPENAI_API_KEY', helpUrl: null, command: null, models: [] }
const frame = { url: pathToFileURL(rendererIndex()).href }
let caller: unknown

beforeEach(async () => {
  vi.clearAllMocks()
  seam.handlers.clear()
  trace = []
  configured = false
  rawConfig = {}
  envResponse = undefined
  onEnvGet = undefined
  failPut = false
  onPut = undefined
  stored = new Set()
  submissions = []
  targetSlug = choice.slug
  modelSetResult = undefined
  catalog = { OPENROUTER_API_KEY: { is_set: false, provider: 'openrouter', is_password: true, url: 'https://openrouter.ai/keys', redacted_value: 'synthetic-private-preview' } }
  caller = { senderFrame: frame, sender: { mainFrame: frame } }
  const base = path.join(process.cwd(), 'node_modules/.cache/provider-composition')
  fs.mkdirSync(base, { recursive: true })
  home = fs.mkdtempSync(path.join(base, 'fixture-'))
  fs.writeFileSync(path.join(home, '.env'), 'UNRELATED=synthetic\n', { mode: 0o644 })
  vi.stubEnv('HERMES_HOME', home)
  backend = new BackendManager()
  Object.assign(backend, { state: { phase: 'ready', runtime: { kind: 'managed' }, baseUrl: 'http://127.0.0.1:1' }, child: { pid: process.pid, exitCode: null, killed: false }, ownedCredentialHome: home, startGeneration: 1 })
  vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
    trace.push(`${init.method} ${url.pathname}`)
    if (url.pathname === '/api/env' && init.method === 'GET') {
      onEnvGet?.()
      return Response.json(envResponse === undefined ? { ...catalog, ...Object.fromEntries([...stored].map(name => [name, { is_set: true, custom: true, is_password: true }])), OPENAI_API_KEY: { is_set: configured, provider: 'openai-api', is_password: true, redacted_value: 'synthetic-private-preview' } } : envResponse)
    }
    if (url.pathname === '/api/env' && init.method === 'PUT') {
      if (failPut) return new Response('synthetic-private-storage-error', { status: 500 })
      const body = JSON.parse(String(init.body)) as { key: string; value: unknown }
      submissions.push(body)
      stored.add(body.key)
      configured = true
      onPut?.()
      return Response.json({ value: 'synthetic-private-response' })
    }
    if (url.pathname === '/api/config') return Response.json(url.searchParams.get('include_defaults') === 'false' ? rawConfig : { providers: { expanded: { api_key: 'synthetic-expanded-private-key' } } })
    if (url.pathname === '/api/model/recommended-default') return Response.json({ model: 'recommended-fixture' })
    if (url.pathname === '/api/model/set') {
      const body = JSON.parse(String(init.body)) as { provider: string; model: string }
      return Response.json(modelSetResult ?? { provider: body.provider, model: body.model })
    }
    throw new Error('Unexpected synthetic protocol request')
  }))
  registerCredentialsIpc(backend)
  seam.handlers.set(IPC.backendRest, (_event, request: RestRequest) => backend.restForRenderer(request))
  seam.invoke.mockImplementation((channel: string, ...args: unknown[]) => seam.handlers.get(channel)!(caller, ...args))
  await import('../../preload/index.ts')
  vi.stubGlobal('window', { heraldOS: seam.api })
  seam.gateway.mockImplementation(async (method: string) => {
    trace.push(method)
    if (method === 'model.options') return { model: 'old-model', providers: [{ slug: targetSlug, name: 'Fixture Provider', authenticated: configured, is_current: false, models: ['first-fixture'] }] }
    return {}
  })
  seam.refresh.mockImplementation(async () => { trace.push('auth.refresh'); return { checked: true, providers: [] } })
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }) })

describe('provider store through actual preload, trusted IPC, service and REST facade', () => {
  it('discovers OpenRouter with empty key_env through trusted metadata, not generic env REST', async () => {
    seam.gateway.mockResolvedValue({ providers: [{ slug: 'openrouter', name: 'OpenRouter', authenticated: false, auth_type: 'api_key', key_env: '', models: [] }] })
    const choices = await readProviderChoices()
    expect(choices[0]).toMatchObject({ slug: 'openrouter', setup: 'key', keyEnv: 'OPENROUTER_API_KEY', ready: false, helpUrl: 'https://openrouter.ai/keys' })
    const metadata = await loadKeyCatalog()
    expect(JSON.stringify(metadata).includes('synthetic-private')).toBe(false)
    expect(trace.every(item => !item.includes('expanded'))).toBe(true)
  })
  it('discovers custom bindings from raw provenance with current endpoint precedence and no literal keys', async () => {
    rawConfig = { providers: {
      'Lab GPU': { key_env: 'LAB_API_KEY', api_key_env: 'SHADOW_API_KEY', api_key: '${OTHER_API_KEY}' },
      secondary: { key_env: '', api_key_env: 'VLLM_KEY' },
      reference: { api_key: '${GATEWAY_KEY}' },
      literal: { api_key: 'synthetic-literal-private-key' },
      malformed: { api_key: '${BAD_KEY} trailing' },
      unsafe: { key_env: 'synthetic-literal-private-key' }
    }, custom_providers: [{ name: 'Lab GPU — llama3', key_env: 'LEGACY_API_KEY' }, { provider_key: 'Old GPU', key_env: 'OLD_API_KEY' }] }
    catalog.LAB_API_KEY = { is_set: false, is_password: true, custom: true }
    seam.gateway.mockResolvedValue({ providers: [{ slug: 'custom:lab-gpu', name: 'Lab GPU', is_user_defined: true, authenticated: true, models: ['fixture'] }] })
    expect(await loadEndpointKeys()).toEqual({ 'lab-gpu': 'LAB_API_KEY', secondary: 'VLLM_KEY', reference: 'GATEWAY_KEY', 'old-gpu': 'OLD_API_KEY' })
    expect((await readProviderChoices())[0]).toMatchObject({ ready: false, setup: 'key', keyEnv: 'LAB_API_KEY' })
    expect(trace.filter(item => item.endsWith('/api/config'))).not.toHaveLength(0)
  })

  it('refuses a provider save when configured-state discovery is malformed', async () => {
    envResponse = { OPENAI_API_KEY: { is_set: 'not-a-boolean', redacted_value: 'synthetic-private-preview' } }
    await expect(saveProviderKey(choice, 'synthetic-fixture-key')).rejects.toThrow('Could not save the API key.')
    expect(trace).not.toContain('PUT /api/env')
    expect(trace).not.toContain('reload.env')
  })

  it('treats an empty successful catalog as known absence, not an unread catalog', async () => {
    rawConfig = { providers: { lab: { key_env: 'LAB_API_KEY' } } }
    envResponse = {}
    seam.gateway.mockResolvedValue({ providers: [{ slug: 'lab', is_user_defined: true, authenticated: true, models: ['fixture'] }] })
    expect((await readProviderChoices())[0].ready).toBe(false)
  })

  it.each(['VLLM_KEY', 'GATEWAY_KEY', 'HERMES_CUSTOM_LAB_API_KEY'])('saves a bound custom endpoint credential (%s) without broadening generic save', async keyEnv => {
    targetSlug = 'lab'
    rawConfig = { providers: { lab: { key_env: keyEnv } } }
    const generic = await seam.api.credentials.save(keyEnv, 'synthetic-fixture-key', 'add')
    expect(generic.ok).toBe(false)
    trace.length = 0
    await expect(saveProviderKey({ ...choice, slug: targetSlug, keyEnv }, 'synthetic-fixture-key')).resolves.toMatchObject({ ok: true })
    expect(configured).toBe(true)
    expect(submissions.length === 1 && submissions[0].key === keyEnv && submissions[0].value === 'synthetic-fixture-key').toBe(true)
    expect(trace.indexOf('PUT /api/env')).toBeGreaterThan(trace.indexOf('GET /api/config'))
    expect(trace.indexOf('reload.env')).toBeGreaterThan(trace.indexOf('PUT /api/env'))
  })

  it('replaces a configured preset while explicit add/update still enforce existence', async () => {
    configured = true
    expect(await seam.api.credentials.save('OPENAI_API_KEY', 'synthetic-fixture-key', 'add')).toEqual({ ok: false, code: 'duplicate' })
    expect(trace).not.toContain('PUT /api/env')
    expect(await seam.api.credentials.save('MISSING_API_KEY', 'synthetic-fixture-key', 'update')).toEqual({ ok: false, code: 'not-found' })
    trace.length = 0
    await expect(saveProviderKey(choice, 'synthetic-replacement-key')).resolves.toMatchObject({ ok: true })
    expect(trace.slice(0, 3)).toEqual(['GET /api/env', 'PUT /api/env', 'reload.env'])
  })

  it('shares one serialized lifecycle for concurrent add, provider replacement, and duplicate add', async () => {
    const results = await Promise.all([
      seam.api.credentials.save('ACME_API_KEY', 'synthetic-first-key', 'add'),
      seam.api.credentials.saveProvider('ACME_API_KEY', 'synthetic-replacement-key'),
      seam.api.credentials.save('ACME_API_KEY', 'synthetic-last-key', 'add')
    ])
    expect(results).toEqual([{ ok: true, data: null }, { ok: true, data: null }, { ok: false, code: 'duplicate' }])
    expect(trace).toEqual(['GET /api/env', 'PUT /api/env', 'GET /api/env', 'PUT /api/env', 'GET /api/env'])
    expect((await seam.api.credentials.providerCatalog()).ok).toBe(true)
    expect(submissions.length === 2 && submissions.at(-1)?.value === 'synthetic-replacement-key').toBe(true)
  })

  it.each(['attached', 'not-ready', 'home-mismatch', 'unsafe-file', 'untrusted', 'subframe'])('rejects %s provider writes before backend transport and never reloads/switches', async kind => {
    if (kind === 'attached') Object.assign(backend, { state: { phase: 'ready', runtime: { kind: 'attached' } } })
    if (kind === 'not-ready') Object.assign(backend, { state: { phase: 'restarting' } })
    if (kind === 'home-mismatch') Object.assign(backend, { ownedCredentialHome: home + '-other' })
    if (kind === 'unsafe-file') { fs.unlinkSync(path.join(home, '.env')); fs.symlinkSync('missing', path.join(home, '.env')) }
    if (kind === 'untrusted') caller = { senderFrame: { url: 'https://not-shell.test' }, sender: { mainFrame: frame } }
    if (kind === 'subframe') caller = { senderFrame: frame, sender: { mainFrame: {} } }
    await expect(saveProviderKey(choice, 'synthetic-fixture-key')).rejects.toThrow('Could not save the API key.')
    expect(trace).toEqual([])
  })

  it('rechecks backend generation after awaited discovery before writing', async () => {
    onEnvGet = () => Object.assign(backend, { startGeneration: 2 })
    await expect(saveProviderKey(choice, 'synthetic-fixture-key')).rejects.toThrow('Could not save the API key.')
    expect(trace).toEqual(['GET /api/env'])
    expect(configured).toBe(false)
  })

  it('does not claim success or switch when the post-write ownership check fails', async () => {
    onPut = () => Object.assign(backend, { startGeneration: 2 })
    await expect(saveProviderKey(choice, 'synthetic-fixture-key')).rejects.toThrow('Could not save the API key.')
    expect(configured).toBe(true)
    expect(trace).toEqual(['GET /api/env', 'PUT /api/env'])
  })

  it('suppresses storage response errors and leaves reload/switch untouched', async () => {
    failPut = true
    const error = await saveProviderKey(choice, 'synthetic-fixture-key').catch(error => error)
    expect(error instanceof Error && error.message === 'Could not save the API key.').toBe(true)
    expect(trace).toEqual(['GET /api/env', 'PUT /api/env'])
    expect(configured).toBe(false)
  })

  it.each(['VLLM_KEY', 'HERMES_CUSTOM_LAB_API_KEY', 'NODE_OPTIONS_API_KEY', 'HERMES_HOME', 'PATH', 'APP_COMMAND_KEY', 'OPENAI_API_KEY\nPATH'])('cannot use provider upsert as an arbitrary environment editor (%s)', async keyEnv => {
    // Even a binding cannot grant control/runtime namespaces. Safe legacy names require a binding.
    rawConfig = { providers: { lab: { key_env: ['VLLM_KEY', 'HERMES_CUSTOM_LAB_API_KEY'].includes(keyEnv) ? 'OTHER_API_KEY' : keyEnv } } }
    await expect(saveProviderKey({ ...choice, keyEnv }, 'synthetic-fixture-key')).rejects.toThrow('Could not save the API key.')
    expect(trace).not.toContain('PUT /api/env')
    expect(trace).not.toContain('reload.env')
  })

  it.each(['', ' ', 'first\nsecond', 'nul\0byte', 'nonascii-é', 'x'.repeat(4097)])('validates key values without backend transport', async value => {
    const error = await saveProviderKey(choice, value).catch(error => error)
    expect(error instanceof Error).toBe(true)
    expect(trace).toEqual([])
  })

  it('keeps the existing best-effort reload behavior before switching', async () => {
    const gateway = seam.gateway.getMockImplementation()!
    seam.gateway.mockImplementation((method: string, params: unknown) => {
      if (method === 'reload.env') { trace.push(method); return Promise.reject(new Error('synthetic-reload-failure')) }
      return gateway(method, params)
    })
    await expect(saveProviderKey(choice, 'synthetic-fixture-key')).resolves.toMatchObject({ ok: true })
    expect(trace.indexOf('reload.env')).toBeLessThan(trace.indexOf('model.options'))
  })

  it('reports saved-but-not-switched only after a successful write and reload attempt', async () => {
    seam.gateway.mockImplementation(async method => { trace.push(method); if (method === 'model.options') throw new Error('Inventory unavailable.'); return {} })
    const error = await saveProviderKey(choice, 'synthetic-fixture-key').catch(error => error)
    expect(error instanceof Error && error.message.startsWith('The key is saved, but Hermes did not switch to OpenAI:')).toBe(true)
    expect(trace).toEqual(['GET /api/env', 'PUT /api/env', 'reload.env', 'model.options'])
  })

  it('retains price confirmation without moving the open chat or refreshing auth early', async () => {
    modelSetResult = { confirm_required: true, confirm_message: 'Confirm fixture price.' }
    await expect(saveProviderKey(choice, 'synthetic-fixture-key')).resolves.toEqual({ ok: false, provider: 'openai-api', model: 'recommended-fixture', confirm: 'Confirm fixture price.' })
    expect(trace).not.toContain('config.set')
    expect(trace).not.toContain('auth.refresh')
  })

  it('keeps the saved model for the current provider instead of asking for a recommendation', async () => {
    seam.gateway.mockImplementation(async method => {
      trace.push(method)
      return method === 'model.options' ? { model: 'saved-fixture', providers: [{ slug: 'openai-api', authenticated: true, is_current: true, models: ['first-fixture'] }] } : {}
    })
    await expect(saveProviderKey(choice, 'synthetic-fixture-key')).resolves.toMatchObject({ model: 'saved-fixture' })
    expect(trace).not.toContain('GET /api/model/recommended-default')
  })

  it('keeps generic env/raw-config renderer capabilities closed after enabling provider setup', async () => {
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      await expect(seam.api.backend.rest({ method, path: '/api/env' })).rejects.toThrow('REST request not allowed')
    }
    await expect(seam.api.backend.rest({ method: 'GET', path: '/api/config/raw' })).rejects.toThrow('REST request not allowed')
    expect(trace).toEqual([])
    rawConfig = { providers: { private: { api_key: 'synthetic-literal-private-key', key_env: 'LAB_API_KEY' } } }
    const projection = await seam.api.backend.rest<Record<string, unknown>>({ method: 'GET', path: '/api/config', query: { include_defaults: false } })
    expect('providers' in projection).toBe(false)
    expect(JSON.stringify(projection).includes('synthetic-literal-private')).toBe(false)
  })

  it.each(['catalog', 'endpoints'] as const)('fails metadata discovery generically for an untrusted %s caller', async kind => {
    caller = { senderFrame: frame, sender: { mainFrame: {} } }
    await expect(kind === 'catalog' ? loadKeyCatalog() : loadEndpointKeys()).rejects.toThrow('Could not read provider')
    expect(trace).toEqual([])
  })

  it.each([null, [], { OPENAI_API_KEY: null }, { OPENAI_API_KEY: { is_set: 'bad' } }])('does not turn malformed catalog responses into an unconfigured success', async malformed => {
    envResponse = malformed
    await expect(loadKeyCatalog()).rejects.toThrow('Could not read provider key metadata.')
  })

  it.each([{ providers: 'bad' }, { custom_providers: {} }])('does not turn malformed config responses into a binding-less success', async malformed => {
    rawConfig = malformed
    await expect(loadEndpointKeys()).rejects.toThrow('Could not read provider endpoint metadata.')
  })

  it.each(['catalog', 'endpoints'] as const)('suppresses upstream metadata failure bodies at the actual protocol seam (%s)', async kind => {
    const text = vi.fn().mockResolvedValue('synthetic-private-metadata-failure')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text }))
    const result = await (kind === 'catalog' ? loadKeyCatalog() : loadEndpointKeys()).catch(error => error)
    expect(result instanceof Error && result.message.startsWith('Could not read provider')).toBe(true)
    expect(text).not.toHaveBeenCalled()
  })

  it('retains current-main fallback and first-binding precedence across duplicate legacy endpoints', async () => {
    rawConfig = {
      providers: { modern: { key_env: 'FIRST_API_KEY' }, fallback: { api_key: 'synthetic-literal-private-key' }, invalid: { key_env: '${NOT_A_VARIABLE}', api_key_env: 'IGNORED_API_KEY' } },
      custom_providers: [{ name: 'modern - model', key_env: 'SECOND_API_KEY' }, { name: 'fallback — model', key_env: 'FALLBACK_API_KEY' }, { provider_key: 'fallback', key_env: 'THIRD_API_KEY' }, { provider_key: 'invalid', key_env: 'LEGACY_API_KEY' }]
    }
    expect(await loadEndpointKeys()).toEqual({ modern: 'FIRST_API_KEY', fallback: 'FALLBACK_API_KEY', invalid: 'LEGACY_API_KEY' })
    const invocation = await seam.handlers.get(IPC.credentialsProviderEndpoints)!(caller, '/caller/supplied/private/path')
    expect(invocation.ok).toBe(true)
    expect(trace).toEqual(['GET /api/config', 'GET /api/config'])
  })

  it('does not admit control-terminated catalog names or provider identifiers', async () => {
    catalog = { 'LEAK_API_KEY\n': { is_set: true, is_password: true }, LAB_API_KEY: { is_set: true, provider: 'openrouter\n', is_password: true } }
    const metadata = await loadKeyCatalog()
    expect(Object.keys(metadata).some(name => /[\r\n]/.test(name))).toBe(false)
    expect(metadata.LAB_API_KEY.provider === undefined).toBe(true)
  })

  it('returns only safe catalog metadata and strict configured booleans', async () => {
    catalog = {
      OPENROUTER_API_KEY: { is_set: true, is_password: true, provider: 'openrouter', url: 'https://openrouter.ai/keys', value: 'synthetic-private-value', redacted_value: 'synthetic-private-preview', unknown: 'synthetic-private-extra' },
      LAB_API_KEY: { is_set: false, is_password: true, url: 'https://user:synthetic-private-password@example.test/help?token=synthetic-private-query' },
      BAD_API_KEY: { is_set: true, is_password: true, provider: 'synthetic bad slug', url: 'javascript:synthetic-private-script' }
    }
    const metadata = await loadKeyCatalog()
    expect(metadata.OPENROUTER_API_KEY).toEqual({ is_set: true, is_password: true, provider: 'openrouter', url: 'https://openrouter.ai/keys' })
    expect(metadata.LAB_API_KEY.url).toBe(null)
    expect(metadata.BAD_API_KEY.provider).toBeUndefined()
    expect(metadata.BAD_API_KEY.url).toBe(null)
    expect(JSON.stringify(metadata).includes('synthetic-private')).toBe(false)
  })

  it('discovers a configured OpenRouter and a configured custom binding without overriding runtime authentication', async () => {
    catalog.OPENROUTER_API_KEY = { is_set: true, is_password: true, provider: 'openrouter' }
    catalog.LAB_API_KEY = { is_set: true, is_password: true }
    rawConfig = { providers: { lab: { api_key: '${LAB_API_KEY}' } } }
    seam.gateway.mockResolvedValue({ providers: [
      { slug: 'openrouter', name: 'OpenRouter', authenticated: true, key_env: '', models: ['fixture'] },
      { slug: 'lab', name: 'Lab GPU', is_user_defined: true, authenticated: true, models: ['fixture'] }
    ] })
    const choices = await readProviderChoices()
    expect(choices.every(item => item.setup === 'key' && item.ready)).toBe(true)
    seam.gateway.mockResolvedValue({ providers: [{ slug: 'lab', is_user_defined: true, authenticated: false, models: [] }] })
    expect((await readProviderChoices())[0].ready).toBe(false)
  })

  it('saves an absent preset before reload, recommendation, default and open-chat switching', async () => {
    await expect(saveProviderKey(choice, ' synthetic-fixture-key ')).resolves.toEqual({ ok: true, provider: 'openai-api', model: 'recommended-fixture' })
    expect(configured).toBe(true)
    expect(submissions.length === 1 && submissions[0].key === 'OPENAI_API_KEY' && submissions[0].value === 'synthetic-fixture-key').toBe(true)
    expect(trace).toEqual(['GET /api/env', 'PUT /api/env', 'reload.env', 'model.options', 'GET /api/model/recommended-default', 'POST /api/model/set', 'config.set', 'auth.refresh'])
    expect(fs.statSync(path.join(home, '.env')).mode & 0o777).toBe(0o600)
  })
})
