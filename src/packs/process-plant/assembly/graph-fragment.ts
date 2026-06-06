import { z } from 'zod'
import {
  componentInstanceSpecSchema,
  connectionIdSchema,
  connectionSpecSchema,
  plantGraphSpecSchema,
  portRefSchema,
  processPlantDisplayProfileSchema,
  variablePathSchema,
  type ComponentInstanceSpec,
  type ConnectionSpec,
  type PlantGraphSpec,
  type ProcessGraphMetadata,
  type ProcessPlantDisplayProfile,
  type VariablePath,
} from '../graph/index.ts'

export const graphFragmentSubstitutionSchema = z.object({
  from: z.string().min(1),
  to: z.string(),
}).strict()
export interface GraphFragmentSubstitution {
  readonly from: string
  readonly to: string
}

export const graphFragmentSpecSchema = z.object({
  components: z.array(componentInstanceSpecSchema),
  connections: z.array(connectionSpecSchema),
  publishedVariables: z.array(variablePathSchema).optional(),
  displayProfiles: z.array(processPlantDisplayProfileSchema).optional(),
}).strict()
export interface GraphFragmentSpec {
  readonly components: ReadonlyArray<ComponentInstanceSpec>
  readonly connections: ReadonlyArray<ConnectionSpec>
  readonly publishedVariables?: ReadonlyArray<VariablePath>
  readonly displayProfiles?: ReadonlyArray<ProcessPlantDisplayProfile>
}

export const graphFragmentComponentOverlaySchema = z.object({
  id: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).optional(),
  metadata: componentInstanceSpecSchema.shape.metadata.optional(),
}).strict()
export interface GraphFragmentComponentOverlay {
  readonly id: string
  readonly parameters?: Readonly<Record<string, unknown>>
  readonly metadata?: ProcessGraphMetadata
}

export const graphFragmentConnectionOverlaySchema = z.object({
  id: z.string().min(1),
  nextId: z.string().min(1).optional(),
  from: z.string().min(3).optional(),
  to: z.string().min(3).optional(),
  metadata: connectionSpecSchema.shape.metadata.optional(),
}).strict()
export interface GraphFragmentConnectionOverlay {
  readonly id: string
  readonly nextId?: string
  readonly from?: string
  readonly to?: string
  readonly metadata?: ProcessGraphMetadata
}

export const graphFragmentInstanceSchema = z.object({
  substitutions: z.array(graphFragmentSubstitutionSchema).optional(),
  componentMetadata: componentInstanceSpecSchema.shape.metadata.optional(),
  connectionMetadata: connectionSpecSchema.shape.metadata.optional(),
  componentOverlays: z.array(graphFragmentComponentOverlaySchema).optional(),
  connectionOverlays: z.array(graphFragmentConnectionOverlaySchema).optional(),
}).strict()
export interface GraphFragmentInstance {
  readonly substitutions?: ReadonlyArray<GraphFragmentSubstitution>
  readonly componentMetadata?: ProcessGraphMetadata
  readonly connectionMetadata?: ProcessGraphMetadata
  readonly componentOverlays?: ReadonlyArray<GraphFragmentComponentOverlay>
  readonly connectionOverlays?: ReadonlyArray<GraphFragmentConnectionOverlay>
}

const replaceString = (value: string, substitutions: ReadonlyArray<GraphFragmentSubstitution>): string =>
  substitutions.reduce((current, substitution) => current.replaceAll(substitution.from, substitution.to), value)

const replaceValue = (value: unknown, substitutions: ReadonlyArray<GraphFragmentSubstitution>): unknown => {
  if (typeof value === 'string') return replaceString(value, substitutions)
  if (Array.isArray(value)) return value.map(item => replaceValue(item, substitutions))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    replaceString(key, substitutions),
    replaceValue(entry, substitutions),
  ]))
}

