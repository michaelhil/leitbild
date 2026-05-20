import type { z } from 'zod'
import type {
  CompiledComponent,
  CompiledEdge,
  CompiledPlantGraph,
  CompiledPort,
  CompiledVariable,
  ComponentDefinition,
  ComponentId,
  ComponentKind,
  EdgeKind,
  LocalVariablePath,
  PlantGraphSpec,
  PortDefinition,
  PortName,
  PortRef,
  VariablePath,
} from './model.ts'
import { edgeKindSchema, plantGraphSpecSchema } from './model.ts'

interface ResolvedPortRef {
  readonly componentId: ComponentId
  readonly portName: string
}

const edgeKinds: ReadonlyArray<EdgeKind> = edgeKindSchema.options

const emptyEdgesByKind = (): Record<EdgeKind, number[]> => {
  const entries = edgeKinds.map((kind): readonly [EdgeKind, number[]] => [kind, []])
  return Object.fromEntries(entries) as Record<EdgeKind, number[]>
}

const parsePortRef = (ref: PortRef): ResolvedPortRef => {
  const separatorIndex = ref.lastIndexOf('.')
  if (separatorIndex < 1 || separatorIndex === ref.length - 1) throw new Error(`invalid port ref: ${ref}`)
  return {
    componentId: ref.slice(0, separatorIndex) as ComponentId,
    portName: ref.slice(separatorIndex + 1),
  }
}

const assertUnique = <T>(items: ReadonlyArray<T>, keyFor: (item: T) => string, label: string): void => {
  const seen = new Set<string>()
  for (const item of items) {
    const key = keyFor(item)
    if (seen.has(key)) throw new Error(`duplicate ${label}: ${key}`)
    seen.add(key)
  }
}

const parseWithContext = <T>(schema: z.ZodType<T>, input: unknown, context: string): T => {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  throw new Error(`${context}: ${result.error.issues.map(issue => `${issue.path.join('.') || '<root>'} ${issue.message}`).join('; ')}`)
}

const compilePorts = (definition: ComponentDefinition): Readonly<Record<string, CompiledPort>> =>
  Object.fromEntries(Object.entries(definition.ports).map(([name, port], index) => [
    name,
    {
      index,
      name: name as PortName,
      kind: port.kind,
      direction: port.direction,
    },
  ]))

const compatiblePortKinds = (from: PortDefinition, to: PortDefinition): boolean => {
  if (from.kind === to.kind) return true
  if (from.kind === 'hydraulicThermal' && (to.kind === 'hydraulic' || to.kind === 'thermal')) return true
  if (to.kind === 'hydraulicThermal' && (from.kind === 'hydraulic' || from.kind === 'thermal')) return true
  return false
}

const directionAllowsConnection = (from: PortDefinition, to: PortDefinition): boolean => {
  const fromCanSend = from.direction === 'out' || from.direction === 'bidirectional'
  const toCanReceive = to.direction === 'in' || to.direction === 'bidirectional'
  return fromCanSend && toCanReceive
}

const inferEdgeKind = (from: PortDefinition, to: PortDefinition): EdgeKind => {
  if (!compatiblePortKinds(from, to)) throw new Error(`cannot infer edge kind for incompatible port kinds ${from.kind} -> ${to.kind}`)
  if (from.kind === 'steam' && to.kind === 'steam') return 'steamFlow'
  if (from.kind === 'electricalAc' && to.kind === 'electricalAc') return 'electricalPower'
  if (from.kind === 'mechanicalShaft' && to.kind === 'mechanicalShaft') return 'mechanicalTorque'
  if (from.kind === 'controlSignal' && to.kind === 'controlSignal') return 'controlSignal'
  if (from.kind === 'logicSignal' && to.kind === 'logicSignal') return 'logicSignal'
  if (from.kind === 'thermal' || to.kind === 'thermal') return 'thermalContact'
  return 'hydraulicFlow'
}

const resolveDefinition = (
  registry: ReadonlyMap<ComponentKind, ComponentDefinition>,
  kind: ComponentKind,
): ComponentDefinition => {
  const definition = registry.get(kind)
  if (!definition) throw new Error(`unknown PWR component kind: ${kind}`)
  return definition
}

const variablePathFor = (componentId: ComponentId, localPath: LocalVariablePath): VariablePath =>
  `${componentId}.${localPath}` as VariablePath

