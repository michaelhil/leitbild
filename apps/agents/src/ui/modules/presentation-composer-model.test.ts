import { expect, test } from 'bun:test'
import { presentationDraftMessageSchema, presentationEvidenceMessageSchema, type PresentationRequest, type PresentationReceipt } from '@leitbild/contracts'
import { createPresentationComposerModel } from './presentation-composer-model.ts'
import { parsePresentationClear, parsePresentationDraft, parsePresentationOffer } from './presentation-wire.ts'

const subject = { workspaceId: '00000000-0000-4000-8000-000000000001', moduleId: 'world', type: 'world.simulation-run', id: 'run' }
const room = { workspaceId: subject.workspaceId, moduleId: 'agents', type: 'agents.room', id: 'assistant' }
const make = () => {
  let now = Date.parse('2026-11-02T10:00:00Z'), roomId = room.id
  const recipient = { subject, clientId: 'client', documentId: 'doc', leaseId: 'lease', expiresAt: new Date(now + 60_000).toISOString() }
  const request = presentationDraftMessageSchema.parse({ type: 'leitbild:presentation-draft', room, request: {
    id: 'request', recipient, source: { moduleId: 'world', kind: 'guide', id: 'attempt', label: 'Guide', executionId: 'step-attempt' },
    target: { subject, type: 'world.composer', id: 'assistant' }, action: { kind: 'draft', text: 'sitrep unit 1' }, purpose: 'Ask for a current picture', mode: 'guide',
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 30_000).toISOString(),
  } }).request
  const receipts: PresentationReceipt[] = [], hints: unknown[] = []
  const model = createPresentationComposerModel({ workspaceId: subject.workspaceId, roomId: () => roomId, now: () => now, receipt: r => receipts.push(r), evidence: h => hints.push(h) })
  model.offer(recipient)
  return { model, request, recipient, receipts, hints, tick: (ms: number) => { now += ms }, room: (id: string) => { roomId = id; model.roomChanged() } }
}

test('draft delivery preserves unsent text; only explicit choices insert and only real acknowledgements link messages', () => {
  const { model, request, receipts, hints } = make()
  model.receive(request, room)
  expect(model.suggestions()).toHaveLength(1)
  expect(receipts).toEqual([])
  expect(model.choose(request.id, 'insert', 'My unsent work')).toBeUndefined()
  expect(model.choose(request.id, 'append', 'My unsent work')).toBe('My unsent work\nsitrep unit 1')
  expect(receipts).toMatchObject([{ status: 'applied', reason: expect.stringContaining('no message has been sent') }])
  model.input('My edited question about unit 1')
  const post = model.postContext(room.id)
  expect(post.presentationDraft).toMatchObject({ sourceId: 'attempt', sourceExecutionId: 'step-attempt' })
  expect(hints).toEqual([])
  model.acknowledge(post.presentationDraft!, 'wrong-room', 'forged')
  expect(hints).toEqual([])
  model.submitted()
  model.acknowledge(post.presentationDraft!, room.id, 'actual-human-message')
  expect(presentationEvidenceMessageSchema.safeParse({ type: 'leitbild:presentation-evidence', ...(hints[0] as object) }).success).toBe(true)
  expect(hints).toMatchObject([{ messageId: 'actual-human-message', requestId: request.id }])
  model.response(['unrelated-message'])
  expect(hints).toHaveLength(1)
  model.response(['actual-human-message'])
  expect(hints).toHaveLength(2)
})

test('whole-draft replacement, clearing, Room changes and a new recipient cannot inherit old prompt attribution', () => {
  for (const action of ['replace-all', 'clear', 'room', 'new-document', 'cancel'] as const) {
    const { model, request, recipient } = make()
    model.receive(request, room)
    expect(model.choose(request.id, 'replace', 'unsent')).toBe('sitrep unit 1')
    if (action === 'replace-all') model.input('unrelated manually typed question', true)
    if (action === 'clear') model.input('')
    if (action === 'room') model.roomChanged()
    if (action === 'new-document') model.offer({ ...recipient, documentId: 'new', leaseId: 'new-lease' })
    if (action === 'cancel') model.clear(request.id)
    expect(model.postContext(room.id).presentationDraft).toBeUndefined()
  }
})

