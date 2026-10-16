import type { ProviderEndpointKeys } from './credentials.ts'

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
/** A bounded variable reference, never a value or a shell expression. */
export const isProviderVariable = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(value)
const endpointId = (value: string) => value.trim().toLowerCase().replace(/ /g, '-').replace(/^custom:/, '')
const namePrefix = (name: string) => ['—', ' - '].map(separator => name.split(separator)).find(parts => parts.length > 1)?.[0].trim() ?? name

/** Name provenance only; call with the public API's unexpanded include_defaults=false config. */
export function endpointKeys(config: { providers?: unknown; custom_providers?: unknown } | null | undefined): ProviderEndpointKeys {
  const found = new Map<string, string>()
  const add = (id: string, entry: unknown) => {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id) || !record(entry)) return
    // Preserve current-main selection: first nonempty explicit field, else a whole ${VAR} reference.
    const named = [entry.key_env, entry.api_key_env].find((value): value is string => typeof value === 'string' && value.trim() !== '')
    const reference = typeof entry.api_key === 'string' && entry.api_key.length <= 132 ? /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/.exec(entry.api_key.trim())?.[1] : undefined
    const variable = named?.trim() ?? reference
    if (isProviderVariable(variable) && !found.has(id)) found.set(id, variable)
  }
  // Hermes finds a binding under providers before the older list. A binding-less entry falls through.
  for (const [id, entry] of Object.entries(record(config?.providers) ? config.providers : {})) add(endpointId(id), entry)
  for (const entry of Array.isArray(config?.custom_providers) ? config.custom_providers : []) {
    if (record(entry)) {
      const name = typeof entry.provider_key === 'string' && entry.provider_key ? entry.provider_key : typeof entry.name === 'string' ? namePrefix(entry.name) : ''
      add(endpointId(name), entry)
    }
  }
  return Object.fromEntries(found)
}
