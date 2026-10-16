import { describe, expect, it, vi } from 'vitest'
import { CredentialService } from './credentials.ts'
import { SECRET_NAMES, SECRET_VALUE_MAX_LENGTH } from '../../shared/credentials.ts'

const prepareWrite = () => () => {}

describe('credential metadata boundary', () => {
  it('enumerates saved custom credential names without returning previews or control names', async () => {
    const rest = vi.fn().mockResolvedValue({ ACME_API_KEY: { custom: true, is_set: true, redacted_value: 'PRIVATE' },
      NODE_OPTIONS_API_KEY: { custom: true, is_set: true }, UNRELATED_SETTING: { custom: true, is_set: true } })
    const result = await new CredentialService(rest).list()
    expect(result.ok && result.data.find(row => row.name === 'ACME_API_KEY')).toEqual({ name: 'ACME_API_KEY', isConfigured: true })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|NODE_OPTIONS|UNRELATED_SETTING|redacted/)
  })
  it('projects only supported names and strict configured booleans', async () => {
    const rest = vi.fn().mockResolvedValue({
      OPENAI_API_KEY: { is_set: true, redacted_value: 'NEVER_TO_RENDERER', value: 'PRIVATE' },
      ANTHROPIC_API_KEY: { is_set: 'PRIVATE' },
      UNRELATED_SECRET: { is_set: true, value: 'PRIVATE' }
    })
    const result = await new CredentialService(rest).list()
    expect(result).toEqual({ ok: true, data: [
      { name: 'VOICE_TOOLS_OPENAI_KEY', isConfigured: false },
      { name: 'OPENAI_API_KEY', isConfigured: true },
      { name: 'ANTHROPIC_API_KEY', isConfigured: false },
      { name: 'OPENROUTER_API_KEY', isConfigured: false },
      { name: 'GEMINI_API_KEY', isConfigured: false },
      { name: 'XAI_API_KEY', isConfigured: false },
      { name: 'GROQ_API_KEY', isConfigured: false }
    ] })
    expect(rest).toHaveBeenCalledExactlyOnceWith({ method: 'GET', path: '/api/env' })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|NEVER_TO_RENDERER|redacted/)
  })

  it('fails closed without forwarding exception bodies', async () => {
    const service = new CredentialService(vi.fn().mockRejectedValue(new Error('PRIVATE')))
    await expect(service.list()).resolves.toEqual({ ok: false })
    const malformed = new CredentialService(vi.fn().mockResolvedValue(null))
    await expect(malformed.list()).resolves.toEqual({ ok: false })
  })
})

