import { embeddedViewEnvelopeSchema, type EmbeddedViewEnvelope } from '@leitbild/contracts'
import { z } from 'zod'
import type { SimulationRunId } from '../../core/model/ids.ts'
import { layoutLiveExpectedSchema, layoutLiveResponseSchema, type LayoutLiveExpected } from './read-model.ts'
import type { LayoutLiveSnapshot } from './client.ts'

/** Map-hosted faceplate only; component detail remains the existing vignette. */
export const LAYOUT_INSPECTION_VIEW_TYPE = 'physical-layout.inspection'

/** Only actual reserved UI geometry constrains space, never camera-fit padding or current card size. */
export const layoutInspectionHostRoom = (size: { readonly width: number; readonly height: number }, padding: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }, clearTop: number) => {
  const x = Math.max(8, padding.left), y = Math.max(8, padding.top, clearTop + 8)
  return { x, y, width: Math.max(0, size.width - x - Math.max(8, padding.right)), height: Math.max(0, size.height - y - Math.max(8, padding.bottom)) }
}

/** The 44px status/close band precedes the shared card inside its iframe. */
export const layoutInspectionContentRoom = (width: number, availableHeight: number) => ({ x: 0, y: 44, width, height: Math.max(0, availableHeight - 44) })

export const layoutInspectionStateSchema = layoutLiveExpectedSchema.omit({ runId: true }).extend({
  elementId: z.string().min(1).max(200), label: z.string().min(1).max(300),
  delivery: z.enum(['direct', 'host']).optional(),
  channel: z.string().uuid().optional(),
}).strict().superRefine((state, context) => {
  if (state.delivery === 'host' && state.channel === undefined) context.addIssue({ code: 'custom', message: 'Hosted inspection requires its own channel' })
  if (state.delivery !== 'host' && state.channel !== undefined) context.addIssue({ code: 'custom', message: 'Only hosted inspection uses a channel' })
})
export type LayoutInspectionState = z.output<typeof layoutInspectionStateSchema>

export const layoutInspectionEnvelope = (config: {
  readonly workspaceId: string
  readonly runId: SimulationRunId
  readonly state: LayoutInspectionState
}): EmbeddedViewEnvelope => embeddedViewEnvelopeSchema.parse({
  moduleId: 'world', subject: { workspaceId: config.workspaceId, moduleId: 'world', type: 'world.simulation-run', id: config.runId },
  viewType: LAYOUT_INSPECTION_VIEW_TYPE, title: config.state.label, height: 400, state: JSON.stringify(layoutInspectionStateSchema.parse(config.state)),
})

export const layoutInspectionExpected = (envelope: EmbeddedViewEnvelope): { readonly state: LayoutInspectionState; readonly expected: LayoutLiveExpected } => {
  if (envelope.moduleId !== 'world' || envelope.viewType !== LAYOUT_INSPECTION_VIEW_TYPE || envelope.subject.type !== 'world.simulation-run') throw new Error('Layout inspection must name a World Simulation Run')
  const state = layoutInspectionStateSchema.parse(JSON.parse(envelope.state))
  return { state, expected: layoutLiveExpectedSchema.parse({ runId: envelope.subject.id, layoutObjectId: state.layoutObjectId, revision: state.revision, objectId: state.objectId, packId: state.packId, modelDigest: state.modelDigest }) }
}

/** Host validates origin, actual iframe source, and exact retained scope before applying this UI message. */
export const layoutInspectionMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('world:layout-inspection-close'), layoutObjectId: z.string().min(1).max(200), elementId: z.string().min(1).max(200), returnFocus: z.boolean() }).strict(),
  z.object({ type: z.literal('world:layout-inspection-size'), layoutObjectId: z.string().min(1).max(200), elementId: z.string().min(1).max(200), height: z.number().finite().int().nonnegative() }).strict(),
  z.object({ type: z.literal('world:layout-inspection-ready'), layoutObjectId: z.string().min(1).max(200), elementId: z.string().min(1).max(200), channel: z.string().uuid() }).strict(),
])

const hostedSpaceSchema = z.object({
  type: z.literal('world:layout-inspection-space'),
  channel: z.string().uuid(),
  layoutObjectId: z.string().min(1).max(200), elementId: z.string().min(1).max(200),
  availableHeight: z.number().finite().nonnegative(),
}).strict()

