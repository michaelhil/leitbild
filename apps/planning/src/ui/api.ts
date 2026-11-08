import { z } from 'zod'
import { moduleResourceDescriptorSchema, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { studySchema, candidateSchema } from '../study-model.ts'

export const demoSchema = z.object({ id: z.enum(['response', 'component-work']), title: z.string(), description: z.string() })
export type Demo = z.infer<typeof demoSchema>
export const comparisonSchema = z.object({
  candidates: z.array(candidateSchema), sameProblem: z.boolean(), comparable: z.boolean(),
  pairs: z.array(z.object({ left: z.string(), right: z.string(), lexicographic: z.number().optional(), leftDominates: z.boolean().optional(), rightDominates: z.boolean().optional(), warning: z.string().optional() })),
})
export type Comparison = z.infer<typeof comparisonSchema>

type PlanningTransport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export const createPlanningClient = (workspaceId: string, transport: PlanningTransport = fetch) => {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}`
  const read = async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await transport(path, init)
    const body: unknown = await response.json()
    if (!response.ok) {
      const failure = z.object({ error: z.object({ message: z.string(), code: z.string().optional() }) }).safeParse(body)
      throw new Error(failure.success ? failure.data.error.message : `Request failed (${response.status})`)
    }
    return body
  }
  const invoke = async <T>(operation: string, input: unknown, schema: z.ZodType<T>, studyId?: string): Promise<T> => {
    const resource = studyId ? { workspaceId, moduleId: 'planning', type: 'planning.study', id: studyId } : undefined
    const body = await read(`${base}/capabilities/${encodeURIComponent(operation)}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, actor: { kind: 'human' }, ...(resource ? { resource } : {}) }),
    })
    return z.object({ result: schema }).parse(body).result
  }
  return {
    invoke,
    demos: () => invoke('planning.demos.read', {}, z.object({ demos: z.array(demoSchema) })),
    resources: async () => z.object({ resources: z.array(moduleResourceDescriptorSchema) }).parse(await read(`${base}/resources`)).resources,
    study: (id: string) => invoke('planning.study.read', { section: 'all' }, studySchema, id),
    demo: (id: Demo['id']) => invoke('planning.demo.start', { case: id }, z.object({ study: studySchema, resource: workspaceResourceReferenceSchema })),
    solve: (id: string, expectedRevision: number) => invoke('planning.study.solve', { expectedRevision }, z.object({ study: studySchema, candidate: candidateSchema }), id),
    baseline: (id: string, expectedRevision: number, candidateId: string) => invoke('planning.study.baseline.set', { expectedRevision, candidateId }, studySchema, id),
    refresh: (studyId: string, expectedRevision: number) => invoke('planning.sources.refresh', { studyId, expectedRevision }, z.object({ study: studySchema, changed: z.boolean() })),
    compare: (id: string, candidateIds: string[]) => invoke('planning.study.compare', { candidateIds }, comparisonSchema, id),
    revise: (id: string, input: unknown) => invoke('planning.study.revise', input, studySchema, id),
  }
}
