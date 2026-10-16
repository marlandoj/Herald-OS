import { describe, expect, it } from 'vitest'
import { STT_VOCABULARY, sttTuningPatch } from './stt-tuning.ts'
import { rendererConfig } from '../../../electron/backend/renderer-config.ts'

describe('sttTuningPatch', () => {
  it('upgrades the default local model and adds the vocabulary', () => {
    expect(sttTuningPatch({})).toEqual({ stt: { local: { model: 'small.en', initial_prompt: STT_VOCABULARY } } })
    expect(sttTuningPatch({ stt: { provider: 'local', local: { model: 'base', initial_prompt: '' } } })).toEqual({ stt: { local: { model: 'small.en', initial_prompt: STT_VOCABULARY } } })
  })

  it('keeps choices the user already made', () => {
    expect(sttTuningPatch({ stt: { local: { model: 'medium.en', initial_prompt: 'my words' } } })).toBeNull()
    expect(sttTuningPatch({ stt: { local: { model: 'medium.en' } } })).toEqual({ stt: { local: { initial_prompt: STT_VOCABULARY } } })
    expect(sttTuningPatch({ stt: { provider: 'openai' } })).toBeNull()
  })

  it.each(['${LOCAL_STT_MODEL}', '${env:LOCAL_STT_MODEL}', 'prefix-${LOCAL_STT_MODEL}', '$LOCAL_STT_MODEL'])(
    'preserves suppressed saved choice %s while adding only an absent prompt', reference => {
      const projected = rendererConfig(
        { stt: { provider: 'local', local: { model: 'base', initial_prompt: '' } } },
        { stt: { local: { model: reference } } }
      )
      expect(projected).toMatchObject({ stt: { local: { model_tuning_eligible: false } } })
      expect(JSON.stringify(projected)).not.toContain(reference)
      expect(projected.stt).not.toHaveProperty('local.model')
      expect(sttTuningPatch(projected)).toEqual({ stt: { local: { initial_prompt: STT_VOCABULARY } } })
    }
  )

  it.each([
    { saved: {}, expanded: {} },
    { saved: {}, expanded: { stt: { local: { model: 'base' } } } },
    { saved: { stt: { local: { model: 'base' } } }, expanded: { stt: { local: { model: 'base' } } } },
    { saved: { stt: { local: { model: '' } } }, expanded: { stt: { local: { model: '' } } } }
  ])('upgrades a genuinely absent/default projected model %#', ({ saved, expanded }) => {
    const projected = rendererConfig(expanded, saved)
    expect(projected).toMatchObject({ stt: { local: { model_tuning_eligible: true } } })
    expect(sttTuningPatch(projected)).toEqual({ stt: { local: { model: 'small.en', initial_prompt: STT_VOCABULARY } } })
  })

  it.each(['medium.en', 'small', 'custom-model/english'])('retains the saved literal choice %s', model => {
    const config = { stt: { provider: 'local', local: { model, initial_prompt: 'user vocabulary' } } }
    const projected = rendererConfig(config, config)
    expect(projected).toMatchObject({ stt: { local: { model, model_tuning_eligible: false, has_initial_prompt: true } } })
    expect(sttTuningPatch(projected)).toBeNull()
  })

  it('preserves a managed model absent from saved config without exposing its value', () => {
    const projected = rendererConfig({ stt: { local: { model: 'managed-model-canary', initial_prompt: 'words' } } }, {})
    expect(JSON.stringify(projected)).not.toContain('managed-model-canary')
    expect(sttTuningPatch(projected)).toBeNull()
  })

  it('preserves a configured prompt when the renderer receives metadata only', () => {
    expect(sttTuningPatch({ stt: { local: { model: 'medium.en', has_initial_prompt: true } } })).toBeNull()
  })
})
