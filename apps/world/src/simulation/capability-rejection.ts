import { z } from 'zod'

export const capabilityRejectionCodes = [
  'capability_input_rejected',
  'capability_target_not_found',
  'capability_work_limit',
] as const

export type CapabilityRejectionCode = typeof capabilityRejectionCodes[number]

export type CapabilityRejection = Error & {
  readonly code: CapabilityRejectionCode
  readonly status: 400 | 404 | 422
}

const statusFor = (code: CapabilityRejectionCode): CapabilityRejection['status'] =>
  code === 'capability_target_not_found' ? 404
    : code === 'capability_work_limit' ? 422
      : 400

export const capabilityRejection = (code: CapabilityRejectionCode, message: string): CapabilityRejection =>
  Object.assign(new Error(message), { code, status: statusFor(code) })

export const rejectCapability = (code: CapabilityRejectionCode, message: string): never => {
  throw capabilityRejection(code, message)
}

export const rejectCapabilityInput = (message: string): never =>
  rejectCapability('capability_input_rejected', message)

export const rejectCapabilityTarget = (message: string): never =>
  rejectCapability('capability_target_not_found', message)

export const rejectCapabilityWork = (message: string): never =>
  rejectCapability('capability_work_limit', message)

export const isCapabilityRejection = (error: unknown): error is CapabilityRejection =>
  error instanceof Error
  && 'code' in error
  && capabilityRejectionCodes.includes((error as { code: CapabilityRejectionCode }).code)

/** Caller mistakes are valid runtime interactions. They must be returned to the
 * caller without falsely degrading an otherwise healthy Pack Runtime. */
export const isExpectedCapabilityRejection = (error: unknown): boolean =>
  error instanceof z.ZodError || isCapabilityRejection(error)
