import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { secureActiveCredentialFile } from './credential-permissions.ts'
import { CredentialService } from './credentials.ts'

let home: string
let file: string
beforeEach(() => {
  const base = path.join(process.cwd(), 'node_modules/.cache/credential-permissions')
  fs.mkdirSync(base, { recursive: true })
  home = fs.mkdtempSync(path.join(base, 'fixture-'))
  file = path.join(home, '.env')
  vi.stubEnv('HERMES_HOME', home)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }) })

const mode = (target = file) => fs.statSync(target).mode & 0o777
const prepareWrite = () => { secureActiveCredentialFile(); return secureActiveCredentialFile }

describe('exact active-home credential permissions', () => {
  it.each(['config.yaml', 'auth.json'])('secures existing %s before and after lifecycle replacement', async name => {
    const target = path.join(home, name)
    fs.writeFileSync(target, 'fixture\n', { mode: 0o644 })
    const read = vi.spyOn(fs, 'readFileSync')
    const rest = vi.fn(async (request: { method: string }) => {
      expect(mode(target)).toBe(0o600)
      if (request.method === 'GET') return {}
      const next = path.join(home, 'replacement')
      fs.writeFileSync(next, 'fixture\n', { mode: 0o644 })
      fs.renameSync(next, target)
      return {}
    })
    expect(await new CredentialService(rest, prepareWrite).save('OPENAI_API_KEY', 'fixture', 'add')).toEqual({ ok: true, data: null })
    expect(mode(target)).toBe(0o600)
    expect(read).not.toHaveBeenCalled()
  })

  it.each(['config.yaml', 'auth.json'].flatMap(name =>
    ['symlink', 'dangling', 'hardlink', 'directory', 'foreign'].map(kind => ({ name, kind }))))('refuses $name $kind before lifecycle transport', async ({ name, kind }) => {
    file = path.join(home, name)
    const target = path.join(home, 'unrelated')
    fs.writeFileSync(target, 'unchanged\n', { mode: 0o644 })
    if (kind === 'symlink') fs.symlinkSync(target, file)
    if (kind === 'dangling') fs.symlinkSync(path.join(home, 'missing'), file)
    if (kind === 'hardlink') fs.linkSync(target, file)
    if (kind === 'directory') fs.mkdirSync(file)
    if (kind === 'foreign') {
      fs.writeFileSync(file, 'fixture\n', { mode: 0o644 })
      const original = fs.fstatSync
      vi.spyOn(fs, 'fstatSync').mockImplementation((...args: Parameters<typeof fs.fstatSync>) => {
        const info = original(...args)
        return info.isFile() ? Object.assign(info, { uid: process.getuid!() + 1 }) : info
      })
    }
    const rest = vi.fn()
    const service = new CredentialService(rest, prepareWrite)
    expect(await service.save('OPENAI_API_KEY', 'fixture')).toEqual({ ok: false })
    expect(await service.remove('OPENAI_API_KEY', true)).toEqual({ ok: false })
    expect(rest).not.toHaveBeenCalled()
    expect(mode(target)).toBe(0o644)
  })

  it('tightens an existing loose mode without reading contents', () => {
    fs.writeFileSync(file, 'UNRELATED=fixture\n', { mode: 0o644 })
    const read = vi.spyOn(fs, 'readFileSync')
    secureActiveCredentialFile()
    expect(mode()).toBe(0o600)
    expect(read).not.toHaveBeenCalled()
  })

  it('leaves creation to the public Hermes lifecycle', () => {
    secureActiveCredentialFile()
    expect(fs.existsSync(file)).toBe(false)
  })

  it('rejects a replacement after open without chmodding its target', () => {
    fs.writeFileSync(file, 'fixture\n', { mode: 0o644 })
    const target = path.join(home, 'unrelated')
    fs.writeFileSync(target, 'fixture\n', { mode: 0o644 })
    const original = fs.fchmodSync
    vi.spyOn(fs, 'fchmodSync').mockImplementation((fd, permissions) => {
      fs.unlinkSync(file)
      fs.symlinkSync(target, file)
      original(fd, permissions)
    })
    const close = vi.spyOn(fs, 'closeSync')
    expect(() => secureActiveCredentialFile()).toThrow('Credential storage unavailable')
    expect(mode(target)).toBe(0o644)
    expect(close).toHaveBeenCalled()
  })

  it('rejects a dangling symlink rather than treating it as a new file', () => {
    fs.symlinkSync(path.join(home, 'missing'), file)
    expect(() => secureActiveCredentialFile()).toThrow('Credential storage unavailable')
  })

  it('fails closed before chmod on foreign ownership', () => {
    fs.writeFileSync(file, 'fixture\n', { mode: 0o644 })
    vi.spyOn(process, 'getuid').mockReturnValue(fs.statSync(home).uid + 1)
    expect(() => secureActiveCredentialFile()).toThrow('Credential storage unavailable')
    expect(mode()).toBe(0o644)
  })

  it('fails closed on unsupported platform metadata before touching files', () => {
    fs.writeFileSync(file, 'fixture\n', { mode: 0o644 })
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    expect(() => secureActiveCredentialFile()).toThrow('Credential storage unavailable')
    expect(mode()).toBe(0o644)
  })

  it('closes descriptors and hides permission error details', () => {
    fs.writeFileSync(file, 'fixture\n', { mode: 0o644 })
    vi.spyOn(fs, 'fchmodSync').mockImplementation(() => { throw new Error('PRIVATE') })
    const close = vi.spyOn(fs, 'closeSync')
    expect(() => secureActiveCredentialFile()).toThrow('Credential storage unavailable')
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('refuses a group-writable home before transport', async () => {
    fs.writeFileSync(file, 'fixture\n', { mode: 0o644 })
    fs.chmodSync(home, 0o770)
    const rest = vi.fn()
    expect(await new CredentialService(rest, prepareWrite).save('OPENAI_API_KEY', 'fixture')).toEqual({ ok: false })
    expect(mode()).toBe(0o644)
    expect(rest).not.toHaveBeenCalled()
  })

  it('rejects a writable ancestor which could replace the otherwise private home', () => {
    const parent = path.join(home, 'writable-parent')
    const nested = path.join(parent, 'profile')
    fs.mkdirSync(parent)
    fs.mkdirSync(nested)
    fs.chmodSync(parent, 0o777)
    const nestedFile = path.join(nested, '.env')
    fs.writeFileSync(nestedFile, 'fixture\n', { mode: 0o644 })
    vi.stubEnv('HERMES_HOME', nested)
    expect(() => secureActiveCredentialFile()).toThrow('Credential storage unavailable')
    expect(mode(nestedFile)).toBe(0o644)
  })

  it.each(['symlink', 'hardlink', 'directory'])('fails closed on %s without changing another file', kind => {
    const target = path.join(home, 'unrelated')
    fs.writeFileSync(target, 'fixture\n', { mode: 0o644 })
    if (kind === 'symlink') fs.symlinkSync(target, file)
    if (kind === 'hardlink') fs.linkSync(target, file)
    if (kind === 'directory') fs.mkdirSync(file)
    expect(() => secureActiveCredentialFile()).toThrow()
    expect(mode(target)).toBe(0o644)
  })

  it.each(['save', 'remove'] as const)('secures before and after atomic API %s', async operation => {
    fs.writeFileSync(file, 'UNRELATED=fixture\n', { mode: 0o644 })
    const rest = vi.fn(async (request: { method: string }) => {
      expect(mode()).toBe(0o600)
      if (request.method === 'GET') return {}
      const next = path.join(home, 'replacement')
      fs.writeFileSync(next, 'UNRELATED=fixture\n', { mode: 0o644 })
      fs.renameSync(next, file)
      return { ok: true }
    })
    const service = new CredentialService(rest, prepareWrite)
    const result = operation === 'save' ? await service.save('OPENAI_API_KEY', 'fixture', 'add') : await service.remove('OPENAI_API_KEY', true)
    expect(result).toEqual({ ok: true, data: null })
    expect(mode()).toBe(0o600)
    expect(fs.readFileSync(file, 'utf8')).toBe('UNRELATED=fixture\n')
  })

  it('returns a generic failure before transport when the file is unsafe', async () => {
    fs.mkdirSync(file)
    const rest = vi.fn()
    await expect(new CredentialService(rest, prepareWrite).save('OPENAI_API_KEY', 'fixture')).resolves.toEqual({ ok: false })
    expect(rest).not.toHaveBeenCalled()
  })
})
