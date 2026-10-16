// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { GeneralSection } from './GeneralSection.tsx'

it('mounts Advanced Settings inside the actual General settings section', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { heraldOS: { credentials: { list: vi.fn() } } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(GeneralSection)))
    expect(host.textContent).toContain('General')
    expect(host.querySelector('button[aria-label="Advanced Settings"]')).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
