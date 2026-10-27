import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { normalizeNativeReasoningConfig } from './modelRegistry'
import {
  normalizeApprovalPolicy,
  normalizeCapabilityProfile,
  resolveCapabilityProfileForApproval,
  type ApprovalPolicy,
  type CapabilityProfile,
  type NativeReasoningConfig,
} from '@fluxos/contracts/agentTypes'
import {
  quarantineCorruptFileSync,
  withFileLockSync,
} from '@fluxos/platform/fileIO'
import { readModelConfiguration, writeModelConfiguration, recoverModelConfiguration } from '@fluxos/platform/modelConfigurationStorage'
import { getActiveProfilePaths } from '@fluxos/platform/profilePaths'

import type { FluxAgentConfig, ModelPreset, ModelMetadataSource, ModelCapabilities, FluxAgentProvider, FluxAgentConfigKey, FluxAgentApiConfigProfile } from '@fluxos/contracts/modelConfigTypes'
export type { FluxAgentConfig, ModelPreset, ModelMetadataSource, ModelCapabilities, FluxAgentProvider, FluxAgentConfigKey, FluxAgentApiConfigProfile } from '@fluxos/contracts/modelConfigTypes'

function configDirectory(): string {
  return getActiveProfilePaths().configRoot
}

function configFile(): string {
  return join(configDirectory(), 'config.json')
}

function configLockFile(): string {
  return join(configDirectory(), '.config.lock')
}

function applyApiKeyOverride(raw: Partial<FluxAgentConfig>): Partial<FluxAgentConfig> {
  const apiKey = process.env.FLUXAGENT_API_KEY?.trim()
  if (!apiKey) return raw
  const activeId = raw.activeApiConfigId ?? raw.apiConfigs?.[0]?.id
  return { ...raw, apiKey, apiConfigs: raw.apiConfigs?.map(profile => profile.id === activeId ? { ...profile, apiKey } : profile) }
}

function writeConfigDocument(config: FluxAgentConfig): void {
  writeModelConfiguration(configDirectory(), config)
}

export const DEFAULT_FREE_MODEL = ''
export const DEFAULT_CONTEXT_WINDOW = 200_000
export const DEFAULT_MAX_TOKENS = 16_384
export const FLUXAGENT_PROVIDERS: FluxAgentProvider[] = ['openai', 'anthropic', 'deepseek', 'kimi', 'glm', 'openrouter', 'custom']

