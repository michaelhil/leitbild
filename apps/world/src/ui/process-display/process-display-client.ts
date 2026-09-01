import type { OperationalObject, SimulationRunId } from '../../core/model/index.ts'
import type { VariablePath } from '../../packs/process-plant/graph/index.ts'
import type {
  CompiledProcessDisplay,
  ProcessDisplayAlarmAnnunciator,
  ProcessDisplayAlarmLifecycle,
  ProcessDisplayAlarmSnapshot,
  ProcessDisplayAlarmSeverity,
  ProcessDisplayGraphLens,
  ProcessDisplayValue,
} from '../../packs/process-plant/displays/index.ts'
import { querySimulationRunPack } from '../simulation-run-client.ts'

export interface ProcessDisplayLensOption {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly lens?: ProcessDisplayGraphLens
}

export interface ProcessDisplayListItem {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly lenses: ReadonlyArray<ProcessDisplayLensOption>
}

export interface ProcessDisplaySnapshot {
  readonly plantId: string
  readonly displayId: string
  readonly values: ReadonlyArray<ProcessDisplayValue>
  readonly alarms: ProcessDisplayAlarmSnapshot
}

export const emptyProcessDisplayAlarmSnapshot: ProcessDisplayAlarmSnapshot = {
  configured: false,
  activeAlarmCount: 0,
  activeTripCount: 0,
  unacknowledgedCount: 0,
  firstOutCount: 0,
  activeHighestSeverity: null,
  activeFirstOut: [],
  active: [],
}

export interface ProcessDisplayProjection {
  readonly plantId: string
  readonly displayId: string
  readonly graphProjection: {
    readonly componentIds: ReadonlyArray<string>
    readonly connectionIds: ReadonlyArray<string>
    readonly diagnostics: ReadonlyArray<Record<string, unknown>>
  }
  readonly displayProjection: {
    readonly visibleWidgetIds: ReadonlyArray<string>
    readonly visiblePathIds: ReadonlyArray<string>
    readonly hiddenWidgetIds: ReadonlyArray<string>
    readonly hiddenPathIds: ReadonlyArray<string>
  }
}

export type ProcessPlantArtifactKind = 'authored-spec' | 'compiled-graph-mermaid'

export interface ProcessPlantArtifactComponent {
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly shownOnOverview: boolean
}

export interface ProcessPlantArtifact {
  readonly plantId: string
  readonly artifact: ProcessPlantArtifactKind
  readonly title: string
  readonly language: 'json' | 'mermaid'
  readonly content: string
  readonly components: ReadonlyArray<ProcessPlantArtifactComponent>
  readonly metadata: {
    readonly specId: string
    readonly componentCount: number
    readonly linkCount: number
    readonly variableCount: number
    readonly overviewComponentCount: number
  }
}

export interface ProcessPlantCatalogEntry {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly compatibleModelRefs?: ReadonlyArray<string>
  readonly parameters?: Readonly<Record<string, unknown>>
}

export interface ProcessPlantActionParameter {
  readonly id: string
  readonly label: string
  readonly unit: string
  readonly defaultValue: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly digits: number
}

export interface ProcessPlantActionCatalogEntry extends Omit<ProcessPlantCatalogEntry, 'parameters'> {
  readonly parameters: ReadonlyArray<ProcessPlantActionParameter>
  readonly inputSchema: Readonly<Record<string, unknown>>
}

export interface ProcessPlantCatalog {
  readonly models: ReadonlyArray<ProcessPlantCatalogEntry>
  readonly operatingPoints: ReadonlyArray<ProcessPlantCatalogEntry>
  readonly automations: ReadonlyArray<ProcessPlantCatalogEntry>
  readonly actions: ReadonlyArray<ProcessPlantActionCatalogEntry>
  readonly assessments: ReadonlyArray<ProcessPlantCatalogEntry>
  readonly recordingProfiles: ReadonlyArray<ProcessPlantCatalogEntry>
  readonly displays: ReadonlyArray<ProcessPlantCatalogEntry>
  readonly credibilityEvidence: ReadonlyArray<ProcessPlantCatalogEntry>
}

export const processPlantIdForObject = (
  object: Pick<OperationalObject, 'id' | 'packId'>,
): string | null => object.packId === 'process-plant' ? String(object.id) : null

