import { z } from 'zod'
import { createHash } from 'node:crypto'
import { perspectiveAdmissionSchema } from '@leitbild/contracts'
import { idSchema, simulationRunIdSchema } from '../model/ids.ts'

export const perspectiveRoleDigest = (roleIds: ReadonlyArray<string>): string => createHash('sha256').update(JSON.stringify([...roleIds].sort())).digest('hex')

/** This relationship is World-private and is never a discovery or context publication. */
export const storedPerspectiveSchema = z.object({
  admission: perspectiveAdmissionSchema,
  runId: simulationRunIdSchema,
  roleIds: z.array(idSchema).min(1),
  prepareRequestId: z.string().uuid(),
}).strict().superRefine((record, context) => {
  if (record.admission.runtimeAvailability !== undefined) context.addIssue({ code: 'custom', path: ['admission', 'runtimeAvailability'], message: 'Runtime availability is derived on read and is never persisted' })
  if (new Set(record.roleIds).size !== record.roleIds.length || perspectiveRoleDigest(record.roleIds) !== record.admission.roleSetDigest) context.addIssue({ code: 'custom', path: ['roleIds'], message: 'Stored held roles must match the exact admission digest' })
})
export type StoredPerspective = z.infer<typeof storedPerspectiveSchema>

export const perspectiveFailure = (code: string, message: string, status = 403, details?: Readonly<Record<string, unknown>>) =>
  Object.assign(new Error(message), { domain: 'world-perspective' as const, code, status, ...(details === undefined ? {} : { details }) })
export const isPerspectiveFailure = (error: unknown): error is Error & { code: string; status: number; details?: Readonly<Record<string, unknown>> } =>
  error instanceof Error && 'domain' in error && error.domain === 'world-perspective'