const DEFAULT_CONFIG: FluxAgentConfig = {
  provider: 'custom',
  apiKey: '',
  baseUrl: '',
  model: DEFAULT_FREE_MODEL,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  maxTokens: DEFAULT_MAX_TOKENS,
  approvalPolicy: 'ask',
  capabilityProfile: 'workspace-write',
  gitEnabled: true,
  reasoning: undefined,
  apiConfigs: [],
  activeApiConfigId: undefined,
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeProvider(value: unknown, fallback: FluxAgentProvider): FluxAgentProvider {
  return typeof value === 'string' && FLUXAGENT_PROVIDERS.includes(value as FluxAgentProvider)
    ? value as FluxAgentProvider
    : fallback
}

function normalizeConfig(raw: Partial<FluxAgentConfig>): FluxAgentConfig {
  const provider = normalizeProvider(raw.provider, DEFAULT_CONFIG.provider)
  const model = typeof raw.model === 'string' ? raw.model.trim() : DEFAULT_CONFIG.model
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : DEFAULT_CONFIG.baseUrl
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : DEFAULT_CONFIG.apiKey
  const contextWindow = positiveInteger(raw.contextWindow, DEFAULT_CONFIG.contextWindow)
  const maxTokens = positiveInteger(raw.maxTokens, DEFAULT_CONFIG.maxTokens)
  const approvalPolicy = normalizeApprovalPolicy(raw.approvalPolicy, DEFAULT_CONFIG.approvalPolicy)
  const capabilityProfile = resolveCapabilityProfileForApproval(
    approvalPolicy,
    raw.capabilityProfile,
    DEFAULT_CONFIG.capabilityProfile,
  )
  const profiles = normalizeApiConfigProfiles((raw as any).apiConfigs)
  let activeApiConfigId = typeof raw.activeApiConfigId === 'string' ? raw.activeApiConfigId : undefined
  const activeProfile = profiles.find(profile => profile.id === activeApiConfigId)
  const hasCurrentConfig = Boolean(model || baseUrl || apiKey)
  const now = Date.now()
  let nextProfiles = profiles
  if (!activeProfile && hasCurrentConfig) {
    const profile = buildApiConfigProfile({
      id: activeApiConfigId || 'main',
      name: 'Main',
      provider,
      apiKey,
      baseUrl,
      model,
      contextWindow,
      maxTokens,
      maxOutputTokens: raw.maxOutputTokens,
      modelCapabilities: raw.modelCapabilities,
      modelMetadataSources: raw.modelMetadataSources,
      reasoning: normalizeNativeReasoningConfig(model, raw.reasoning, provider, raw.modelCapabilities),
      createdAt: now,
      updatedAt: now,
    })
    nextProfiles = upsertApiConfigProfile(profiles, profile)
    activeApiConfigId = profile.id
  } else if (!activeProfile) {
    activeApiConfigId = nextProfiles[0]?.id
  }

  const selected = nextProfiles.find(profile => profile.id === activeApiConfigId)
  return {
    provider: selected?.provider ?? provider,
    apiKey: selected?.apiKey ?? apiKey,
    baseUrl: selected?.baseUrl ?? baseUrl,
    model: selected?.model ?? model,
    contextWindow: selected?.contextWindow ?? contextWindow,
    maxTokens: selected?.maxTokens ?? maxTokens,
    maxOutputTokens: selected?.maxOutputTokens,
    modelCapabilities: selected?.modelCapabilities,
    modelMetadataSources: selected?.modelMetadataSources,
    approvalPolicy,
    capabilityProfile,
    gitEnabled: raw.gitEnabled !== false,
    reasoning: selected?.reasoning ?? normalizeNativeReasoningConfig(model, raw.reasoning, provider, raw.modelCapabilities),
    apiConfigs: nextProfiles,
    activeApiConfigId,
  }
}

function buildApiConfigProfile(raw: Partial<FluxAgentApiConfigProfile> & Partial<FluxAgentConfig>): FluxAgentApiConfigProfile {
  const now = Date.now()
  const provider = normalizeProvider(raw.provider, DEFAULT_CONFIG.provider)
  const model = typeof raw.model === 'string' ? raw.model.trim() : DEFAULT_CONFIG.model
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/+$/, '') : DEFAULT_CONFIG.baseUrl
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : DEFAULT_CONFIG.apiKey
  const contextWindow = positiveInteger(raw.contextWindow, DEFAULT_CONFIG.contextWindow)
  const maxTokens = positiveInteger(raw.maxTokens, DEFAULT_CONFIG.maxTokens)
  const maxOutputTokens = raw.maxOutputTokens === undefined ? undefined : positiveInteger(raw.maxOutputTokens, maxTokens)
  const reasoning = normalizeNativeReasoningConfig(model, raw.reasoning, provider, raw.modelCapabilities)
  const id = typeof raw.id === 'string' && raw.id.trim()
    ? raw.id.trim()
    : `api_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : defaultApiConfigName(provider, model, id),
    provider,
    apiKey,
    baseUrl,
    model,
    contextWindow,
    maxTokens,
    maxOutputTokens,
    modelCapabilities: raw.modelCapabilities,
    modelMetadataSources: raw.modelMetadataSources,
    reasoning,
    createdAt: positiveInteger(raw.createdAt, now),
    updatedAt: positiveInteger(raw.updatedAt, now),
  }
}

function normalizeApiConfigProfiles(value: unknown): FluxAgentApiConfigProfile[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const profiles: FluxAgentApiConfigProfile[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const profile = buildApiConfigProfile(item as Partial<FluxAgentApiConfigProfile>)
    let id = profile.id
    let suffix = 2
    while (seen.has(id)) {
      id = `${profile.id}-${suffix++}`
    }
    seen.add(id)
    profiles.push({ ...profile, id })
  }
  return profiles
}

function emptyConfigWithProfiles(): FluxAgentConfig {
  return {
    ...DEFAULT_CONFIG,
    apiConfigs: [],
    activeApiConfigId: undefined,
  }
}

export function createEmptyConfig(): FluxAgentConfig {
  return emptyConfigWithProfiles()
}

function defaultApiConfigName(provider: FluxAgentProvider, model: string, id: string): string {
  return model ? `${provider} / ${model}` : id
}

function upsertApiConfigProfile(profiles: FluxAgentApiConfigProfile[] | undefined, profile: FluxAgentApiConfigProfile): FluxAgentApiConfigProfile[] {
  const list = profiles ?? []
  const index = list.findIndex(item => item.id === profile.id)
  if (index < 0) return [...list, profile]
  return list.map((item, i) => i === index ? { ...profile, createdAt: item.createdAt || profile.createdAt } : item)
}

function activeFieldsFromProfile(config: FluxAgentConfig, profile?: FluxAgentApiConfigProfile): FluxAgentConfig {
  if (!profile) return config
  return {
    ...config,
    provider: profile.provider,
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    model: profile.model,
    contextWindow: profile.contextWindow,
    maxTokens: profile.maxTokens,
    maxOutputTokens: profile.maxOutputTokens,
    modelCapabilities: profile.modelCapabilities,
    modelMetadataSources: profile.modelMetadataSources,
    reasoning: profile.reasoning,
    activeApiConfigId: profile.id,
  }
}

function syncActiveProfile(config: FluxAgentConfig, touchUpdatedAt = true): FluxAgentConfig {
  const normalizedProfiles = normalizeApiConfigProfiles(config.apiConfigs)
  const hasCurrentConfig = Boolean(config.model || config.baseUrl || config.apiKey)
  if (normalizedProfiles.length === 0 && !hasCurrentConfig) {
    return {
      ...config,
      provider: normalizeProvider(config.provider, DEFAULT_CONFIG.provider),
      apiKey: '',
      baseUrl: '',
      model: '',
      contextWindow: positiveInteger(config.contextWindow, DEFAULT_CONFIG.contextWindow),
      maxTokens: positiveInteger(config.maxTokens, DEFAULT_CONFIG.maxTokens),
      reasoning: undefined,
      apiConfigs: [],
      activeApiConfigId: undefined,
    }
  }
  const activeId = config.activeApiConfigId || normalizedProfiles[0]?.id || 'main'
  const existing = normalizedProfiles.find(profile => profile.id === activeId)
  const now = Date.now()
  const activeFieldsChanged = !existing || existing.provider !== config.provider
    || existing.apiKey !== config.apiKey
    || existing.baseUrl !== config.baseUrl.replace(/\/+$/, '')
    || existing.model !== config.model.trim()
    || existing.contextWindow !== config.contextWindow
    || existing.maxTokens !== config.maxTokens
    || existing.maxOutputTokens !== config.maxOutputTokens
    || JSON.stringify(existing.modelCapabilities) !== JSON.stringify(config.modelCapabilities)
    || JSON.stringify(existing.modelMetadataSources) !== JSON.stringify(config.modelMetadataSources)
    || JSON.stringify(existing.reasoning) !== JSON.stringify(normalizeNativeReasoningConfig(config.model, config.reasoning, config.provider, config.modelCapabilities))
  const activeProfile = buildApiConfigProfile({
    ...(existing ?? {}),
    id: activeId,
    name: existing?.name || defaultApiConfigName(config.provider, config.model, activeId),
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    maxOutputTokens: config.maxOutputTokens,
    modelCapabilities: config.modelCapabilities,
    modelMetadataSources: config.modelMetadataSources,
    reasoning: config.reasoning,
    createdAt: existing?.createdAt || now,
    updatedAt: touchUpdatedAt && activeFieldsChanged ? now : existing?.updatedAt || now,
  })
  const profiles = upsertApiConfigProfile(normalizedProfiles, activeProfile)
  return activeFieldsFromProfile({
    ...config,
    apiConfigs: profiles,
    activeApiConfigId: activeId,
  }, activeProfile)
}

export function setConfigValue(config: FluxAgentConfig, key: string, value: string): FluxAgentConfig {
  const updateActive = (next: FluxAgentConfig): FluxAgentConfig => syncActiveProfile(next)
  switch (key) {
    case 'provider': {
      if (!FLUXAGENT_PROVIDERS.includes(value as FluxAgentProvider)) {
        throw new Error(`Invalid provider. Use one of: ${FLUXAGENT_PROVIDERS.join(', ')}`)
      }
      return updateActive({ ...config, provider: value as FluxAgentProvider })
    }
    case 'apiKey':
      return updateActive({ ...config, apiKey: value })
    case 'baseUrl': {
      try {
        new URL(value)
      } catch {
        throw new Error('Invalid baseUrl. Use a full URL such as https://api.example.com/v1')
      }
      return updateActive({ ...config, baseUrl: value.replace(/\/+$/, '') })
    }
    case 'model':
      if (!value.trim()) throw new Error('model cannot be empty')
      return updateActive({
        ...config,
        model: value.trim(),
        maxOutputTokens: undefined,
        modelCapabilities: undefined,
        modelMetadataSources: undefined,
        reasoning: normalizeNativeReasoningConfig(value.trim(), config.reasoning, config.provider),
      })
    case 'approvalPolicy':
      if (!['ask', 'agent', 'full', 'request', 'auto'].includes(value.toLowerCase())) {
        throw new Error('approvalPolicy must be ask, agent, or full')
      }
      {
        const approvalPolicy = normalizeApprovalPolicy(value.toLowerCase(), config.approvalPolicy)
        const capabilityProfile = approvalPolicy === 'full'
          ? 'danger-full-access'
          : config.approvalPolicy === 'full' && config.capabilityProfile === 'danger-full-access'
            ? 'workspace-write'
            : normalizeCapabilityProfile(config.capabilityProfile)
        return { ...config, approvalPolicy, capabilityProfile }
      }
    case 'capabilityProfile':
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(value.toLowerCase())) {
        throw new Error('capabilityProfile must be read-only, workspace-write, or danger-full-access')
      }
      {
        const capabilityProfile = normalizeCapabilityProfile(value.toLowerCase(), config.capabilityProfile)
        const approvalPolicy = config.approvalPolicy === 'full' && capabilityProfile !== 'danger-full-access'
          ? 'agent'
          : config.approvalPolicy
        return { ...config, approvalPolicy, capabilityProfile }
      }
    case 'gitEnabled': {
      const normalized = value.toLowerCase()
      if (!['true', 'false', 'on', 'off', 'enabled', 'disabled'].includes(normalized)) {
        throw new Error('gitEnabled must be on or off')
      }
      return { ...config, gitEnabled: ['true', 'on', 'enabled'].includes(normalized) }
    }
    case 'reasoningEnabled': {
      const normalized = value.toLowerCase()
      if (!['true', 'false', 'on', 'off', 'enabled', 'disabled'].includes(normalized)) {
        throw new Error('reasoningEnabled must be on or off')
      }
      return updateActive({
        ...config,
        reasoning: normalizeNativeReasoningConfig(config.model, {
          ...config.reasoning,
          enabled: ['true', 'on', 'enabled'].includes(normalized),
        }, config.provider, config.modelCapabilities),
      })
    }
    case 'reasoningEffort':
      return updateActive({
        ...config,
        reasoning: normalizeNativeReasoningConfig(config.model, {
          ...config.reasoning,
          effort: value.toLowerCase() as NativeReasoningConfig['effort'],
        }, config.provider, config.modelCapabilities),
      })
    case 'reasoningBudgetTokens': {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 1024) throw new Error('reasoningBudgetTokens must be at least 1024')
      return updateActive({
        ...config,
        reasoning: normalizeNativeReasoningConfig(config.model, {
          ...config.reasoning,
          budgetTokens: parsed,
        }, config.provider, config.modelCapabilities),
      })
    }
    case 'contextWindow':
    case 'maxTokens': {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${key} must be a positive integer`)
      }
      if (key === 'maxTokens' && config.maxOutputTokens && parsed > config.maxOutputTokens) {
        throw new Error(`maxTokens cannot exceed this model's ${config.maxOutputTokens} token output limit`)
      }
      return updateActive({ ...config, [key]: parsed } as FluxAgentConfig)
    }
    default:
      throw new Error(`Unknown config key "${key}". Valid keys: provider, apiKey, baseUrl, model, contextWindow, maxTokens, approvalPolicy, capabilityProfile, gitEnabled, reasoningEnabled, reasoningEffort, reasoningBudgetTokens`)
  }
}