export const compilePlantGraph = (
  input: unknown,
  registry: ReadonlyMap<ComponentKind, ComponentDefinition>,
): CompiledPlantGraph => {
  const spec = plantGraphSpecSchema.parse(input)
  assertUnique(spec.components, component => component.id, 'component id')
  assertUnique(spec.connections, connection => connection.id, 'connection id')

  const componentIndexById = new Map<ComponentId, number>()
  const definitions = new Map<ComponentId, ComponentDefinition>()
  const components: CompiledComponent[] = spec.components.map((component, index) => {
    const definition = resolveDefinition(registry, component.kind)
    componentIndexById.set(component.id, index)
    definitions.set(component.id, definition)
    const compiled: CompiledComponent = {
      index,
      id: component.id,
      kind: component.kind,
      label: component.label,
      parameters: parseWithContext(definition.parametersSchema, component.parameters, `component ${component.id} parameters`),
      ...(component.initialState === undefined ? {} : {
        initialState: parseWithContext(definition.initialStateSchema ?? definition.parametersSchema, component.initialState, `component ${component.id} initialState`),
      }),
      ports: compilePorts(definition),
      variables: definition.variables.map(variable => ({
        ...variable,
        path: variablePathFor(component.id, variable.path),
      })),
    }
    return compiled
  })

  const edgesByKind = emptyEdgesByKind()
  const edges: CompiledEdge[] = spec.connections.map((connection, index) => {
    const from = parsePortRef(connection.from)
    const to = parsePortRef(connection.to)
    const fromComponentIndex = componentIndexById.get(from.componentId)
    const toComponentIndex = componentIndexById.get(to.componentId)
    if (fromComponentIndex === undefined) throw new Error(`connection ${connection.id} references unknown component: ${from.componentId}`)
    if (toComponentIndex === undefined) throw new Error(`connection ${connection.id} references unknown component: ${to.componentId}`)
    const fromDefinition = definitions.get(from.componentId)
    const toDefinition = definitions.get(to.componentId)
    if (!fromDefinition || !toDefinition) throw new Error(`connection ${connection.id} failed to resolve component definitions`)
    const fromPort = fromDefinition.ports[from.portName]
    const toPort = toDefinition.ports[to.portName]
    if (!fromPort) throw new Error(`connection ${connection.id} references unknown port: ${from.componentId}.${from.portName}`)
    if (!toPort) throw new Error(`connection ${connection.id} references unknown port: ${to.componentId}.${to.portName}`)
    if (!compatiblePortKinds(fromPort, toPort)) throw new Error(`connection ${connection.id} has incompatible port kinds: ${fromPort.kind} -> ${toPort.kind}`)
    if (!directionAllowsConnection(fromPort, toPort)) throw new Error(`connection ${connection.id} has invalid port directions: ${fromPort.direction} -> ${toPort.direction}`)
    const inferredKind = inferEdgeKind(fromPort, toPort)
    const kind = connection.edgeKind ?? inferredKind
    if (connection.edgeKind !== undefined && connection.edgeKind !== inferredKind) {
      throw new Error(`connection ${connection.id} declares edge kind ${connection.edgeKind} but port kinds require ${inferredKind}`)
    }
    const compiled: CompiledEdge = {
      index,
      id: connection.id,
      kind,
      fromComponentIndex,
      fromPortIndex: components[fromComponentIndex]?.ports[from.portName]?.index ?? -1,
      toComponentIndex,
      toPortIndex: components[toComponentIndex]?.ports[to.portName]?.index ?? -1,
      ...(connection.medium === undefined ? {} : { medium: connection.medium }),
    }
    edgesByKind[kind].push(index)
    return compiled
  })

  const published = new Set(spec.publishedVariables)
  const variables: CompiledVariable[] = components.flatMap(component =>
    component.variables.map(descriptor => ({
      path: descriptor.path,
      componentIndex: component.index,
      descriptor,
      published: published.has(descriptor.path),
    })),
  )
  const availableVariablePaths = new Set(variables.map(variable => variable.path))
  for (const path of published) {
    if (!availableVariablePaths.has(path)) throw new Error(`published variable does not exist: ${path}`)
  }

  return {
    specId: spec.id,
    title: spec.title,
    timestep: spec.timestep,
    components,
    componentIndexById,
    edges,
    edgesByKind,
    variables,
  }
}
