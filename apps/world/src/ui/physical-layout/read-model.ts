import { z } from 'zod'
import { alertStateSchema, prioritySchema } from '../../core/model/alerts.ts'
import { objectIdSchema, simulationRunIdSchema } from '../../core/model/ids.ts'
import { observationElementSchema } from '../../core/observation/capabilities.ts'
import { observableSchema, observationSchema, stampSchema } from '../../core/observation/model.ts'
import type { VignetteElement, VignetteSample, VignetteValue } from '../../features/displays/compose/model.ts'
import type { AlertRow } from '../../features/displays/alerts/rows.ts'
import { topologyBindingSchema, topologyMediumSchema, topologyNodeClassSchema } from '../../core/observation/topology.ts'

const text = z.string().min(1).max(300)
const digest = z.string().regex(/^[a-f0-9]{64}$/)

export const layoutLiveExpectedSchema = z.object({
  runId: simulationRunIdSchema, layoutObjectId: objectIdSchema, revision: z.string().min(1).max(200), objectId: objectIdSchema, packId: z.string().min(1).max(128), modelDigest: digest,
}).strict()
export type LayoutLiveExpected = z.output<typeof layoutLiveExpectedSchema>

export const layoutLiveScopeSchema = layoutLiveExpectedSchema.extend({ epoch: z.string().min(1).max(128), sequence: z.number().int().nonnegative() }).strict()

const elementSchema = z.unknown().transform((input): VignetteElement => {
  const element = observationElementSchema.parse(input)
  if ('lead' in element || 'stopped' in element || 'criteria' in element || 'table' in element) throw new Error('An inspection element carries no copied owner read plan')
  return element
})

/** Validate the exact shared display declaration, keeping its qualified label. */
const valueSchema = z.unknown().transform((input): VignetteValue => {
  const parsed = z.object({ label: z.string().min(1).max(1000), element: elementSchema.optional(), simulated: z.literal(true).optional() }).passthrough().parse(input)
  const { element, simulated, label, ...fields } = parsed
  // An observable's source label is object-local (80 chars); a display's is
  // qualified by its owner's label. All its semantic fields use the owner schema.
  const value = observableSchema.parse({ ...fields, label: 'Layout reading' })
  const { element: _element, tag: _tag, meaningfulWhile: _meaningful, lead: _lead, ...shown } = value
  return { ...shown, label, ...(element === undefined ? {} : { element }), ...(simulated === undefined ? {} : { simulated }) }
})
const operationalReadings = { bindings: z.array(topologyBindingSchema), values: z.array(valueSchema) }
const connectionEnd = z.object({ elementId: text, label: text, port: text }).strict()
const incidentConnection = z.object({ id: text, from: connectionEnd, to: connectionEnd, medium: topologyMediumSchema, directed: z.boolean() }).strict()
const subjectTopologySchema = z.discriminatedUnion('kind', [
  z.object({ ...operationalReadings, kind: z.literal('node'), class: topologyNodeClassSchema, equipmentKind: text, connections: z.array(incidentConnection).optional() }).strict(),
  z.object({ ...operationalReadings, kind: z.literal('connection'), from: connectionEnd, to: connectionEnd, medium: topologyMediumSchema, directed: z.boolean() }).strict(),
])

