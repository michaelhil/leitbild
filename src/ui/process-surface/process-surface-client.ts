import type { ControlInstanceId } from '../../core/model/index.ts'
import type {
  CompiledProcessSurface,
  ProcessSurfaceAlarmAnnunciator,
  ProcessSurfaceAlarmLifecycle,
  ProcessSurfaceAlarmSnapshot,
  ProcessSurfaceAlarmSeverity,
  ProcessSurfaceGraphLens,
  ProcessSurfaceValue,
} from '../../packs/process-plant/surfaces/index.ts'
import { queryControlInstancePack } from '../control-instance-client.ts'

export interface ProcessSurfaceLensOption {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly lens?: ProcessSurfaceGraphLens
}

export interface ProcessSurfaceListItem {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly lenses: ReadonlyArray<ProcessSurfaceLensOption>
}

export interface ProcessSurfaceSnapshot {
  readonly systemId: string
  readonly surfaceId: string
  readonly values: ReadonlyArray<ProcessSurfaceValue>
  readonly alarms: ProcessSurfaceAlarmSnapshot
}

export const emptyProcessSurfaceAlarmSnapshot: ProcessSurfaceAlarmSnapshot = {
  configured: false,
  activeAlarmCount: 0,
  activeTripCount: 0,
  unacknowledgedCount: 0,
  firstOutCount: 0,
  activeHighestSeverity: null,
  activeFirstOut: [],
  active: [],
}

export interface ProcessSurfaceProjection {
  readonly systemId: string
  readonly surfaceId: string
  readonly graphProjection: {
    readonly componentIds: ReadonlyArray<string>
    readonly connectionIds: ReadonlyArray<string>
    readonly diagnostics: ReadonlyArray<Record<string, unknown>>
  }
  readonly surfaceProjection: {
    readonly visibleWidgetIds: ReadonlyArray<string>
    readonly visiblePathIds: ReadonlyArray<string>
    readonly hiddenWidgetIds: ReadonlyArray<string>
    readonly hiddenPathIds: ReadonlyArray<string>
  }
}

export type ProcessPlantArtifactKind = 'authored-spec' | 'compiled-graph-mermaid'

export interface ProcessPlantArtifactSourceLink {
  readonly symbol: string
  readonly importedName: string
  readonly targetPath: string
  readonly targetLineIndex: number | null
}

export interface ProcessPlantArtifactSourceFile {
  readonly path: string
  readonly content: string
}

export interface ProcessPlantArtifactComponent {
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly shownOnOverview: boolean
  readonly source: string
  readonly sourcePath: string
  readonly sourceLinks: ReadonlyArray<ProcessPlantArtifactSourceLink>
}

export interface ProcessPlantArtifact {
  readonly systemId: string
  readonly artifact: ProcessPlantArtifactKind
  readonly title: string
  readonly language: 'json' | 'mermaid'
  readonly content: string
  readonly components: ReadonlyArray<ProcessPlantArtifactComponent>
  readonly sourceFiles: ReadonlyArray<ProcessPlantArtifactSourceFile>
  readonly metadata: {
    readonly specId: string
    readonly componentCount: number
    readonly linkCount: number
    readonly variableCount: number
    readonly overviewComponentCount: number
  }
}

const assertObject = (value: unknown, message: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

const assertArray = (value: unknown, message: string): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) throw new Error(message)
  return value
}

const assertString = (value: unknown, message: string): string => {
  if (typeof value !== 'string') throw new Error(message)
  return value
}

const assertNumber = (value: unknown, message: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(message)
  return value
}

const assertBoolean = (value: unknown, message: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(message)
  return value
}

const requireOkResult = (value: unknown): Record<string, unknown> => {
  const envelope = assertObject(value, 'process surface query returned a malformed response')
  if (envelope.ok !== true) throw new Error(typeof envelope.reason === 'string' ? envelope.reason : 'process surface query failed')
  return assertObject(envelope.result, 'process surface query returned a malformed result')
}

