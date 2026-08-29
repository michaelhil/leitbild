import { createHash } from 'node:crypto'
import {
  accessContextSchema,
  newRequestId,
  requestIdSchema,
  workspaceIdSchema,
  type AccessContext,
  type WorkspaceId,
} from '@samsinn-leitbild/platform-contracts'
import { assertValidInstanceId } from '../paths.ts'

const legacyInstanceNamespace = 'samsinn-legacy-instance-workspace-v1'

export const workspaceIdForLegacyInstance = (instanceId: string): WorkspaceId => {
  assertValidInstanceId(instanceId)
  const bytes = Uint8Array.from(createHash('sha256').update(`${legacyInstanceNamespace}:${instanceId}`).digest().subarray(0, 16))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Buffer.from(bytes).toString('hex')
  return workspaceIdSchema.parse(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`)
}

export const createOpenAccessContext = (workspaceId: WorkspaceId, req: Request): AccessContext => {
  const suppliedRequestId = req.headers.get('x-request-id')
  const requestId = suppliedRequestId === null ? newRequestId() : requestIdSchema.parse(suppliedRequestId)
  const correlationId = req.headers.get('x-correlation-id')
  return accessContextSchema.parse({
    workspaceId,
    requestId,
    actor: { kind: 'anonymous' },
    ...(correlationId === null ? {} : { correlationId }),
  })
}
