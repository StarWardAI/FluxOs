import { describe, expect, it } from 'vitest'
import { countMessagesTokens, countTextTokens } from './tokenCounter'

describe('tokenCounter', () => {
  it('counts any model with the generic tokenizer', () => {
    const result = countTextTokens('hello world', { provider: 'openai', model: 'gpt-5.5' })

    expect(result.source).toBe('tokenizer')
    expect(result.tokenizer).toBe('o200k_base')
    expect(result.tokens).toBeGreaterThan(0)
  })

  it('does not depend on model names for tokenizer selection', () => {
    const listed = countTextTokens('hello world', { provider: 'custom', model: 'vendor/new-model' })
    const unknown = countTextTokens('hello world', { provider: 'unknown', model: 'mystery-model' })

    expect(listed.source).toBe('tokenizer')
    expect(unknown.source).toBe('tokenizer')
    expect(listed.tokens).toBe(unknown.tokens)
  })

  it('counts message batches with per-message overhead', () => {
    const result = countMessagesTokens([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'long coding task' },
    ], { provider: 'custom', model: 'deepseek-v4-pro' })

    expect(result.source).toBe('tokenizer')
    expect(result.tokens).toBeGreaterThan(0)
  })
})
