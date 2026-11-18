import { expect, test } from 'bun:test'
import { diagramReply, replacementFromReply } from '../../core/diagram-request.ts'
import type { UIMessage } from './render/render-types.ts'

test('a late request for a different diagram cannot be mistaken for the current replacement', () => {
  const make = (id: string, requestId: string, diagramIndex: number): UIMessage => ({
    id, senderId: 'ai', content: '```mermaid\nflowchart LR\nA --> B\n```', timestamp: 1, type: 'chat',
    inReplyTo: ['answer'], cause: { kind: 'diagram-request', name: 'Hilde', requestId, diagramIndex },
  })
  const messages = [make('old', 'old-request', 0), make('new', 'new-request', 1)]
  expect(diagramReply(messages, 'answer', 'ai', 'new-request')?.id).toBe('new')
  expect(diagramReply(messages, 'another-answer', 'ai', 'new-request')).toBeUndefined()
  expect(replacementFromReply(messages[1]!)).toBe('flowchart LR\nA --> B')
})

test('error, pass, missing and multiple diagrams leave replacement decisions explicit', () => {
  const reply: UIMessage = { id: 'r', senderId: 'ai', content: 'No grounded detail is available.', timestamp: 1, type: 'chat' }
  expect(() => replacementFromReply(reply)).toThrow('exactly one')
  expect(() => replacementFromReply({ ...reply, type: 'error', content: 'Cancelled' })).toThrow('Cancelled')
  expect(() => replacementFromReply({ ...reply, type: 'pass', content: '' })).toThrow('without a replacement')
  expect(() => replacementFromReply({ ...reply, content: '```mermaid\nA --> B\n```\n```mermaid\nC --> D\n```' })).toThrow('exactly one')
})
