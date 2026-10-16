// @vitest-environment happy-dom
import { randomBytes } from 'node:crypto'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditAction } from '../../shared/ipc.ts'

vi.mock('../lib/motion.ts', () => ({ reducedMotion: () => true }))
const stores = vi.hoisted(() => ({ focused: null as string | null, web: {} as Record<string, { id: string; windowId: string }> }))
vi.mock('./web-windows.ts', () => ({ $webWindows: { get: () => stores.web } }))
vi.mock('./windows.ts', () => ({ $focusedWindowId: { get: () => stores.focused }, $windows: { get: () => ({}) }, focusWindow: vi.fn() }))
import { bindEditTarget, charBeforeCaret, describeTarget, rememberFocusedEditable, performEdit, NoEditTargetError } from './edit-target.ts'
import { AdvancedSettings } from '../features/settings/sections/AdvancedSettings.tsx'

const dispatch = vi.fn(async () => undefined)
let off: () => void
beforeEach(() => {
  vi.clearAllMocks()
  stores.focused = null
  stores.web = {}
  Object.assign(window, { heraldOS: { edit: { perform: dispatch } } })
  off = bindEditTarget()
})
afterEach(() => {
  off()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

function input(type = 'text', ignored = false) {
  const field = document.createElement('input')
  field.type = type
  if (ignored) field.setAttribute('data-edit-ignore', '')
  document.body.append(field)
  return field
}
function guardReads(field: HTMLInputElement) {
  // Generated fixture data never appears in assertions or diagnostics.
  field.value = randomBytes(24).toString('hex')
  return vi.spyOn(field, 'value', 'get')
}

describe('protected edit targets', () => {
  it.each([['password', false], ['password', true], ['text', true]] as const)('never remembers/reads/refocuses %s (ignored=%s)', async (type, ignored) => {
    const field = input(type, ignored)
    field.focus()
    const read = guardReads(field)
    rememberFocusedEditable()
    field.blur()
    const focus = vi.spyOn(field, 'focus')
    expect(charBeforeCaret() !== null).toBe(false)
    expect(describeTarget()).toBe('nothing')
    await expect(performEdit({ kind: 'insert', text: 'ordinary' }, { needsField: true })).rejects.toBeInstanceOf(NoEditTargetError)
    expect(read.mock.calls.length > 0).toBe(false)
    expect(focus.mock.calls.length > 0).toBe(false)
    expect(dispatch.mock.calls.length > 0).toBe(false)
  })

  it.each(['password', 'ignore', 'ancestor-ignore', 'disabled', 'readonly'] as const)('invalidates a connected cached target after %s changes', async protection => {
    const field = input()
    field.focus()
    rememberFocusedEditable()
    field.blur()
    if (protection === 'password') field.type = 'password'
    if (protection === 'ignore') field.setAttribute('data-edit-ignore', '')
    if (protection === 'ancestor-ignore') {
      const wrapper = document.createElement('div')
      wrapper.setAttribute('data-edit-ignore', '')
      field.replaceWith(wrapper)
      wrapper.append(field)
    }
    if (protection === 'disabled') field.disabled = true
    if (protection === 'readonly') field.readOnly = true
    const read = guardReads(field)
    const focus = vi.spyOn(field, 'focus')
    expect(charBeforeCaret() !== null).toBe(false)
    await expect(performEdit({ kind: 'key', key: 'enter' }, { needsField: true })).rejects.toBeInstanceOf(NoEditTargetError)
    expect(read.mock.calls.length > 0 || focus.mock.calls.length > 0 || dispatch.mock.calls.length > 0).toBe(false)
    // Invalidating the cache is permanent, not merely ignoring it for this call.
    field.type = 'text'
    field.disabled = false
    field.readOnly = false
    field.removeAttribute('data-edit-ignore')
    field.parentElement?.removeAttribute('data-edit-ignore')
    expect(charBeforeCaret() !== null).toBe(false)
  })

  it.each(['selectAll', 'unselect', 'copy', 'undo', 'redo', 'delete'] as const)('refuses optional %s with a protected active field and ordinary cached target', async kind => {
    const ordinary = input()
    ordinary.focus()
    rememberFocusedEditable()
    const field = input('password')
    field.focus()
    const read = guardReads(field)
    const focus = vi.spyOn(ordinary, 'focus')
    await performEdit({ kind })
    expect(document.activeElement === field).toBe(true)
    expect(read.mock.calls.length > 0 || focus.mock.calls.length > 0 || dispatch.mock.calls.length > 0).toBe(false)
  })

  it('excludes background pointer capture of an ignored descendant', async () => {
    const field = input('password', true)
    field.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(charBeforeCaret() !== null).toBe(false)
    await expect(performEdit({ kind: 'paste' }, { needsField: true })).rejects.toBeInstanceOf(NoEditTargetError)
    expect(dispatch.mock.calls.length > 0).toBe(false)
  })

  it('refuses a protected active field before routing to a front web view', async () => {
    stores.focused = 'web-window'
    stores.web = { page: { id: 'page', windowId: 'web-window' } }
    input('password').focus()
    await performEdit({ kind: 'copy' })
    expect(dispatch.mock.calls.length > 0).toBe(false)
  })

  it.each(['Add Key', 'Update OPENAI_API_KEY', 'Add VOICE_TOOLS_OPENAI_KEY'])('protects actual AdvancedSettings %s DOM from read/refocus/edit/submit', async label => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const save = vi.fn()
    Object.assign(window.heraldOS, { credentials: {
      list: vi.fn().mockResolvedValue({ ok: true, data: [
        { name: 'OPENAI_API_KEY', isConfigured: true }, { name: 'VOICE_TOOLS_OPENAI_KEY', isConfigured: false }
      ] }), save, remove: vi.fn()
    } })
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => root.render(createElement(AdvancedSettings)))
      await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Advanced Settings"]')!.click())
      await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click())
      const field = host.querySelector<HTMLInputElement>('input[type=password]')!
      expect(Boolean(field && field.closest('[data-edit-ignore]'))).toBe(true)
      field.focus()
      const read = guardReads(field)
      rememberFocusedEditable()
      await performEdit({ kind: 'selectAll' })
      await expect(performEdit({ kind: 'key', key: 'enter' }, { needsField: true })).rejects.toBeInstanceOf(NoEditTargetError)
      field.blur()
      const focus = vi.spyOn(field, 'focus')
      expect(charBeforeCaret() !== null).toBe(false)
      await expect(performEdit({ kind: 'insert', text: 'ordinary' }, { needsField: true })).rejects.toBeInstanceOf(NoEditTargetError)
      expect(read.mock.calls.length > 0 || focus.mock.calls.length > 0 || dispatch.mock.calls.length > 0 || save.mock.calls.length > 0).toBe(false)
    } finally {
      await act(async () => root.unmount())
    }
  })
})

