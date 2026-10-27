import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentEngine } from '@fluxos/agent-runtime/agentEngine'
import { DefaultAgentStateProvider } from '@fluxos/agent-runtime/runtime/stateProvider'
import type { AgentTurn } from '@fluxos/contracts/agentTypes'
import type { ToolExecutor } from '@fluxos/contracts/toolExecutor'
import { WorkProjectionEngine } from '@fluxos/presentation/workProjection'
import { projectWorkProjection } from '@fluxos/presentation/taskFlowProjection'
import { ConversationEventLog } from '../events/conversationEventLog'
import { ConversationEventNormalizer } from '../events/conversationEventNormalizer'
import { ConversationRuntimeRepositoryV2 } from './conversationRuntimeRepositoryV2'
import type { PersistedConversation } from './types'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function directory() {
  const root = mkdtempSync(join(tmpdir(), 'fluxos-reasoning-timing-'))
  roots.push(root)
  return root
}

function context(root: string, turn: AgentTurn): PersistedConversation {
  return { id: 'reasoning-timing', title: 'Reasoning timing', createdAt: 1_000, updatedAt: 10_000,
    workspacePath: root, mode: 'vibe', provider: 'custom', model: 'test-model', turnCount: 2,
    turns: [{ id: 'user', role: 'user', content: 'Inspect', timestamp: 1_000, metadata: { workRunId: 'run' } }, turn] }
}

