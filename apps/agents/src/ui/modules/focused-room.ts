// A missing Room in an explicit focused URL must never subscribe to the Workspace.
export const focusedRoomFor = (params: URLSearchParams): string | null | undefined =>
  params.get('view') === 'focused' ? params.get('room')?.trim() || null : undefined

const pageRoom = globalThis.location?.href ? focusedRoomFor(new URL(location.href).searchParams) : undefined
export const isFocusedRoomView = pageRoom !== undefined
export const focusedRoomId = pageRoom ?? null
