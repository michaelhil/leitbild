import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  presentationActionSchema, presentationRecipientSchema, presentationReceiptSchema, presentationTargetSchema,
  workspaceResourceReferenceSchema, type PresentationRecipient, type PresentationTarget,
  moduleIdSchema,
} from '@leitbild/contracts'
import type { SimulationRunRegistry } from '../simulation-runs/registry.ts'
import type { SimulationRunId } from '../model/ids.ts'
import { objectIdSchema } from '../model/ids.ts'
import type { Actor } from '../simulation-runs/actors.ts'
import { createGuideAttempt, currentGuideStep, advanceGuideAttempt } from './store.ts'
import { guideAttemptIdSchema, type GuideAttempt } from './attempt.ts'
import { guideFailure } from './errors.ts'
import { evaluateGuideCondition } from './conditions.ts'
import type { GuideTarget, GuideStep } from './model.ts'
import { refObjectId } from '../model/alerts.ts'

const identity = z.string().min(1).max(256)
const worldModuleId = moduleIdSchema.parse('world')
const recipientInput = z.object({ recipient: presentationRecipientSchema }).strict()
export const presentationInputs = {
  register: z.object({ clientId: identity, documentId: identity }).strict(),
  poll: recipientInput,
  unregister: recipientInput,
  targets: z.object({ text: z.string().max(200).optional(), objectId: objectIdSchema.optional(), elements: z.boolean().default(false), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20) }).strict(),
  request: z.object({
    recipient: presentationRecipientSchema.optional(), requestId: identity, target: presentationTargetSchema,
    action: presentationActionSchema, purpose: z.string().min(1).max(500), executionId: identity.optional(),
  }).strict(),
  result: z.object({ recipient: presentationRecipientSchema, requestId: identity }).strict(),
  cancel: z.object({ recipient: presentationRecipientSchema, requestId: identity }).strict(),
  receipt: z.object({ recipient: presentationRecipientSchema, receipt: presentationReceiptSchema }).strict(),
}
export const guideInputs = {
  read: z.object({ attemptId: guideAttemptIdSchema.optional(), recipient: presentationRecipientSchema.optional() }).strict(),
  start: z.object({ recipient: presentationRecipientSchema }).strict(),
  show: z.object({ attemptId: guideAttemptIdSchema, recipient: presentationRecipientSchema, takeover: z.boolean().default(false) }).strict(),
  advance: z.object({ attemptId: guideAttemptIdSchema, recipient: presentationRecipientSchema, expectedRevision: z.number().int().nonnegative(), action: z.enum(['next', 'skip', 'pause', 'resume', 'stop']), takeover: z.boolean().default(false) }).strict(),
  receipt: z.object({ attemptId: guideAttemptIdSchema, stepAttemptId: z.string().uuid(), effectId: identity, recipient: presentationRecipientSchema, receipt: presentationReceiptSchema }).strict(),
}

export interface GuidanceCall { readonly registry: SimulationRunRegistry; readonly runId: SimulationRunId; readonly actor: Actor }
const subjectOf = (call: GuidanceCall) => workspaceResourceReferenceSchema.parse({ workspaceId: call.registry.workspaceId, moduleId: 'world', type: 'world.simulation-run', id: call.runId })
const sameSubject = (call: GuidanceCall, subject: PresentationRecipient['subject']): boolean => subject.workspaceId === call.registry.workspaceId && subject.moduleId === 'world' && subject.type === 'world.simulation-run' && String(subject.id) === String(call.runId)
const recipientOf = (call: GuidanceCall, recipient: PresentationRecipient): PresentationRecipient => {
  if (!sameSubject(call, recipient.subject)) throw guideFailure('presentation_scope_mismatch', 'The receiver belongs to another Resource', 403)
  return call.registry.presentation.current(recipient)
}
const ownReceiver = (call: GuidanceCall, recipient: PresentationRecipient): PresentationRecipient => {
  if (call.actor.role === 'ai_agent') throw guideFailure('presentation_receiver_for_people', 'An agent cannot register or impersonate a browser receiver', 403)
  const current = recipientOf(call, recipient)
  if (JSON.stringify([...call.registry.presentation.roleIds(current)].sort()) !== JSON.stringify([...(call.actor.roleIds ?? [])].sort())) {
    throw guideFailure('presentation_perspective_changed', 'The receiver belongs to another perspective; register this document again', 403)
  }
  return current
}

