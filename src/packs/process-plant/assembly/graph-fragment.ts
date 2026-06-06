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

export interface GraphFragmentSubstitution {
  readonly from: string
  readonly to: string
}

export interface GraphFragmentSpec {
  readonly components: ReadonlyArray<ComponentInstanceSpec>
  readonly connections: ReadonlyArray<ConnectionSpec>
  readonly publishedVariables?: ReadonlyArray<VariablePath>
  readonly displayProfiles?: ReadonlyArray<ProcessPlantDisplayProfile>
}

export interface GraphFragmentInstance {
  readonly substitutions?: ReadonlyArray<GraphFragmentSubstitution>
  readonly componentMetadata?: ProcessGraphMetadata
  readonly connectionMetadata?: ProcessGraphMetadata
  readonly componentOverlays?: ReadonlyArray<GraphFragmentComponentOverlay>
  readonly connectionOverlays?: ReadonlyArray<GraphFragmentConnectionOverlay>
}

export interface GraphFragmentComponentOverlay {
  readonly id: string
  readonly parameters?: Readonly<Record<string, unknown>>
  readonly metadata?: ProcessGraphMetadata
}

export interface GraphFragmentConnectionOverlay {
  readonly id: string
  readonly nextId?: string
  readonly from?: string
  readonly to?: string
  readonly metadata?: ProcessGraphMetadata
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

export const instantiateGraphFragment = (
  fragment: GraphFragmentSpec,
  instance: GraphFragmentInstance,
): Required<GraphFragmentSpec> => {
  const substitutions = instance.substitutions ?? []
  const components = fragment.components.map(component => componentInstanceSpecSchema.parse(replaceValue(component, substitutions)))
  const connections = fragment.connections.map(connection => connectionSpecSchema.parse(replaceValue(connection, substitutions)))
  return {
    components: applyComponentOverlays(components, instance),
    connections: applyConnectionOverlays(connections, instance),
    publishedVariables: (fragment.publishedVariables ?? []).map(path => variablePathSchema.parse(replaceString(String(path), substitutions))),
    displayProfiles: (fragment.displayProfiles ?? []).map(profile => processPlantDisplayProfileSchema.parse(replaceValue(profile, substitutions))),
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
