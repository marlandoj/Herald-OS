// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdvancedSettings } from './AdvancedSettings.tsx'
import { SECRET_NAMES } from '../../../../shared/credentials.ts'

let host: HTMLDivElement
let root: Root
const metadata = SECRET_NAMES.map(name => ({ name, isConfigured: name === 'OPENAI_API_KEY' }))
const credentials = {
  list: vi.fn().mockResolvedValue({ ok: true, data: metadata }),
  save: vi.fn().mockResolvedValue({ ok: true, data: null }),
  remove: vi.fn().mockResolvedValue({ ok: true, data: null })
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { heraldOS: { credentials } })
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(createElement(AdvancedSettings)))
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)
  expect(found, `button ${label}`).toBeDefined()
  return found!
}

async function click(label: string) {
  await act(async () => button(label).click())
}

async function edit() {
  await click('Advanced Settings')
  await click('Update OPENAI_API_KEY')
  return host.querySelector<HTMLInputElement>('input[type="password"]')!
}

describe('Advanced Settings credential UI', () => {
  it('shows a safe duplicate result after a stale list and clears the draft', async () => {
    await click('Advanced Settings')
    await click('Add Key')
    host.querySelector<HTMLInputElement>('input[aria-label="Credential name"]')!.value = 'ACME_API_KEY'
    const value = host.querySelector<HTMLInputElement>('input[type=password]')!
    value.value = 'fixture-value'
    credentials.save.mockResolvedValueOnce({ ok: false, code: 'duplicate' })
    await click('Save credential')
    expect(value.value).toBe('')
    expect(host.querySelector('[role=alert]')?.textContent).toMatch(/already exists/i)
  })
  it.each(['PATH', 'NODE_OPTIONS_API_KEY', 'acme_api_key', 'ACME_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'])('rejects invalid names and preset collisions locally (%s)', async name => {
    await click('Advanced Settings')
    await click('Add Key')
    host.querySelector<HTMLInputElement>('input[aria-label="Credential name"]')!.value = name
    const value = host.querySelector<HTMLInputElement>('input[type=password]')!
    value.value = 'fixture-value'
    await click('Save credential')
    expect(value.value).toBe('')
    expect(credentials.save).not.toHaveBeenCalled()
    expect(host.querySelector('[role=alert]')).not.toBeNull()
  })
  it('offers Add Key with a local name and clears the masked draft before explicit creation', async () => {
    await click('Advanced Settings')
    await click('Add Key')
    const name = host.querySelector<HTMLInputElement>('input[aria-label="Credential name"]')!
    const value = host.querySelector<HTMLInputElement>('input[type=password]')!
    expect(name).not.toBeNull()
    expect(value.hasAttribute('value')).toBe(false)
    expect(value.closest('[data-edit-ignore]')).not.toBeNull()
    name.value = 'ACME_API_KEY'
    value.value = 'fixture-value'
    credentials.save.mockImplementationOnce(async () => {
      expect(value.value).toBe('')
      return { ok: true, data: null }
    })
    await click('Save credential')
    expect(credentials.save).toHaveBeenCalledExactlyOnceWith('ACME_API_KEY', 'fixture-value', 'add')
    expect(host.querySelector('input')).toBeNull()
  })
  it('starts collapsed and lists only names and configured state on expansion', async () => {
    expect(button('Advanced Settings').getAttribute('aria-expanded')).toBe('false')
    expect(credentials.list).not.toHaveBeenCalled()
    await click('Advanced Settings')
    expect(button('Advanced Settings').getAttribute('aria-expanded')).toBe('true')
    for (const name of SECRET_NAMES) expect(host.textContent).toContain(name)
    expect(host.textContent).toContain('Configured')
    expect(host.textContent).toContain('Not configured')
    expect(host.textContent).toContain('GPT-Live')
    expect(host.textContent).toContain('HERMES_HOME')
    expect(host.textContent).toContain('.env')
    expect(host.textContent).toMatch(/restart|reload/i)
    expect(host.querySelector('input')).toBeNull()
    expect(host.textContent).not.toMatch(/reveal/i)
  })

  it('uses an empty masked uncontrolled input and clears it before IPC handoff', async () => {
    const input = await edit()
    expect(input).not.toBeNull()
    expect(input.value).toBe('')
    expect(input.hasAttribute('value')).toBe(false)
    expect(input.getAttribute('autocomplete')).toBe('new-password')
    expect(input.closest('[data-edit-ignore]')).not.toBeNull()
    expect(document.activeElement).toBe(input)
    expect(host.querySelector(`label[for="${input.id}"]`)?.textContent).toContain('OPENAI_API_KEY')
    input.value = 'fixture-value'
    credentials.save.mockImplementationOnce(async (name, value) => {
      expect(input.value).toBe('')
      expect(name).toBe('OPENAI_API_KEY')
      expect(value).toBe('fixture-value')
      return { ok: true, data: null }
    })
    await click('Save credential')
    expect(credentials.save).toHaveBeenCalledExactlyOnceWith('OPENAI_API_KEY', 'fixture-value', 'update')
    expect(host.textContent).not.toContain('fixture-value')
    expect(host.querySelector('input')).toBeNull()
    expect(credentials.list).toHaveBeenCalledTimes(2)
  })

  it.each(['Cancel credential edit', 'Advanced Settings', 'Add ANTHROPIC_API_KEY'])('clears the draft synchronously on %s', async action => {
    const input = await edit()
    input.value = 'fixture-value'
    await act(async () => {
      button(action).click()
      expect(input.value).toBe('')
    })
    expect(credentials.save).not.toHaveBeenCalled()
    expect(host.querySelector<HTMLInputElement>('input')?.value ?? '').toBe('')
  })

  it('clears even the detached input on navigation/unmount', async () => {
    const input = await edit()
    input.value = 'fixture-value'
    await act(async () => root.render(null))
    expect(input.value).toBe('')
    expect(credentials.save).not.toHaveBeenCalled()
  })

  it('clears on Escape and on pagehide without sending a credential', async () => {
    const input = await edit()
    input.value = 'fixture-value'
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(input.value).toBe('')
    await click('Update OPENAI_API_KEY')
    const next = host.querySelector<HTMLInputElement>('input')!
    next.value = 'fixture-value'
    window.dispatchEvent(new Event('pagehide'))
    expect(next.value).toBe('')
    expect(credentials.save).not.toHaveBeenCalled()
  })

  it('requires a separate explicit removal confirmation and permits cancellation', async () => {
    const input = await edit()
    input.value = 'fixture-value'
    await click('Remove OPENAI_API_KEY')
    expect(input.value).toBe('')
    expect(credentials.remove).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain('OPENAI_API_KEY')
    await click('Cancel removal')
    expect(credentials.remove).not.toHaveBeenCalled()
    await click('Remove OPENAI_API_KEY')
    await click('Confirm removal of OPENAI_API_KEY')
    expect(credentials.remove).toHaveBeenCalledExactlyOnceWith('OPENAI_API_KEY', true)
    expect(host.querySelector('[role="alertdialog"]')).toBeNull()
    expect(credentials.list).toHaveBeenCalledTimes(2)
  })

  it('rejects an empty draft before IPC and clears it', async () => {
    const input = await edit()
    input.value = '   '
    await click('Save credential')
    expect(input.value).toBe('')
    expect(credentials.save).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not save credential')
  })

  it('shows generic load failure and permits retry without stale configured state', async () => {
    credentials.list.mockRejectedValueOnce(new Error('PRIVATE_ERROR'))
    await click('Advanced Settings')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not load credential status')
    expect(host.textContent).not.toContain('PRIVATE_ERROR')
    expect(host.textContent).not.toContain('Not configured')
    await click('Refresh credential status')
    expect(host.textContent).toContain('Configured')
  })

  it('clears the input on failed save and never renders an IPC exception', async () => {
    const input = await edit()
    input.value = 'fixture-value'
    credentials.save.mockRejectedValueOnce(new Error('PRIVATE_ERROR'))
    await click('Save credential')
    expect(input.value).toBe('')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not save credential')
    expect(host.textContent).not.toMatch(/PRIVATE_ERROR|fixture-value/)
  })

  it('shows only a generic failed-removal error', async () => {
    await click('Advanced Settings')
    await click('Remove OPENAI_API_KEY')
    credentials.remove.mockResolvedValueOnce({ ok: false })
    await click('Confirm removal of OPENAI_API_KEY')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not remove credential')
  })

  it('prevents duplicate submissions while pending and ignores results after collapse', async () => {
    const input = await edit()
    input.value = 'fixture-value'
    let resolve!: (result: { ok: true; data: null }) => void
    credentials.save.mockReturnValueOnce(new Promise(done => { resolve = done }))
    await act(async () => { button('Save credential').click(); button('Save credential').click() })
    expect(credentials.save).toHaveBeenCalledOnce()
    expect(input.value).toBe('')
    await click('Advanced Settings')
    await act(async () => resolve({ ok: true, data: null }))
    expect(credentials.list).toHaveBeenCalledOnce()
    expect(host.querySelector('input')).toBeNull()
  })
})
