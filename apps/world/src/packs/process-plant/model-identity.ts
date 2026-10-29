import { createHash } from 'node:crypto'
import type { CompiledPlantGraph, PlantGraphSpec } from './graph/index.ts'

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// Operator wording is deliberately outside numerical/model identity.
const withoutPresentation = <T extends { readonly metadata?: { readonly presentation?: unknown } | undefined }>(item: T): T => {
  if (item.metadata?.presentation === undefined) return item
  const { presentation: _presentation, ...metadata } = item.metadata
  if (Object.keys(metadata).length > 0) return { ...item, metadata }
  const { metadata: _metadata, ...rest } = item
  return rest as T
}

/** Cache key for compiling one authored graph against this process's component library. */
export const processPlantSourceDigest = (graph: PlantGraphSpec): string => hash({
  ...graph,
  components: graph.components.map(withoutPresentation),
  connections: graph.connections.map(withoutPresentation),
})

const libraryDigests = new WeakMap<CompiledPlantGraph, string>()

/**
 * A source graph alone does not describe the runtime variable table: reusable
 * component definitions add variables, parsed defaults, ports and semantics.
 * Include their resolved contribution so a changed table cannot retain an old
 * checkpoint/layout/evidence identity. Code revision remains separate provenance.
 */
export const processPlantModelDigest = (sourceDigest: string, graph: CompiledPlantGraph): string => {
  let libraryDigest = libraryDigests.get(graph)
  if (libraryDigest === undefined) {
    libraryDigest = hash({
      components: graph.components.map(({ id, kind, parameters, ports, semantics }) => ({ id, kind, parameters, ports, semantics })),
      variables: graph.variables,
    })
    libraryDigests.set(graph, libraryDigest)
  }
  return hash({ sourceDigest, libraryDigest })
}