const supportedControls = ['view', 'guide', 'alarms', 'dashboard', 'assistant'] as const
const targetFor = (call: GuidanceCall, target: GuideTarget): PresentationTarget => ({
  subject: subjectOf(call), type: target.kind === 'composer' ? 'world.composer' : target.kind === 'panel' ? 'world.panel' : target.kind === 'control' ? 'world.control' : 'world.object',
  id: target.kind === 'object' ? target.objectId : target.kind === 'panel' ? target.panelId : target.kind === 'control' ? target.controlId : 'assistant',
  ...(target.kind === 'object' && target.elementId !== undefined ? { part: target.elementId } : {}),
})
const effectRequestId = (attempt: GuideAttempt, effectId: string, recipient: PresentationRecipient): string =>
  `guide:${attempt.id}:${attempt.stepAttemptId}:${createHash('sha256').update(JSON.stringify([effectId, recipient.leaseId])).digest('hex').slice(0, 32)}`

const targetAllowed = (call: GuidanceCall, recipient: PresentationRecipient, target: PresentationTarget): (() => boolean) => () => {
  const runtime = call.registry.get(call.runId)
  if (!runtime || !sameSubject(call, target.subject)) return false
  const issuer = runtime.inspectionPolicy(call.actor)
  const roles = call.registry.presentation.roleIds(recipient)
  const receiver = runtime.inspectionPolicy({ id: call.actor.id, label: 'Presentation recipient', role: 'operator', ...(roles.length === 0 ? {} : { roleIds: roles }) })
  if (target.type === 'world.object') return runtime.snapshot().objects.some(object => String(object.id) === target.id) && issuer.canInspect(target.id) && receiver.canInspect(target.id)
  if (target.type === 'world.panel') return runtime.packs().some(pack => pack.ui?.surfacePanels.some(panel => panel.id === target.id))
  if (target.type === 'world.composer') return target.id === 'assistant'
  return target.type === 'world.control' && (supportedControls as readonly string[]).includes(target.id)
}

