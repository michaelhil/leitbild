import { describe, expect, test } from 'bun:test'
import { buildOAIBody } from './openai-compatible-wire.ts'

describe('OpenAI-compatible native tool history', () => {
  test('preserves assistant tool calls and matching tool results on the wire', () => {
    const body = buildOAIBody({
      model: 'openai:gpt-5-mini',
      messages: [
        { role: 'user', content: 'Inspect it.' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_17', function: { name: 'workspace_call', arguments: { calls: [] } } }] },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'call_17', name: 'workspace_call' },
      ],
    }, false, 'openai')
    expect(body.messages).toEqual([
      { role: 'user', content: 'Inspect it.' },
      { role: 'assistant', content: ' ', tool_calls: [{ id: 'call_17', type: 'function', function: { name: 'workspace_call', arguments: '{"calls":[]}' } }] },
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'call_17', name: 'workspace_call' },
    ])
  })
})
