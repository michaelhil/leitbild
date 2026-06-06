import {
  componentInstanceSpecSchema,
  connectionSpecSchema,
  plantGraphSpecSchema,
  processPlantDisplayProfileSchema,
  variablePathSchema,
  type ComponentInstanceSpec,
  type ConnectionSpec,
  type PlantGraphSpec,
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
  readonly substitutions: ReadonlyArray<GraphFragmentSubstitution>
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

export const instantiateGraphFragment = (
  fragment: GraphFragmentSpec,
  instance: GraphFragmentInstance,
): Required<GraphFragmentSpec> => ({
  components: fragment.components.map(component => componentInstanceSpecSchema.parse(replaceValue(component, instance.substitutions))),
  connections: fragment.connections.map(connection => connectionSpecSchema.parse(replaceValue(connection, instance.substitutions))),
  publishedVariables: (fragment.publishedVariables ?? []).map(path => variablePathSchema.parse(replaceString(String(path), instance.substitutions))),
  displayProfiles: (fragment.displayProfiles ?? []).map(profile => processPlantDisplayProfileSchema.parse(replaceValue(profile, instance.substitutions))),
})

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
