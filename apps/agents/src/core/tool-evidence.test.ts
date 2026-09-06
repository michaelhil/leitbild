import { expect, test } from 'bun:test'
import { extractToolInteractions } from './tool-evidence.ts'

test('repeated provider IDs are paired within their assistant call group', () => {
  const interactions = extractToolInteractions([
    { role: 'assistant', content: '', toolCalls: [{ id: 'same', function: { name: 'first', arguments: { value: 1 } } }] },
    { role: 'tool', toolCallId: 'same', content: 'first result' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'same', function: { name: 'second', arguments: { value: 2 } } }] },
    { role: 'tool', toolCallId: 'same', content: 'second result' },
  ])
  expect(interactions.map(call => [call.callIndex, call.result?.content])).toEqual([[0, 'first result'], [1, 'second result']])
})

test('an unfinished earlier group cannot claim a later repeated ID result', () => {
  const interactions = extractToolInteractions([
    { role: 'assistant', content: '', toolCalls: [{ id: 'same', function: { name: 'incomplete', arguments: {} } }] },
    { role: 'assistant', content: '', toolCalls: [{ id: 'same', function: { name: 'second', arguments: {} } }, { id: 'other', function: { name: 'third', arguments: {} } }] },
    { role: 'tool', toolCallId: 'other', content: 'third result' },
    { role: 'tool', toolCallId: 'same', content: 'second result' },
  ])
  expect(interactions.map(call => call.result?.content)).toEqual([undefined, 'second result', 'third result'])
})
