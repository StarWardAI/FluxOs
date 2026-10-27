import type {
  ContinuumDailyRollup,
  ContinuumNextRead,
  ContinuumRecallDepth,
  ContinuumRecallResult,
  ContinuumRecallSection,
  ContinuumReference,
} from '@fluxos/contracts/continuumTypes'
import type { Memory, MemoryContinuitySummary, MemoryHistoryHit } from '@fluxos/contracts/memoryTypes'
import type { ContinuumStore } from './continuum'

const RECALL_RESULT_BUDGET = 30_000
const RECENT_SUMMARIES = 5
const RECENT_SUMMARY_CHARS = 800
const ROLLUP_SECTION_CHARS = 6_000
const DEEP_ROLLUP_CHARS = 12_000
const ENTITY_EVENTS_SHOWN = 5
const SEARCH_DAILY_LIMIT_DAYS = 366

export type { ContinuumRecallDepth }

export interface ContinuumRecallInput {
  depth: ContinuumRecallDepth
  query?: string
  entity?: string
  date?: string
  limit?: number
}

export interface ContinuumRecallDeps {
  store: ContinuumStore
  summaries?: () => MemoryContinuitySummary[]
  searchMessages?: (query: string, limit: number) => MemoryHistoryHit[]
  memories?: (query: string, limit: number) => Memory[]
  validateRefs?: (refs: ContinuumReference[]) => boolean[]
  /** Policy-aware evidence readability; gates cross-workspace person events. */
  readRef?: (ref: ContinuumReference) => boolean
  now?: () => number
}

function isoDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

function nextReadsFrom(refs: ContinuumReference[]): ContinuumNextRead[] {
  return refs.slice(0, 8).map(ref => ({ conversationId: ref.conversationId, messageId: ref.messageId, offset: ref.offset }))
}

/**
 * Read-time evidence filtering. Refs are validated in one batched call per
 * document (the underlying index refreshes its catalog on every validate
 * call, so per-detail calls would scale with detail count); entity events
 * additionally require the evidence to be readable under the current
 * workspace's history policy, which is what keeps cross-workspace person
 * timelines from showing unverifiable entries.
 */
function applyEvidenceFilter(deps: ContinuumRecallDeps) {
  const validate = deps.validateRefs
  const rollup = (value: ContinuumDailyRollup): ContinuumDailyRollup => {
    if (!validate) return value
    const allRefs = value.entries.flatMap(entry => entry.keyDetails.flatMap(detail => detail.refs))
    if (!allRefs.length) return value
    const verdicts = new Map(validate(allRefs).map((ok, index) => [allRefs[index], ok]))
    const entries = value.entries.map(entry => ({
      ...entry,
      keyDetails: entry.keyDetails.filter(detail => !detail.refs.length || detail.refs.some(ref => verdicts.get(ref) === true)),
    }))
    return { ...value, entries }
  }
  const events = (timeline: Array<{ date: string; text: string; refs: ContinuumReference[] }>): Array<{ date: string; text: string; refs: ContinuumReference[] }> => {
    if (!validate && !deps.readRef) return timeline
    const refs = timeline.flatMap(event => event.refs)
    const verdicts = validate ? new Map(validate(refs).map((ok, index) => [refs[index], ok])) : undefined
    return timeline.filter(event => {
      if (!event.refs.length) return true
      if (verdicts && !event.refs.some(ref => verdicts.get(ref) === true)) return false
      if (deps.readRef) return event.refs.some(ref => deps.readRef!(ref))
      return true
    })
  }
  return { rollup, events }
}

function collectRollupRefs(rollup: ContinuumDailyRollup, cap = 24): ContinuumReference[] {
  const refs: ContinuumReference[] = []
  for (const entry of rollup.entries) {
    for (const detail of entry.keyDetails) {
      for (const ref of detail.refs) {
        if (refs.length >= cap) return refs
        refs.push(ref)
      }
    }
  }
  return refs
}

