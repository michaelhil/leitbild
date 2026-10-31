import { elementWorld, parameters, type Source } from './native/explorer/source.ts'

/** Authoring-derived overview; no triangle compile or inferred equipment bounds. */
export const explorerBuildingFootprints = (source: Source) => source.elements.filter(element => element.kind === 'building' && element.disposition !== 'removed').map(element => {
  const dimensions = parameters(source, element), pose = elementWorld(source, element), c = Math.cos(pose.yaw), s = Math.sin(pose.yaw)
  const local: Array<[number, number]> = element.footprint === 'ellipse'
    ? Array.from({ length: 33 }, (_, index) => { const angle = index * Math.PI * 2 / 32; return [dimensions.length / 2 + Math.cos(angle) * dimensions.length / 2, dimensions.width / 2 + Math.sin(angle) * dimensions.width / 2] })
    : [[0, 0], [dimensions.length, 0], [dimensions.length, dimensions.width], [0, dimensions.width], [0, 0]]
  const ring = local.map(([x, y]): [number, number] => [pose.position[0] + c * x - s * y - source.origin[0], pose.position[1] + s * x + c * y - source.origin[1]])
  ring[ring.length - 1] = [...ring[0]!]
  return { id: element.id, scopeId: element.id, label: element.label, ring, base: pose.position[2] - source.origin[2], height: dimensions.height }
})
