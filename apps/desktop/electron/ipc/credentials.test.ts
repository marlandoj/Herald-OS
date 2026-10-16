import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pathToFileURL } from 'node:url'
import { IPC } from '../../shared/ipc.ts'
import { rendererIndex } from '../paths.ts'
import { registerCredentialsIpc } from './credentials.ts'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) } }))


beforeEach(() => { handlers.clear(); vi.clearAllMocks() })

const prepareCredentialWrite = () => () => {}

function shellEvent() {
  const frame = { url: pathToFileURL(rendererIndex()).href }
  return { senderFrame: frame, sender: { mainFrame: frame } }
}

describe('credential IPC', () => {
  it('passes explicit creation mode for safe custom names and rejects reserved names', async () => {
    const backend = { prepareCredentialWrite, rest: vi.fn().mockResolvedValue({}) }
    registerCredentialsIpc(backend)
    await expect(handlers.get(IPC.credentialsSave)!(shellEvent(), 'ACME_API_KEY', 'fixture', 'add')).resolves.toEqual({ ok: true, data: null })
    expect(backend.rest).toHaveBeenLastCalledWith({ method: 'PUT', path: '/api/env', body: { key: 'ACME_API_KEY', value: 'fixture' } })
    const before = backend.rest.mock.calls.length
    for (const name of ['NODE_OPTIONS_API_KEY', 'UNRELATED_SETTING', 'HERMES_AUTH_TOKEN']) {
      await expect(handlers.get(IPC.credentialsSave)!(shellEvent(), name, 'fixture', 'add')).resolves.toEqual({ ok: false })
      await expect(handlers.get(IPC.credentialsRemove)!(shellEvent(), name, true)).resolves.toEqual({ ok: false })
    }
    expect(backend.rest.mock.calls.length).toBe(before)
  })
  it('registers narrow list/save/remove handlers and uses trusted REST only', async () => {
    const backend = { prepareCredentialWrite, rest: vi.fn().mockResolvedValue({ OPENAI_API_KEY: { is_set: true, redacted_value: 'PRIVATE' } }) }
    registerCredentialsIpc(backend)
    expect([...handlers.keys()]).toEqual(['herald-os:credentials:provider-endpoints', 'herald-os:credentials:provider-catalog', 'herald-os:credentials:list', 'herald-os:credentials:save', 'herald-os:credentials:save-provider', 'herald-os:credentials:remove'])
    const listing = await handlers.get(IPC.credentialsList)!(shellEvent())
    expect(JSON.stringify(listing)).not.toContain('PRIVATE')
    expect(backend.rest).toHaveBeenCalledExactlyOnceWith({ method: 'GET', path: '/api/env' })
    await expect(handlers.get(IPC.credentialsSave)!(shellEvent(), 'PATH', 'fixture')).resolves.toEqual({ ok: false })
    expect(backend.rest).toHaveBeenCalledOnce()
    await handlers.get(IPC.credentialsSave)!(shellEvent(), 'OPENAI_API_KEY', 'fixture')
    expect(backend.rest).toHaveBeenLastCalledWith({ method: 'PUT', path: '/api/env', body: { key: 'OPENAI_API_KEY', value: 'fixture' } })
    await handlers.get(IPC.credentialsRemove)!(shellEvent(), 'OPENAI_API_KEY', true)
    expect(backend.rest).toHaveBeenLastCalledWith({ method: 'DELETE', path: '/api/env', body: { key: 'OPENAI_API_KEY' } })
  })

  it('rejects subframes and nonshell callers without reflecting arguments', async () => {
    const backend = { prepareCredentialWrite, rest: vi.fn() }
    registerCredentialsIpc(backend)
    for (const event of [null, { senderFrame: { url: 'https://example.test' }, sender: { mainFrame: {} } }, { ...shellEvent(), sender: { mainFrame: {} } }]) {
      for (const handler of handlers.values()) {
        await expect(handler(event, 'OPENAI_API_KEY', 'PRIVATE')).resolves.toEqual({ ok: false })
      }
    }
    expect(backend.rest).not.toHaveBeenCalled()
  })
  it('denies attached-backend writes before touching local profile metadata', async () => {
    const backend = { prepareCredentialWrite: () => { throw new Error('Credential storage unavailable') }, rest: vi.fn() }
    registerCredentialsIpc(backend)
    await expect(handlers.get(IPC.credentialsSave)!(shellEvent(), 'OPENAI_API_KEY', 'fixture')).resolves.toEqual({ ok: false })
    await expect(handlers.get(IPC.credentialsRemove)!(shellEvent(), 'OPENAI_API_KEY', true)).resolves.toEqual({ ok: false })
    expect(backend.rest).not.toHaveBeenCalled()
  })
})
