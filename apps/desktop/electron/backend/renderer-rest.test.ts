import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackendManager } from './manager.ts'
import { sttTuningPatch, type LocalSttConfig } from '../../src/lib/voice/stt-tuning.ts'

function readyManager() {
  const backend = new BackendManager()
  Object.assign(backend, { state: { phase: 'ready', baseUrl: 'http://127.0.0.1:1', logTail: [] }, token: 'test-token' })
  return backend
}

afterEach(() => vi.unstubAllGlobals())

describe('renderer REST credential isolation', () => {
  it.each(['/api/env', '/api/env/reveal', '/api/env/validate', '/api/env/', '/api/env?profile=other', '/api/%65nv', '/api/config/../env', '/api//env', '/api/env#fragment', '/api/ENV', '/api/../api/env', '/api/env\\reveal'])('blocks bypass route %s before transport', async path => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(readyManager().restForRenderer({ method: 'GET', path })).rejects.toThrow('REST request not allowed')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    '/api/%65nv', '/api/%63onfig', '/api/%45NV/reveal', '/api/env%2Freveal', '/api/config%5Craw',
    '/api/%2565nv', '/api/%252563onfig', '/api/env%252Freveal', '/api/config%255Craw',
    '/api/mcp/servers/a%2Fb/enabled', '/api/mcp/servers/a%5Cb/enabled', '/api/mcp/servers/%252f/test',
    '/api/mcp/servers/%252e%252e/test', '/api/mcp/servers/%2520/test', '/api/mcp/servers/%252525/test',
    '/api/mcp/servers/name%2500/test', '/api/mcp/servers/name%25C2%2585/test',
    '/api/%25env', '/api/%25config', '/api/env%25/reveal', '/api/config%25/raw',
    '/api/status%25', '/api/mcp/servers/CPU%20100%25/unknown',
    '/api/mcp/servers/CPU%20100%25/test/extra', '/api/mcp/servers/CPU%20100%25/test%25',
    '/api/mcp%25/servers/CPU%20100%25/test', '/api/mcp/servers/CPU%20100%25/',
    '/api/mcp/servers/CPU%20100%/test', '/api/mcp/servers/%43PU%20100%25/test',
    '/api/mcp/servers/My%20Server%2fother/test', '/api/mcp/servers/My%20Server%3f/test',
    '/api/mcp/servers/name%E2%80%8B/test', '/api/mcp/servers/name%E2%80%AE/test',
    '/api/mcp/servers/%2E%2E/enabled', '/api/mcp/servers/../env', '/api/mcp/servers/%00/test',
    '/api/mcp/servers/%0A/test', '/api/mcp/servers/%7F/test', '/api/mcp/servers/%C2%85/test',
    '/api/mcp/servers/%/test', '/api/mcp/servers/%GG/test', '/api/mcp/servers/%FF/test',
    '/api/mcp/servers/My%20Server//enabled', '/api/mcp/servers/My Server/enabled'
  ])('rejects ambiguous encoded route %s before transport', async path => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(readyManager().restForRenderer({ method: 'GET', path })).rejects.toThrow('REST request not allowed')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([['PUT', '/enabled'], ['DELETE', ''], ['POST', '/test'], ['POST', '/auth']] as const)(
    'preserves literal-percent MCP name for %s %s', async (method, suffix) => {
      const fetch = vi.fn().mockImplementation(() => new Response('{"ok":true}'))
      vi.stubGlobal('fetch', fetch)
      const name = 'CPU 100%'
      expect(encodeURIComponent(name)).toBe('CPU%20100%25')
      const path = `/api/mcp/servers/${encodeURIComponent(name)}${suffix}`
      await expect(readyManager().restForRenderer({ method, path })).resolves.toEqual({ ok: true })
      expect((fetch.mock.calls[0]![0] as URL).pathname).toBe(path)
      expect(fetch).toHaveBeenCalledOnce()
    }
  )

  it.each(['My Server', '日本語 server', 'München', 'env', 'config', 'semi;colon', 'hash#query?', '%env'])('preserves encoded MCP name %s across existing operations', async name => {
    const fetch = vi.fn().mockImplementation(() => new Response('{"ok":true}'))
    vi.stubGlobal('fetch', fetch)
    const backend = readyManager()
    for (const [method, suffix] of [['PUT', '/enabled'], ['DELETE', ''], ['POST', '/test'], ['POST', '/auth']] as const) {
      const path = `/api/mcp/servers/${encodeURIComponent(name)}${suffix}`
      await expect(backend.restForRenderer({ method, path })).resolves.toEqual({ ok: true })
      expect((fetch.mock.calls.at(-1)![0] as URL).pathname).toBe(path)
    }
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('preserves existing nonsensitive REST transport', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"status":"ok"}'))
    vi.stubGlobal('fetch', fetch)
    await expect(readyManager().restForRenderer({ method: 'GET', path: '/api/status' })).resolves.toEqual({ status: 'ok' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('does not read or reflect error bodies for trusted credential requests', async () => {
    const text = vi.fn().mockResolvedValue('{"detail":"PRIVATE"}')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, text }))
    await expect(readyManager().rest({ method: 'PUT', path: '/api/env', body: { key: 'OPENAI_API_KEY', value: 'fixture' } })).rejects.toThrow('Credential operation failed')
    expect(text).not.toHaveBeenCalled()
  })

  it('preserves a saved reference-backed model through the real projection-to-tuner path', async () => {
    const backend = readyManager()
    const reference = '${env:LOCAL_STT_MODEL}'
    let savedModel = reference
    const fetch = vi.fn(async (url: URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const patch = JSON.parse(String(init.body)) as { config: LocalSttConfig }
        savedModel = patch.config.stt?.local?.model ?? savedModel
        return new Response('{"ok":true}')
      }
      return new Response(JSON.stringify({ stt: { provider: 'local', local: {
        model: url.searchParams.get('include_defaults') === 'false' ? savedModel : 'medium.en',
        initial_prompt: 'user vocabulary'
      } } }))
    })
    vi.stubGlobal('fetch', fetch)
    // Positive expansion control; do not reset the reference before the renderer read.
    expect(await backend.rest({ method: 'GET', path: '/api/config' })).toMatchObject({ stt: { local: { model: 'medium.en' } } })
    const projected = await backend.restForRenderer<LocalSttConfig>({ method: 'GET', path: '/api/config' })
    expect(JSON.stringify(projected)).not.toContain('medium.en')
    expect(JSON.stringify(projected)).not.toContain(reference)
    // Same read -> tune -> optional PUT sequence as voice.ts on gateway-ready startup.
    const patch = sttTuningPatch(projected)
    if (patch) await backend.restForRenderer({ method: 'PUT', path: '/api/config', body: { config: patch } })
    expect(savedModel).toBe(reference)
    expect(patch).toBeNull()
  })

  it('never projects an already expanded model reference from the defaulted config response', async () => {
    const backend = readyManager()
    // Synthetic public API protocol seam: include_defaults=false selects unexpanded saved
    // config, whereas the defaulted response expands references. No runtime is started.
    let model = '${OPENAI_API_KEY}'
    const fetch = vi.fn(async (url: URL) => new Response(JSON.stringify({
      stt: { provider: 'local', local: {
        model: url.searchParams.get('include_defaults') === 'false' ? model : model.replace('${OPENAI_API_KEY}', 'ordinary-printable-canary'),
        initial_prompt: 'saved words'
      } },
      tts: { provider: 'edge' }, delegation: { max_concurrent_children: 4 }
    })))
    vi.stubGlobal('fetch', fetch)
    // Positive expansion control, immediately followed by renderer GET before reset.
    const expanded = await backend.rest({ method: 'GET', path: '/api/config' })
    expect(JSON.stringify(expanded)).toContain('ordinary-printable-canary')
    const safe = await backend.restForRenderer({ method: 'GET', path: '/api/config' })
    expect(JSON.stringify(safe)).not.toContain('ordinary-printable-canary')
    expect(safe).toMatchObject({ stt: { provider: 'local', local: { has_initial_prompt: true } }, tts: { provider: 'edge' } })
    expect(new URL(fetch.mock.calls.at(-1)![0]).searchParams.get('include_defaults')).toBe('false')
    // Supported free-form literal identifiers remain readable, not reduced to a whitelist.
    model = 'custom-model/english'
    expect(await backend.restForRenderer({ method: 'GET', path: '/api/config' })).toMatchObject({
      stt: { local: { model: 'custom-model/english' } }
    })
  })

  it.each(['${OPENAI_API_KEY}', '${env:OPENAI_API_KEY}', 'prefix-${OPENAI_API_KEY}'])('keeps %s unexpanded at the saved-config seam', async reference => {
    const backend = readyManager()
    const fetch = vi.fn(async (url: URL) => new Response(JSON.stringify({
      stt: { provider: 'local', local: { model: url.searchParams.get('include_defaults') === 'false' ? reference : 'medium.en' } }
    })))
    vi.stubGlobal('fetch', fetch)
    // Even a value that looks exactly like a supported model isn't provenance.
    expect(await backend.rest({ method: 'GET', path: '/api/config' })).toMatchObject({ stt: { local: { model: 'medium.en' } } })
    const safe = await backend.restForRenderer({ method: 'GET', path: '/api/config', query: { include_defaults: true } })
    expect((safe as { stt: { local: object } }).stt.local).not.toHaveProperty('model')
    expect((fetch.mock.calls.at(-1)![0] as URL).searchParams.get('include_defaults')).toBe('false')
  })

  it('preserves defaulted finite settings without falling back to a resolved free-form value', async () => {
    const backend = readyManager()
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => new Response(JSON.stringify(
      url.searchParams.get('include_defaults') === 'false' ? {} : {
        stt: { provider: 'local', local: { model: 'PRIVATE', initial_prompt: '' } },
        tts: { provider: 'edge' }, delegation: { max_concurrent_children: 4 }, tools: { tool_search: { enabled: 'auto' } }
      }
    ))))
    const safe = await backend.restForRenderer({ method: 'GET', path: '/api/config' })
    expect(safe).toEqual({ stt: { provider: 'local', local: { has_initial_prompt: false, model_tuning_eligible: false } },
      tts: { provider: 'edge' }, delegation: { max_concurrent_children: 4 }, tools: { tool_search: { enabled: 'auto' } } })
    expect(JSON.stringify(safe)).not.toContain('PRIVATE')
  })

  it('fails closed with a generic error when the unexpanded config request fails', async () => {
    const text = vi.fn().mockResolvedValue('PRIVATE')
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('{"stt":{"local":{"model":"PRIVATE"}}}'))
      .mockResolvedValueOnce({ ok: false, status: 500, text }))
    await expect(readyManager().restForRenderer({ method: 'GET', path: '/api/config' })).rejects.toThrow('Configuration operation failed')
    expect(text).not.toHaveBeenCalled()
  })

  it('projects only safe settings, discarding credential mirrors and expanded environment references', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Response(JSON.stringify({
      stt: { provider: 'local', local: { model: 'small.en', initial_prompt: 'PRIVATE' }, api_key: 'PRIVATE' },
      tts: { provider: 'edge', openai: { api_key: 'PRIVATE' } },
      delegation: { max_concurrent_children: 4, token: 'PRIVATE' },
      tools: { tool_search: { enabled: 'auto', token: 'PRIVATE' } },
      auxiliary: { vision: { api_key: 'PRIVATE' } },
      providers: { custom: { api_key: 'PRIVATE', key_env: 'PRIVATE' } },
      custom_providers: [{ api_key: 'PRIVATE' }],
      unknown_extension: { credentials: 'PRIVATE' }
    }))))
    const result = await readyManager().restForRenderer({ method: 'GET', path: '/api/config' })
    expect(result).toEqual({
      stt: { provider: 'local', local: { model: 'small.en', has_initial_prompt: true, model_tuning_eligible: false } },
      tts: { provider: 'edge' }, delegation: { max_concurrent_children: 4 },
      tools: { tool_search: { enabled: 'auto' } }
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
  })

  it.each(['/api/config/raw', '/api/config/defaults', '/api/config/schema', '/api/CONFIG'])('denies raw/configuration alternate route %s', async path => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(readyManager().restForRenderer({ method: 'GET', path })).rejects.toThrow('REST request not allowed')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([true, false])('does not accept model tuning metadata %s as writable configuration', async eligible => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(readyManager().restForRenderer({ method: 'PUT', path: '/api/config', body: {
      config: { stt: { local: { model_tuning_eligible: eligible } } }
    } })).rejects.toThrow('REST request not allowed')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never sends credential fields or redacted placeholders back through generic config PUT', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(readyManager().restForRenderer({ method: 'PUT', path: '/api/config', body: { config: { auxiliary: { vision: { api_key: '••••' } } } } })).rejects.toThrow('REST request not allowed')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('discards config PUT responses and failures rather than reflecting credential values', async () => {
    const text = vi.fn().mockResolvedValue('{"detail":"PRIVATE"}')
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text })
    vi.stubGlobal('fetch', fetch)
    const request = { method: 'PUT' as const, path: '/api/config', body: { config: { tts: { provider: 'edge' } } } }
    await expect(readyManager().restForRenderer(request)).rejects.toThrow('Configuration operation failed')
    expect(text).not.toHaveBeenCalled()
    fetch.mockResolvedValue(new Response('{"ok":true,"api_key":"PRIVATE"}'))
    await expect(readyManager().restForRenderer(request)).resolves.toEqual({ ok: true })
  })
})
