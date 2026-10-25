import { z } from 'zod'
const point = z.tuple([z.number().finite(), z.number().finite()])
const ring = z.array(point).min(4).refine(points => points[0]![0] === points.at(-1)![0] && points[0]![1] === points.at(-1)![1], 'Pavement rings must close')
export const pavementSurfaceSchema = z.array(z.array(ring).min(1)).min(1)
export const circulationNetworkSchema = z.object({
  surfaceTolerance: z.number().finite().positive(),
  nodes: z.array(z.object({ id: z.string().min(1), position: point, kind: z.enum(['junction', 'entrance', 'terminal']) }).strict()),
  edges: z.array(z.object({ id: z.string().min(1), from: z.string().min(1), to: z.string().min(1), width: z.number().finite().positive(), turnRadius: z.number().finite().positive(), path: z.array(point).min(2), class: z.enum(['service', 'access', 'pedestrian']) }).strict()),
}).strict().superRefine((network, context) => {
  const ids = new Set(network.nodes.map(node => node.id))
  if (ids.size !== network.nodes.length || new Set(network.edges.map(edge => edge.id)).size !== network.edges.length) context.addIssue({ code: 'custom', message: 'Circulation identities must be unique' })
  for (const edge of network.edges) {
    const start = network.nodes.find(node => node.id === edge.from), end = network.nodes.find(node => node.id === edge.to)
    if (!start || !end) { context.addIssue({ code: 'custom', message: `Unresolved road endpoint: ${edge.id}` }); continue }
    if (edge.path[0]!.some((value, axis) => value !== start.position[axis]) || edge.path.at(-1)!.some((value, axis) => value !== end.position[axis])) context.addIssue({ code: 'custom', message: `Road endpoints disagree with their nodes: ${edge.id}` })
    if (edge.path.some((point, index) => index > 0 && point[0] === edge.path[index - 1]![0] && point[1] === edge.path[index - 1]![1])) context.addIssue({ code: 'custom', message: `Zero-length road edge: ${edge.id}` })
  }
})
export type CirculationNetwork = z.infer<typeof circulationNetworkSchema>
