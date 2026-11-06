import { expect, test } from 'bun:test'
import { openSendAsPicker, createHumanInline } from './send-as-picker.ts'
import { $agents, $rooms, $roomMembers, $selectedHumanByRoom, $selectedRoomId } from './stores.ts'
import { setWSClient } from './ws-send.ts'
import type { WSClient } from './ws-client.ts'

// Handler fixture; native Tab/Enter behavior is supplied by the button element
// and exercised in browser QA, rather than emulated here.
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
  const original = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch, location: globalThis.location }
  let prompts = 0, promptResult: string | null = null
  const body = createElement('body'), sent: unknown[] = [], requests: { input: unknown; init?: RequestInit }[] = []
  Object.assign(globalThis, {
    document: { body, createElement, querySelectorAll: () => [], addEventListener: () => {}, removeEventListener: () => {} },
    window: { prompt: () => { prompts++; return promptResult } },
    location: { pathname: '/workspaces/8bf7b0d6-c28d-45c3-982b-efae68007b65/agents' },
    fetch: async (input: unknown, init?: RequestInit) => { requests.push({ input, init }); return Response.json({ id: 'new-human' }) },
  })
  setWSClient({ send: value => { sent.push(value) } } as unknown as WSClient)
  const roomId = 'ordinary-room'
  $rooms.set({ [roomId]: { id: roomId, name: 'Control room' } }); $selectedRoomId.set(roomId)
  return { nodes, sent, requests, roomId, prompts: () => prompts, prompt: (value: string | null) => { promptResult = value }, restore: () => {
    setWSClient(null); Object.assign(globalThis, original)
    $agents.set({}); $rooms.set({}); $roomMembers.set({}); $selectedRoomId.set(null); $selectedHumanByRoom.set({})
  } }
}

test('ordinary in-room human choice remains a native button and delegates actual submission', async () => {
  const dom = domFixture()
  try {
    const submitted: string[] = [], input = { value: 'Unsent draft' } as HTMLTextAreaElement
    $roomMembers.set({ [dom.roomId]: ['human'] })
    $agents.set({ human: { id: 'human', name: 'Participant', kind: 'human', state: 'idle' } })
    await openSendAsPicker(dom.roomId, input.value, { chatInput: input, resetChatInputHeight: () => {}, submitAs: id => { submitted.push(id) } })
    const row = dom.nodes.find(node => node.children.some(child => child.textContent === 'Participant'))!
    expect(row.tag).toBe('button'); expect(row.type).toBe('button')
    expect(row.children.some(child => child.textContent === 'in room')).toBe(true)
    expect(dom.nodes.some(node => node.textContent === '+ New human')).toBe(true)
    await row.onclick!()
    expect(submitted).toEqual(['human'])
    expect($selectedHumanByRoom.get()[dom.roomId]).toBe('human')
    expect($roomMembers.get()[dom.roomId]).toEqual(['human'])
    expect(input.value).toBe('Unsent draft')
    expect(dom.sent).toEqual([]); expect(dom.prompts()).toBe(0); expect(dom.requests).toEqual([])
  } finally { dom.restore() }
})

test('ordinary out-of-room humans retain the add-to-room choice and cancelling selection preserves the draft', async () => {
  const dom = domFixture()
  try {
    const input = { value: 'Keep this draft' } as HTMLTextAreaElement
    $agents.set({ human: { id: 'human', name: 'Visitor', kind: 'human', state: 'idle' } })
    await openSendAsPicker(dom.roomId, input.value, { chatInput: input, resetChatInputHeight: () => {} })
    const row = dom.nodes.find(node => node.children.some(child => child.textContent === 'Visitor'))!
    expect(row.tag).toBe('button')
    expect(row.children.some(child => child.textContent === 'add to room')).toBe(true)
    await dom.nodes.find(node => node.textContent === 'Cancel')!.onclick!()
    expect($selectedHumanByRoom.get()[dom.roomId]).toBeUndefined()
    expect(input.value).toBe('Keep this draft')
    expect(dom.sent).toEqual([]); expect(dom.prompts()).toBe(0); expect(dom.requests).toEqual([])
  } finally { dom.restore() }
})

test('ordinary missing-human flow still offers creation, and creation uses the existing owner endpoint', async () => {
  const dom = domFixture()
  try {
    const input = { value: 'Keep until submitted' } as HTMLTextAreaElement, submitted: string[] = []
    const deps = { chatInput: input, resetChatInputHeight: () => {}, submitAs: (id: string) => { submitted.push(id) } }
    await openSendAsPicker(dom.roomId, input.value, deps)
    expect(dom.prompts()).toBe(1)
    expect(dom.requests).toEqual([]); expect(input.value).toBe('Keep until submitted')
    dom.prompt(' New participant ')
    await createHumanInline(dom.roomId, input.value, deps)
    expect(dom.requests).toHaveLength(1)
    expect(dom.requests[0]!.input).toBe('/api/workspaces/8bf7b0d6-c28d-45c3-982b-efae68007b65/agents/agents/human')
    expect(JSON.parse(String(dom.requests[0]!.init!.body))).toEqual({ name: 'New participant', roomName: 'Control room' })
    expect($selectedHumanByRoom.get()[dom.roomId]).toBe('new-human')
    expect(submitted).toEqual(['new-human']); expect(dom.sent).toEqual([])
    expect(input.value).toBe('Keep until submitted')
  } finally { dom.restore() }
})