export type ProcessPlantCredibilityArtifactLanguage = 'json' | 'svg'

export interface ProcessPlantCredibilityArtifactRef {
  readonly id: string
  readonly title: string
  readonly language: ProcessPlantCredibilityArtifactLanguage
  readonly contentType: string
  readonly path: string
}

export interface ProcessPlantCredibilityEvidence {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly scope: string
  readonly generatedFromCommand: string
  readonly artifacts: ReadonlyArray<ProcessPlantCredibilityArtifactRef>
}

export interface ProcessPlantCredibilityList {
  readonly plantId: string
  readonly evidence: ReadonlyArray<ProcessPlantCredibilityEvidence>
}

export interface ProcessPlantCredibilityArtifact {
  readonly plantId: string
  readonly evidence: ProcessPlantCredibilityEvidence
  readonly artifact: ProcessPlantCredibilityArtifactRef
  readonly content: string
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
  const envelope = assertObject(value, 'process display query returned a malformed response')
  if (envelope.ok !== true) throw new Error(typeof envelope.reason === 'string' ? envelope.reason : 'process display query failed')
  return assertObject(envelope.result, 'process display query returned a malformed result')
}

const parseLensOption = (value: unknown): ProcessDisplayLensOption => {
  const lens = assertObject(value, 'process display lens option is malformed')
  return {
    id: assertString(lens.id, 'process display lens option requires id'),
    label: assertString(lens.label, 'process display lens option requires label'),
    ...(typeof lens.description === 'string' ? { description: lens.description } : {}),
    ...(lens.lens === undefined ? {} : { lens: assertObject(lens.lens, 'process display lens option has malformed lens') as unknown as ProcessDisplayGraphLens }),
  }
}

const parseDisplayValues = (value: unknown): ReadonlyArray<ProcessDisplayValue> =>
  assertArray(value, 'process display snapshot result has no values array').map(item => {
    const record = assertObject(item, 'process display value is malformed')
    return {
      path: assertString(record.path, 'process display value requires path') as ProcessDisplayValue['path'],
      label: assertString(record.label, 'process display value requires label'),
      unit: assertString(record.unit, 'process display value requires unit'),
      value: record.value,
      formatted: assertString(record.formatted, 'process display value requires formatted'),
    }
  })

const parseAlarmSeverity = (value: unknown): ProcessDisplayAlarmSeverity => {
  if (value === 'info' || value === 'notice' || value === 'warning' || value === 'critical') return value
  throw new Error('process display alarm lifecycle has invalid severity')
}

const parseAlarmPriority = (value: unknown): NonNullable<ProcessDisplayAlarmLifecycle['annunciator']>['priority'] => {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'urgent') return value
  throw new Error('process display alarm annunciator has invalid priority')
}

const parseAlarmRole = (value: unknown): NonNullable<ProcessDisplayAlarmLifecycle['annunciator']>['role'] => {
  if (value === 'symptom' || value === 'cause' || value === 'automaticAction' || value === 'status') return value
  throw new Error('process display alarm annunciator has invalid role')
}

const parseOptionalNumber = (value: unknown, message: string): number | undefined => {
  if (value === undefined) return undefined
  return assertNumber(value, message)
}

