export type GuidanceFailure = Error & { readonly domain: 'world-guidance'; readonly code: string; readonly status: number }

export const guideFailure = (code: string, message: string, status = 409): GuidanceFailure =>
  Object.assign(new Error(message), { domain: 'world-guidance' as const, code, status })

export const isGuidanceFailure = (error: unknown): error is GuidanceFailure =>
  error instanceof Error && 'domain' in error && error.domain === 'world-guidance'
