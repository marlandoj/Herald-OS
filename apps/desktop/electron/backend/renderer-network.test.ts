import { beforeEach, describe, expect, it, vi } from 'vitest'
import { blockedBackendRequest, registerRendererNetworkGuard } from './renderer-network.ts'

const { defaultSession, events } = vi.hoisted(() => ({
  defaultSession: { webRequest: { onBeforeRequest: vi.fn() } },
  events: new Map<string, (...args: unknown[]) => void>()
}))
vi.mock('electron', () => ({
  app: { on: (event: string, handler: (...args: unknown[]) => void) => events.set(event, handler) },
  session: { defaultSession }
}))
const origin = 'http://127.0.0.1:12345'
beforeEach(() => { defaultSession.webRequest.onBeforeRequest.mockClear(); events.clear() })

describe('active backend renderer network restriction', () => {
  it.each(['/api/env', '/api/env/reveal', '/api/env/validate?key=fixture', '/api/config', '/api/config/raw',
    '/api/config?include_defaults=true', '/api/%65nv/reveal', '/api/env%2Freveal', '/api/config/../env/reveal',
    '/api/%63onfig/raw', '/api/ENV/reveal', '/api/config%5craw'])('blocks %s', route => {
    expect(blockedBackendRequest(origin + route, origin)).toBe(true)
  })

  it.each(['/api/status', '/api/audio/transcribe', '/api/chat', '/api/env-other', '/api/configuration'])('preserves nonsensitive %s', route => {
    expect(blockedBackendRequest(origin + route, origin)).toBe(false)
  })

  it('keeps WebSocket/audio and other origins outside this narrow HTTP restriction', () => {
    expect(blockedBackendRequest('ws://127.0.0.1:12345/ws?token=fixture', origin)).toBe(false)
    expect(blockedBackendRequest('ws://127.0.0.1:12345/api/audio/speak-stream', origin)).toBe(false)
    expect(blockedBackendRequest('http://127.0.0.1:54321/api/config', origin)).toBe(false)
    expect(blockedBackendRequest(origin + '/api/env', undefined)).toBe(false)
  })

  it.each(['localhost', 'localhost.', '127.1', '[::1]'])('blocks known same-port loopback alias %s', host => {
    expect(blockedBackendRequest(`http://${host}:12345/api/env/reveal`, origin)).toBe(true)
    expect(blockedBackendRequest(`http://${host}:54321/api/env/reveal`, origin)).toBe(false)
  })

  it('covers shared desktop/panels default session and new partitions without duplicate listeners', () => {
    let baseUrl: string | undefined = origin
    registerRendererNetworkGuard({ getState: () => ({ phase: 'ready', attempt: 0, baseUrl, logTail: [] }) })
    expect(defaultSession.webRequest.onBeforeRequest).toHaveBeenCalledOnce()
    const callback = defaultSession.webRequest.onBeforeRequest.mock.calls[0]![1]
    const response = vi.fn()
    // No webContentsId: workers/subframes must not evade the session rule.
    callback({ url: origin + '/api/env/reveal' }, response)
    expect(response).toHaveBeenLastCalledWith({ cancel: true })
    baseUrl = 'http://127.0.0.1:54321'
    callback({ url: origin + '/api/env/reveal' }, response)
    expect(response).toHaveBeenLastCalledWith({ cancel: false })
    callback({ url: baseUrl + '/api/config' }, response)
    expect(response).toHaveBeenLastCalledWith({ cancel: true })
    const guest = { webRequest: { onBeforeRequest: vi.fn() } }
    events.get('session-created')!(guest)
    events.get('session-created')!(guest)
    expect(guest.webRequest.onBeforeRequest).toHaveBeenCalledOnce()
    guest.webRequest.onBeforeRequest.mock.calls[0]![1]({ url: baseUrl + '/api/env' }, response)
    expect(response).toHaveBeenLastCalledWith({ cancel: true })
  })
})