const parseAlarmAnnunciator = (value: unknown): ProcessDisplayAlarmAnnunciator | undefined => {
  if (value === undefined) return undefined
  const annunciator = assertObject(value, 'process display alarm annunciator is malformed')
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

const parseAlarmLifecycle = (value: unknown): ProcessDisplayAlarmLifecycle => {
  const lifecycle = assertObject(value, 'process display alarm lifecycle is malformed')
  const kind = lifecycle.kind
  if (kind !== 'alarm' && kind !== 'trip') throw new Error('process display alarm lifecycle has invalid kind')
  const parsedAnnunciator = parseAlarmAnnunciator(lifecycle.annunciator)
  const firstOutRank = parseOptionalNumber(lifecycle.firstOutRank, 'process display alarm lifecycle has invalid firstOutRank')
  const firstActiveElapsedMs = parseOptionalNumber(lifecycle.firstActiveElapsedMs, 'process display alarm lifecycle has invalid firstActiveElapsedMs')
  const lastActiveElapsedMs = parseOptionalNumber(lifecycle.lastActiveElapsedMs, 'process display alarm lifecycle has invalid lastActiveElapsedMs')
  const lastClearedElapsedMs = parseOptionalNumber(lifecycle.lastClearedElapsedMs, 'process display alarm lifecycle has invalid lastClearedElapsedMs')
  return {
    id: assertString(lifecycle.id, 'process display alarm lifecycle requires id'),
    kind,
    title: assertString(lifecycle.title, 'process display alarm lifecycle requires title'),
    message: assertString(lifecycle.message, 'process display alarm lifecycle requires message'),
    severity: parseAlarmSeverity(lifecycle.severity),
    phase: assertString(lifecycle.phase, 'process display alarm lifecycle requires phase'),
    active: assertBoolean(lifecycle.active, 'process display alarm lifecycle requires active'),
    acknowledged: assertBoolean(lifecycle.acknowledged, 'process display alarm lifecycle requires acknowledged'),
    firstOut: assertBoolean(lifecycle.firstOut, 'process display alarm lifecycle requires firstOut'),
    resettable: assertBoolean(lifecycle.resettable, 'process display alarm lifecycle requires resettable'),
    ...(parsedAnnunciator === undefined ? {} : { annunciator: parsedAnnunciator }),
    ...(firstOutRank === undefined ? {} : { firstOutRank }),
    ...(firstActiveElapsedMs === undefined ? {} : { firstActiveElapsedMs }),
    ...(lastActiveElapsedMs === undefined ? {} : { lastActiveElapsedMs }),
    ...(lastClearedElapsedMs === undefined ? {} : { lastClearedElapsedMs }),
  }
}

const parseAlarmSnapshot = (value: unknown): ProcessDisplayAlarmSnapshot => {
  const snapshot = assertObject(value, 'process display snapshot result has no alarms object')
  const activeHighestSeverity = snapshot.activeHighestSeverity
  if (activeHighestSeverity !== null && activeHighestSeverity !== undefined) parseAlarmSeverity(activeHighestSeverity)
  return {
    configured: assertBoolean(snapshot.configured, 'process display alarm snapshot requires configured'),
    activeAlarmCount: assertNumber(snapshot.activeAlarmCount, 'process display alarm snapshot requires activeAlarmCount'),
    activeTripCount: assertNumber(snapshot.activeTripCount, 'process display alarm snapshot requires activeTripCount'),
    unacknowledgedCount: assertNumber(snapshot.unacknowledgedCount, 'process display alarm snapshot requires unacknowledgedCount'),
    firstOutCount: assertNumber(snapshot.firstOutCount, 'process display alarm snapshot requires firstOutCount'),
    activeHighestSeverity: activeHighestSeverity === null || activeHighestSeverity === undefined ? null : parseAlarmSeverity(activeHighestSeverity),
    activeFirstOut: assertArray(snapshot.activeFirstOut, 'process display alarm snapshot requires activeFirstOut').map(parseAlarmLifecycle),
    active: assertArray(snapshot.active, 'process display alarm snapshot requires active').map(parseAlarmLifecycle),
  }
}

const parseCompiledProcessDisplay = (value: unknown): CompiledProcessDisplay => {
  const display = assertObject(value, 'process display read result has no display')
  const designSize = assertObject(display.designSize, 'process display requires designSize')
  if (typeof designSize.width !== 'number' || typeof designSize.height !== 'number') {
    throw new Error('process display designSize requires numeric width and height')
  }
  return {
    id: assertString(display.id, 'process display requires id'),
    title: assertString(display.title, 'process display requires title'),
    ...(typeof display.description === 'string' ? { description: display.description } : {}),
    designSize: { width: designSize.width, height: designSize.height },
    lenses: assertArray(display.lenses, 'process display requires lenses').map(parseLensOption),
    widgets: assertArray(display.widgets, 'process display requires widgets') as CompiledProcessDisplay['widgets'],
    paths: assertArray(display.paths, 'process display requires paths') as CompiledProcessDisplay['paths'],
    bindingPaths: assertArray(display.bindingPaths, 'process display requires bindingPaths') as CompiledProcessDisplay['bindingPaths'],
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
  }
}

const parseProcessPlantCatalogEntry = (value: unknown): ProcessPlantCatalogEntry => {
  const entry = assertObject(value, 'process plant catalog entry is malformed')
  return {
    id: assertString(entry.id, 'process plant catalog entry requires id'),
    title: assertString(entry.title, 'process plant catalog entry requires title'),
    ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
    ...(entry.compatibleModelRefs === undefined ? {} : {
      compatibleModelRefs: assertArray(entry.compatibleModelRefs, 'process plant catalog compatibleModelRefs must be an array')
        .map(ref => assertString(ref, 'process plant catalog compatible model ref must be a string')),
    }),
    ...(entry.parameters !== undefined && !Array.isArray(entry.parameters)
      ? { parameters: assertObject(entry.parameters, 'process plant catalog parameters must be an object') }
      : {}),
  }
}

const parseProcessPlantActionParameter = (value: unknown): ProcessPlantActionParameter => {
  const parameter = assertObject(value, 'process plant action parameter is malformed')
  return {
    id: assertString(parameter.id, 'process plant action parameter requires id'),
    label: assertString(parameter.label, 'process plant action parameter requires label'),
    unit: assertString(parameter.unit, 'process plant action parameter requires unit'),
    defaultValue: assertNumber(parameter.defaultValue, 'process plant action parameter requires defaultValue'),
    min: assertNumber(parameter.min, 'process plant action parameter requires min'),
    max: assertNumber(parameter.max, 'process plant action parameter requires max'),
    step: assertNumber(parameter.step, 'process plant action parameter requires step'),
    digits: assertNumber(parameter.digits, 'process plant action parameter requires digits'),
  }
}

const parseProcessPlantAction = (value: unknown): ProcessPlantActionCatalogEntry => {
  const entry = assertObject(value, 'process plant action is malformed')
  const base = parseProcessPlantCatalogEntry(entry)
  return {
    ...base,
    parameters: assertArray(entry.parameters, 'process plant action requires parameters').map(parseProcessPlantActionParameter),
    inputSchema: assertObject(entry.inputSchema, 'process plant action requires inputSchema'),
  }
}

export const readProcessPlantCatalog = async (
  simulationRunId: SimulationRunId,
): Promise<ProcessPlantCatalog> => {
  const body = await querySimulationRunPack(simulationRunId, {
    packId: 'process-plant',
    kind: 'process-plant.catalog.list',
    payload: {},
  })
  const result = requireOkResult(body.response)
  return {
    models: assertArray(result.models, 'process plant catalog result has no models array').map(parseProcessPlantCatalogEntry),
    operatingPoints: assertArray(result.operatingPoints, 'process plant catalog result has no operatingPoints array').map(parseProcessPlantCatalogEntry),
    automations: assertArray(result.automations, 'process plant catalog result has no automations array').map(parseProcessPlantCatalogEntry),
    actions: assertArray(result.actions, 'process plant catalog result has no actions array').map(parseProcessPlantAction),
    assessments: assertArray(result.assessments, 'process plant catalog result has no assessments array').map(parseProcessPlantCatalogEntry),
    recordingProfiles: assertArray(result.recordingProfiles, 'process plant catalog result has no recordingProfiles array').map(parseProcessPlantCatalogEntry),
    displays: assertArray(result.displays, 'process plant catalog result has no displays array').map(parseProcessPlantCatalogEntry),
    credibilityEvidence: assertArray(result.credibilityEvidence, 'process plant catalog result has no credibilityEvidence array').map(parseProcessPlantCatalogEntry),
  }
}

const parseProcessPlantCredibilityArtifactLanguage = (value: unknown): ProcessPlantCredibilityArtifactLanguage => {
  const language = assertString(value, 'process plant credibility artifact requires language')
  if (language !== 'json' && language !== 'svg') throw new Error(`unsupported process plant credibility artifact language: ${language}`)
  return language
}

const parseProcessPlantCredibilityArtifactRef = (value: unknown): ProcessPlantCredibilityArtifactRef => {
  const artifact = assertObject(value, 'process plant credibility artifact ref is malformed')
  return {
    id: assertString(artifact.id, 'process plant credibility artifact requires id'),
    title: assertString(artifact.title, 'process plant credibility artifact requires title'),
    language: parseProcessPlantCredibilityArtifactLanguage(artifact.language),
    contentType: assertString(artifact.contentType, 'process plant credibility artifact requires contentType'),
    path: assertString(artifact.path, 'process plant credibility artifact requires path'),
  }
}

const parseProcessPlantCredibilityEvidence = (value: unknown): ProcessPlantCredibilityEvidence => {
  const evidence = assertObject(value, 'process plant credibility evidence is malformed')
  return {
    id: assertString(evidence.id, 'process plant credibility evidence requires id'),
    title: assertString(evidence.title, 'process plant credibility evidence requires title'),
    description: assertString(evidence.description, 'process plant credibility evidence requires description'),
    scope: assertString(evidence.scope, 'process plant credibility evidence requires scope'),
    generatedFromCommand: assertString(evidence.generatedFromCommand, 'process plant credibility evidence requires generatedFromCommand'),
    artifacts: assertArray(evidence.artifacts, 'process plant credibility evidence requires artifacts').map(parseProcessPlantCredibilityArtifactRef),
  }
}

export const listProcessPlantCredibilityEvidence = async (
  simulationRunId: SimulationRunId,
  plantId: string,
): Promise<ProcessPlantCredibilityList> => {
  const body = await querySimulationRunPack(simulationRunId, {
    packId: 'process-plant',
    kind: 'process-plant.credibility.list',
    payload: { plantId },
  })
  const result = requireOkResult(body.response)
  return {
    plantId: assertString(result.plantId, 'process plant credibility list requires plantId'),
    evidence: assertArray(result.evidence, 'process plant credibility list requires evidence').map(parseProcessPlantCredibilityEvidence),
  }
}

export const readProcessPlantCredibilityArtifact = async (
  simulationRunId: SimulationRunId,
  plantId: string,
  evidenceId: string,
  artifactId: string,
): Promise<ProcessPlantCredibilityArtifact> => {
  const body = await querySimulationRunPack(simulationRunId, {
    packId: 'process-plant',
    kind: 'process-plant.credibility.read',
    payload: { plantId, evidenceId, artifactId },
  })
  const result = requireOkResult(body.response)
  return {
    plantId: assertString(result.plantId, 'process plant credibility read requires plantId'),
    evidence: parseProcessPlantCredibilityEvidence(result.evidence),
    artifact: parseProcessPlantCredibilityArtifactRef(result.artifact),
    content: assertString(result.content, 'process plant credibility artifact requires content'),
  }
}

export const listProcessPlantVariablePaths = async (
  simulationRunId: SimulationRunId,
  plantId: string,
): Promise<ReadonlyArray<VariablePath>> => {
  const body = await querySimulationRunPack(simulationRunId, {
    packId: 'process-plant',
    kind: 'process-plant.variables.search',
    payload: { plantId },
  })
  const result = requireOkResult(body.response)
  const plants = assertArray(result.plants, 'process plant variables search result has no plants array')
  for (const item of plants) {
    const plant = assertObject(item, 'process plant variables search plant is malformed')
    if (assertString(plant.plantId, 'process plant variables search plant requires plantId') !== plantId) continue
    return assertArray(plant.variables, 'process plant variables search plant has no variables array')
      .map(variable => assertString(assertObject(variable, 'process plant variable is malformed').path, 'process plant variable requires path') as VariablePath)
  }
  throw new Error(`process plant variables search did not return plant ${plantId}`)
}

export const listProcessDisplays = async (
  simulationRunId: SimulationRunId,
  plantId: string,
): Promise<ReadonlyArray<ProcessDisplayListItem>> => {
  const body = await querySimulationRunPack(simulationRunId, {
    packId: 'process-plant',
    kind: 'process-plant.displays.list',
    payload: { plantId },
  })
  const result = requireOkResult(body.response)
  return assertArray(result.displays, 'process display list result has no displays array').map(item => {
    const display = assertObject(item, 'process display list item is malformed')
    if (typeof display.id !== 'string' || typeof display.title !== 'string') throw new Error('process display list item requires id and title')
    return {
      id: display.id,
      title: display.title,
      ...(typeof display.description === 'string' ? { description: display.description } : {}),
      lenses: assertArray(display.lenses, 'process display list item requires lenses').map(parseLensOption),
    }
  })
}

export const readProcessDisplay = async (
  simulationRunId: SimulationRunId,
  plantId: string,
  displayId: string,
): Promise<CompiledProcessDisplay> => {
  const body = await querySimulationRunPack(simulationRunId, {
    packId: 'process-plant',
    kind: 'process-plant.display.read',
    payload: { plantId, displayId },
  })
  const result = requireOkResult(body.response)
  return parseCompiledProcessDisplay(result.display)
}

export const readProcessDisplaySnapshot = async (
  simulationRunId: SimulationRunId,
  plantId: string,
  displayId: string,
): Promise<ProcessDisplaySnapshot> => {
  const body = await querySimulationRunPack(simulationRunId, {
    packId: 'process-plant',
    kind: 'process-plant.display.snapshot',
    payload: { plantId, displayId },
  })
  const result = requireOkResult(body.response)
  if (typeof result.plantId !== 'string' || typeof result.displayId !== 'string') throw new Error('process display snapshot result requires plantId and displayId')
  return {
    plantId: result.plantId,
    displayId: result.displayId,
    values: parseDisplayValues(result.values),
    alarms: parseAlarmSnapshot(result.alarms),
  }
}

export const readProcessDisplayProjection = async (
  simulationRunId: SimulationRunId,
  plantId: string,
  displayId: string,
  lens: ProcessDisplayGraphLens,
): Promise<ProcessDisplayProjection> => {
  const body = await querySimulationRunPack(simulationRunId, {
    packId: 'process-plant',
    kind: 'process-plant.display.project',
    payload: { plantId, displayId, lens },
  })
  const result = requireOkResult(body.response)
  if (typeof result.plantId !== 'string' || typeof result.displayId !== 'string') throw new Error('process display projection result requires plantId and displayId')
  const graphProjection = assertObject(result.graphProjection, 'process display projection result has no graphProjection')
  const displayProjection = assertObject(result.displayProjection, 'process display projection result has no displayProjection')
  return {
    plantId: result.plantId,
    displayId: result.displayId,
    graphProjection: {
      componentIds: assertArray(graphProjection.componentIds, 'process display graph projection has no componentIds') as ReadonlyArray<string>,
      connectionIds: assertArray(graphProjection.connectionIds, 'process display graph projection has no connectionIds') as ReadonlyArray<string>,
      diagnostics: assertArray(graphProjection.diagnostics, 'process display graph projection has no diagnostics') as ReadonlyArray<Record<string, unknown>>,
    },
    displayProjection: {
      visibleWidgetIds: assertArray(displayProjection.visibleWidgetIds, 'process display projection has no visibleWidgetIds') as ReadonlyArray<string>,
      visiblePathIds: assertArray(displayProjection.visiblePathIds, 'process display projection has no visiblePathIds') as ReadonlyArray<string>,
      hiddenWidgetIds: assertArray(displayProjection.hiddenWidgetIds, 'process display projection has no hiddenWidgetIds') as ReadonlyArray<string>,
      hiddenPathIds: assertArray(displayProjection.hiddenPathIds, 'process display projection has no hiddenPathIds') as ReadonlyArray<string>,
    },
  }
}

export const readProcessPlantArtifact = async (
  simulationRunId: SimulationRunId,
  plantId: string,
  artifact: ProcessPlantArtifactKind,
): Promise<ProcessPlantArtifact> => {
  const body = await querySimulationRunPack(simulationRunId, {
    packId: 'process-plant',
    kind: 'process-plant.artifact.read',
    payload: { plantId, artifact },
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
    plantId: assertString(result.plantId, 'process plant artifact result requires plantId'),
    artifact: returnedArtifact,
    title: assertString(result.title, 'process plant artifact result requires title'),
    language,
    content: assertString(result.content, 'process plant artifact result requires content'),
    components: assertArray(result.components, 'process plant artifact result requires components').map(parseProcessPlantArtifactComponent),
    metadata: {
      specId: assertString(metadata.specId, 'process plant artifact metadata requires specId'),
      componentCount: assertNumber(metadata.componentCount, 'process plant artifact metadata requires componentCount'),
      linkCount: assertNumber(metadata.linkCount, 'process plant artifact metadata requires linkCount'),
      variableCount: assertNumber(metadata.variableCount, 'process plant artifact metadata requires variableCount'),
      overviewComponentCount: assertNumber(metadata.overviewComponentCount, 'process plant artifact metadata requires overviewComponentCount'),
    },
  }
}
