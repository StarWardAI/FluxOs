import { REASONING_EFFORTS, type NativeReasoningConfig, type ReasoningEffort } from '@fluxos/contracts/agentTypes'
import type { ModelCapabilities } from './config'

export type SupportedModelProvider = 'openai' | 'anthropic' | 'deepseek' | 'kimi' | 'glm'

export type ReasoningControlKind = 'effort' | 'adaptive-effort' | 'budget' | 'toggle-effort' | 'toggle' | 'fixed'

export interface ModelReasoningCapabilities {
  family: SupportedModelProvider
  control: ReasoningControlKind
  efforts: ReasoningEffort[]
  supportsToggle: boolean
  defaultEnabled: boolean
  defaultEffort?: ReasoningEffort
  defaultBudgetTokens?: number
  omitTemperature: boolean
  preservesReasoningContent?: boolean
  description: string
}

export interface NativeReasoningRequest {
  enabled: boolean
  reasoningEffort?: ReasoningEffort
  thinking?: {
    type: 'disabled' | 'enabled' | 'adaptive'
    budget_tokens?: number
    keep?: 'all'
  }
  outputConfig?: { effort: ReasoningEffort }
  omitTemperature: boolean
}

export function normalizeModelKey(value?: string): string {
  return (value || '').trim().toLowerCase()
}

function capabilities(
  family: SupportedModelProvider,
  control: ReasoningControlKind,
  efforts: ReasoningEffort[],
  options: Partial<ModelReasoningCapabilities>,
): ModelReasoningCapabilities {
  return {
    family,
    control,
    efforts,
    supportsToggle: control !== 'fixed',
    defaultEnabled: true,
    omitTemperature: control !== 'effort',
    description: 'Provider-native reasoning control.',
    ...options,
  }
}

function reconcileAdvertisedReasoning(
  base: ModelReasoningCapabilities,
  discovered?: ModelCapabilities,
): ModelReasoningCapabilities | null {
  if (!discovered) return base
  if (discovered.reasoning === false) return null
  if (base.control === 'budget' || (base.control === 'fixed' && base.efforts.length === 0)) {
    return {
      ...base,
      supportsToggle: discovered.reasoningMandatory ? false : base.supportsToggle,
      defaultEnabled: discovered.reasoningDefaultEnabled ?? base.defaultEnabled,
      defaultEffort: discovered.reasoningDefaultEffort ?? base.defaultEffort,
    }
  }
  const advertised = discovered.reasoningEfforts?.filter(effort => REASONING_EFFORTS.includes(effort)) ?? []
  if (advertised.length === 0) {
    return {
      ...base,
      supportsToggle: discovered.reasoningMandatory ? false : base.supportsToggle,
      defaultEnabled: discovered.reasoningDefaultEnabled ?? base.defaultEnabled,
      defaultEffort: discovered.reasoningDefaultEffort ?? base.defaultEffort,
    }
  }
  const intersection = base.efforts.filter(effort => advertised.includes(effort))
  const efforts = intersection.length > 0 ? intersection : advertised
  const defaultEffort = efforts.includes(base.defaultEffort as ReasoningEffort)
    ? base.defaultEffort
    : efforts.includes('medium')
      ? 'medium'
      : efforts[0]
  return {
    ...base,
    efforts,
    defaultEffort: discovered.reasoningDefaultEffort && efforts.includes(discovered.reasoningDefaultEffort)
      ? discovered.reasoningDefaultEffort
      : defaultEffort,
    supportsToggle: discovered.reasoningMandatory ? false : base.supportsToggle,
    defaultEnabled: discovered.reasoningDefaultEnabled ?? base.defaultEnabled,
  }
}

export function getModelReasoningCapabilities(
  model: string,
  provider?: string,
  discovered?: ModelCapabilities,
): ModelReasoningCapabilities | null {
  // Model behavior is never guessed from a name. Reasoning negotiation only
  // happens when the active catalog (managed backend or API discovery)
  // advertises capabilities for the model.
  void model
  const providerKey = normalizeModelKey(provider)

  if (discovered?.reasoning) {
    const efforts = discovered.reasoningEfforts?.filter(effort => effort !== undefined) ?? []
    // OpenAI's discovery contract historically only exposed `reasoning: true`
    // for some models. Keep the known OpenAI effort wire shape for that
    // explicit declaration, while requiring effort metadata for other
    // providers so an unknown model is not assigned a guessed format.
    const supportsEffort = efforts.length > 0
      || discovered.supportedParameters?.includes('reasoning_effort')
      || providerKey === 'openai'
    if (supportsEffort) {
      const available = efforts.length > 0 ? efforts : ['low', 'medium', 'high'] as ReasoningEffort[]
      return reconcileAdvertisedReasoning(capabilities('openai', 'effort', available, {
        defaultEffort: available.includes('medium') ? 'medium' : available[0],
        omitTemperature: false,
        description: 'Reasoning effort reported by the active API model metadata.',
      }), discovered)
    }
    return reconcileAdvertisedReasoning(capabilities('openai', 'fixed', [], {
      supportsToggle: false,
      omitTemperature: false,
      description: 'Reasoning is supported, but the API did not advertise an adjustable control.',
    }), discovered)
  }

  return null
}

export function normalizeNativeReasoningConfig(
  model: string,
  config?: NativeReasoningConfig,
  provider?: string,
  discovered?: ModelCapabilities,
): NativeReasoningConfig | undefined {
  const capability = getModelReasoningCapabilities(model, provider, discovered)
  if (!capability) return undefined

  const enabled = capability.supportsToggle ? config?.enabled ?? capability.defaultEnabled : true
  const requestedEffort = config?.effort
  const effort = capability.efforts.length > 0
    ? capability.efforts.includes(requestedEffort as ReasoningEffort)
      ? requestedEffort
      : capability.defaultEffort ?? capability.efforts[0]
    : undefined
  const budgetTokens = capability.control === 'budget'
    ? Math.max(1_024, Math.min(128_000, Math.round(config?.budgetTokens ?? capability.defaultBudgetTokens ?? 8_192)))
    : undefined

  return { enabled, effort, budgetTokens }
}

export function resolveNativeReasoningRequest(
  model: string,
  config?: NativeReasoningConfig,
  provider?: string,
  discovered?: ModelCapabilities,
): NativeReasoningRequest | null {
  const capability = getModelReasoningCapabilities(model, provider, discovered)
  const normalized = normalizeNativeReasoningConfig(model, config, provider, discovered)
  if (!capability || !normalized) return null

  const request: NativeReasoningRequest = {
    enabled: normalized.enabled !== false,
    omitTemperature: capability.omitTemperature && normalized.enabled !== false,
  }

  if (capability.control === 'effort') {
    request.reasoningEffort = request.enabled
      ? normalized.effort
      : capability.efforts.includes('none') ? 'none' : undefined
    request.omitTemperature = request.reasoningEffort !== 'none'
  } else if (normalized.effort) {
    request.reasoningEffort = normalized.effort
  }
  return request
}

export function formatNativeReasoningSetting(
  model: string,
  config?: NativeReasoningConfig,
  provider?: string,
  discovered?: ModelCapabilities,
): string | null {
  const capability = getModelReasoningCapabilities(model, provider, discovered)
  const normalized = normalizeNativeReasoningConfig(model, config, provider, discovered)
  if (!capability || !normalized) return null
  if (normalized.enabled === false) return 'off'
  if (normalized.effort) return normalized.effort
  if (capability.control === 'fixed') return 'fixed'
  return 'on'
}
