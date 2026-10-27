import type { Vector3 } from './math.ts'

/** One prepared architecture mesh in deterministic source/placement order.
 * Matrix is affine, column-major, from source-local to the cohort's local basis;
 * it includes placement bearing and this mesh's level-separation translation. */
export interface PhysicalArchitectureBspSource {
  readonly id: string
  readonly sceneId: string
  readonly assetKey: string
  readonly meshIndex: number
  readonly occurrenceId: string
  readonly matrix: ArrayLike<number>
  /** xyz, source-normal xyz, source-material index: exactly PhysicalMesh.vertices. */
  readonly vertices: ArrayLike<number>
  /** Source-local xyz pairs: six values per authored segment. */
  readonly lines: ArrayLike<number>
  readonly materials: readonly string[]
  readonly lineMaterials?: readonly string[]
  readonly lineStyles?: readonly ('feature' | 'context' | 'section')[]
}
export interface PhysicalArchitectureBspInput {
  readonly key: string
  readonly sources: readonly PhysicalArchitectureBspSource[]
}
export interface PhysicalArchitectureBspFragment {
  readonly kind: 'triangle' | 'line'
  /** Index in result.owners; also the visibility-mask key. */
  readonly ownerIndex: number
  readonly material: string
  readonly strokeStyle?: 'feature' | 'context' | 'section'
  /** Vertex address/count, not float address, in result.vertices. */
  readonly first: number
  readonly count: number
  /** Earlier coincident sources; hidden winners reveal the retained alternative. */
  readonly occludedBy: readonly number[]
}
export interface PhysicalArchitectureBspNode {
  /** Three actual common-basis points; no quantized plane key or metric epsilon. */
  readonly plane: readonly [Vector3, Vector3, Vector3]
  readonly normal: Vector3
  readonly front: number
  readonly back: number
  /** Coplanar faces before original authored strokes. */
  readonly fragments: readonly number[]
}
export interface PhysicalArchitectureBsp {
  readonly key: string
  readonly owners: ReadonlyArray<Pick<PhysicalArchitectureBspSource, 'id' | 'sceneId' | 'assetKey' | 'meshIndex' | 'occurrenceId'>>
  /** Per vertex: common xyz, source normal xyz, source-local xyz (stride 9).
   * Material/owner/style belong to the fragment, never interpolated. */
  readonly vertices: Float64Array
  readonly fragments: readonly PhysicalArchitectureBspFragment[]
  readonly nodes: readonly PhysicalArchitectureBspNode[]
  readonly root: number
  readonly diagnostics: {
    readonly inputTriangles: number
    readonly inputLines: number
    readonly splitPolygons: number
    readonly splitLines: number
    readonly coplanarOverlaps: number
    readonly retainedAlternatives: number
    readonly vertexBytes: number
  }
}
export type PhysicalArchitectureBspPreparer = ((input: PhysicalArchitectureBspInput, signal?: AbortSignal) => Promise<PhysicalArchitectureBsp>) & {
  readonly destroy: () => void
  readonly diagnostics: () => { readonly workers: number; readonly pending: number }
}