test('expired/headless/foreign recipient and wrong Room never apply or fall back to the latest selected conversation', () => {
  const { model, request, recipient, receipts, tick } = make()
  model.receive({ ...request, recipient: { ...recipient, documentId: 'old' } }, room)
  expect(model.suggestions()).toEqual([])
  model.receive(request, { ...room, id: 'other' })
  expect(receipts).toMatchObject([{ status: 'unavailable' }])
  model.receive({ ...request, id: 'expired' }, room)
  tick(31_000)
  expect(model.choose('expired', 'replace', 'keep me')).toBeUndefined()
  expect(receipts.at(-1)?.status).toBe('expired')
  tick(30_000)
  expect(model.postContext(room.id)).toEqual({})
  model.offer(null)
  model.receive(request, room)
  expect(model.suggestions()).toEqual([])
})

test('browser parsers follow the checked contract and reject hidden fields, wrong Room and cross-Run addresses', () => {
  const { request, recipient } = make()
  const draft = { type: 'leitbild:presentation-draft', room, request }
  expect(parsePresentationDraft(draft)?.room.id).toBe(room.id)
  expect(parsePresentationOffer({ type: 'leitbild:presentation-offer', recipient })?.recipient).toEqual(recipient)
  expect(parsePresentationDraft({ ...draft, selector: '#chat-input' })).toBeNull()
  expect(parsePresentationDraft({ ...draft, request: { ...request, target: { ...request.target, subject: { ...subject, id: 'hidden-run' } } } })).toBeNull()
  expect(parsePresentationDraft({ ...draft, request: { ...request, source: { ...request.source, initiatingRoom: { ...room, id: 'other' } } } })).toBeNull()
  expect(parsePresentationOffer({ type: 'leitbild:presentation-offer', recipient: { ...recipient, actor: 'admin' } })).toBeNull()
  expect(parsePresentationClear({ type: 'leitbild:presentation-clear', recipient, room, requestId: request.id, clearRequestId: 'actual-clear' })).toMatchObject({ requestId: request.id, clearRequestId: 'actual-clear' })
  expect(parsePresentationClear({ type: 'leitbild:presentation-clear', recipient, room, requestId: request.id, clearRequestId: 1 })).toBeNull()
})


test('submission capacity preserves every unconfirmed human post and refuses before a new draft can be sent', () => {
  const { model, request, hints } = make()
  const links: NonNullable<ReturnType<typeof model.postContext>['presentationDraft']>[] = []
  for (let i = 0; i < 16; i++) {
    const current = { ...request, id: `pending-${i}` }
    model.receive(current, room); model.choose(current.id, 'insert', '')
    links.push(model.postContext(room.id).presentationDraft!); model.submitted()
  }
  const waiting = { ...request, id: 'waiting-17' }
  model.receive(waiting, room)
  const unsent = model.choose(waiting.id, 'replace', 'existing draft')!
  expect(unsent).toBe('sitrep unit 1')
  expect(() => model.postContext(room.id)).toThrow('still awaiting their actual message receipts')
  expect(model.chosen()?.link.requestId).toBe(waiting.id)
  model.acknowledge(links[0]!, room.id, 'actual-human-message-0')
  expect(hints).toMatchObject([{ requestId: 'pending-0', messageId: 'actual-human-message-0' }])
  // A reconciled link may retire; the remaining unconfirmed links survive.
  expect(model.postContext(room.id).presentationDraft?.requestId).toBe(waiting.id)
  model.acknowledge(links[1]!, room.id, 'actual-human-message-1')
  expect(hints.at(-1)).toMatchObject({ requestId: 'pending-1', messageId: 'actual-human-message-1' })
})

test('an expired linked recipient cannot silently turn the chosen draft into an unrelated post', () => {
  const { model, request, tick } = make()
  model.receive(request, room); model.choose(request.id, 'insert', '')
  tick(61_000)
  expect(() => model.postContext(room.id)).toThrow('no current browser receiver')
  expect(model.chosen()?.link.requestId).toBe(request.id)
  model.unlink()
  expect(model.postContext(room.id)).toEqual({})
})