function renderRollup(rollup: ContinuumDailyRollup, charBudget: number): string {
  const lines: string[] = [`# ${rollup.date} (${rollup.entries.length} conversations)`]
  if (rollup.narrative) lines.push(rollup.narrative)
  if (rollup.corrections.length) lines.push(`Corrections: ${rollup.corrections.map(correction => correction.note).join(' / ')}`)
  for (const entry of rollup.entries) {
    lines.push(`## ${entry.title}`)
    if (entry.summary) lines.push(entry.summary)
    for (const detail of entry.keyDetails) lines.push(`- ${detail.text}`)
    lines.push('')
  }
  const text = lines.join('\n')
  return text.length > charBudget ? `${text.slice(0, charBudget)}…` : text
}

function messageSection(hit: MemoryHistoryHit): ContinuumRecallSection {
  return { kind: 'message', title: `${hit.title} · ${new Date(hit.updatedAt).toISOString().slice(0, 16).replace('T', ' ')} (${hit.kind})`,
    text: hit.text.slice(0, 1_600), refs: [{ conversationId: hit.conversationId, messageId: hit.messageId, offset: hit.offset, digest: hit.digest }],
    nextReads: [{ conversationId: hit.conversationId, messageId: hit.messageId, offset: hit.offset }] }
}

/** Deterministic three-depth recall router over the Continuum layers. */
export function routeRecall(input: ContinuumRecallInput, deps: ContinuumRecallDeps): ContinuumRecallResult {
  const now = (deps.now ?? Date.now)()
  const sections: ContinuumRecallSection[] = []
  let used = 0
  let truncated = false
  const push = (section: ContinuumRecallSection): void => {
    if (used + section.text.length > RECALL_RESULT_BUDGET) { truncated = true; return }
    sections.push(section)
    used += section.text.length
  }
  const evidence = applyEvidenceFilter(deps)

  if (input.depth === 'recent') {
    for (const summary of (deps.summaries?.() ?? []).slice(-RECENT_SUMMARIES).reverse()) {
      // Evidence without a digest cannot be verified; keep it out of refs.
      const verified = summary.evidence.flatMap(item => item.conversationId && item.messageId && item.digest
        ? [{ ref: { conversationId: item.conversationId, messageId: item.messageId, offset: item.offset ?? 0, digest: item.digest } as ContinuumReference, next: { conversationId: item.conversationId, messageId: item.messageId, offset: item.offset ?? 0 } }]
        : [])
      push({ kind: 'summary', title: summary.title, text: summary.text.length > RECENT_SUMMARY_CHARS ? `${summary.text.slice(0, RECENT_SUMMARY_CHARS)}…` : summary.text,
        refs: verified.map(item => item.ref),
        nextReads: verified.map(item => item.next) })
    }
    for (const date of [isoDate(now), isoDate(now - 86_400_000)]) {
      const rollup = deps.store.readDaily(date)
      if (rollup) {
        // Text and refs must come from the same validated view.
        const validated = evidence.rollup(rollup)
        push({ kind: 'rollup', title: `Daily rollup ${date}`, text: renderRollup(validated, ROLLUP_SECTION_CHARS), refs: collectRollupRefs(validated) })
      }
    }
    if (!sections.length) push({ kind: 'hint', title: 'No recent memory', text: 'No continuity summaries or daily rollups exist yet; keep conversing and let memory maintenance run.', refs: [] })
    return { depth: input.depth, sections, truncated }
  }

  if (input.depth === 'topic') {
    const query = input.query ?? input.entity ?? ''
    for (const dossier of deps.store.searchEntities(query, 3)) {
      const events = evidence.events(dossier.timeline)
      const needle = query.trim().normalize('NFKC').toLowerCase()
      const matched = events.filter(event => !needle || event.text.normalize('NFKC').toLowerCase().includes(needle)).slice(-ENTITY_EVENTS_SHOWN)
      const shown = matched.length ? matched : events.slice(-ENTITY_EVENTS_SHOWN)
      const text = [dossier.summary, '', ...shown.map(event => `[${event.date}] ${event.text}`)].join('\n')
      push({ kind: 'entity', title: `${dossier.name} (${dossier.kind})`, text, refs: shown.flatMap(event => event.refs).slice(0, 8), nextReads: nextReadsFrom(shown.flatMap(event => event.refs)) })
    }
    for (const match of searchDailySections(deps, evidence, query, 2)) {
      push({ kind: 'rollup', title: `Daily rollup ${match.rollup.date}`, text: match.text, refs: collectRollupRefs(match.rollup) })
    }
    for (const memory of deps.memories?.(query, 6) ?? []) push({ kind: 'memory', title: `Memory · ${memory.kind}`, text: memory.text, refs: [] })
    if (!sections.length) push({ kind: 'hint', title: 'No topic match', text: `Nothing matched "${query}" in entity dossiers, daily rollups or memories. Try recall depth "deep" or search_history.`, refs: [] })
    return { depth: input.depth, sections, truncated }
  }

  // deep
  if (input.date) {
    const rollup = deps.store.readDaily(input.date)
    if (rollup) {
      push({ kind: 'rollup', title: `Daily rollup ${input.date}`, text: renderRollup(evidence.rollup(rollup), DEEP_ROLLUP_CHARS), refs: collectRollupRefs(rollup, 40), nextReads: nextReadsFrom(collectRollupRefs(rollup, 40)) })
    } else {
      push({ kind: 'hint', title: 'No rollup for date', text: `No daily rollup exists for ${input.date}.`, refs: [] })
    }
  }
  const query = (input.query ?? '').trim()
  if (query) {
    for (const match of searchDailySections(deps, evidence, query, input.date ? 2 : 5)) {
      push({ kind: 'rollup', title: `Daily rollup ${match.rollup.date}`, text: match.text, refs: collectRollupRefs(match.rollup), nextReads: nextReadsFrom(collectRollupRefs(match.rollup)) })
    }
    for (const dossier of deps.store.searchEntities(query, 2)) {
      const events = evidence.events(dossier.timeline)
      const text = [dossier.summary, '', ...events.slice(-ENTITY_EVENTS_SHOWN).map(event => `[${event.date}] ${event.text}`)].join('\n')
      push({ kind: 'entity', title: `${dossier.name} (${dossier.kind})`, text, refs: events.slice(-ENTITY_EVENTS_SHOWN).flatMap(event => event.refs).slice(0, 8) })
    }
    const limit = Math.min(Math.max(1, input.limit ?? 10), 50)
    for (const hit of deps.searchMessages?.(query, limit) ?? []) push(messageSection(hit))
    if (!sections.length) push({ kind: 'hint', title: 'No deep match', text: `Nothing matched "${query}" across rollups, entities or message history. Try search_history with alternate wording.`, refs: [] })
  }
  return { depth: input.depth, sections, truncated }
}