/** Available host space is independent of the card's current allocated height. */
export const layoutInspectionSpaceMessage = (state: LayoutInspectionState, availableHeight: number): z.output<typeof hostedSpaceSchema> => {
  if (state.delivery !== 'host' || state.channel === undefined) throw new Error('Inspection did not request hosted space')
  return hostedSpaceSchema.parse({ type: 'world:layout-inspection-space', channel: state.channel, layoutObjectId: state.layoutObjectId, elementId: state.elementId, availableHeight })
}

/** Call only after checking the actual parent Window and same origin. */
export const readHostedLayoutInspectionSpace = (state: LayoutInspectionState, input: unknown): number => {
  const message = hostedSpaceSchema.parse(input)
  if (state.delivery !== 'host' || message.channel !== state.channel || message.layoutObjectId !== state.layoutObjectId || message.elementId !== state.elementId) throw new Error('Inspection space belongs to a different host channel or target')
  return message.availableHeight
}

const hostedSampleSchema = z.object({
  type: z.literal('world:layout-inspection-sample'),
  channel: z.string().uuid(),
  layoutObjectId: z.string().min(1).max(200), elementId: z.string().min(1).max(200),
  snapshot: z.object({
    phase: z.enum(['connecting', 'live', 'inactive', 'missing', 'failed', 'suspended']),
    latest: layoutLiveResponseSchema.nullable(), failure: z.string().nullable(),
    stamp: z.object({ scope: layoutLiveExpectedSchema, epoch: z.string().min(1), sequence: z.number().int().nonnegative(), receivedWallMs: z.number().finite() }).strict().nullable(),
  }).strict(),
}).strict()

/** Share the acquired subject without a second read or renewing its freshness. */
export const layoutInspectionSampleMessage = (state: LayoutInspectionState, snapshot: LayoutLiveSnapshot): z.output<typeof hostedSampleSchema> => {
  if (state.delivery !== 'host' || state.channel === undefined) throw new Error('Inspection did not request hosted evidence')
  const latest = snapshot.latest === null ? null : (() => {
    const subject = snapshot.latest.subjects.find(subject => subject.elementId === state.elementId)
    if (!subject) throw new Error('Inspection subject is absent from the acquired owner sample')
    const refs = new Set([...subject.values, ...(subject.topology?.values ?? [])].map(value => value.ref))
    return { ...snapshot.latest, subjects: [subject], sample: { ...snapshot.latest.sample, observations: snapshot.latest.sample.observations.filter(value => refs.has(value.ref)) } }
  })()
  const stamp = snapshot.stamp === null ? null : { ...snapshot.stamp, scope: {
    runId: snapshot.stamp.scope.runId, layoutObjectId: snapshot.stamp.scope.layoutObjectId, revision: snapshot.stamp.scope.revision,
    objectId: snapshot.stamp.scope.objectId, packId: snapshot.stamp.scope.packId, modelDigest: snapshot.stamp.scope.modelDigest,
  } }
  return hostedSampleSchema.parse({ type: 'world:layout-inspection-sample', channel: state.channel, layoutObjectId: state.layoutObjectId, elementId: state.elementId, snapshot: { ...snapshot, stamp, latest } })
}

/** Call only after checking the actual parent Window and same origin. */
export const readHostedLayoutInspectionSample = (state: LayoutInspectionState, expected: LayoutLiveExpected, input: unknown): LayoutLiveSnapshot => {
  const message = hostedSampleSchema.parse(input)
  if (state.delivery !== 'host' || message.channel !== state.channel || message.layoutObjectId !== state.layoutObjectId || message.elementId !== state.elementId) throw new Error('Inspection evidence belongs to a different host channel or target')
  const snapshot = message.snapshot
  if (snapshot.latest !== null) {
    if ((Object.keys(expected) as Array<keyof LayoutLiveExpected>).some(key => snapshot.latest!.scope[key] !== expected[key])) throw new Error('Inspection evidence belongs to another Run, layout or owner')
    if (!snapshot.latest.subjects.some(subject => subject.elementId === state.elementId)) throw new Error('Inspection evidence is missing its subject')
  }
  if (snapshot.stamp !== null) {
    if (snapshot.latest === null || (Object.keys(expected) as Array<keyof LayoutLiveExpected>).some(key => snapshot.stamp!.scope[key] !== expected[key])
      || snapshot.stamp.epoch !== snapshot.latest.scope.epoch || snapshot.stamp.sequence !== snapshot.latest.scope.sequence) throw new Error('Inspection evidence and owner acquisition stamp disagree')
  } else if (snapshot.phase === 'live') throw new Error('Live inspection evidence has no owner acquisition stamp')
  return snapshot
}