const parseLensOption = (value: unknown): ProcessSurfaceLensOption => {
  const lens = assertObject(value, 'process surface lens option is malformed')
  return {
    id: assertString(lens.id, 'process surface lens option requires id'),
    label: assertString(lens.label, 'process surface lens option requires label'),
    ...(typeof lens.description === 'string' ? { description: lens.description } : {}),
    ...(lens.lens === undefined ? {} : { lens: assertObject(lens.lens, 'process surface lens option has malformed lens') as unknown as ProcessSurfaceGraphLens }),
  }
}

const parseSurfaceValues = (value: unknown): ReadonlyArray<ProcessSurfaceValue> =>
  assertArray(value, 'process surface snapshot result has no values array').map(item => {
    const record = assertObject(item, 'process surface value is malformed')
    return {
      path: assertString(record.path, 'process surface value requires path') as ProcessSurfaceValue['path'],
      label: assertString(record.label, 'process surface value requires label'),
      unit: assertString(record.unit, 'process surface value requires unit'),
      value: record.value,
      formatted: assertString(record.formatted, 'process surface value requires formatted'),
    }
  })

const parseAlarmSeverity = (value: unknown): ProcessSurfaceAlarmSeverity => {
  if (value === 'info' || value === 'notice' || value === 'warning' || value === 'critical') return value
  throw new Error('process surface alarm lifecycle has invalid severity')
}

const parseAlarmPriority = (value: unknown): NonNullable<ProcessSurfaceAlarmLifecycle['annunciator']>['priority'] => {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'urgent') return value
  throw new Error('process surface alarm annunciator has invalid priority')
}

const parseAlarmRole = (value: unknown): NonNullable<ProcessSurfaceAlarmLifecycle['annunciator']>['role'] => {
  if (value === 'symptom' || value === 'cause' || value === 'automaticAction' || value === 'status') return value
  throw new Error('process surface alarm annunciator has invalid role')
}

const parseOptionalNumber = (value: unknown, message: string): number | undefined => {
  if (value === undefined) return undefined
  return assertNumber(value, message)
}

const parseAlarmAnnunciator = (value: unknown): ProcessSurfaceAlarmAnnunciator | undefined => {
  if (value === undefined) return undefined
  const annunciator = assertObject(value, 'process surface alarm annunciator is malformed')
  const priority = annunciator.priority === undefined ? undefined : parseAlarmPriority(annunciator.priority)
  const role = annunciator.role === undefined ? undefined : parseAlarmRole(annunciator.role)
  return {
    ...(typeof annunciator.system === 'string' ? { system: annunciator.system } : {}),
    ...(typeof annunciator.equipmentId === 'string' ? { equipmentId: annunciator.equipmentId } : {}),
    ...(typeof annunciator.group === 'string' ? { group: annunciator.group } : {}),
    ...(typeof annunciator.firstOutGroup === 'string' ? { firstOutGroup: annunciator.firstOutGroup } : {}),
    ...(priority === undefined ? {} : { priority }),
    ...(role === undefined ? {} : { role }),
  }
}

