import { getEncoding, type Tiktoken, type TiktokenEncoding } from 'js-tiktoken'
import { createFluxAgentRequestHeaders } from './clientIdentity'

export type TokenCountSource = 'provider' | 'tokenizer' | 'unavailable'

export interface TokenCountResult {
  tokens: number
  source: TokenCountSource
  tokenizer?: string
  reason?: string
}

interface CountOptions {
  provider?: string
  model?: string
}

// No model-name knowledge in the kernel: one generic encoding counts every
// model; exact counts come from provider usage.
const TOKENIZER_ENCODING: TiktokenEncoding = 'o200k_base'
const encoderCache = new Map<TiktokenEncoding, Tiktoken>()

function getEncoder(name: TiktokenEncoding): Tiktoken {
  const cached = encoderCache.get(name)
  if (cached) return cached
  const encoder = getEncoding(name)
  encoderCache.set(name, encoder)
  return encoder
}

export function countTextTokens(text: string, options: CountOptions = {}): TokenCountResult {
  void options
  return {
    tokens: getEncoder(TOKENIZER_ENCODING).encode(text || '').length,
    source: 'tokenizer',
    tokenizer: TOKENIZER_ENCODING,
  }
}

export function countValueTokens(value: unknown, options: CountOptions = {}): TokenCountResult {
  if (typeof value === 'string') return countTextTokens(value, options)
  return countTextTokens(JSON.stringify(value ?? ''), options)
}

export function countMessagesTokens(messages: Array<Record<string, unknown>>, options: CountOptions = {}): TokenCountResult {
  let total = 0
  for (const message of messages) {
    const count = countValueTokens(message, options)
    if (count.source === 'unavailable') return count
    total += count.tokens + 4
  }
  return { tokens: total, source: 'tokenizer', tokenizer: TOKENIZER_ENCODING }
}

export function countTurnishTokens(value: unknown, options: CountOptions = {}): TokenCountResult {
  return countValueTokens(value, options)
}

export async function countAnthropicMessagesWithProvider(params: {
  baseUrl: string
  apiKey: string
  model: string
  messages: Array<Record<string, unknown>>
  system?: unknown
  tools?: unknown[]
  customHeaders?: Record<string, string>
  fetchImpl?: typeof fetch
}): Promise<TokenCountResult> {
  const fetcher = params.fetchImpl ?? fetch
  const response = await fetcher(`${params.baseUrl.replace(/\/+$/, '')}/messages/count_tokens`, {
    method: 'POST',
    headers: createFluxAgentRequestHeaders({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${params.apiKey}`,
      'x-api-key': params.apiKey,
      'anthropic-version': '2023-06-01',
      ...(params.customHeaders ?? {}),
    }),
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      ...(params.system ? { system: params.system } : {}),
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
    }),
  })

  if (!response.ok) {
    return {
      tokens: 0,
      source: 'unavailable',
      reason: `Anthropic count_tokens failed: ${response.status}`,
    }
  }

  const payload = await response.json() as { input_tokens?: unknown }
  return typeof payload.input_tokens === 'number'
    ? { tokens: payload.input_tokens, source: 'provider' }
    : { tokens: 0, source: 'unavailable', reason: 'Anthropic count_tokens response omitted input_tokens' }
}
