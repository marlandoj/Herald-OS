import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackendManager } from './manager.ts'

let home: string
let file: string
beforeEach(() => {
  const base = path.join(process.cwd(), 'node_modules/.cache/credential-backend')
  fs.mkdirSync(base, { recursive: true })
  home = fs.mkdtempSync(path.join(base, 'fixture-'))
  file = path.join(home, '.env')
  fs.writeFileSync(file, 'UNRELATED=fixture\n', { mode: 0o644 })
  vi.stubEnv('HERMES_HOME', home)
})
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }) })
const mode = () => fs.statSync(file).mode & 0o777

function ownedBackend() {
  const backend = new BackendManager()
  Object.assign(backend, {
    state: { phase: 'ready', runtime: { kind: 'managed' }, baseUrl: 'http://127.0.0.1:1' },
    child: { pid: process.pid, exitCode: null, killed: false },
    ownedCredentialHome: home,
    startGeneration: 1
  })
  return backend
}

describe('backend-owned credential target', () => {
  it('binds pre/post protection to the home actually passed to the owned serve child', () => {
    const finish = ownedBackend().prepareCredentialWrite()
    expect(mode()).toBe(0o600)
    const replacement = path.join(home, 'replacement')
    fs.writeFileSync(replacement, 'UNRELATED=fixture\n', { mode: 0o644 })
    fs.renameSync(replacement, file)
    finish()
    expect(mode()).toBe(0o600)
  })

  it.each(['attached', 'unowned', 'mismatched', 'not-ready', 'relative-home'])('fails closed for %s without chmod', kind => {
    const backend = ownedBackend()
    if (kind === 'attached') Object.assign(backend, { state: { phase: 'ready', runtime: { kind: 'attached' } } })
    if (kind === 'unowned') Object.assign(backend, { child: null })
    if (kind === 'mismatched') Object.assign(backend, { ownedCredentialHome: path.join(home, 'other') })
    if (kind === 'not-ready') Object.assign(backend, { state: { phase: 'restarting' } })
    if (kind === 'relative-home') vi.stubEnv('HERMES_HOME', path.relative(process.cwd(), home))
    expect(() => backend.prepareCredentialWrite()).toThrow('Credential storage unavailable')
    expect(mode()).toBe(0o644)
  })

  it('does not harden a different backend after an in-flight restart', () => {
    const backend = ownedBackend()
    const finish = backend.prepareCredentialWrite()
    fs.chmodSync(file, 0o644)
    Object.assign(backend, { startGeneration: 2 })
    expect(finish).toThrow('Credential storage unavailable')
    expect(mode()).toBe(0o644)
  })

  it('refuses a replaced home directory across the public lifecycle', () => {
    const finish = ownedBackend().prepareCredentialWrite()
    const moved = `${home}-original`
    fs.renameSync(home, moved)
    try {
      fs.mkdirSync(home, { mode: 0o700 })
      fs.writeFileSync(file, 'UNRELATED=replacement\n', { mode: 0o644 })
      expect(finish).toThrow('Credential storage unavailable')
      expect(mode()).toBe(0o644)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.renameSync(moved, home)
    }
  })
})