/** Availability is cheap metadata; the receiver reports real panel/display/geometry availability when applying it. */
export const runPresentationOperation = async (kind: keyof typeof presentationInputs, raw: unknown, call: GuidanceCall): Promise<unknown> => {
  const delivery = call.registry.presentation
  const runtime = await call.registry.load(call.runId)
  // Applies the existing role/side and AI restriction boundary before any target metadata is returned.
  const policy = runtime.inspectionPolicy(call.actor)
  if (kind === 'register') {
    if (call.actor.role === 'ai_agent') throw guideFailure('presentation_receiver_for_people', 'Only a person opens a browser receiver', 403)
    return delivery.register({ subject: subjectOf(call), ...presentationInputs.register.parse(raw) }, call.actor.roleIds ?? [])
  }
  if (kind === 'targets') {
    const input = presentationInputs.targets.parse(raw)
    if (input.objectId !== undefined && !policy.canInspect(input.objectId)) throw guideFailure('presentation_target_unavailable', 'This target is not available to the caller', 403)
    if (input.elements && input.objectId === undefined) throw guideFailure('presentation_target_required', 'Element discovery requires one discovered exact object', 400)
    const targets: Array<{ target: PresentationTarget; label: string; actions: string[] }> = []
    for (const object of runtime.snapshot().objects) {
      if (!policy.canInspect(object.id) || input.objectId !== undefined && input.objectId !== object.id) continue
      targets.push({ target: { subject: subjectOf(call), type: 'world.object', id: object.id }, label: object.label, actions: ['focus', 'reveal', 'highlight'] })
    }
    if (input.elements && input.objectId !== undefined) {
      const declarations = await runtime.observations(call.actor).declarations([input.objectId])
      const declaration = declarations[0]
      if (declaration !== undefined && !('refused' in declaration)) for (const element of declaration.elements) {
        targets.push({ target: { subject: subjectOf(call), type: 'world.object', id: input.objectId, part: element.id }, label: element.label, actions: ['reveal', 'highlight'] })
      }
    }
    if (input.objectId === undefined) {
      for (const pack of runtime.packs()) for (const panel of pack.ui?.surfacePanels ?? []) targets.push({ target: { subject: subjectOf(call), type: 'world.panel', id: panel.id }, label: panel.label, actions: ['reveal', 'highlight'] })
      for (const id of supportedControls) targets.push({ target: { subject: subjectOf(call), type: 'world.control', id }, label: id, actions: ['reveal', 'highlight'] })
      targets.push({ target: { subject: subjectOf(call), type: 'world.composer', id: 'assistant' }, label: 'Assistant prompt suggestion', actions: ['draft'] })
    }
    const found = targets.filter(entry => input.text === undefined || `${entry.label} ${entry.target.id}`.toLowerCase().includes(input.text.toLowerCase()))
    if (runtime.inspectionPolicy(call.actor).key !== policy.key) throw guideFailure('presentation_discovery_superseded', 'The inspection picture changed; discover targets again')
    return { targets: found.slice(input.offset, input.offset + input.limit), ...(found.length > input.offset + input.limit ? { nextOffset: input.offset + input.limit } : {}) }
  }
  if (kind === 'request') {
    const input = presentationInputs.request.parse(raw)
    if (input.action.kind === 'clear') throw guideFailure('presentation_use_cancel', 'Cancel the original request to clear only its owned cues', 400)
    if (input.recipient === undefined) throw guideFailure('no_recipient', 'This turn has no current browser receiver; offer an attributed suggestion for a person to open')
    const recipient = recipientOf(call, input.recipient)
    const allowed = targetAllowed(call, recipient, input.target)
    if (!allowed()) throw guideFailure('presentation_target_unavailable', 'This target is not available to the caller', 403)
    if (input.target.part !== undefined) {
      const declarations = await runtime.observations(call.actor).declarations([objectIdSchema.parse(input.target.id)])
      const declaration = declarations[0]
      if (declaration === undefined || 'refused' in declaration || !declaration.elements.some(element => element.id === input.target.part)) throw guideFailure('presentation_target_unavailable', 'This target is not available to the caller', 403)
    }
    const request = delivery.request({ id: input.requestId, recipient,
      source: { moduleId: worldModuleId, kind: call.actor.role === 'ai_agent' ? 'agent' : 'person', id: call.actor.id, label: call.actor.displayName ?? call.actor.label, ...(input.executionId === undefined ? {} : { executionId: input.executionId }) },
      target: input.target, action: input.action, purpose: input.purpose, mode: 'suggest', allowed,
    })
    return { requestId: request.id, status: 'pending', expiresAt: request.expiresAt }
  }
  if (kind === 'poll') {
    const input = presentationInputs.poll.parse(raw), recipient = ownReceiver(call, input.recipient)
    const renewed = delivery.renew(recipient)
    return { recipient: renewed, requests: delivery.pending(renewed) }
  }
  if (kind === 'receipt') {
    const input = presentationInputs.receipt.parse(raw)
    return delivery.receipt(ownReceiver(call, input.recipient), input.receipt)
  }
  if (kind === 'unregister') {
    delivery.unregister(ownReceiver(call, presentationInputs.unregister.parse(raw).recipient))
    return { closed: true }
  }
  if (kind === 'cancel') {
    const input = presentationInputs.cancel.parse(raw)
    return delivery.cancel(recipientOf(call, input.recipient), input.requestId, call.actor.role === 'ai_agent' ? call.actor.id : undefined)
  }
  const input = presentationInputs.result.parse(raw)
  return delivery.result(recipientOf(call, input.recipient), input.requestId)
}

const requireGuide = async (call: GuidanceCall) => {
  const scenario = await call.registry.compiledScenarioForRun(call.runId)
  if (scenario.guide === undefined) throw guideFailure('guide_not_available', 'No guide is pinned in this Run', 404)
  return { guide: scenario.guide, startsAt: scenario.world.startsAt }
}

