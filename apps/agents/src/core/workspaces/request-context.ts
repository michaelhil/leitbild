import {
  accessContextSchema,
  newRequestId,
  requestIdSchema,
  type AccessContext,
  type WorkspaceId,
} from '@leitbild/contracts'

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