describe('trusted credential writes', () => {
  it('rechecks owned backend authority after asynchronous duplicate discovery before PUT', async () => {
    let valid = true
    const rest = vi.fn(async () => { valid = false; return {} })
    const service = new CredentialService(rest, () => () => { if (!valid) throw new Error('PRIVATE') })
    await expect(service.save('ACME_API_KEY', 'fixture', 'add')).resolves.toEqual({ ok: false })
    expect(rest.mock.calls).toHaveLength(1)
  })
  it('orders removal after an in-flight update instead of restoring the removed key', async () => {
    let exists = true
    const rest = vi.fn(async (request: { method: string }) => {
      if (request.method === 'GET') return { ACME_API_KEY: { is_set: exists, custom: true } }
      exists = request.method === 'PUT'
      return {}
    })
    const service = new CredentialService(rest, prepareWrite)
    await Promise.all([service.save('ACME_API_KEY', 'fixture', 'update'), service.remove('ACME_API_KEY', true)])
    expect(exists).toBe(false)
  })
  it('serializes concurrent adds so a duplicate never silently overwrites', async () => {
    let exists = false
    const rest = vi.fn(async (request: { method: string }) => {
      if (request.method === 'GET') return exists ? { ACME_API_KEY: { is_set: true, custom: true } } : {}
      exists = true
      return {}
    })
    const service = new CredentialService(rest, prepareWrite)
    const results = await Promise.all([service.save('ACME_API_KEY', 'first', 'add'), service.save('ACME_API_KEY', 'second', 'add')])
    expect(results).toEqual([{ ok: true, data: null }, { ok: false, code: 'duplicate' }])
    expect(rest.mock.calls.filter(([request]) => request.method === 'PUT')).toHaveLength(1)
  })
  it('creates a new named credential, rejects a duplicate and updates only existing entries', async () => {
    const stored: Record<string, { custom: boolean; is_set: boolean }> = {}
    const rest = vi.fn(async (request: { method: string; body?: unknown }) => {
      if (request.method === 'GET') return { ...stored }
      const body = request.body as { key: string }
      stored[body.key] = { custom: true, is_set: true }
      return { value: 'PRIVATE' }
    })
    const service = new CredentialService(rest, prepareWrite)
    await expect(service.save('ACME_API_KEY', 'fixture', 'add')).resolves.toEqual({ ok: true, data: null })
    await expect(service.save('ACME_API_KEY', 'fixture', 'add')).resolves.toEqual({ ok: false, code: 'duplicate' })
    await expect(service.save('MISSING_API_KEY', 'fixture', 'update')).resolves.toEqual({ ok: false, code: 'not-found' })
    await expect(service.save('ACME_API_KEY', 'fixture', 'update')).resolves.toEqual({ ok: true, data: null })
    expect(rest.mock.calls.filter(([request]) => request.method === 'PUT')).toHaveLength(2)
  })
  it('saves only allowlisted names through PUT with no profile or query', async () => {
    const rest = vi.fn().mockResolvedValue({ ok: true, value: 'PRIVATE' })
    const service = new CredentialService(rest, prepareWrite)
    for (const name of SECRET_NAMES) {
      await expect(service.save(name, 'fixture-value', 'add')).resolves.toEqual({ ok: true, data: null })
      expect(rest).toHaveBeenLastCalledWith({ method: 'PUT', path: '/api/env', body: { key: name, value: 'fixture-value' } })
    }
  })

  it.each(['', '../.env', 'OPENAI_API_KEY\nPATH', 'PATH', 'openai_api_key', 'OPENAI_API_KEY=bad', null, {}])('rejects unsafe/unsupported names (%j)', async name => {
    const rest = vi.fn()
    const service = new CredentialService(rest)
    await expect(service.save(name, 'fixture-value')).resolves.toEqual({ ok: false })
    await expect(service.remove(name, true)).resolves.toEqual({ ok: false })
    expect(rest).not.toHaveBeenCalled()
  })

  it.each(['', '  ', '\t', 'first\nsecond', 'first\rsecond', 'nul\0byte', '\u001b', 'nonascii-\u00e9', 'x'.repeat(SECRET_VALUE_MAX_LENGTH + 1), null, {}])('rejects invalid values without transport', async value => {
    const rest = vi.fn()
    await expect(new CredentialService(rest).save('OPENAI_API_KEY', value)).resolves.toEqual({ ok: false })
    expect(rest).not.toHaveBeenCalled()
  })

  it('requires explicit removal confirmation and discards backend response bodies', async () => {
    const rest = vi.fn().mockResolvedValue({ ok: true, config_scrubbed: ['PRIVATE'] })
    const service = new CredentialService(rest, prepareWrite)
    for (const confirmation of [false, undefined, 'true', 1]) {
      await expect(service.remove('OPENAI_API_KEY', confirmation)).resolves.toEqual({ ok: false })
    }
    expect(rest).not.toHaveBeenCalled()
    await expect(service.remove('OPENAI_API_KEY', true)).resolves.toEqual({ ok: true, data: null })
    expect(rest).toHaveBeenCalledExactlyOnceWith({ method: 'DELETE', path: '/api/env', body: { key: 'OPENAI_API_KEY' } })
  })

  it('returns generic save/remove failure without exception messages or logging', async () => {
    const service = new CredentialService(vi.fn().mockRejectedValue(new Error('PRIVATE')), prepareWrite)
    const logger = vi.spyOn(console, 'error')
    await expect(service.save('OPENAI_API_KEY', 'fixture-value')).resolves.toEqual({ ok: false })
    await expect(service.remove('OPENAI_API_KEY', true)).resolves.toEqual({ ok: false })
    expect(logger).not.toHaveBeenCalled()
    logger.mockRestore()
  })
})
