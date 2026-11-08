export interface PlanningError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: Readonly<Record<string, unknown>>
}

export const planningError = (
  status: number,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): PlanningError => Object.assign(new Error(message), { status, code, ...(details === undefined ? {} : { details }) })

export const isPlanningError = (error: unknown): error is PlanningError =>
  error instanceof Error && 'code' in error && typeof error.code === 'string' && 'status' in error && typeof error.status === 'number'
