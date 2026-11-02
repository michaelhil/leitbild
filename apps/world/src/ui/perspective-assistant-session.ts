import { z } from 'zod'
import {
  perspectiveAssistantAvailabilityMessageSchema, perspectiveAssistantRequestMessageSchema,
  perspectiveAssistantResultMessageSchema, perspectiveAssistantOfferMessageSchema,
  worldPerspectiveReferenceSchema,
  type PerspectiveAdmission, type WorldPerspectiveReference, type PresentationRequest,
} from '@leitbild/contracts'
import type { PresentationApplication } from './guidance-session.ts'
import type { PerspectiveOwnerClient } from './perspective-client.ts'
import { createPerspectivePresentationSession, type PerspectiveAttentionScreen, type PerspectivePresentationSession } from './perspective-presentation-session.ts'

const referenceSchema = z.object({ prepareRequestId: z.string().uuid(), resource: worldPerspectiveReferenceSchema.optional() }).strict()
type ResumeReference = z.infer<typeof referenceSchema>
const sameResource = (left: WorldPerspectiveReference, right: WorldPerspectiveReference): boolean => left.workspaceId === right.workspaceId && left.moduleId === right.moduleId && left.type === right.type && left.id === right.id
const sameAdmission = (left: PerspectiveAdmission, right: PerspectiveAdmission): boolean => sameResource(left.resource, right.resource) && left.admissionGeneration === right.admissionGeneration && left.runIncarnation === right.runIncarnation && left.roleSetDigest === right.roleSetDigest

export interface PerspectiveAssistantScreen {
  available: boolean
  phase: 'idle' | 'preparing' | 'pending' | 'connecting' | 'connected' | 'disconnected' | 'revoked'
  requestId: string | null
  admission: PerspectiveAdmission | null
  attention: PerspectiveAttentionScreen
  problem: string | null
}

const noAttention = (): PerspectiveAttentionScreen => ({ recipient: null, suggestion: null, cue: null, error: null })

