export const request = async <T>(path: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(path, options)
  if (response.status === 204) return undefined as T
  const body = await response.json() as T & { error?: { message?: string } }
  if (!response.ok) throw new Error(body.error?.message ?? `Request failed: ${response.status}`)
  return body
}

export const jsonRequest = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
