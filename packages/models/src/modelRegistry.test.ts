import { describe, expect, it } from 'vitest'
import {
  formatNativeReasoningSetting,
  getModelReasoningCapabilities,
  normalizeNativeReasoningConfig,
  resolveNativeReasoningRequest,
} from './modelRegistry'
import type { ModelCapabilities } from './config'

describe('modelRegistry', () => {
  it('does not infer reasoning from a model name or provider name', () => {
    expect(getModelReasoningCapabilities('gpt-5.6')).toBeNull()
    expect(getModelReasoningCapabilities('claude-opus-5', 'anthropic')).toBeNull()
    expect(getModelReasoningCapabilities('vendor/deepseek-future', 'deepseek')).toBeNull()
    expect(getModelReasoningCapabilities('vendor/glm-future', 'glm')).toBeNull()
    expect(getModelReasoningCapabilities('vendor/kimi-future', 'kimi')).toBeNull()
    expect(getModelReasoningCapabilities('vendor/open-model', 'openai')).toBeNull()
  })

  it('uses reasoning effort metadata advertised by an API', () => {
    const discovered: ModelCapabilities = {
      reasoning: true,
      reasoningEfforts: ['low', 'high'],
      supportedParameters: ['reasoning_effort'],
    }

    expect(resolveNativeReasoningRequest(
      'vendor/new-model',
      { effort: 'high' },
      'custom',
      discovered,
    )).toMatchObject({ reasoningEffort: 'high' })
  })

  it('narrows effort choices to advertised values', () => {
    const discovered: ModelCapabilities = {
      reasoning: true,
      reasoningEfforts: ['low', 'high'],
      supportedParameters: ['reasoning_effort'],
    }

    expect(getModelReasoningCapabilities('vendor/new-model', 'custom', discovered)?.efforts).toEqual(['low', 'high'])
    expect(normalizeNativeReasoningConfig('vendor/new-model', { effort: 'max' }, 'custom', discovered)?.effort).toBe('low')
  })

  it('treats an explicit OpenAI reasoning declaration as effort control without effort metadata', () => {
    expect(getModelReasoningCapabilities('vendor/gpt-like', 'openai', { reasoning: true })?.control).toBe('effort')
    expect(getModelReasoningCapabilities('vendor/gpt-like', 'openai', { reasoning: true })?.efforts).toContain('high')
  })

  it('maps a bare reasoning declaration from other providers to fixed control', () => {
    expect(getModelReasoningCapabilities('vendor/model', 'custom', { reasoning: true })?.control).toBe('fixed')
    expect(formatNativeReasoningSetting('vendor/model', { enabled: true }, 'custom', { reasoning: true })).toBe('fixed')
  })

  it('honors an explicit API declaration that reasoning is unavailable', () => {
    expect(getModelReasoningCapabilities('vendor/model', 'openai', { reasoning: false })).toBeNull()
  })

  it('honors gateway reasoning defaults and mandatory thinking', () => {
    const capabilities: ModelCapabilities = {
      reasoning: true,
      reasoningEfforts: ['low', 'high'],
      reasoningDefaultEffort: 'high',
      reasoningDefaultEnabled: true,
      reasoningMandatory: true,
    }
    expect(getModelReasoningCapabilities('vendor/model', 'custom', capabilities)).toMatchObject({
      defaultEffort: 'high',
      defaultEnabled: true,
      supportsToggle: false,
    })
  })

  it('disables effort negotiation when the toggle is off', () => {
    const discovered: ModelCapabilities = {
      reasoning: true,
      reasoningEfforts: ['low', 'high'],
      supportedParameters: ['reasoning_effort'],
    }
    expect(resolveNativeReasoningRequest('vendor/model', { enabled: false }, 'custom', discovered)).toMatchObject({ enabled: false })
  })
})
