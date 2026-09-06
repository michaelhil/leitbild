import { describe, expect, test } from 'bun:test'
import { continuationMetadata, readableQueryMessage, extractPromptSections, extractToolInteractions } from './context-modal.ts'

describe('generation inspection', () => {
  test('ordinary inspection omits sensitive protocol while the complete original remains exact', () => {
    const message = { role: 'assistant', content: 'Public answer', continuation: {
      provider: 'openrouter' as const, model: 'qwen/reasoner', endpointHash: 'a'.repeat(64),
      reasoningDetails: [{ type: 'reasoning.encrypted', data: 'SECRET', signature: 'SIGNED' }], reasoning: 'PRIVATE',
    } }
    const before = JSON.stringify(message)
    expect(readableQueryMessage(message)).toEqual({ role: 'assistant', content: 'Public answer' })
    const metadata = JSON.stringify(continuationMetadata([message]))
    expect(metadata).toContain('reasoning.encrypted')
    for (const secret of ['SECRET', 'SIGNED', 'PRIVATE']) expect(metadata).not.toContain(secret)
    expect(JSON.stringify(message)).toBe(before)
  })
  test('splits the exact system prompt into navigable prompt categories', () => {
    const sections = extractPromptSections([
      '<leitbild:workspace_rules>Keep it scoped.</leitbild:workspace_rules>',
      '<leitbild:identity>Investigate carefully.</leitbild:identity>',
      '<leitbild:context>Room A\nParticipants: You</leitbild:context>',
    ].join('\n\n'))
    expect(sections.map(section => section.label)).toEqual([
      'Workspace rules', 'Agent identity', 'Runtime context',
    ])
    expect(sections[1]!.content).toBe('Investigate carefully.')
  })

  test('pairs exact tool arguments with the result sent back to the model', () => {
    const interactions = extractToolInteractions([
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', function: { name: 'workspace_call', arguments: { operationId: 'read.live' } } }] },
      { role: 'tool', content: '{"status":"ready"}', toolCallId: 'call-1', name: 'workspace_call' },
      { role: 'assistant', content: 'Ready.' },
    ])
    expect(interactions).toEqual([{
      callIndex: 0,
      id: 'call-1',
      name: 'workspace_call',
      arguments: { operationId: 'read.live' },
      result: { content: '{"status":"ready"}', name: 'workspace_call' },
    }])
  })
})