const guideView = async (call: GuidanceCall, attempt: GuideAttempt, recipient?: PresentationRecipient, present = false): Promise<unknown> => {
  const { guide, startsAt } = await requireGuide(call)
  const step = currentGuideStep(guide, attempt, call.actor.roleIds ?? [])
  const runtime = await call.registry.load(call.runId)
  const canInspect = (id: string) => runtime.inspectionPolicy(call.actor).canInspect(id)
  const references = step.effects.flatMap(effect => effect.target.kind === 'object' ? [effect.target.objectId] : [])
  if (step.completion.kind === 'condition' && step.completion.condition.kind !== 'clock') references.push(step.completion.condition.kind === 'object-status' ? step.completion.condition.objectId : refObjectId(step.completion.condition.ref))
  if (references.some(id => !canInspect(id))) throw guideFailure('guide_step_unavailable', 'This guide step is not available in the current inspection picture', 403)
  const condition = step.completion.kind !== 'condition' ? undefined : await evaluateGuideCondition({ condition: step.completion.condition, runtime, actor: call.actor, startsAt, canInspect: id => runtime.inspectionPolicy(call.actor).canInspect(id) })
  const effects: Array<GuideStep['effects'][number] & { requestId?: string; delivery?: string; reason?: string }> = []
  if (present && recipient !== undefined && attempt.status === 'active') {
    call.registry.presentation.assertGuide(attempt.id, ownReceiver(call, recipient))
    for (const effect of step.effects) {
      if (attempt.receipts.some(record => record.effectId === effect.id)) { effects.push(effect); continue }
      const target = targetFor(call, effect.target)
      const requestId = effectRequestId(attempt, effect.id, recipient)
      try {
        call.registry.presentation.request({
          id: requestId, recipient,
          source: { moduleId: worldModuleId, kind: 'guide', id: attempt.id, label: guide.title, executionId: attempt.stepAttemptId },
          target, action: effect.action, purpose: step.title, mode: 'guide', allowed: targetAllowed(call, recipient, target),
        })
        effects.push({ ...effect, requestId, delivery: 'pending' })
      } catch (error) {
        const code = (error as { code?: string }).code
        if (code !== 'presentation_target_unavailable' && code !== 'presentation_busy' && code !== 'no_recipient') throw error
        // Explicit partial delivery: the saved step remains usable and the person can retry/show or skip it.
        effects.push({ ...effect, requestId, delivery: 'unavailable', reason: (error as Error).message })
      }
    }
  } else for (const effect of step.effects) effects.push({ ...effect, ...(recipient === undefined ? {} : { requestId: effectRequestId(attempt, effect.id, ownReceiver(call, recipient)) }) })
  return {
    available: true, title: guide.title, attemptId: attempt.id, revision: attempt.revision, status: attempt.status,
    stepAttemptId: attempt.stepAttemptId,
    // No future instructions, trigger metadata, hidden step count, or another learner's progress.
    step: { id: step.id, title: step.title, instruction: step.instruction, ...(step.help === undefined ? {} : { help: step.help }), completion: step.completion.kind, effects },
    completed: attempt.completed.map(entry => entry.evidence?.ref !== undefined && !canInspect(refObjectId(entry.evidence.ref)) ? { stepId: entry.stepId, outcome: entry.outcome, at: entry.at } : entry),
    receipts: attempt.receipts, ...(condition === undefined ? {} : { condition }),
  }
}

