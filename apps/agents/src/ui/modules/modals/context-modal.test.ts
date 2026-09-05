import { describe, expect, test } from 'bun:test'
import { extractPromptSections, extractToolInteractions } from './context-modal.ts'

describe('generation inspection', () => {
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
      id: 'call-1',
      name: 'workspace_call',
      arguments: { operationId: 'read.live' },
      result: { content: '{"status":"ready"}', name: 'workspace_call' },
    }])
  })
})