const parseAlarmLifecycle = (value: unknown): ProcessSurfaceAlarmLifecycle => {
  const lifecycle = assertObject(value, 'process surface alarm lifecycle is malformed')
  const kind = lifecycle.kind
  if (kind !== 'alarm' && kind !== 'trip') throw new Error('process surface alarm lifecycle has invalid kind')
  const parsedAnnunciator = parseAlarmAnnunciator(lifecycle.annunciator)
  const firstOutRank = parseOptionalNumber(lifecycle.firstOutRank, 'process surface alarm lifecycle has invalid firstOutRank')
  const firstActiveElapsedMs = parseOptionalNumber(lifecycle.firstActiveElapsedMs, 'process surface alarm lifecycle has invalid firstActiveElapsedMs')
  const lastActiveElapsedMs = parseOptionalNumber(lifecycle.lastActiveElapsedMs, 'process surface alarm lifecycle has invalid lastActiveElapsedMs')
  const lastClearedElapsedMs = parseOptionalNumber(lifecycle.lastClearedElapsedMs, 'process surface alarm lifecycle has invalid lastClearedElapsedMs')
  return {
    id: assertString(lifecycle.id, 'process surface alarm lifecycle requires id'),
    kind,
    title: assertString(lifecycle.title, 'process surface alarm lifecycle requires title'),
    message: assertString(lifecycle.message, 'process surface alarm lifecycle requires message'),
    severity: parseAlarmSeverity(lifecycle.severity),
    phase: assertString(lifecycle.phase, 'process surface alarm lifecycle requires phase'),
    active: assertBoolean(lifecycle.active, 'process surface alarm lifecycle requires active'),
    acknowledged: assertBoolean(lifecycle.acknowledged, 'process surface alarm lifecycle requires acknowledged'),
    firstOut: assertBoolean(lifecycle.firstOut, 'process surface alarm lifecycle requires firstOut'),
    resettable: assertBoolean(lifecycle.resettable, 'process surface alarm lifecycle requires resettable'),
    ...(parsedAnnunciator === undefined ? {} : { annunciator: parsedAnnunciator }),
    ...(firstOutRank === undefined ? {} : { firstOutRank }),
    ...(firstActiveElapsedMs === undefined ? {} : { firstActiveElapsedMs }),
    ...(lastActiveElapsedMs === undefined ? {} : { lastActiveElapsedMs }),
    ...(lastClearedElapsedMs === undefined ? {} : { lastClearedElapsedMs }),
  }
}

const parseAlarmSnapshot = (value: unknown): ProcessSurfaceAlarmSnapshot => {
  const snapshot = assertObject(value, 'process surface snapshot result has no alarms object')
  const activeHighestSeverity = snapshot.activeHighestSeverity
  if (activeHighestSeverity !== null && activeHighestSeverity !== undefined) parseAlarmSeverity(activeHighestSeverity)
  return {
    configured: assertBoolean(snapshot.configured, 'process surface alarm snapshot requires configured'),
    activeAlarmCount: assertNumber(snapshot.activeAlarmCount, 'process surface alarm snapshot requires activeAlarmCount'),
    activeTripCount: assertNumber(snapshot.activeTripCount, 'process surface alarm snapshot requires activeTripCount'),
    unacknowledgedCount: assertNumber(snapshot.unacknowledgedCount, 'process surface alarm snapshot requires unacknowledgedCount'),
    firstOutCount: assertNumber(snapshot.firstOutCount, 'process surface alarm snapshot requires firstOutCount'),
    activeHighestSeverity: activeHighestSeverity === null || activeHighestSeverity === undefined ? null : parseAlarmSeverity(activeHighestSeverity),
    activeFirstOut: assertArray(snapshot.activeFirstOut, 'process surface alarm snapshot requires activeFirstOut').map(parseAlarmLifecycle),
    active: assertArray(snapshot.active, 'process surface alarm snapshot requires active').map(parseAlarmLifecycle),
  }
}

const parseCompiledProcessSurface = (value: unknown): CompiledProcessSurface => {
  const surface = assertObject(value, 'process surface read result has no surface')
  const designSize = assertObject(surface.designSize, 'process surface requires designSize')
  if (typeof designSize.width !== 'number' || typeof designSize.height !== 'number') {
    throw new Error('process surface designSize requires numeric width and height')
  }
  return {
    id: assertString(surface.id, 'process surface requires id'),
    title: assertString(surface.title, 'process surface requires title'),
    ...(typeof surface.description === 'string' ? { description: surface.description } : {}),
    designSize: { width: designSize.width, height: designSize.height },
    lenses: assertArray(surface.lenses, 'process surface requires lenses').map(parseLensOption),
    widgets: assertArray(surface.widgets, 'process surface requires widgets') as CompiledProcessSurface['widgets'],
    paths: assertArray(surface.paths, 'process surface requires paths') as CompiledProcessSurface['paths'],
    bindingPaths: assertArray(surface.bindingPaths, 'process surface requires bindingPaths') as CompiledProcessSurface['bindingPaths'],
  }
}

