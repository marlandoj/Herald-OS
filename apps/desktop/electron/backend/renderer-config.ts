// Renderer configuration is a narrow settings capability, not a credential export.
// Free-form reads MUST come from the supported unexpanded saved-config response;
// validation of a resolved string cannot recover its environment-reference provenance.
type RecordValue = Record<string, unknown>
type Rule = ((value: unknown) => boolean) | { [key: string]: Rule }
const object = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value)
// Nonsecret settings must remain literals: Hermes expands ${VAR}/${env:VAR} on GET.
// Refuse incomplete references and bare $VAR too, rather than depending on expansion details.
const string = (value: unknown) => typeof value === 'string' && value.length <= 4096 &&
  !/[\x00-\x1f\x7f]/.test(value) && !/\$(?:\{|[A-Za-z_])/.test(value)
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1000
const choice = (...values: unknown[]) => (value: unknown) => values.includes(value)
const sttProvider = choice('nous', 'local', 'openai', 'groq', 'mistral', 'elevenlabs')
const ttsProvider = choice('nous', 'edge', 'openai', 'elevenlabs', 'neutts', 'kittentts', 'piper')
const toolSearch = choice('auto', 'off', 'on', 'false', 'true', '0', '1', 'no', 'yes', false, true)

const readable: Rule = {
  stt: { provider: sttProvider },
  tts: { provider: ttsProvider },
  delegation: { max_concurrent_children: count },
  tools: { tool_search: { enabled: toolSearch } }
}
const writable: Rule = {
  stt: { provider: sttProvider, local: { model: string, initial_prompt: string } },
  tts: { provider: ttsProvider },
  delegation: { max_concurrent_children: count },
  tools: { tool_search: { enabled: toolSearch } },
  // Local-model selection intentionally clears a stale key; it cannot submit a key/preview.
  model: { provider: choice('custom', 'lmstudio'), default: string,
    base_url: choice('http://127.0.0.1:11434/v1', 'http://127.0.0.1:1234/v1'),
    api_key: choice(''), api_mode: choice('') }
}

function project(value: unknown, rule: Rule): unknown {
  if (typeof rule === 'function') return rule(value) ? value : undefined
  if (!object(value)) return undefined
  const result: RecordValue = {}
  for (const key of Object.keys(rule)) {
    const next = project(value[key], rule[key]!)
    if (next !== undefined) result[key] = next
  }
  return result
}

export function rendererConfig(value: unknown, saved: unknown): RecordValue {
  // Defaulted/expanded input is usable only for these finite, typed settings.
  const result = (project(value, readable) ?? {}) as RecordValue
  const expandedLocal = object(value) && object(value.stt) && object(value.stt.local) ? value.stt.local : {}
  const savedLocal = object(saved) && object(saved.stt) && object(saved.stt.local) ? saved.stt.local : {}
  const stt = (result.stt ??= {}) as RecordValue
  const local = (stt.local ??= {}) as RecordValue
  local.has_initial_prompt = typeof expandedLocal.initial_prompt === 'string' && Boolean(expandedLocal.initial_prompt.trim())
  // Omission is not absence: references/managed choices must never enter the tuner's
  // missing-model branch. Only an explicit saved default or a genuinely absent/default
  // model is eligible. Expanded free-form text contributes only to this boolean.
  const defaultModel = (model: unknown) => model === undefined || model === '' || model === 'base'
  local.model_tuning_eligible = savedLocal.model === 'base' ||
    (defaultModel(savedLocal.model) && defaultModel(expandedLocal.model))
  if (string(savedLocal.model)) {
    // Emit the saved literal itself, never a resolved value matched against another read.
    local.model = savedLocal.model
  }
  // Older Hermes versions also accept tools.tool_search as a scalar boolean.
  if (object(value) && object(value.tools) && typeof value.tools.tool_search === 'boolean') {
    result.tools = { tool_search: value.tools.tool_search }
  }
  return result
}

function valid(value: unknown, rule: Rule): boolean {
  if (typeof rule === 'function') return rule(value)
  return object(value) && Object.keys(value).length > 0 && Object.keys(value).every(key =>
    Object.hasOwn(rule, key) && valid(value[key], rule[key]!))
}

export function rendererConfigPatch(body: unknown): boolean {
  return object(body) && Object.keys(body).length === 1 && Object.hasOwn(body, 'config') && valid(body.config, writable)
}
