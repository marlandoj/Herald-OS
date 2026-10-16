// Deliberately not a general-purpose environment editor or profile selector.
export const SECRET_NAMES = [
  'VOICE_TOOLS_OPENAI_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY'
] as const

export type SecretName = string
export type SecretSaveMode = 'add' | 'update'
export const SECRET_NAME_MAX_LENGTH = 128

// Positive credential-purpose grammar, not a general environment-variable editor.
// Runtime/control namespaces stay reserved even when disguised with a key suffix.
const RESERVED_PREFIX = /^(?:(?:NODE|PYTHON|BASH)[A-Z0-9]*|LD|DYLD|ELECTRON|HERALD|HERMES|XDG|ENV|GIT|NPM|PIP|CONDA|VIRTUAL_ENV|PROMPT|SUDO|SSH|SSL|HTTP|HTTPS|ALL|NO|PATH|HOME|SHELL|USER|LOGNAME|LANG|LC|DISPLAY|WAYLAND|DBUS|VSCODE|BUN|DENO|JAVA|RUBY|PERL|QT|GTK|GDK|CHROME|CHROMIUM|AWS_CONTAINER|AWS_WEB_IDENTITY)(?:_|$)/
const CONTROL_SEGMENT = /(?:^|_)(?:OPTIONS|PRELOAD|PATH|PROXY|BASE_URL|ENDPOINT|COMMAND|EXEC|SCRIPT|HOOK)(?:_|$)/
export function isCredentialName(name: unknown): name is SecretName {
  if (typeof name !== 'string' || name.length > SECRET_NAME_MAX_LENGTH ||
    !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(name) || /[^A-Z0-9_]/.test(name)) return false
  if (SECRET_NAMES.some(preset => preset === name)) return true
  return /_(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|SECRET_KEY)$/.test(name) &&
    !RESERVED_PREFIX.test(name) && !CONTROL_SEGMENT.test(name)
}
/** Legacy/custom endpoint variables are writable only when trusted raw config binds them. */
export function isBoundProviderCredentialName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length > SECRET_NAME_MAX_LENGTH ||
    !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(name) || !/_(?:KEY|TOKEN|SECRET)$/.test(name) || CONTROL_SEGMENT.test(name)) return false
  const generated = /^HERMES_CUSTOM_[A-Z0-9]+(?:_[A-Z0-9]+)*_API_KEY$/.test(name)
  return generated || !RESERVED_PREFIX.test(name)
}

export interface SecretMetadata {
  name: SecretName
  isConfigured: boolean
}
export type SecretResult<T> = { ok: true; data: T } | { ok: false; code?: 'invalid' | 'duplicate' | 'not-found' }
/** Public provider setup metadata only. No values, previews, paths or raw config. */
export interface ProviderKeyMetadata {
  provider?: string
  is_password: boolean
  is_set: boolean
  url: string | null
}
export type ProviderEndpointKeys = Record<string, string>
export type ProviderKeyCatalog = Record<string, ProviderKeyMetadata>
export const SECRET_VALUE_MAX_LENGTH = 4096
