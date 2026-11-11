import { createHash } from 'node:crypto'
import {
  planningFactsInputSchema, planningFactsOutputSchema, planningProjectionOutputSchema,
  type PlanningFactsInput, type PlanningFactsOutput, type PlanningProjectionInput, type PlanningSubject, type WorkspaceResourceReference,
} from '@leitbild/contracts'
import { rawObjectReadPolicy } from '../packs/inspection.ts'
import { createQueryReadPolicy, unavailableQueryReadScope } from '../../simulation/query-read-policy.ts'
import type { PackRuntimeQuery } from '../../simulation/protocol.ts'
import type { WorldPack } from '../packs/protocol.ts'
import type { RunRoles } from '../model/roles.ts'
import type { SimulationRunStateSnapshot } from './state-store.ts'

/** Every answer page, as JSON, stays within this many bytes. */
export const planningFactsPageBytes = 4_096
const defaultSearchLimit = 10
const searchFactsPerItem = 2
// <next fact>.<next item's locator>.<fact ids served from that item, with the next one>.<question>, the last three as digests.
const cursorPattern = /^(\d{1,3})\.([0-9a-f]{16})\.([0-9a-f]{16})\.([0-9a-f]{16})$/
// The longest cursor this port writes; every page is measured as if it carried one.
const longestCursor = `999.${'f'.repeat(16)}.${'f'.repeat(16)}.${'f'.repeat(16)}`

export type PlanningFactsRefusal = Error & {
  readonly name: 'PlanningFactsRefusal'
  readonly status: 400 | 404 | 409 | 500
  readonly code: string
  readonly details?: Readonly<Record<string, unknown>>
}
const refusal = (status: PlanningFactsRefusal['status'], code: string, message: string, details?: Readonly<Record<string, unknown>>): PlanningFactsRefusal =>
  Object.assign(new Error(message), { name: 'PlanningFactsRefusal' as const, status, code, ...(details === undefined ? {} : { details }) })
export const isPlanningFactsRefusal = (error: unknown): error is PlanningFactsRefusal => error instanceof Error && error.name === 'PlanningFactsRefusal'

const projectionId = (packId: string) => `world.${packId}.planning-basis`
const packOf = (locator: string) => locator.slice(0, locator.indexOf('/'))
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16)
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
/** The ids of an item's facts already served, and of the next one; nothing is served from an item started afresh. */
const servedDigest = (subject: PlanningSubject, next: number) => digest(JSON.stringify(next === 0 ? [] : subject.facts.slice(0, next + 1).map(fact => fact.id)))
const unknownSubjects = (locators: ReadonlyArray<string>) =>
  refusal(404, 'unknown_subject', `No item in this Run has the locator ${locators.join(', ')}`, { subjects: locators })
const invalidAnswer = (packId: string, reason: string) =>
  refusal(500, 'invalid_pack_answer', `The ${packId} Pack answered planning facts outside the contract: ${reason}`, { packId })

/** Search answers show the first observed state values only; exact subjects carry every fact. */
const searchItem = (subject: PlanningSubject): PlanningSubject => ({
  ...subject, facts: subject.facts.filter(fact => fact.basis === 'observed' && fact.quantity === 'state').slice(0, searchFactsPerItem),
})

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 0)
/**
 * Search order: every asked word must begin a word of the name ("feed" finds "Feedwater"); names holding more of
 * the asked words exactly come first, then by locator. Null when the subject does not match.
 */
const relevance = (subject: PlanningSubject, input: PlanningFactsInput): number | null => {
  if (input.kind !== undefined && subject.kind !== input.kind) return null
  const asked = words(input.text ?? ''), name = words(subject.label)
  if (!asked.every(word => name.some(part => part.startsWith(word)))) return null
  return asked.filter(word => name.includes(word)).length
}

/**
 * One page of `items` from the cursor's item, closed before it passes the byte budget or `limit` items. An item
 * larger than a page continues on the next page under the same locator, from its next fact.
 */
const page = (frame: Pick<PlanningFactsOutput, 'run' | 'observedAt'>, items: ReadonlyArray<PlanningSubject>, query: string, cursor: string | undefined, limit: number | undefined) => {
  let start = { item: 0, fact: 0 }
  if (cursor !== undefined) {
    const parsed = cursorPattern.exec(cursor)
    if (parsed === null || parsed[4] !== query) throw refusal(400, 'invalid_cursor', 'This cursor belongs to another question; ask again without it')
    const item = items.findIndex(subject => digest(subject.locator) === parsed[2])
    const fact = Number(parsed[1])
    // A fact added or removed in the served part of a continued item would leave a gap or a repeat: refuse it.
    if (item < 0 || fact >= Math.max(1, items[item]!.facts.length) || servedDigest(items[item]!, fact) !== parsed[3]) {
      throw refusal(400, 'invalid_cursor', 'The items this cursor continues have changed; ask again without it')
    }
    start = { item, fact }
  }
  const fits = (candidate: ReadonlyArray<PlanningSubject>) => bytes({ ...frame, items: candidate, more: longestCursor }) <= planningFactsPageBytes
  const out: PlanningSubject[] = []
  let next = start
  while (next.item < items.length && (limit === undefined || out.length < limit)) {
    const subject = items[next.item]!
    const rest = { ...subject, facts: subject.facts.slice(next.fact) }
    if (fits([...out, rest])) {
      out.push(rest)
      next = { item: next.item + 1, fact: 0 }
      continue
    }
    if (out.length > 0) break
    let count = 0
    while (count < rest.facts.length && fits([{ ...rest, facts: rest.facts.slice(0, count + 1) }])) count++
    // The contract bounds one fact and one subject frame well inside a page.
    if (count === 0) throw new Error(`A planning fact of ${subject.locator} exceeds one answer page`)
    out.push({ ...rest, facts: rest.facts.slice(0, count) })
    next = { item: next.item, fact: next.fact + count }
    break
  }
  const following = items[next.item]
  return { items: out, ...(following === undefined ? {} : { more: `${next.fact}.${digest(following.locator)}.${servedDigest(following, next.fact)}.${query}` }) }
}

