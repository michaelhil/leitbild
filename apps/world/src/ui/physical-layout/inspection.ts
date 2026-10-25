import { embeddedViewEnvelopeSchema, type EmbeddedViewEnvelope } from '@leitbild/contracts'
import { z } from 'zod'
import type { SimulationRunId } from '../../core/model/ids.ts'
import { layoutLiveExpectedSchema, type LayoutLiveExpected } from './read-model.ts'

/** Map-hosted faceplate only; component detail remains the existing vignette. */
export const LAYOUT_INSPECTION_VIEW_TYPE = 'physical-layout.inspection'

export const layoutInspectionStateSchema = layoutLiveExpectedSchema.omit({ runId: true }).extend({
  elementId: z.string().min(1).max(200), label: z.string().min(1).max(300),
}).strict()
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
  z.object({ type: z.literal('world:layout-inspection-size'), layoutObjectId: z.string().min(1).max(200), elementId: z.string().min(1).max(200), height: z.number().int().min(120).max(960) }).strict(),
])
