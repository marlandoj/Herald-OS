import { app, session, type Session } from 'electron'
import type { BackendManager } from './manager.ts'

/** Only the active backend HTTP credential/config routes, not general renderer confinement. */
export function blockedBackendRequest(url: string, baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  let target: URL
  try {
    target = new URL(url)
    const active = new URL(baseUrl)
    const loopback = (host: string) => ['127.0.0.1', 'localhost', '[::1]'].includes(host.replace(/\.$/, ''))
    // Don't make a second origin spelling of the same local endpoint a bypass.
    const localAlias = loopback(active.hostname) && loopback(target.hostname) &&
      target.protocol === active.protocol && target.port === active.port
    if (!['http:', 'https:'].includes(target.protocol) || (target.origin !== active.origin && !localAlias)) return false
  } catch { return false }
  try {
    // Chromium normalizes literal dot segments; decode encoded route separators/names too.
    const decoded = decodeURIComponent(target.pathname).replaceAll('\\', '/')
    const pathname = new URL(decoded, target.origin).pathname
    return /^\/api\/(?:env|config)(?:\/|$)/i.test(pathname)
  } catch {
    // Malformed paths on the backend are not an alternate credential capability.
    return true
  }
}

export function registerRendererNetworkGuard(backend: Pick<BackendManager, 'getState'>): void {
  const guarded = new WeakSet<Session>()
  const protect = (target: Session) => {
    if (guarded.has(target)) return
    guarded.add(target)
    // No existing onBeforeRequest listeners in the application. Electron keeps only the last.
    // Guard all requests in these sessions, including workers/frames without webContentsId.
    target.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      callback({ cancel: blockedBackendRequest(details.url, backend.getState().baseUrl) })
    })
  }
  protect(session.defaultSession)
  // Desktop and all panels share defaultSession; future guest/custom sessions get the same rule.
  app.on('session-created', protect)
}