const parseProcessPlantArtifactComponent = (value: unknown): ProcessPlantArtifactComponent => {
  const component = assertObject(value, 'process plant artifact component is malformed')
  if (typeof component.shownOnOverview !== 'boolean') throw new Error('process plant artifact component requires shownOnOverview')
  return {
    id: assertString(component.id, 'process plant artifact component requires id'),
    label: assertString(component.label, 'process plant artifact component requires label'),
    kind: assertString(component.kind, 'process plant artifact component requires kind'),
    shownOnOverview: component.shownOnOverview,
    source: assertString(component.source, 'process plant artifact component requires source'),
    sourcePath: assertString(component.sourcePath, 'process plant artifact component requires sourcePath'),
    sourceLinks: assertArray(component.sourceLinks, 'process plant artifact component requires sourceLinks').map(parseProcessPlantArtifactSourceLink),
  }
}

const parseProcessPlantArtifactSourceLink = (value: unknown): ProcessPlantArtifactSourceLink => {
  const link = assertObject(value, 'process plant artifact source link is malformed')
  const targetLineIndex = link.targetLineIndex
  if (targetLineIndex !== null && (typeof targetLineIndex !== 'number' || !Number.isInteger(targetLineIndex) || targetLineIndex < 0)) {
    throw new Error('process plant artifact source link requires nullable nonnegative targetLineIndex')
  }
  return {
    symbol: assertString(link.symbol, 'process plant artifact source link requires symbol'),
    importedName: assertString(link.importedName, 'process plant artifact source link requires importedName'),
    targetPath: assertString(link.targetPath, 'process plant artifact source link requires targetPath'),
    targetLineIndex,
  }
}

const parseProcessPlantArtifactSourceFile = (value: unknown): ProcessPlantArtifactSourceFile => {
  const file = assertObject(value, 'process plant artifact source file is malformed')
  return {
    path: assertString(file.path, 'process plant artifact source file requires path'),
    content: assertString(file.content, 'process plant artifact source file requires content'),
  }
}

export const listProcessSurfaces = async (
  controlInstanceId: ControlInstanceId,
  systemId: string,
): Promise<ReadonlyArray<ProcessSurfaceListItem>> => {
  const body = await queryControlInstancePack(controlInstanceId, {
    packId: 'process-plant',
    kind: 'process-plant.surfaces.list',
    payload: { systemId },
  })
  const result = requireOkResult(body.response)
  return assertArray(result.surfaces, 'process surface list result has no surfaces array').map(item => {
    const surface = assertObject(item, 'process surface list item is malformed')
    if (typeof surface.id !== 'string' || typeof surface.title !== 'string') throw new Error('process surface list item requires id and title')
    return {
      id: surface.id,
      title: surface.title,
      ...(typeof surface.description === 'string' ? { description: surface.description } : {}),
      lenses: assertArray(surface.lenses, 'process surface list item requires lenses').map(parseLensOption),
    }
  })
}

export const readProcessSurface = async (
  controlInstanceId: ControlInstanceId,
  systemId: string,
  surfaceId: string,
): Promise<CompiledProcessSurface> => {
  const body = await queryControlInstancePack(controlInstanceId, {
    packId: 'process-plant',
    kind: 'process-plant.surface.read',
    payload: { systemId, surfaceId },
  })
  const result = requireOkResult(body.response)
  return parseCompiledProcessSurface(result.surface)
}

export const readProcessSurfaceSnapshot = async (
  controlInstanceId: ControlInstanceId,
  systemId: string,
  surfaceId: string,
): Promise<ProcessSurfaceSnapshot> => {
  const body = await queryControlInstancePack(controlInstanceId, {
    packId: 'process-plant',
    kind: 'process-plant.surface.snapshot',
    payload: { systemId, surfaceId },
  })
  const result = requireOkResult(body.response)
  if (typeof result.systemId !== 'string' || typeof result.surfaceId !== 'string') throw new Error('process surface snapshot result requires systemId and surfaceId')
  return {
    systemId: result.systemId,
    surfaceId: result.surfaceId,
    values: parseSurfaceValues(result.values),
    alarms: parseAlarmSnapshot(result.alarms),
  }
}

