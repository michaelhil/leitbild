import { expect, test } from 'bun:test'
import { agentsPerspectiveRoomAdmissionSchema, newWorkspaceId } from '@leitbild/contracts'
import { openSendAsPicker, createHumanInline } from './send-as-picker.ts'
import { $agents, $rooms, $roomMembers, $selectedHumanByRoom, $selectedRoomId } from './stores.ts'
import { snapshotAgentsForView } from './ws-dispatch/mappers.ts'
import { setWSClient } from './ws-send.ts'
import type { WSClient } from './ws-client.ts'
import type { WSOutbound } from '../../core/types/ws-protocol.ts'

type Snapshot = Extract<WSOutbound, { type: 'snapshot' }>
const privateRoom = () => {
  const workspaceId = newWorkspaceId()
  const admission = agentsPerspectiveRoomAdmissionSchema.parse({ perspective: { workspaceId, moduleId: 'world', type: 'world.perspective', id: 'blue' },
    admissionGeneration: crypto.randomUUID(), room: { workspaceId, moduleId: 'agents', type: 'agents.room', id: 'private-room' },
    actualAgentId: 'actual-ai', runtimeGeneration: crypto.randomUUID(), templateId: 'template', templateRevision: 'a'.repeat(64),
    status: 'bound', revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  return { id: 'private-room', name: 'Perspective Assistant', perspective: { admission } }
}

test('focused private snapshot preserves existing human authors without promoting them to execution members', () => {
  const room = privateRoom()
  const snapshot = { type: 'snapshot', rooms: [room],
    agents: [{ id: 'actual-ai', kind: 'ai', name: 'Scoped' }, { id: 'public-human', kind: 'human', name: 'Participant' }, { id: 'unrelated-ai', kind: 'ai', name: 'Unrelated' }],
    roomStates: { [room.id]: { members: ['actual-ai'], mode: 'broadcast', paused: false, muted: [] } },
  } as unknown as Snapshot
  expect(snapshotAgentsForView(snapshot, room.id).map(agent => agent.id)).toEqual(['actual-ai', 'public-human'])
  expect(snapshot.roomStates![room.id]!.members).toEqual(['actual-ai'])
  const ordinary = { ...snapshot, rooms: [{ id: room.id, name: 'Ordinary' }] } as Snapshot
  expect(snapshotAgentsForView(ordinary, room.id).map(agent => agent.id)).toEqual(['actual-ai'])
  expect(snapshotAgentsForView(ordinary, null)).toEqual(snapshot.agents)
})

// Lifecycle-only DOM fixture: actual layout and native input are exercised by
// the browser proof. This checks the actual picker handlers and outgoing ports.
const domFixture = () => {
  type Node = { tag: string; type?: string; children: Node[]; style: Record<string, string>; className: string; textContent: string; innerHTML: string;
    onclick?: (event?: unknown) => Promise<void> | void; removed: boolean; appendChild: (node: Node) => Node;
    querySelector: () => Node; remove: () => void; addEventListener: () => void }
  const nodes: Node[] = []
  const createElement = (tag: string): Node => {
    const node: Node = { tag, children: [], style: {}, className: '', textContent: '', innerHTML: '', removed: false,
      appendChild: child => { node.children.push(child); return child }, querySelector: () => createElement('strong'),
      remove: () => { node.removed = true }, addEventListener: () => {} }
    nodes.push(node); return node
  }
  const original = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout }
  let prompts = 0, fetches = 0
  const body = createElement('body'), sent: unknown[] = []
  Object.assign(globalThis, { document: { body, createElement, querySelectorAll: () => [], addEventListener: () => {}, removeEventListener: () => {} },
    window: { prompt: () => { prompts++; return null } }, fetch: () => { fetches++; throw new Error('No HTTP authoring expected') }, setTimeout: () => 0 })
  setWSClient({ send: value => { sent.push(value) } } as unknown as WSClient)
  return { nodes, body, sent, prompts: () => prompts, fetches: () => fetches, restore: () => {
    setWSClient(null); Object.assign(globalThis, original)
    $agents.set({}); $rooms.set({}); $roomMembers.set({}); $selectedRoomId.set(null); $selectedHumanByRoom.set({})
  } }
}

test('private picker posts as an existing public human without creating or adding a member', async () => {
  const dom = domFixture()
  try {
    const room = privateRoom(), submitted: string[] = []
    $rooms.set({ [room.id]: room }); $selectedRoomId.set(room.id); $roomMembers.set({ [room.id]: ['actual-ai'] })
    $agents.set({ 'public-human': { id: 'public-human', name: 'Participant', kind: 'human', state: 'idle' }, 'actual-ai': { id: 'actual-ai', name: 'Scoped', kind: 'ai', state: 'idle' } })
    const input = { value: 'Unsent private draft' } as HTMLTextAreaElement
    await openSendAsPicker(room.id, input.value, { chatInput: input, resetChatInputHeight: () => {}, submitAs: id => { submitted.push(id) } })
    expect(dom.nodes.some(node => node.textContent === '+ New human')).toBe(false)
    expect(dom.nodes.some(node => node.textContent === 'add to room')).toBe(false)
    const row = dom.nodes.find(node => node.children.some(child => child.textContent === 'Participant'))!
    expect(row.tag).toBe('button') // Native Tab/Enter/Space activation; no clickable-div keyboard emulation.
    expect(row.type).toBe('button') // Choosing an author must not submit an enclosing form first.
    expect(row.children.some(child => child.textContent === 'post as')).toBe(true)
    await row.onclick!()
    expect(submitted).toEqual(['public-human'])
    expect($selectedHumanByRoom.get()[room.id]).toBe('public-human')
    expect($roomMembers.get()[room.id]).toEqual(['actual-ai'])
    expect(input.value).toBe('Unsent private draft') // The real submission callback owns successful clearing.
    expect(dom.sent).toEqual([]); expect(dom.prompts()).toBe(0); expect(dom.fetches()).toBe(0)
  } finally { dom.restore() }
})

test('private missing-sender and direct create paths refuse locally without a native prompt or authoring request', async () => {
  const dom = domFixture()
  try {
    const room = privateRoom(), input = { value: 'Keep this draft' } as HTMLTextAreaElement
    $rooms.set({ [room.id]: room }); $agents.set({})
    const deps = { chatInput: input, resetChatInputHeight: () => {} }
    await openSendAsPicker(room.id, input.value, deps)
    await createHumanInline(room.id, input.value, deps)
    expect(dom.nodes.filter(node => node.textContent.startsWith('No existing human sender'))).toHaveLength(2)
    expect(dom.prompts()).toBe(0); expect(dom.fetches()).toBe(0); expect(dom.sent).toEqual([])
    expect(input.value).toBe('Keep this draft')
  } finally { dom.restore() }
})