const overlayMapFor = <T extends { readonly id: string }>(
  overlays: ReadonlyArray<T> | undefined,
  label: string,
): ReadonlyMap<string, T> => {
  const entries = overlays ?? []
  const byId = new Map<string, T>()
  for (const overlay of entries) {
    if (byId.has(overlay.id)) throw new Error(`duplicate graph fragment ${label} overlay: ${overlay.id}`)
    byId.set(overlay.id, overlay)
  }
  return byId
}

const assertAllOverlaysApplied = (
  overlaysById: ReadonlyMap<string, unknown>,
  appliedIds: ReadonlySet<string>,
  label: string,
): void => {
  for (const id of overlaysById.keys()) {
    if (!appliedIds.has(id)) throw new Error(`graph fragment ${label} overlay references unknown id: ${id}`)
  }
}

const parameterRecord = (component: ComponentInstanceSpec): Record<string, unknown> => {
  if (!component.parameters || typeof component.parameters !== 'object' || Array.isArray(component.parameters)) {
    throw new Error(`graph fragment component overlay cannot merge non-object parameters for: ${component.id}`)
  }
  return component.parameters as Record<string, unknown>
}

const mergedMetadata = (
  current: ProcessGraphMetadata | undefined,
  instance: ProcessGraphMetadata | undefined,
  overlay: ProcessGraphMetadata | undefined,
): ProcessGraphMetadata | undefined => {
  if (current === undefined && instance === undefined && overlay === undefined) return undefined
  return {
    ...(current ?? {}),
    ...(instance ?? {}),
    ...(overlay ?? {}),
  }
}

const applyComponentOverlays = (
  components: ReadonlyArray<ComponentInstanceSpec>,
  instance: GraphFragmentInstance,
): ReadonlyArray<ComponentInstanceSpec> => {
  const overlaysById = overlayMapFor(instance.componentOverlays, 'component')
  const appliedIds = new Set<string>()
  const next = components.map(component => {
    const overlay = overlaysById.get(String(component.id))
    if (overlay !== undefined) appliedIds.add(overlay.id)
    return componentInstanceSpecSchema.parse({
      ...component,
      ...(overlay?.parameters === undefined
        ? {}
        : { parameters: { ...parameterRecord(component), ...overlay.parameters } }),
      ...(mergedMetadata(component.metadata, instance.componentMetadata, overlay?.metadata) === undefined
        ? {}
        : { metadata: mergedMetadata(component.metadata, instance.componentMetadata, overlay?.metadata) }),
    })
  })
  assertAllOverlaysApplied(overlaysById, appliedIds, 'component')
  return next
}

const applyConnectionOverlays = (
  connections: ReadonlyArray<ConnectionSpec>,
  instance: GraphFragmentInstance,
): ReadonlyArray<ConnectionSpec> => {
  const overlaysById = overlayMapFor(instance.connectionOverlays, 'connection')
  const appliedIds = new Set<string>()
  const next = connections.map(connection => {
    const overlay = overlaysById.get(String(connection.id))
    if (overlay !== undefined) appliedIds.add(overlay.id)
    return connectionSpecSchema.parse({
      ...connection,
      id: overlay?.nextId === undefined ? connection.id : connectionIdSchema.parse(overlay.nextId),
      from: overlay?.from === undefined ? connection.from : portRefSchema.parse(overlay.from),
      to: overlay?.to === undefined ? connection.to : portRefSchema.parse(overlay.to),
      ...(mergedMetadata(connection.metadata, instance.connectionMetadata, overlay?.metadata) === undefined
        ? {}
        : { metadata: mergedMetadata(connection.metadata, instance.connectionMetadata, overlay?.metadata) }),
    })
  })
  assertAllOverlaysApplied(overlaysById, appliedIds, 'connection')
  return next
}

const cleanComponentOverlay = (overlay: z.infer<typeof graphFragmentComponentOverlaySchema>): GraphFragmentComponentOverlay => ({
  id: overlay.id,
  ...(overlay.parameters === undefined ? {} : { parameters: overlay.parameters }),
  ...(overlay.metadata === undefined ? {} : { metadata: overlay.metadata }),
})

