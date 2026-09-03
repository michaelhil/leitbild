export type RequestError = Error & {
  readonly status: number
  readonly code?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export const request = async <T>(path: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(path, options)
  if (response.status === 204) return undefined as T
  const body = await response.json() as T & { error?: { code?: string; message?: string; details?: Readonly<Record<string, unknown>> } }
  if (!response.ok) throw Object.assign(new Error(body.error?.message ?? `Request failed: ${response.status}`), {
    status: response.status,
    ...(body.error?.code === undefined ? {} : { code: body.error.code }),
    ...(body.error?.details === undefined ? {} : { details: body.error.details }),
  }) satisfies RequestError
  return body
}

export const jsonRequest = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