export function ensureDirectories(workspacePath?: string): void {
  const dirs = [configDirectory(), getActiveProfilePaths().conversationsRoot]
  if (workspacePath) {
    dirs.push(join(workspacePath, '.fluxagent', 'memory'))
  }
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }
}

function persistConfig(config: FluxAgentConfig): FluxAgentConfig {
  const normalized = syncActiveProfile(normalizeConfig(config))
  const apiKey = process.env.FLUXAGENT_API_KEY?.trim()
  let document = normalized
  if (apiKey) {
    const stored = existsSync(configFile()) ? readModelConfiguration(configDirectory()) as Partial<FluxAgentConfig> : {}
    document = {
      ...normalized,
      apiKey: normalized.apiKey === apiKey ? stored.apiKey || '' : normalized.apiKey,
      apiConfigs: normalized.apiConfigs?.map(profile => ({ ...profile, apiKey: profile.id === normalized.activeApiConfigId && profile.apiKey === apiKey
        ? stored.apiConfigs?.find(item => item.id === profile.id)?.apiKey ?? stored.apiKey ?? '' : profile.apiKey })),
    }
  }
  writeConfigDocument(document)
  return normalized
}

export async function loadConfig(): Promise<FluxAgentConfig> {
  ensureDirectories()
  return withFileLockSync(configLockFile(), () => {
    recoverModelConfiguration(configDirectory())
    if (!existsSync(configFile())) {
      const initial = normalizeConfig(DEFAULT_CONFIG)
      writeConfigDocument(initial)
      return normalizeConfig(applyApiKeyOverride(initial))
    }

    let userConfig: Partial<FluxAgentConfig>
    try {
      const parsed = JSON.parse(readFileSync(configFile(), 'utf8').replace(/^\uFEFF/, ''))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Configuration must be a JSON object')
      userConfig = {}
    } catch (error) {
      const backupPath = quarantineCorruptFileSync(configFile())
      console.warn(`FluxOs preserved an invalid configuration file at ${backupPath}: ${error instanceof Error ? error.message : String(error)}`)
      const recovered = normalizeConfig({ ...DEFAULT_CONFIG, ...readModelConfiguration(configDirectory()) })
      writeConfigDocument(recovered)
      return normalizeConfig(applyApiKeyOverride(recovered))
    }

    const merged = normalizeConfig({ ...DEFAULT_CONFIG, ...readModelConfiguration(configDirectory()) as Partial<FluxAgentConfig> })
    return normalizeConfig(applyApiKeyOverride(syncActiveProfile(merged, false)))
  })
}

