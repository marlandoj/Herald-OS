import { describe, expect, it } from 'vitest'
import { isBoundProviderCredentialName, isCredentialName, SECRET_NAMES } from './credentials.ts'

describe('credential-purpose name policy', () => {
  it('limits legacy provider credential names without widening generic credential access', () => {
    for (const name of ['VLLM_KEY', 'GATEWAY_KEY', 'HERMES_CUSTOM_10_0_0_5_8080_API_KEY']) {
      expect(isBoundProviderCredentialName(name)).toBe(true)
      expect(isCredentialName(name)).toBe(false)
    }
    for (const name of ['NODEEXTRA_KEY', 'PYTHONHOME_KEY', 'HERMES_HOME', 'HERMES_CUSTOM_COMMAND_API_KEY', 'APP_ENDPOINT_KEY', 'PATH', 'UNRELATED', 'bad_key', 'VLLM_KEY\n', 'A'.repeat(129) + '_KEY', null, {}]) {
      expect(isBoundProviderCredentialName(name)).toBe(false)
    }
  })
  it.each(['PYTHONHOME_API_KEY', 'PYTHONSTARTUP_AUTH_TOKEN', 'NODEEXTRA_API_KEY', 'BASHOPTS_API_KEY', 'PROMPT_AUTH_TOKEN', 'SUDO_AUTH_TOKEN', 'PIP_AUTH_TOKEN', 'VIRTUAL_ENV_AUTH_TOKEN', 'CONDA_AUTH_TOKEN'])('reserves entire runtime namespaces including joined prefixes (%s)', name => {
    expect(isCredentialName(name)).toBe(false)
  })
  it('accepts presets and bounded uppercase purpose-suffixed service credentials', () => {
    for (const name of [...SECRET_NAMES, 'ACME_API_KEY', 'SERVICE_ACCESS_TOKEN', 'SERVICE_AUTH_TOKEN', 'SERVICE_CLIENT_SECRET', 'SERVICE_SECRET_KEY']) {
      expect(isCredentialName(name)).toBe(true)
    }
  })
  it.each(['PATH', 'HOME', 'ACME_URL', 'ACME_KEY', 'acme_api_key', '_ACME_API_KEY', 'ACME__API_KEY', 'ACME_API_KEY\n', 'É_API_KEY', 'A'.repeat(129) + '_API_KEY', 'NODE_OPTIONS_API_KEY', 'PYTHONPATH_API_KEY', 'LD_PRELOAD_API_KEY', 'DYLD_INSERT_LIBRARIES_API_KEY', 'ELECTRON_AUTH_TOKEN', 'HERMES_AUTH_TOKEN', 'HERALD_OS_API_KEY', 'XDG_AUTH_TOKEN', 'BASH_ENV_API_KEY', 'GIT_ASKPASS_AUTH_TOKEN', 'NPM_AUTH_TOKEN', 'SSH_AUTH_TOKEN', 'SSL_CERT_API_KEY', 'ENV_API_KEY', 'HTTP_PROXY_API_KEY', 'OPENAI_BASE_URL_API_KEY', null, {}])('rejects runtime, noncredential and malformed names (%j)', name => {
    expect(isCredentialName(name)).toBe(false)
  })
})
