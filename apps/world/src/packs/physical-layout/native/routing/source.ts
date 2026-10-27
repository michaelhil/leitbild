import { z } from 'zod'
const id = z.string().min(1).max(200)
const point = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
export const routingBoundsSchema = z.object({ min: point, max: point }).strict().refine(value => value.min.every((v, a) => v < value.max[a]!), 'A routing envelope needs positive volume')
export const routingTerminalSchema = z.object({
  id, elementId: id, subjectId: id, port: id, local: point,
  outward: z.tuple([z.number().int().min(-1).max(1), z.number().int().min(-1).max(1), z.number().int().min(-1).max(1)]).refine(v => v.reduce((sum, n) => sum + Math.abs(n), 0) === 1, 'A terminal needs one outward axis'),
}).strict()
export const routingConnectionSchema = z.object({
  id, graphConnectionId: id, from: id, to: id, kind: z.enum(['pipe', 'electrical']),
  diameter: z.number().finite().positive(), clearance: z.number().finite().nonnegative(), bendRadius: z.number().finite().positive(),
  envelope: routingBoundsSchema, via: z.array(point).optional(),
  material: z.enum(['pipe', 'steam', 'crane']), layerId: id,
}).strict().refine(value => value.from !== value.to, 'A connection needs distinct terminals')
/** Source authoring constraints, not numerical solver geometry. Ports retain the
 * graph's exact component/port identity; the accepted centerline is reproducible. */
export const physicalRoutingSchema = z.object({
  terminals: z.array(routingTerminalSchema), connections: z.array(routingConnectionSchema), obstacleElementIds: z.array(id),
}).strict().superRefine((network, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message })
  for (const [label, ids] of [['terminal', network.terminals.map(t => t.id)], ['connection', network.connections.map(c => c.id)], ['obstacle', network.obstacleElementIds]] as const) if (new Set(ids).size !== ids.length) issue(`Duplicate routing ${label}`)
  const terminals = new Set(network.terminals.map(t => t.id))
  for (const route of network.connections) if (!terminals.has(route.from) || !terminals.has(route.to)) issue(`Unknown routing terminal: ${route.id}`)
})
export type PhysicalRouting = z.infer<typeof physicalRoutingSchema>
export type RoutingConnection = z.infer<typeof routingConnectionSchema>
export type RoutingTerminal = z.infer<typeof routingTerminalSchema>
export type RoutePoint = readonly [number, number, number]
export interface RouteBounds { readonly min: RoutePoint; readonly max: RoutePoint }