function searchDailySections(deps: ContinuumRecallDeps, evidence: ReturnType<typeof applyEvidenceFilter>, query: string, limit: number): Array<{ rollup: ContinuumDailyRollup; text: string }> {
  const needle = query.trim().normalize('NFKC').toLowerCase()
  if (!needle) return []
  const dates = deps.store.listDailyDates().slice(-SEARCH_DAILY_LIMIT_DAYS)
  const results: Array<{ rollup: ContinuumDailyRollup; text: string; score: number }> = []
  for (let index = dates.length - 1; index >= 0 && results.length < limit; index -= 1) {
    const rollup = evidence.rollup(deps.store.readDaily(dates[index]) ?? { date: dates[index], generatedAt: 0, workspaces: [], entries: [], corrections: [] })
    const matched = rollup.entries
      .map(entry => ({ entry, hit: `${entry.title} ${entry.summary} ${entry.keyDetails.map(detail => detail.text).join(' ')}`.normalize('NFKC').toLowerCase().includes(needle) }))
      .filter(item => item.hit)
    if (!matched.length) continue
    const lines = [`# ${rollup.date}`]
    for (const item of matched) {
      lines.push(`## ${item.entry.title}`)
      if (item.entry.summary) lines.push(item.entry.summary)
      for (const detail of item.entry.keyDetails) lines.push(`- ${detail.text}`)
      lines.push('')
    }
    results.push({ rollup, text: lines.join('\n'), score: matched.length })
  }
  return results.sort((a, b) => b.score - a.score).map(({ rollup, text }) => ({ rollup, text: text.slice(0, ROLLUP_SECTION_CHARS) }))
}
