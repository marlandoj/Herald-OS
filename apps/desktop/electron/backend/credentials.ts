import type { RestRequest } from '../../shared/ipc.ts'
import { isBoundProviderCredentialName, isCredentialName, SECRET_NAMES, SECRET_VALUE_MAX_LENGTH, type SecretMetadata, type SecretResult, type ProviderEndpointKeys, type ProviderKeyCatalog } from '../../shared/credentials.ts'

import { endpointKeys } from '../../shared/provider-metadata.ts'

export class CredentialService {
  private pending: Promise<unknown> = Promise.resolve()
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation)
    this.pending = result.then(() => undefined, () => undefined)
    return result
  }
  constructor(
    private readonly rest: (request: RestRequest) => Promise<unknown>,
    private readonly prepareWrite: () => (() => void) = () => { throw new Error('Credential storage unavailable') }
  ) {}

  async list(): Promise<SecretResult<SecretMetadata[]>> {
    try {
      const rows = await this.rest({ method: 'GET', path: '/api/env' })
      if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return { ok: false }
      const metadata = rows as Record<string, { is_set?: unknown; custom?: unknown }>
      const custom = Object.keys(metadata).filter(name => isCredentialName(name) &&
        !SECRET_NAMES.some(preset => preset === name) &&
        (metadata[name]?.custom === true || metadata[name]?.is_set === true)).sort()
      return { ok: true, data: [...SECRET_NAMES, ...custom].map(name => ({ name, isConfigured: metadata[name]?.is_set === true })) }
    } catch {
      // Never serialize, log or attach the upstream error to a renderer result.
      return { ok: false }
    }
  }

  async providerEndpoints(): Promise<SecretResult<ProviderEndpointKeys>> {
    try {
      // Raw public API only. Never parse profile files or accept a caller-supplied path.
      const config = await this.rest({ method: 'GET', path: '/api/config', query: { include_defaults: false } })
      if (!config || typeof config !== 'object' || Array.isArray(config)) return { ok: false }
      const saved = config as { providers?: unknown; custom_providers?: unknown }
      if ((saved.providers !== undefined && (!saved.providers || typeof saved.providers !== 'object' || Array.isArray(saved.providers))) ||
        (saved.custom_providers !== undefined && !Array.isArray(saved.custom_providers))) return { ok: false }
      return { ok: true, data: endpointKeys(saved) }
    } catch {
      return { ok: false }
    }
  }

  async providerCatalog(): Promise<SecretResult<ProviderKeyCatalog>> {
    try {
      const rows = await this.rest({ method: 'GET', path: '/api/env' })
      if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return { ok: false }
      const catalog: ProviderKeyCatalog = {}
      for (const [name, entry] of Object.entries(rows)) {
        if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) continue
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.is_set !== 'boolean') return { ok: false }
        const provider = typeof entry.provider === 'string' && /^[a-z][a-z0-9._-]{0,127}$/.test(entry.provider) ? entry.provider : undefined
        let url: string | null = null
        if (typeof entry.url === 'string' && entry.url.length <= 256) {
          try {
            const parsed = new URL(entry.url)
            if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) url = parsed.href
          } catch { /* Not public help metadata. */ }
        }
        catalog[name] = { ...(provider ? { provider } : {}), is_password: entry.is_password === true, is_set: entry.is_set, url }
      }
      return { ok: true, data: catalog }
    } catch {
      return { ok: false }
    }
  }

  async save(name: unknown, value: unknown, mode: unknown = 'update'): Promise<SecretResult<null>> {
    // Reject control/non-ASCII characters too: upstream otherwise prints character diagnostics.
    if (!isCredentialName(name) || (mode !== 'add' && mode !== 'update') || typeof value !== 'string' || !value.trim() ||
      value.length > SECRET_VALUE_MAX_LENGTH || /[^\x20-\x7e]/.test(value)) return { ok: false }
    return this.serial(() => this.write(name, value, mode))
  }

  /** Provider setup creates or replaces a key in the same serialized, guarded lifecycle. */
  async saveProvider(name: unknown, value: unknown): Promise<SecretResult<null>> {
    if ((!isCredentialName(name) && !isBoundProviderCredentialName(name)) || typeof value !== 'string' || !value.trim() ||
      value.length > SECRET_VALUE_MAX_LENGTH || /[^\x20-\x7e]/.test(value)) return { ok: false }
    return this.serial(() => this.write(name, value, 'provider'))
  }

  private async write(name: string, value: string, mode: 'add' | 'update' | 'provider'): Promise<SecretResult<null>> {
    try {
      const finish = this.prepareWrite()
      try {
        if (mode === 'provider' && !isCredentialName(name)) {
          const bindings = await this.providerEndpoints()
          if (!bindings.ok || !Object.values(bindings.data).includes(name)) return { ok: false }
        }
        if (mode === 'provider') {
          // The provider chooser needs known configured-state metadata, not a guessed absence.
          if (!(await this.providerCatalog()).ok) return { ok: false }
        } else {
          const listing = await this.list()
          if (!listing.ok) return { ok: false }
          const exists = listing.data.some(row => row.name === name && (row.isConfigured || !SECRET_NAMES.some(preset => preset === name)))
          if (mode === 'add' && exists) return { ok: false, code: 'duplicate' }
          if (mode === 'update' && !exists) return { ok: false, code: 'not-found' }
        }
        // Discovery awaited the backend; refuse a restarted/rebound target before writing.
        finish()
        await this.rest({ method: 'PUT', path: '/api/env', body: { key: name, value } })
      } finally {
        finish()
      }
      return { ok: true, data: null }
    } catch {
      return { ok: false }
    }
  }

  async remove(name: unknown, confirmed: unknown): Promise<SecretResult<null>> {
    if (!isCredentialName(name) || confirmed !== true) return { ok: false }
    return this.serial(() => this.delete(name))
  }

  private async delete(name: string): Promise<SecretResult<null>> {
    try {
      const finish = this.prepareWrite()
      try {
        await this.rest({ method: 'DELETE', path: '/api/env', body: { key: name } })
      } finally {
        finish()
      }
      return { ok: true, data: null }
    } catch {
      return { ok: false }
    }
  }
}