/**
 * World's Run-scoped planning facts query. It fans out to each Pack's active planning projection, validates every
 * answer, and pages the merged answer. It never pauses the Run, refuses a moving one, or writes to its journal:
 * each fact keeps its own simulation `at`.
 */
export const createPlanningFactsPort = (ports: {
  readonly snapshot: () => SimulationRunStateSnapshot
  readonly roles: () => RunRoles | null
  readonly packs: () => ReadonlyArray<WorldPack>
  readonly invoke: (query: PackRuntimeQuery) => Promise<unknown>
  readonly active: (id: string) => boolean
}) => {
  const owners = () => ports.packs().map(pack => String(pack.descriptor.id)).filter(packId => ports.active(projectionId(packId))).sort()
  const project = async (requests: ReadonlyArray<readonly [string, PlanningProjectionInput]>) => {
    const snapshot = ports.snapshot()
    const restrictions = snapshot.scenario?.agentRestrictions
    const restricted = requests.map(([packId]) => packId).filter(packId => restrictions?.operationIds.some(id => id.startsWith(`world.${packId}.`)))
    if (restricted.length > 0) unavailableQueryReadScope(`Planning facts are unavailable while ${restricted.join(', ')} operations are restricted in this Run`)
    const denied = restrictions?.objects.filter(entry => entry.deny.includes('inspect')).map(entry => String(entry.objectId)) ?? []
    const revision = restrictions?.revision ?? 0
    const readPolicy = rawObjectReadPolicy(createQueryReadPolicy(`planning:${revision}`, denied), snapshot.objects, ports.packs())
    const subjects: PlanningSubject[] = []
    for (const [packId, input] of requests) {
      const answer = planningProjectionOutputSchema.safeParse(await ports.invoke({ capabilityId: projectionId(packId), input, readPolicy }))
      if (!answer.success) throw invalidAnswer(packId, answer.error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || 'answer'}: ${issue.message}`).join('; '))
      const seen = new Set<string>()
      for (const subject of answer.data.subjects) {
        if (packOf(subject.locator) !== packId) throw invalidAnswer(packId, `it answered ${subject.locator}, which another Pack owns`)
        if (input.subjects !== undefined && !input.subjects.includes(subject.locator)) throw invalidAnswer(packId, `it answered ${subject.locator}, which was not asked for`)
        if (seen.has(subject.locator)) throw invalidAnswer(packId, `it answered ${subject.locator} twice`)
        seen.add(subject.locator)
      }
      subjects.push(...answer.data.subjects)
    }
    // Run motion is read as it comes; a permission change during the read is not.
    if ((ports.snapshot().scenario?.agentRestrictions.revision ?? 0) !== revision) {
      throw refusal(409, 'query_policy_superseded', 'Restrictions on this Run changed while its planning facts were read; ask again')
    }
    return subjects
  }
  return {
    read: async (source: WorkspaceResourceReference, raw: unknown): Promise<PlanningFactsOutput> => {
      const input = planningFactsInputSchema.parse(raw)
      if (ports.roles() !== null) unavailableQueryReadScope('Planning facts are read only from Runs without roles')
      const frame = {
        run: { workspaceId: String(source.workspaceId), moduleId: 'world' as const, type: 'world.simulation-run' as const, id: String(source.id) },
        observedAt: new Date().toISOString(),
      }
      const query = digest(JSON.stringify([input.subjects ?? null, input.text ?? null, input.kind ?? null, input.limit ?? null]))
      if (input.subjects === undefined) {
        const subjects = await project(owners().map(packId => [packId, { detail: 'index' }] as const))
        const items = subjects.flatMap(subject => { const score = relevance(subject, input); return score === null ? [] : [{ subject, score }] })
          .sort((a, b) => b.score - a.score || a.subject.locator.localeCompare(b.subject.locator)).map(({ subject }) => searchItem(subject))
        return planningFactsOutputSchema.parse({ ...frame, ...page(frame, items, query, input.cursor, input.limit ?? defaultSearchLimit) })
      }
      const repeated = input.subjects.filter((locator, index) => input.subjects!.indexOf(locator) !== index)
      if (repeated.length > 0) throw refusal(400, 'invalid_request', `Name each subject once: ${[...new Set(repeated)].join(', ')}`)
      const active = new Set(owners())
      const byPack = new Map<string, string[]>()
      for (const locator of input.subjects) if (active.has(packOf(locator))) byPack.set(packOf(locator), [...byPack.get(packOf(locator)) ?? [], locator])
      // Each Pack gets all of its locators in one request: some facts (Einsatz arrivals) exist only for subjects read together.
      const subjects = await project([...byPack].sort(([a], [b]) => a.localeCompare(b)).map(([packId, locators]) => [packId, { subjects: locators, detail: 'facts' }] as const))
      const found = new Map(subjects.map(subject => [subject.locator, subject]))
      const missing = input.subjects.filter(locator => !found.has(locator))
      if (missing.length > 0) throw unknownSubjects(missing)
      return planningFactsOutputSchema.parse({ ...frame, ...page(frame, input.subjects.map(locator => found.get(locator)!), query, input.cursor, undefined) })
    },
  }
}
export type PlanningFactsPort = ReturnType<typeof createPlanningFactsPort>