export const readProcessSurfaceProjection = async (
  controlInstanceId: ControlInstanceId,
  systemId: string,
  surfaceId: string,
  lens: ProcessSurfaceGraphLens,
): Promise<ProcessSurfaceProjection> => {
  const body = await queryControlInstancePack(controlInstanceId, {
    packId: 'process-plant',
    kind: 'process-plant.surface.project',
    payload: { systemId, surfaceId, lens },
  })
  const result = requireOkResult(body.response)
  if (typeof result.systemId !== 'string' || typeof result.surfaceId !== 'string') throw new Error('process surface projection result requires systemId and surfaceId')
  const graphProjection = assertObject(result.graphProjection, 'process surface projection result has no graphProjection')
  const surfaceProjection = assertObject(result.surfaceProjection, 'process surface projection result has no surfaceProjection')
  return {
    systemId: result.systemId,
    surfaceId: result.surfaceId,
    graphProjection: {
      componentIds: assertArray(graphProjection.componentIds, 'process surface graph projection has no componentIds') as ReadonlyArray<string>,
      connectionIds: assertArray(graphProjection.connectionIds, 'process surface graph projection has no connectionIds') as ReadonlyArray<string>,
      diagnostics: assertArray(graphProjection.diagnostics, 'process surface graph projection has no diagnostics') as ReadonlyArray<Record<string, unknown>>,
    },
    surfaceProjection: {
      visibleWidgetIds: assertArray(surfaceProjection.visibleWidgetIds, 'process surface projection has no visibleWidgetIds') as ReadonlyArray<string>,
      visiblePathIds: assertArray(surfaceProjection.visiblePathIds, 'process surface projection has no visiblePathIds') as ReadonlyArray<string>,
      hiddenWidgetIds: assertArray(surfaceProjection.hiddenWidgetIds, 'process surface projection has no hiddenWidgetIds') as ReadonlyArray<string>,
      hiddenPathIds: assertArray(surfaceProjection.hiddenPathIds, 'process surface projection has no hiddenPathIds') as ReadonlyArray<string>,
    },
  }
}

export const readProcessPlantArtifact = async (
  controlInstanceId: ControlInstanceId,
  systemId: string,
  artifact: ProcessPlantArtifactKind,
): Promise<ProcessPlantArtifact> => {
  const body = await queryControlInstancePack(controlInstanceId, {
    packId: 'process-plant',
    kind: 'process-plant.artifact.read',
    payload: { systemId, artifact },
  })
  const result = requireOkResult(body.response)
  const metadata = assertObject(result.metadata, 'process plant artifact result requires metadata')
  const language = assertString(result.language, 'process plant artifact result requires language')
  if (language !== 'json' && language !== 'mermaid') throw new Error(`unsupported process plant artifact language: ${language}`)
  const returnedArtifact = assertString(result.artifact, 'process plant artifact result requires artifact')
  if (returnedArtifact !== 'authored-spec' && returnedArtifact !== 'compiled-graph-mermaid') {
    throw new Error(`unsupported process plant artifact kind: ${returnedArtifact}`)
  }
  return {
    systemId: assertString(result.systemId, 'process plant artifact result requires systemId'),
    artifact: returnedArtifact,
    title: assertString(result.title, 'process plant artifact result requires title'),
    language,
    content: assertString(result.content, 'process plant artifact result requires content'),
    components: assertArray(result.components, 'process plant artifact result requires components').map(parseProcessPlantArtifactComponent),
    sourceFiles: assertArray(result.sourceFiles, 'process plant artifact result requires sourceFiles').map(parseProcessPlantArtifactSourceFile),
    metadata: {
      specId: assertString(metadata.specId, 'process plant artifact metadata requires specId'),
      componentCount: assertNumber(metadata.componentCount, 'process plant artifact metadata requires componentCount'),
      linkCount: assertNumber(metadata.linkCount, 'process plant artifact metadata requires linkCount'),
      variableCount: assertNumber(metadata.variableCount, 'process plant artifact metadata requires variableCount'),
      overviewComponentCount: assertNumber(metadata.overviewComponentCount, 'process plant artifact metadata requires overviewComponentCount'),
    },
  }
}
