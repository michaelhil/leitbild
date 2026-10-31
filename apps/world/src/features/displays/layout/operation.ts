import type { TopologyBinding, TopologyGraph } from '../../../core/observation/topology.ts'
import type { VignetteValue } from '../compose/model.ts'

/** Owner-declared drawing semantics; neither physical geometry nor live state. */
interface LayoutTopologyReadings {
  readonly bindings: ReadonlyArray<TopologyBinding>
}
export interface LayoutConnectionEnd { readonly elementId: string; readonly label: string; readonly port: string }
export interface LayoutIncidentConnection {
  readonly id: string
  readonly from: LayoutConnectionEnd
  readonly to: LayoutConnectionEnd
  readonly medium: TopologyGraph['media'][number]
  readonly directed: boolean
}
export type LayoutSubjectTopologyStructure = LayoutTopologyReadings & (
  | { readonly kind: 'node'; readonly class: TopologyGraph['nodes'][number]['class']; readonly equipmentKind: string
      /** Missing means not supplied; empty means known no incident owner connections. */
      readonly connections?: ReadonlyArray<LayoutIncidentConnection> | undefined }
  | { readonly kind: 'connection'; readonly from: LayoutConnectionEnd; readonly to: LayoutConnectionEnd; readonly medium: TopologyGraph['media'][number]; readonly directed: boolean }
)
export type LayoutSubjectTopology = LayoutSubjectTopologyStructure & {
  /** The declarations of every binding/guard explicitly acquired in this read. */
  readonly values: ReadonlyArray<VignetteValue>
}
export interface LayoutOperationalSubject {
  readonly elementId: string
  readonly label: string
  readonly topology?: LayoutSubjectTopology | undefined
}
