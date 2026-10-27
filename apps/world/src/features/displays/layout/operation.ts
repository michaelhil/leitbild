import type { TopologyBinding, TopologyGraph } from '../../../core/observation/topology.ts'
import type { VignetteValue } from '../compose/model.ts'

/** Owner-declared drawing semantics; neither physical geometry nor live state. */
interface LayoutTopologyReadings {
  readonly bindings: ReadonlyArray<TopologyBinding>
  /** The declarations of every binding/guard explicitly acquired in this read. */
  readonly values: ReadonlyArray<VignetteValue>
}
export interface LayoutConnectionEnd { readonly elementId: string; readonly label: string; readonly port: string }
export type LayoutSubjectTopology = LayoutTopologyReadings & (
  | { readonly kind: 'node'; readonly class: TopologyGraph['nodes'][number]['class']; readonly equipmentKind: string }
  | { readonly kind: 'connection'; readonly from: LayoutConnectionEnd; readonly to: LayoutConnectionEnd; readonly medium: TopologyGraph['media'][number]; readonly directed: boolean }
)
export interface LayoutOperationalSubject {
  readonly elementId: string
  readonly label: string
  readonly topology?: LayoutSubjectTopology
}
