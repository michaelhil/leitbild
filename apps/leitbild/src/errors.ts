export type HostError = Error & {
  readonly status: number
  readonly code: string
  readonly retryable: boolean
  readonly details?: Readonly<Record<string, unknown>>
}

export const hostError = (config: {
  readonly status: number
  readonly code: string
  readonly message: string
  readonly retryable?: boolean
  readonly details?: Readonly<Record<string, unknown>>
}): HostError => Object.assign(new Error(config.message), {
  status: config.status,
  code: config.code,
  retryable: config.retryable ?? false,
  ...(config.details === undefined ? {} : { details: config.details }),
})

export const isHostError = (error: unknown): error is HostError =>
  error instanceof Error
  && typeof (error as Partial<HostError>).status === 'number'
  && typeof (error as Partial<HostError>).code === 'string'
  && typeof (error as Partial<HostError>).retryable === 'boolean'
