import type {
  ModuleBinding,
  ModuleDiscovery,
  WorkspaceId,
} from '@samsinn-leitbild/platform-contracts'

export type { LeitbildMirrorConfig } from '../../core/types/room.ts'

export type LeitbildManifestSummary = ModuleDiscovery

export interface LeitbildWorkspaceConnection {
  readonly moduleBinding: ModuleBinding
  readonly workspaceId: WorkspaceId
}

export interface ResolvedLeitbildAgentBinding extends LeitbildWorkspaceConnection {
  readonly simulationRunId: string
  readonly role: 'observer' | 'operator'
}

export const REQUIRED_LINK_RELS = [
  'self',
  'workspaces',
  'workspace',
  'scenarios',
  'scenario',
  'simulationRuns',
  'simulationRun',
  'simulationRunSnapshot',
  'simulationRunEvents',
  'simulationRunPackQueries',
  'simulationRunCapabilities',
  'simulationRunCommands',
  'realtime',
] as const

export interface LeitbildEvent {
  readonly seq: number
  readonly type: string
  readonly id?: string
  readonly [key: string]: unknown
}

export type LeitbildEventHandler = (event: LeitbildEvent) => void

export interface SubscriptionHandle {
  readonly close: () => void
  readonly lastSeq: () => number
}

export interface SimulationRunSnapshot {
  readonly seq: number
  readonly clock?: {
    readonly currentTime?: string
    readonly paused?: boolean
    readonly speed?: number
  }
  readonly objects?: ReadonlyArray<unknown>
  readonly scenarioId?: string
  readonly [key: string]: unknown
}

export interface SimulationRunSummary {
  readonly id: string
  readonly scenarioId: string | null
  readonly scenarioRevisionId: string | null
  readonly createdAt: string | null
  readonly loaded: boolean
  readonly snapshotSeq: number | null
  readonly objectCount: number | null
  readonly loadError?: string
  readonly websocketClientCount: number
}

export interface ScenarioSummary {
  readonly id: string
  readonly title?: string
  readonly description?: string
  readonly [key: string]: unknown
}