const cleanConnectionOverlay = (overlay: z.infer<typeof graphFragmentConnectionOverlaySchema>): GraphFragmentConnectionOverlay => ({
  id: overlay.id,
  ...(overlay.nextId === undefined ? {} : { nextId: overlay.nextId }),
  ...(overlay.from === undefined ? {} : { from: overlay.from }),
  ...(overlay.to === undefined ? {} : { to: overlay.to }),
  ...(overlay.metadata === undefined ? {} : { metadata: overlay.metadata }),
})

export const parseGraphFragmentSpec = (fragment: unknown): GraphFragmentSpec => {
  const parsed = graphFragmentSpecSchema.parse(fragment)
  return {
    components: parsed.components,
    connections: parsed.connections,
    ...(parsed.publishedVariables === undefined ? {} : { publishedVariables: parsed.publishedVariables }),
    ...(parsed.displayProfiles === undefined ? {} : { displayProfiles: parsed.displayProfiles }),
  }
}

export const parseGraphFragmentInstance = (instance: unknown): GraphFragmentInstance => {
  const parsed = graphFragmentInstanceSchema.parse(instance)
  return {
    ...(parsed.substitutions === undefined ? {} : { substitutions: parsed.substitutions }),
    ...(parsed.componentMetadata === undefined ? {} : { componentMetadata: parsed.componentMetadata }),
    ...(parsed.connectionMetadata === undefined ? {} : { connectionMetadata: parsed.connectionMetadata }),
    ...(parsed.componentOverlays === undefined ? {} : { componentOverlays: parsed.componentOverlays.map(cleanComponentOverlay) }),
    ...(parsed.connectionOverlays === undefined ? {} : { connectionOverlays: parsed.connectionOverlays.map(cleanConnectionOverlay) }),
  }
}

export const instantiateGraphFragment = (
  fragment: GraphFragmentSpec,
  instance: GraphFragmentInstance,
): Required<GraphFragmentSpec> => {
  const parsedFragment = parseGraphFragmentSpec(fragment)
  const parsedInstance = parseGraphFragmentInstance(instance)
  const substitutions = parsedInstance.substitutions ?? []
  const components = parsedFragment.components.map(component => componentInstanceSpecSchema.parse(replaceValue(component, substitutions)))
  const connections = parsedFragment.connections.map(connection => connectionSpecSchema.parse(replaceValue(connection, substitutions)))
  return {
    components: applyComponentOverlays(components, parsedInstance),
    connections: applyConnectionOverlays(connections, parsedInstance),
    publishedVariables: (parsedFragment.publishedVariables ?? []).map(path => variablePathSchema.parse(replaceString(String(path), substitutions))),
    displayProfiles: (parsedFragment.displayProfiles ?? []).map(profile => processPlantDisplayProfileSchema.parse(replaceValue(profile, substitutions))),
  }
}

export const composePlantGraph = (config: {
  readonly base: PlantGraphSpec
  readonly id: string
  readonly title: string
  readonly fragments: ReadonlyArray<GraphFragmentSpec>
  readonly publishedVariables?: ReadonlyArray<VariablePath>
  readonly displayProfiles?: ReadonlyArray<ProcessPlantDisplayProfile>
}): PlantGraphSpec =>
  plantGraphSpecSchema.parse({
    ...config.base,
    id: config.id,
    title: config.title,
    components: [
      ...config.base.components,
      ...config.fragments.flatMap(fragment => fragment.components),
    ],
    connections: [
      ...config.base.connections,
      ...config.fragments.flatMap(fragment => fragment.connections),
    ],
    publishedVariables: [
      ...config.base.publishedVariables,
      ...(config.publishedVariables ?? config.fragments.flatMap(fragment => fragment.publishedVariables ?? [])),
    ],
    displayProfiles: config.displayProfiles ?? config.base.displayProfiles,
  })