export function saveConfig(config: FluxAgentConfig): FluxAgentConfig {
  ensureDirectories()
  return withFileLockSync(configLockFile(), () => {
    return persistConfig(config)
  })
}

export function getConfigDir(): string {
  return configDirectory()
}

export function getConfigFile(): string {
  return configFile()
}

export function redactConfig(config: FluxAgentConfig): FluxAgentConfig {
  return {
    ...config,
    apiKey: config.apiKey ? '***' : '',
    apiConfigs: config.apiConfigs?.map(profile => ({ ...profile, apiKey: profile.apiKey ? '***' : '' })),
  }
}

export function getConversationsDir(): string {
  return getActiveProfilePaths().conversationsRoot
}

export function getPresetByIdOrModelFrom(presets: ModelPreset[], idOrModel: string): ModelPreset | undefined {
  return presets.find(p => p.id === idOrModel || p.model === idOrModel)
}

export function applyPreset(config: FluxAgentConfig, preset: ModelPreset): FluxAgentConfig {
  return syncActiveProfile({
    ...config,
    provider: preset.provider,
    model: preset.model,
    baseUrl: preset.baseUrl,
    contextWindow: preset.contextWindow,
    maxTokens: Math.min(preset.maxTokens, preset.maxOutputTokens ?? preset.maxTokens),
    maxOutputTokens: preset.maxOutputTokens,
    modelCapabilities: preset.capabilities,
    modelMetadataSources: preset.metadataSources,
    reasoning: normalizeNativeReasoningConfig(preset.model, preset.reasoning ?? config.reasoning, preset.provider, preset.capabilities),
  })
}

