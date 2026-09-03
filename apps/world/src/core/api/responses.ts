export const json = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })

export interface ApiErrorBody {
  readonly error: {
    readonly code: string
    readonly message: string
    readonly details?: Readonly<Record<string, unknown>>
  }
}

export const apiError = (status: number, code: string, message: string, details?: Readonly<Record<string, unknown>>): Response =>
  json({ error: { code, message, ...(details === undefined ? {} : { details }) } } satisfies ApiErrorBody, { status })

export const readJson = async (req: Request): Promise<unknown> => {
  const text = await req.text()
  if (text.trim().length === 0) return {}
  return JSON.parse(text) as unknown
}
