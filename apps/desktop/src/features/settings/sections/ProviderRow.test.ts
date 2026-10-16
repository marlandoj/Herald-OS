// @vitest-environment happy-dom
import { atom } from 'nanostores'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelProviderRow } from './ProviderRow.tsx'

const loaders = vi.hoisted(() => ({ options: vi.fn(), keys: vi.fn(), endpoints: vi.fn() }))
vi.mock('../../../store/gateway.ts', () => ({ $connection: atom('open'), $connectionEpoch: atom(1) }))
vi.mock('../../../store/hermes-auth.ts', () => ({ $hermesAuth: atom({ providers: [] }), refreshHermesAuth: vi.fn(), requestHermesLogin: vi.fn() }))
vi.mock('../../../store/model-provider.ts', () => ({
  $providerChanges: atom(0), $providerFocus: atom(null), loadModelOptions: loaders.options, loadKeyCatalog: loaders.keys, loadEndpointKeys: loaders.endpoints,
  providerSlug: (id: string) => id, saveProviderKey: vi.fn(), setHermesModel: vi.fn(), switchToProvider: vi.fn()
}))
vi.mock('../../../store/notifications.ts', () => ({ notify: vi.fn() }))
vi.mock('../../../store/web-windows.ts', () => ({ openWebWindow: vi.fn() }))
vi.mock('../../../store/windows.ts', () => ({ openApp: vi.fn(), showPage: vi.fn() }))

let dispose: (() => Promise<void>) | undefined
afterEach(async () => { await dispose?.(); dispose = undefined; vi.clearAllMocks() })

it.each(['keys', 'endpoints'] as const)('does not claim provider readiness/setup when %s metadata fails', async failed => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  loaders.options.mockResolvedValue({ providers: [{ slug: 'lab', name: 'Lab GPU', is_current: true, is_user_defined: true, authenticated: true, models: ['fixture'] }] })
  loaders.keys.mockResolvedValue({})
  loaders.endpoints.mockResolvedValue({})
  loaders[failed].mockRejectedValue(new Error('Provider metadata unavailable.'))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  dispose = async () => { await act(async () => root.unmount()); host.remove() }
  await act(async () => root.render(createElement(ModelProviderRow)))
  expect(host.textContent).toContain('Provider metadata unavailable.')
  expect(host.textContent).not.toContain('Uses your own endpoint')
  expect(host.textContent).not.toContain('No key')
  expect(host.textContent).toContain('Choose a provider')
})