export function getApiConfigProfiles(config: FluxAgentConfig): FluxAgentApiConfigProfile[] {
  return normalizeConfig(config).apiConfigs ?? []
}

export function getActiveApiConfigProfile(config: FluxAgentConfig): FluxAgentApiConfigProfile | undefined {
  const normalized = normalizeConfig(config)
  return normalized.apiConfigs?.find(profile => profile.id === normalized.activeApiConfigId)
}

export function saveApiConfigProfile(config: FluxAgentConfig, profile: FluxAgentApiConfigProfile, makeActive = true): FluxAgentConfig {
  const normalized = normalizeConfig(config)
  const existing = normalized.apiConfigs?.find(item => item.id === profile.id)
  const unchanged = existing
    && existing.name === profile.name
    && existing.provider === profile.provider
    && existing.apiKey === profile.apiKey
    && existing.baseUrl === profile.baseUrl
    && existing.model === profile.model
    && existing.contextWindow === profile.contextWindow
    && existing.maxTokens === profile.maxTokens
    && existing.maxOutputTokens === profile.maxOutputTokens
    && JSON.stringify(existing.modelCapabilities) === JSON.stringify(profile.modelCapabilities)
    && JSON.stringify(existing.modelMetadataSources) === JSON.stringify(profile.modelMetadataSources)
    && JSON.stringify(existing.reasoning) === JSON.stringify(profile.reasoning)
  const storedProfile = {
    ...profile,
    createdAt: existing?.createdAt || profile.createdAt,
    updatedAt: unchanged ? existing.updatedAt : Date.now(),
  }
  const profiles = upsertApiConfigProfile(normalized.apiConfigs, storedProfile)
  const next = {
    ...normalized,
    apiConfigs: profiles,
    activeApiConfigId: makeActive ? profile.id : normalized.activeApiConfigId,
  }
  const selected = profiles.find(item => item.id === next.activeApiConfigId)
  return activeFieldsFromProfile(next, selected)
}