const alertRowSchema = z.object({
  key: text, objectId: objectIdSchema, objectLabel: text, packId: text, categoryId: text,
  group: z.object({ objectId: objectIdSchema, subjectGroup: text.optional(), label: text.optional() }).strict(),
  alert: alertStateSchema, priority: prioritySchema.nullable(), state: z.enum(['active-unack', 'active-ack', 'returned-unack']),
  raised: stampSchema.nullable(), expected: z.object({ after: text }).strict().optional(), tag: text.optional(),
  action: z.object({ label: text, ends: z.array(text).max(256).optional() }).strict().optional(),
  category: z.object({ id: text, label: text, order: z.number().int().nonnegative() }).strict().optional(), ownState: z.literal(true).optional(),
  acknowledge: z.object({ capabilityId: text, input: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])) }).strict().optional(),
}).strict().superRefine((row, context) => {
  const state = row.alert.returned === true ? (row.alert.acknowledged ? null : 'returned-unack') : row.alert.acknowledged ? 'active-ack' : 'active-unack'
  if (row.state !== state || row.priority !== (row.alert.priority ?? null) || row.group.objectId !== row.objectId
    || row.key !== `${row.objectId}|${row.alert.id}`) context.addIssue({ code: 'custom', message: 'Layout alert presentation disagrees with its owner lifecycle' })
}).transform(row => row as AlertRow)

const sampleSchema = z.object({
  at: stampSchema.extend({ paused: z.boolean() }).strict(), observations: z.array(observationSchema).max(4096), alerts: z.array(alertRowSchema).max(8192),
  // A layout read is not a second entity table, slots reader or map query.
  entities: z.record(z.string(), z.never()), slots: z.record(z.string(), z.never()), maps: z.record(z.string(), z.never()),
  categories: z.record(z.string(), z.array(z.object({ id: text, label: text, short: z.string().min(1).max(24).optional() }).strict()).max(256)).optional(),
}).strict()

const responseSchema = z.object({
  scope: layoutLiveScopeSchema, acquiredAt: z.string().datetime({ offset: true }), sample: sampleSchema,
  subjects: z.array(z.object({ elementId: z.string().min(1).max(200), label: text, values: z.array(valueSchema).max(16), word: z.string().min(1).max(300).nullable(), devices: z.array(elementSchema).max(64), topology: subjectTopologySchema.optional() }).strict()).min(1),
}).strict().superRefine((response, context) => {
  const subjects = response.subjects.map(subject => subject.elementId)
  if (new Set(subjects).size !== subjects.length) context.addIssue({ code: 'custom', message: 'Duplicate layout live subject' })
  const refs = response.sample.observations.map(observation => observation.ref)
  if (new Set(refs).size !== refs.length) context.addIssue({ code: 'custom', message: 'Duplicate layout live observation' })
  if (response.subjects.some(subject => [...subject.values, ...(subject.topology?.values ?? [])].some(value => !value.ref.startsWith(`${response.scope.objectId}#`)))
    || refs.some(ref => !ref.startsWith(`${response.scope.objectId}#`))
    || response.sample.alerts.some(row => row.objectId !== response.scope.objectId || row.packId !== response.scope.packId)) context.addIssue({ code: 'custom', message: 'Layout live content belongs to another owner' })
  for (const subject of response.subjects) if (subject.topology) {
    const values = new Set(subject.topology.values.map(value => value.ref)), acquired = new Set(refs)
    if (values.size !== subject.topology.values.length || [...values].some(ref => !acquired.has(ref))) context.addIssue({ code: 'custom', message: 'Layout semantic readings must be unique and acquired' })
    if (subject.topology.bindings.some(binding => [binding.ref, ...(binding.while ? [binding.while] : [])].some(ref => !values.has(ref)))) context.addIssue({ code: 'custom', message: 'Layout semantic binding has no acquired declaration' })
    if (subject.topology.kind === 'node' && subject.topology.connections) {
      const connections = subject.topology.connections
      if (new Set(connections.map(connection => connection.id)).size !== connections.length) context.addIssue({ code: 'custom', message: 'Duplicate component-level connection' })
      if (connections.some(connection => connection.from.elementId !== subject.elementId && connection.to.elementId !== subject.elementId)) context.addIssue({ code: 'custom', message: 'Component-level connection does not meet its owner subject' })
    }
  }
})

export type LayoutLiveResponse = Omit<z.output<typeof responseSchema>, 'sample'> & { readonly sample: VignetteSample }

export const layoutLiveResponseSchema = responseSchema.transform(response => response as LayoutLiveResponse)