describe('ordinary edit positive controls', () => {
  it('preserves an ordinary destination across an ignored picker that is removed before insertion', async () => {
    const destination = input()
    destination.focus()
    rememberFocusedEditable()
    const picker = input('search', true)
    picker.focus()
    picker.remove()
    await performEdit({ kind: 'insert', text: 'ordinary' }, { needsField: true })
    expect(document.activeElement === destination).toBe(true)
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ kind: 'insert', text: 'ordinary' })
  })

  it.each(['input', 'textarea', 'contenteditable'] as const)('remembers/refocuses/dispatches ordinary %s', async kind => {
    const field = kind === 'input' ? input() : document.createElement(kind === 'textarea' ? 'textarea' : 'div')
    if (kind === 'contenteditable') {
      field.contentEditable = 'true'
      field.tabIndex = 0
    }
    document.body.append(field)
    field.focus()
    rememberFocusedEditable()
    field.blur()
    await performEdit({ kind: 'insert', text: 'ordinary' }, { needsField: true })
    expect(document.activeElement === field).toBe(true)
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ kind: 'insert', text: 'ordinary' })
  })

  it('reads ordinary text before the caret', () => {
    const field = input()
    field.value = 'ordinary'
    field.focus()
    field.setSelectionRange(8, 8)
    expect(charBeforeCaret()).toBe('y')
  })

  it.each(['selectAll', 'copy', 'undo'] as const)('retains ordinary no-field %s controls', async kind => {
    await performEdit({ kind } as EditAction)
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ kind })
  })

  it('dispatches to an ordinary front web view', async () => {
    stores.focused = 'web-window'
    stores.web = { page: { id: 'page', windowId: 'web-window' } }
    await performEdit({ kind: 'copy' })
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ kind: 'copy' }, 'page')
  })
})