export function createApiConfigProfile(input: Partial<FluxAgentApiConfigProfile> & Partial<FluxAgentConfig>): FluxAgentApiConfigProfile {
  return buildApiConfigProfile(input)
}

export function switchActiveApiConfig(config: FluxAgentConfig, apiConfigId: string): FluxAgentConfig {
  const normalized = normalizeConfig(config)
  const profile = normalized.apiConfigs?.find(item => item.id === apiConfigId)
  if (!profile) throw new Error(`API config not found: ${apiConfigId}`)
  return activeFieldsFromProfile({ ...normalized, activeApiConfigId: apiConfigId }, profile)
}

export function deleteApiConfigProfile(config: FluxAgentConfig, apiConfigId: string): FluxAgentConfig {
  const normalized = normalizeConfig(config)
  const profiles = (normalized.apiConfigs ?? []).filter(profile => profile.id !== apiConfigId)
  if (profiles.length === 0) {
    return emptyConfigWithProfiles()
  }
  const nextActiveId = normalized.activeApiConfigId === apiConfigId
    ? profiles[0]?.id
    : normalized.activeApiConfigId
  const next = {
    ...normalized,
    apiConfigs: profiles,
    activeApiConfigId: nextActiveId,
  }
  return activeFieldsFromProfile(next, profiles.find(profile => profile.id === nextActiveId))
}
