import { beforeEach, describe, expect, it, vi } from 'vitest'
import { $hermesAuth, refreshHermesAuth } from './hermes-auth.ts'

vi.mock('./gateway.ts', () => ({ $gatewayReady: { subscribe: vi.fn() }, onGatewayEvent: vi.fn() }))
vi.mock('./notifications.ts', () => ({ notify: vi.fn() }))
vi.mock('./shell.ts', () => ({ isMainSurface: true }))
const { get } = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../lib/rest.ts', () => ({ rest: { get } }))

beforeEach(() => {
  vi.clearAllMocks()
  $hermesAuth.set({ checked: false, activeProvider: null, providers: [], needsLogin: false, reason: null, snoozed: false, chosen: null })
})

describe('provider sign-in metadata', () => {
  it('preserves active-provider selection without ever requesting raw config YAML', async () => {
    get.mockImplementation(async (route: string) => {
      if (route === '/api/providers/oauth') return { providers: [{ id: 'nous', name: 'Nous', flow: 'device_code', status: { logged_in: false } }] }
      if (route === '/api/model/auxiliary') return { main: { provider: 'nous', model: 'fixture' } }
      throw new Error('Raw configuration must not be requested')
    })
    const state = await refreshHermesAuth()
    expect(state.activeProvider).toBe('nous')
    expect(state.needsLogin).toBe(true)
    expect(get.mock.calls.map(call => call[0]).sort()).toEqual(['/api/model/auxiliary', '/api/providers/oauth'])
  })

  it('retains the last known provider when metadata is temporarily unavailable', async () => {
    $hermesAuth.set({ ...$hermesAuth.get(), activeProvider: 'nous' })
    get.mockImplementation(async (route: string) => {
      if (route === '/api/providers/oauth') return { providers: [] }
      throw new Error('Unavailable')
    })
    expect((await refreshHermesAuth()).activeProvider).toBe('nous')
  })
})
