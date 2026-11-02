import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { GuideDefinition, GuideConditionResult, GuideStep } from './model.ts'
import { guideFailure } from './errors.ts'
import { guideAttemptSchema, type GuideAttempt } from './attempt.ts'


export const guideDigest = (guide: GuideDefinition): string => createHash('sha256').update(JSON.stringify(guide)).digest('hex')

export interface GuideFile {
  readonly read: () => Promise<GuideAttempt | null>
  readonly change: <T>(apply: (current: GuideAttempt | null) => { next: GuideAttempt; result: T }) => Promise<T>
}

export const readGuideAttempt = async (path: string): Promise<GuideAttempt | null> => {
  let text: string
  try { text = await readFile(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null // No attempt has been created at this identity.
    throw error
  }
  try { return guideAttemptSchema.parse(JSON.parse(text)) }
  catch (error) { throw guideFailure('guide_state_unreadable', `Guide progress is unreadable: ${error instanceof Error ? error.message : String(error)}`, 500) }
}

const eligible = (step: GuideStep, roleIds: readonly string[]): boolean => step.roles === undefined || step.roles.some(role => roleIds.includes(role))

export const createGuideAttempt = (guide: GuideDefinition, roleIds: readonly string[], at: string): GuideAttempt => {
  const step = guide.steps.find(step => eligible(step, roleIds))
  if (!step) throw guideFailure('guide_not_available', 'This guide has no step for the current perspective', 403)
  return guideAttemptSchema.parse({
    id: crypto.randomUUID(), guideId: guide.id, guideDigest: guideDigest(guide), revision: 0,
    createdAt: at, updatedAt: at, status: 'active', roleIds: [...roleIds], stepId: step.id,
    stepAttemptId: crypto.randomUUID(), completed: [], receipts: [],
  })
}

export const currentGuideStep = (guide: GuideDefinition, attempt: GuideAttempt, roleIds: readonly string[]): GuideStep => {
  if (attempt.guideDigest !== guideDigest(guide)) throw guideFailure('guide_revision_mismatch', 'This attempt belongs to another pinned guide')
  if (JSON.stringify([...attempt.roleIds].sort()) !== JSON.stringify([...roleIds].sort())) {
    throw guideFailure('guide_perspective_changed', 'The guide belongs to a different role set; start a fresh compatible attempt', 403)
  }
  const step = guide.steps.find(step => step.id === attempt.stepId)
  if (!step || !eligible(step, roleIds)) throw guideFailure('guide_step_unavailable', 'The current guide step is not available in this perspective', 403)
  return step
}

export const advanceGuideAttempt = (input: {
  guide: GuideDefinition; attempt: GuideAttempt; expectedRevision: number; roleIds: readonly string[];
  action: 'next' | 'skip' | 'pause' | 'resume' | 'stop'; at: string; evidence?: GuideConditionResult;
}): GuideAttempt => {
  const { guide, attempt, action } = input
  if (attempt.revision !== input.expectedRevision) throw guideFailure('guide_progress_conflict', 'Guide progress changed; read its current step before trying again')
  const step = currentGuideStep(guide, attempt, input.roleIds)
  if (attempt.status === 'stopped' || attempt.status === 'completed') throw guideFailure('guide_finished', 'This guide attempt has ended; start a fresh eligible attempt')
  const base = { ...attempt, revision: attempt.revision + 1, updatedAt: input.at }
  if (action === 'pause' || action === 'resume' || action === 'stop') {
    return { ...base, status: action === 'pause' ? 'paused' : action === 'stop' ? 'stopped' : 'active' }
  }
  if (attempt.status === 'paused') throw guideFailure('guide_paused', 'Resume the guide before advancing it')
  let outcome: GuideAttempt['completed'][number]['outcome'] = 'skipped'
  if (action === 'next') {
    if (step.completion.kind === 'condition' && input.evidence?.status !== 'satisfied') throw guideFailure('guide_condition_unmet', input.evidence?.reason ?? 'Current World evidence does not establish this step')
    const completion = step.completion
    if (completion.kind === 'presentation' && !attempt.receipts.some(entry => entry.effectId === completion.effectId && entry.receipt.status === 'applied')) {
      throw guideFailure('guide_presentation_pending', 'The requested presentation has not been applied; show it, retry it or explicitly skip this step')
    }
    outcome = step.completion.kind === 'condition' ? 'satisfied' : step.completion.kind === 'presentation' ? 'presented' : 'acknowledged'
  }
  const index = guide.steps.findIndex(candidate => candidate.id === step.id)
  const nextIndex = step.next === undefined ? index + 1 : guide.steps.findIndex(candidate => candidate.id === step.next)
  const next = guide.steps.slice(nextIndex).find(candidate => eligible(candidate, input.roleIds))
  return guideAttemptSchema.parse({
    ...base, status: next === undefined ? 'completed' : 'active', stepId: next?.id ?? attempt.stepId,
    stepAttemptId: next === undefined ? attempt.stepAttemptId : crypto.randomUUID(), receipts: [],
    completed: [...attempt.completed, { stepId: step.id, outcome, at: input.at,
      ...(action === 'next' && step.completion.kind === 'condition' ? { evidence: input.evidence } : {}) }],
  })
}
