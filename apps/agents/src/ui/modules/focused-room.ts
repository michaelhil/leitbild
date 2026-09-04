// The Host embeds a Room in focused mode. This is a presentation boundary:
// the Agents runtime remains Workspace-scoped, while this browser view shows
// only the selected Room and its members.
const params = typeof location === 'undefined' ? null : new URL(location.href).searchParams

export const focusedRoomId = params?.get('view') === 'focused' ? params.get('room') : null
export const isFocusedRoomView = focusedRoomId !== null