async function produce(durationMs: number, interrupted = false) {
  let clock = 1_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  const state = new DefaultAgentStateProvider({ provider: 'custom', apiKey: 'test', baseUrl: 'http://example.test',
    model: 'test-model', contextWindow: 100_000, maxTokens: 4_096 }, process.cwd())
  let engine!: AgentEngine
  const executor = { streamMessage: vi.fn(async (_url, _headers, _body, onLine) => {
    clock = 5_000
    onLine(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Inspect evidence.' }, finish_reason: null }] })}`)
    clock += durationMs
    if (interrupted) { engine.abort(); return { success: false, error: 'Request aborted' } }
    onLine(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] })}`)
    onLine('data: [DONE]')
    return { success: true, data: '' }
  }), streamAbort: vi.fn(async () => {}) } as unknown as ToolExecutor
  engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', workspacePath: process.cwd(), gitEnabled: false }, executor, state)
  ;(engine as any).abortController = new AbortController()
  const log = new ConversationEventLog('reasoning-timing')
  const normalizer = new ConversationEventNormalizer('reasoning-timing')
  log.appendMany(normalizer.startRun({ runId: 'run', at: 1_000 }))
  log.appendMany(normalizer.normalizeAgent({ type: 'turn:start', turn: context('', {} as AgentTurn).turns[0]! }, { at: 1_000 }))
  engine.subscribe(event => { log.appendMany(normalizer.normalizeAgent(event, { at: clock })) })
  try {
    const turn: AgentTurn = await (engine as any).callModelProvider('openai_chat', state.getActiveConfig(), state.getActiveModel(),
      [{ role: 'system', content: 'system' }, { role: 'user', content: 'Inspect' }], 1_000)
    turn.metadata = { ...turn.metadata, workRunId: 'run' }
    log.appendMany(normalizer.normalizeAgent({ type: 'turn:complete', turn }, { at: clock }))
    log.appendMany(normalizer.finishRun({ outcome: interrupted ? 'interrupted' : 'completed', at: clock + 1_000 }))
    return { turn, events: log.getEvents() }
  } finally { engine.destroy() }
}

describe('reasoning timing from producer to restored renderer input', () => {
  it.each(['canonical', 'snapshot'] as const)('retains measured timing through %s journal serialization and restore', async mode => {
    const root = directory(), { turn, events } = await produce(4_000)
    expect(turn.metadata?.duration).toBe(8_000)
    expect(turn.metadata?.thinking).toMatchObject({ startedAt: 5_000, durationMs: 4_000 })
    const value = context(root, turn), repository = () => new ConversationRuntimeRepositoryV2(root, 'profile', 'workspace', root)
    if (mode === 'canonical') for (const event of events) repository().appendCanonical(event, value)
    else repository().persist(value)
    const persisted = readFileSync(join(root, 'events', value.id + '.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const item = persisted.find(event => event.type === 'item.created' && event.payload.item.kind === 'reasoning').payload.item
    expect(item).toMatchObject({ createdAt: 5_000, updatedAt: 9_000, payload: { startedAt: 5_000, durationMs: 4_000 } })
    const restored = repository().load(value.id)!
    expect(restored.turns.find(candidate => candidate.role === 'assistant')?.metadata?.thinking)
      .toMatchObject({ content: 'Inspect evidence.', startedAt: 5_000, durationMs: 4_000 })
    const work = new WorkProjectionEngine(restored.id).replace(restored.canonicalEvents!)
    expect(Object.values(work.nodes).find(node => node.kind === 'reasoning'))
      .toMatchObject({ startedAt: 5_000, updatedAt: 9_000, completedAt: 9_000, settled: true })
    expect(Object.values(projectWorkProjection(work).nodes).find(node => node.kind === 'thinking'))
      .toMatchObject({ createdAt: 5_000, updatedAt: 9_000, settled: true })
  })

  it.each([false, true])('preserves a measured zero duration, including interrupted=%s', async interrupted => {
    const root = directory(), { turn, events } = await produce(0, interrupted), value = context(root, turn)
    expect(turn.metadata?.thinking).toMatchObject({ startedAt: 5_000, durationMs: 0 })
    const repository = new ConversationRuntimeRepositoryV2(root, 'profile', 'workspace', root)
    for (const event of events) repository.appendCanonical(event, value)
    expect(repository.load(value.id)?.turns.find(candidate => candidate.role === 'assistant')?.metadata?.thinking)
      .toMatchObject({ startedAt: 5_000, durationMs: 0, status: interrupted ? 'interrupted' : 'complete' })
  })

  it('keeps timing when restored turns are normalized back into canonical events', () => {
    const turn: AgentTurn = { id: 'assistant', role: 'assistant', content: 'Done', timestamp: 10_000,
      metadata: { thinking: { content: 'Measured', startedAt: 5_000, durationMs: 4_000 } } }
    const log = new ConversationEventLog('reasoning-timing'), normalizer = new ConversationEventNormalizer('reasoning-timing')
    const events = log.appendMany(normalizer.restoreTurns([turn]))
    expect(events.find(event => event.type === 'stream.committed' && event.payload.channel === 'thinking')?.payload)
      .toMatchObject({ startedAt: 5_000, durationMs: 4_000 })
    expect(Object.values(new WorkProjectionEngine('reasoning-timing').replace(events).nodes).find(node => node.kind === 'reasoning'))
      .toMatchObject({ startedAt: 5_000, updatedAt: 9_000, completedAt: 9_000 })
  })

  it('does not invent timing for the actual historical committed-item shape', () => {
    // 149790f3: reasoning has only text/omitted and equal commit timestamps.
    const root = directory(), committedAt = 1_792_975_485_353
    const turn: AgentTurn = { id: 'historical-assistant', role: 'assistant', content: 'Done', timestamp: committedAt,
      metadata: { workRunId: 'run', duration: 41_965, thinking: { content: 'Historical reasoning', status: 'complete' } } }
    const value = context(root, turn), repository = new ConversationRuntimeRepositoryV2(root, 'profile', 'workspace', root)
    repository.persist(value)
    const restored = repository.load(value.id)!, thinking = restored.turns.find(candidate => candidate.role === 'assistant')?.metadata?.thinking
    expect(thinking?.content).toBe('Historical reasoning')
    expect(thinking?.startedAt).toBeUndefined()
    expect(thinking?.durationMs).toBeUndefined()
    const work = new WorkProjectionEngine(restored.id).replace(restored.canonicalEvents!)
    expect(Object.values(work.nodes).find(node => node.kind === 'reasoning'))
      .toMatchObject({ startedAt: committedAt, updatedAt: committedAt, completedAt: committedAt })
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid measured duration %s before writing a reasoning item', durationMs => {
    const root = directory(), turn: AgentTurn = { id: 'assistant', role: 'assistant', content: 'Done', timestamp: 9_000,
      metadata: { thinking: { content: 'Measured', startedAt: 5_000, durationMs } } }
    expect(() => new ConversationRuntimeRepositoryV2(root, 'profile', 'workspace', root).persist(context(root, turn)))
      .toThrow(/Invalid Conversation V2/)
  })
})