export const runGuideOperation = async (kind: keyof typeof guideInputs, raw: unknown, call: GuidanceCall): Promise<unknown> => {
  const runtime = await call.registry.load(call.runId)
  runtime.inspectionPolicy(call.actor)
  const { guide, startsAt } = await requireGuide(call)
  if (kind === 'start') {
    const recipient = ownReceiver(call, guideInputs.start.parse(raw).recipient)
    if (guide.entry !== undefined) {
      const evidence = await evaluateGuideCondition({ condition: guide.entry, runtime, actor: call.actor, startsAt, canInspect: id => runtime.inspectionPolicy(call.actor).canInspect(id) })
      if (evidence.status !== 'satisfied') throw guideFailure('guide_entry_unmet', `${evidence.reason}; continue unguided or start a fresh Run`)
    }
    const attempt = createGuideAttempt(guide, call.actor.roleIds ?? [], new Date().toISOString())
    await call.registry.guideFile(call.runId, attempt.id).change(current => {
      if (current !== null) throw guideFailure('guide_identity_conflict', 'This guide attempt already exists')
      return { next: attempt, result: attempt }
    })
    call.registry.presentation.claimGuide(attempt.id, recipient, false)
    return guideView(call, attempt, recipient, true)
  }
  if (kind === 'read') {
    const input = guideInputs.read.parse(raw)
    if (input.attemptId === undefined) return { available: true, title: guide.title, ...(guide.description === undefined ? {} : { description: guide.description }) }
    const attempt = await call.registry.guideFile(call.runId, input.attemptId).read()
    if (attempt === null) throw guideFailure('guide_attempt_unavailable', 'This guide attempt is not available in this Run', 404)
    return guideView(call, attempt, input.recipient)
  }
  if (kind === 'show') {
    const input = guideInputs.show.parse(raw), recipient = ownReceiver(call, input.recipient)
    call.registry.presentation.claimGuide(input.attemptId, recipient, input.takeover)
    const attempt = await call.registry.guideFile(call.runId, input.attemptId).change(current => {
      if (current === null) throw guideFailure('guide_attempt_unavailable', 'This guide attempt is not available', 404)
      currentGuideStep(guide, current, call.actor.roleIds ?? [])
      if (current.status === 'stopped' || current.status === 'completed') throw guideFailure('guide_finished', 'Start a new eligible guide attempt')
      // Explicit Show is a new delivery attempt; it never replays a physical command or rewrites completed learning.
      const next = { ...current, revision: current.revision + 1, stepAttemptId: crypto.randomUUID(), receipts: [], updatedAt: new Date().toISOString(), status: 'active' as const }
      return { next, result: next }
    })
    return guideView(call, attempt, recipient, true)
  }
  if (kind === 'advance') {
    const input = guideInputs.advance.parse(raw), recipient = ownReceiver(call, input.recipient)
    if (input.action === 'resume') call.registry.presentation.claimGuide(input.attemptId, recipient, input.takeover)
    else call.registry.presentation.assertGuide(input.attemptId, recipient)
    const file = call.registry.guideFile(call.runId, input.attemptId), current = await file.read()
    if (current === null) throw guideFailure('guide_attempt_unavailable', 'This guide attempt is not available in this Run', 404)
    const step = currentGuideStep(guide, current, call.actor.roleIds ?? [])
    const evidence = input.action !== 'next' || step.completion.kind !== 'condition' ? undefined
      : await evaluateGuideCondition({ condition: step.completion.condition, runtime, actor: call.actor, startsAt, canInspect: id => runtime.inspectionPolicy(call.actor).canInspect(id) })
    const next = await file.change(attempt => {
      if (attempt === null) throw guideFailure('guide_attempt_unavailable', 'This guide attempt was removed', 404)
      const next = advanceGuideAttempt({ guide, attempt, expectedRevision: input.expectedRevision, roleIds: call.actor.roleIds ?? [], action: input.action, at: new Date().toISOString(), ...(evidence === undefined ? {} : { evidence }) })
      return { next, result: next }
    })
    if (input.action === 'pause' || input.action === 'stop') call.registry.presentation.cancelGuide(input.attemptId)
    return guideView(call, next, recipient, true)
  }
  const input = guideInputs.receipt.parse(raw), recipient = ownReceiver(call, input.recipient)
  call.registry.presentation.assertGuide(input.attemptId, recipient)
  const next = await call.registry.guideFile(call.runId, input.attemptId).change(attempt => {
    if (attempt === null || attempt.stepAttemptId !== input.stepAttemptId) throw guideFailure('guide_receipt_stale', 'This receipt belongs to an earlier guide step')
    const step = currentGuideStep(guide, attempt, call.actor.roleIds ?? [])
    if (!step.effects.some(effect => effect.id === input.effectId) || input.receipt.requestId !== effectRequestId(attempt, input.effectId, recipient)) throw guideFailure('guide_receipt_stale', 'The receipt does not match this step action')
    const receipt = call.registry.presentation.receipt(recipient, input.receipt)
    const recorded = attempt.receipts.find(entry => entry.effectId === input.effectId)
    const next = recorded === undefined ? { ...attempt, revision: attempt.revision + 1, updatedAt: new Date().toISOString(), receipts: [...attempt.receipts, { effectId: input.effectId, receipt }] } : attempt
    return { next, result: next }
  })
  return guideView(call, next, recipient)
}