/** This controller retains opaque references only. World owns the admission; Host/Agents own Room setup. */
export const createPerspectiveAssistantSession = (config: {
  key: string
  roleLabels: ReadonlyArray<string>
  owner: PerspectiveOwnerClient
  host: { origin: string; parent: unknown }
  post: (message: unknown) => void
  changed: (screen: PerspectiveAssistantScreen) => void
  apply: (request: PresentationRequest, signal: AbortSignal, cameraAllowed: boolean) => Promise<PresentationApplication>
  clear: (request: PresentationRequest) => void
  cleanupProblem: () => void
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  initialAvailability?: z.infer<typeof perspectiveAssistantAvailabilityMessageSchema> | null
}) => {
  let closed = false, roleEnded = false, generation = 0, restoring = false
  let worldDocumentId = config.initialAvailability?.worldDocumentId ?? null, documentReplaced = false
  let reference: ResumeReference | null = null
  let receiver: PerspectivePresentationSession | null = null
  const endedGenerations = new Set<number>()
  let screen: PerspectiveAssistantScreen = { available: Boolean(worldDocumentId && config.initialAvailability?.available), phase: 'idle', requestId: null, admission: null, attention: noAttention(), problem: null }
  const update = (patch: Partial<PerspectiveAssistantScreen>): void => { if (!closed) { screen = { ...screen, ...patch }; config.changed(screen) } }
  const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
  try { const stored = config.storage.getItem(config.key); if (stored) reference = referenceSchema.parse(JSON.parse(stored)) }
  catch { screen.problem = 'The saved Assistant reference could not be read. Start a new scope explicitly or inspect this browser’s storage.' }
  const save = (): void => {
    if (closed || roleEnded) return
    try { if (reference) config.storage.setItem(config.key, JSON.stringify(reference)); else config.storage.removeItem(config.key) }
    catch { update({ problem: 'This browser could not retain the Assistant reference. The admitted World scope remains real.' }) }
  }
  const offer = (): void => {
    if (closed || documentReplaced || !worldDocumentId || !screen.requestId) return
    config.post(perspectiveAssistantOfferMessageSchema.parse({ type: 'leitbild:perspective-assistant-offer', worldDocumentId, requestId: screen.requestId, admission: screen.admission, recipient: screen.attention.recipient, roleLabels: screen.admission ? [...config.roleLabels] : [] }))
  }
  const detach = (): void => { receiver?.stop(); receiver = null; update({ attention: noAttention() }) }
  const revokeAccepted = async (admission: PerspectiveAdmission, reason: string): Promise<PerspectiveAdmission> => {
    if (admission.status === 'revoked') return admission
    let revoked: PerspectiveAdmission
    try { revoked = await config.owner.revoke(admission.resource, admission.revision, reason) }
    catch (error) {
      if ((error as { code?: string }).code !== 'perspective_revision_conflict') throw error
      const current = await config.owner.read(admission.resource)
      if (!sameAdmission(current, admission)) throw new Error('The previous Perspective admission changed identity')
      revoked = current.status === 'revoked' ? current : await config.owner.revoke(current.resource, current.revision, reason)
    }
    if (!sameAdmission(revoked, admission) || revoked.status !== 'revoked') throw new Error('The owner did not confirm ending this exact Perspective admission')
    return revoked
  }
  const retireLate = async (admission: PerspectiveAdmission, token?: number): Promise<void> => {
    if (!roleEnded && (token === undefined || !endedGenerations.has(token))) return
    try { await revokeAccepted(admission, 'The World screen changed exercise roles during setup') }
    catch { config.cleanupProblem() }
  }
  const retain = (admission: PerspectiveAdmission): void => {
    if (closed || roleEnded || !reference) return
    reference = { ...reference, resource: admission.resource }; save()
  }
  const validate = async (): Promise<boolean> => {
    const prior = screen.admission
    if (closed || roleEnded || !prior || prior.status !== 'active') return false
    const current = await config.owner.read(prior.resource)
    if (closed || !screen.admission || !sameAdmission(screen.admission, prior)) return false
    if (!sameAdmission(current, prior)) throw new Error('The Perspective admission changed identity')
    if (current.status !== 'active') {
      detach(); update({ admission: current, phase: current.status === 'revoked' ? 'revoked' : 'pending' }); offer(); return false
    }
    if (current.runtimeAvailability?.status === 'unavailable') {
      detach(); update({ admission: current, phase: 'disconnected', problem: current.runtimeAvailability.reason ?? 'The exact Assistant runtime is unavailable. End this scope before starting a fresh one.' }); offer(); return false
    }
    if (current.binding?.room.id !== prior.binding?.room.id || current.binding?.actualAgentId !== prior.binding?.actualAgentId || current.binding?.runtimeGeneration !== prior.binding?.runtimeGeneration) throw new Error('The Perspective runtime relationship changed')
    update({ admission: current }); return true
  }
  const connect = async (admission: PerspectiveAdmission, token: number): Promise<void> => {
    if (closed || token !== generation) return
    if (admission.runtimeAvailability?.status === 'unavailable') {
      detach(); update({ admission, phase: 'disconnected', problem: admission.runtimeAvailability.reason ?? 'The exact Assistant runtime is unavailable. End this scope before starting a fresh one.' }); offer(); return
    }
    detach(); update({ admission, phase: 'connecting', problem: null })
    receiver = createPerspectivePresentationSession({
      resource: admission.resource, owner: config.owner, validate, apply: config.apply, clear: config.clear,
      changed: attention => {
        if (closed || token !== generation || !screen.admission || !sameAdmission(screen.admission, admission)) return
        update({ attention, phase: attention.recipient ? 'connected' : 'disconnected', problem: attention.error })
        offer()
      },
    })
  }
  const restore = async (): Promise<void> => {
    if (closed || documentReplaced || roleEnded || restoring || !reference?.resource || !screen.available) return
    restoring = true
    const token = generation, resource = reference.resource
    update({ phase: 'connecting', requestId: reference.prepareRequestId })
    try {
      const admission = await config.owner.read(resource)
      if (closed || token !== generation || !screen.available) { await retireLate(admission, token); return }
      if (!sameResource(admission.resource, resource)) throw new Error('The owner returned another Perspective')
      update({ admission, phase: admission.status === 'active' ? 'connecting' : admission.status === 'revoked' ? 'revoked' : 'pending' })
      if (admission.status === 'active') await connect(admission, token)
    } catch (error) { if (token === generation) update({ phase: 'disconnected', problem: errorText(error) }) }
    finally { restoring = false }
  }
  const ask = async (requestId: string = crypto.randomUUID()): Promise<void> => {
    if (closed || documentReplaced || !worldDocumentId || roleEnded || !screen.available || screen.phase === 'preparing') return
    if (screen.admission?.status === 'active' && screen.attention.recipient) {
      try { if (await validate()) offer() }
      catch (error) { detach(); update({ phase: 'disconnected', problem: errorText(error) }); offer() }
      return
    }
    const token = ++generation
    const causalRequestId = screen.admission?.status === 'revoked' ? requestId : reference?.prepareRequestId ?? requestId
    detach(); update({ requestId: causalRequestId, phase: 'preparing', problem: null })
    try {
      let admission: PerspectiveAdmission
      if (screen.admission && screen.admission.status !== 'revoked') admission = await config.owner.read(screen.admission.resource)
      else if (reference?.resource && screen.admission?.status !== 'revoked') admission = await config.owner.read(reference.resource)
      else {
        if (!reference || screen.admission?.status === 'revoked') reference = { prepareRequestId: causalRequestId }
        save()
        admission = await config.owner.prepare(reference.prepareRequestId)
      }
      if (closed || token !== generation || !screen.available) { await retireLate(admission, token); endedGenerations.delete(token); return }
      retain(admission)
      update({ admission, phase: admission.status === 'revoked' ? 'revoked' : admission.status === 'active' ? 'connecting' : 'pending' })
      if (admission.status === 'active') await connect(admission, token)
      else offer()
    } catch (error) { if (token === generation) update({ phase: 'disconnected', problem: errorText(error) }) }
  }
  const completed = async (data: z.infer<typeof perspectiveAssistantResultMessageSchema>): Promise<void> => {
    if (closed || roleEnded || data.requestId !== screen.requestId || !screen.admission) return
    if (data.problem) { update({ phase: screen.admission.status === 'pending' ? 'pending' : 'disconnected', problem: data.problem.message }); return }
    const returned = data.admission
    if (!returned || !sameAdmission(returned, screen.admission)) { update({ problem: 'The Assistant setup result does not match this World scope.' }); return }
    const token = generation
    try {
      const admission = await config.owner.read(returned.resource)
      if (closed || token !== generation || data.requestId !== screen.requestId) return
      if (!sameAdmission(admission, returned)) throw new Error('The World admission no longer matches this setup result')
      retain(admission)
      if (admission.status === 'active' && receiver && admission.runtimeAvailability?.status !== 'unavailable') { update({ admission, problem: null }); return }
      update({ admission, phase: admission.status === 'revoked' ? 'revoked' : admission.status === 'active' ? 'connecting' : 'pending', problem: null })
      if (admission.status === 'active') await connect(admission, token)
      else offer()
    } catch (error) { if (token === generation) update({ phase: 'disconnected', problem: errorText(error) }) }
  }
  config.changed(screen)
  if (screen.available) void restore()
  return {
    ask,
    read: restore,
    accept: async () => { await receiver?.accept() }, decline: async () => { await receiver?.decline() },
    clearCue: () => receiver?.clearCue(), clearVisualCue: () => receiver?.clearVisualCue(), manualCamera: () => receiver?.manualCamera(),
    reconnect: async () => { if (screen.admission?.status === 'active') { const token = ++generation; await connect(screen.admission, token) } else await restore() },
    end: async () => {
      const prior = screen.admission
      if (closed) return
      endedGenerations.add(generation)
      const token = ++generation
      detach(); update({ phase: 'disconnected', problem: null })
      if (screen.requestId && worldDocumentId) config.post(perspectiveAssistantOfferMessageSchema.parse({ type: 'leitbild:perspective-assistant-offer', worldDocumentId, requestId: screen.requestId, admission: null, recipient: null, roleLabels: [] }))
      if (!prior) {
        reference = null; save(); update({ admission: null, phase: 'idle', problem: 'Setup stopped. Any accepted pending admission will be closed without creating authority.' }); offer(); return
      }
      try {
        const admission = await revokeAccepted(prior, 'The person ended this Assistant scope')
        if (closed || token !== generation) return
        reference = null; save(); update({ admission, phase: 'revoked' }); offer()
      } catch (error) { if (token === generation) update({ problem: errorText(error) }) }
    },
    receive: (event: { origin: string; source: unknown; data: unknown }): void => {
      if (closed || roleEnded || event.origin !== config.host.origin || event.source !== config.host.parent) return
      const availability = perspectiveAssistantAvailabilityMessageSchema.safeParse(event.data)
      if (availability.success) {
        if (worldDocumentId !== null && availability.data.worldDocumentId !== worldDocumentId) {
          documentReplaced = true; generation++; detach(); update({ available: false, phase: 'disconnected', problem: 'This World document was replaced. Reopen its current view.' }); return
        }
        if (documentReplaced) return
        worldDocumentId = availability.data.worldDocumentId
        const changed = screen.available !== availability.data.available
        update({ available: availability.data.available })
        if (changed && screen.available) void restore()
        else if (changed) { generation++; detach(); update({ phase: screen.admission ? 'disconnected' : 'idle' }); offer() }
        return
      }
      const request = perspectiveAssistantRequestMessageSchema.safeParse(event.data)
      if (request.success) { if (request.data.worldDocumentId === worldDocumentId) void ask(request.data.requestId); return }
      const result = perspectiveAssistantResultMessageSchema.safeParse(event.data)
      if (result.success && result.data.worldDocumentId === worldDocumentId) void completed(result.data)
    },
    forgetForRoleChange: (): void => {
      roleEnded = true; generation++
      try { config.storage.removeItem(config.key) } catch { config.cleanupProblem() }
      const admission = screen.admission
      detach(); update({ admission: null, phase: 'idle' }); offer()
      if (admission) void retireLate(admission)
    },
    stop: (): void => {
      if (closed) return
      if (screen.requestId && worldDocumentId) config.post(perspectiveAssistantOfferMessageSchema.parse({ type: 'leitbild:perspective-assistant-offer', worldDocumentId, requestId: screen.requestId, admission: null, recipient: null, roleLabels: [] }))
      closed = true; generation++; receiver?.stop(); receiver = null
    },
  }
}
export type PerspectiveAssistantSession = ReturnType<typeof createPerspectiveAssistantSession>
