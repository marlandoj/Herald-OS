import type { EditAction } from '../../shared/ipc.ts'
import { reducedMotion } from '../lib/motion.ts'
import { $webWindows } from './web-windows.ts'
import { $focusedWindowId, $windows, focusWindow } from './windows.ts'

/*
 * Where voice typing and editing land. Speaking usually starts with a click on the mic or the orb,
 * which moves focus off the text field the user meant, so the last focused editable element is
 * remembered and focused again before typing. When the frontmost Hermes window is a web page, the
 * action goes to that page instead.
 */

let lastEditable: HTMLElement | null = null
let bound = false

/** Passwords are never ordinary edit targets, even when a caller omitted the opt-out marker. */
function isEditExcluded(element: Element | null): boolean {
  return Boolean(element?.closest('[data-edit-ignore]')) ||
    (element instanceof HTMLInputElement && element.type === 'password')
}

export function isEditable(element: Element | null): element is HTMLElement {
  if (!element || !(element instanceof HTMLElement) || isEditExcluded(element)) {
    return false
  }

  if (element.isContentEditable) {
    return true
  }

  if (element instanceof HTMLTextAreaElement) {
    return !element.disabled && !element.readOnly
  }

  if (element instanceof HTMLInputElement) {
    return !element.disabled && !element.readOnly && /^(text|search|url|email|tel|number|)$/.test(element.type)
  }

  return false
}

/** Remember the focused field now (a conversation is starting and may move focus to the orb/mic). */
export function rememberFocusedEditable(): void {
  rememberEditable(document.activeElement)
}

function rememberEditable(element: Element | null): void {
  // An ordinary ignored picker must not replace its destination; a password clears it outright.
  if ((element instanceof HTMLInputElement && element.type === 'password') || (lastEditable && (!lastEditable.isConnected || !isEditable(lastEditable)))) {
    lastEditable = null
  }

  if (isEditable(element)) {
    lastEditable = element
  }
}

export function bindEditTarget(): () => void {
  if (bound) {
    return () => undefined
  }

  bound = true
  // Pickers that type into the field the person was in (the emoji picker) opt out with data-edit-ignore.
  const onFocus = (event: FocusEvent) => rememberEditable(event.target as Element)
  // A press on a field also counts: focus events do not fire while the window is in the background.
  const onPointer = (event: PointerEvent) => rememberEditable((event.target as Element | null)?.closest?.('textarea, input, [contenteditable="true"]') ?? null)
  document.addEventListener('focusin', onFocus, true)
  document.addEventListener('pointerdown', onPointer, true)

  return () => {
    document.removeEventListener('focusin', onFocus, true)
    document.removeEventListener('pointerdown', onPointer, true)
    bound = false
  }
}

/** The OS window that contains an element (by the window manager's data attribute), if any. */
function windowIdOf(element: HTMLElement): string | null {
  return element.closest<HTMLElement>('[data-window-id]')?.dataset.windowId ?? null
}

/** Describe the target for captions: "the terminal", "the Hermes composer", "the web page". */
export function describeTarget(): string {
  if (isEditExcluded(document.activeElement)) {
    currentEditable()

    return 'nothing'
  }

  const web = frontWebView()

  if (web) {
    return 'the web page'
  }

  const element = currentEditable()

  if (!element) {
    return 'nothing'
  }

  if (element.classList.contains('xterm-helper-textarea')) {
    return 'the terminal'
  }

  const label = element.getAttribute('aria-label') || element.getAttribute('placeholder') || ''

  return label ? `"${label.slice(0, 40)}"` : 'the text field'
}

function frontWebView(): string | null {
  const focused = $focusedWindowId.get()

  if (!focused) {
    return null
  }

  const entry = Object.values($webWindows.get()).find(w => w.windowId === focused)

  return entry?.id ?? null
}

function currentEditable(): HTMLElement | null {
  const active = document.activeElement

  // Recheck connected caches: their type, marker, ancestry or writable state may have changed.
  if (isEditExcluded(active) || (lastEditable && (!lastEditable.isConnected || !isEditable(lastEditable)))) {
    lastEditable = null
  }

  if (isEditExcluded(active)) {
    return null
  }

  if (isEditable(active)) {
    return active
  }

  return lastEditable?.isConnected ? lastEditable : null
}

/** The character before the caret in the target text field (null for the terminal and web pages). */
export function charBeforeCaret(): string | null {
  if (frontWebView()) {
    return null
  }

  const element = currentEditable()

  if (!(element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) || element.classList.contains('xterm-helper-textarea')) {
    return null
  }

  const caret = element.selectionStart ?? element.value.length

  return caret > 0 ? element.value[caret - 1] : ''
}

export class NoEditTargetError extends Error {
  constructor() {
    super('Nothing to type into. Click a text field (or the terminal) first, then say it again.')
    this.name = 'NoEditTargetError'
  }
}

/**
 * Perform an edit on the right target. `needsField`: typing and key presses need a text field (or a
 * web page); clipboard actions also work on a plain selection.
 */
export async function performEdit(action: EditAction, options: { needsField?: boolean } = {}): Promise<{ target: string }> {
  // Optional clipboard/selection edits otherwise fall through to Chromium's active password field.
  if (isEditExcluded(document.activeElement)) {
    lastEditable = null

    if (options.needsField) {
      throw new NoEditTargetError()
    }

    return { target: 'nothing' }
  }

  const web = frontWebView()

  if (web) {
    await window.heraldOS.edit.perform(action, web)

    return { target: 'the web page' }
  }

  const element = currentEditable()

  if (!element && options.needsField) {
    throw new NoEditTargetError()
  }

  if (element && document.activeElement !== element) {
    const windowId = windowIdOf(element)

    if (windowId && $windows.get()[windowId]) {
      focusWindow(windowId)
    }

    element.focus({ preventScroll: true })
  }

  // Focus handlers can change protection synchronously; never dispatch after that transition.
  if (isEditExcluded(document.activeElement) || (element && !isEditable(element))) {
    lastEditable = null

    if (options.needsField) {
      throw new NoEditTargetError()
    }

    return { target: 'nothing' }
  }

  const target = describeTarget()
  await window.heraldOS.edit.perform(action)

  return { target }
}

/** Scroll the main content of the frontmost window. */
export function scrollFront(direction: 'up' | 'down' | 'top' | 'bottom'): boolean {
  const focused = $focusedWindowId.get()
  const win = focused ? $windows.get()[focused] : null
  const x = win ? win.bounds.x + win.bounds.width / 2 : window.innerWidth / 2
  const y = win ? win.bounds.y + win.bounds.height / 2 : window.innerHeight / 2
  let element = document.elementFromPoint(x, y) as HTMLElement | null

  while (element && element !== document.body) {
    const style = getComputedStyle(element)

    if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 4) {
      break
    }

    element = element.parentElement
  }

  if (!element || element === document.body) {
    return false
  }

  const behavior: ScrollBehavior = reducedMotion() ? 'auto' : 'smooth'

  if (direction === 'top') {
    element.scrollTo({ top: 0, behavior })
  } else if (direction === 'bottom') {
    element.scrollTo({ top: element.scrollHeight, behavior })
  } else {
    element.scrollBy({ top: (direction === 'down' ? 1 : -1) * element.clientHeight * 0.8, behavior })
  }

  return true
}
