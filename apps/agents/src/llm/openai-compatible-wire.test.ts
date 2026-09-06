import { describe, expect, test } from 'bun:test'
import { buildOAIBody } from './openai-compatible-wire.ts'

describe('OpenAI-compatible native tool history', () => {
  test('OpenAI routes preserve optional tool fields without changing shared schemas or other providers', () => {
    const parameters = { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false }
    const tools = [{ type: 'function' as const, function: { name: 'read', description: 'Read', parameters } }]
    const request = { model: 'gpt-4o', messages: [], tools }
    for (const provider of ['openai', 'openrouter']) {
      const body = buildOAIBody(request, true, provider)
      expect(body.tools).toEqual([{ type: 'function', function: { ...tools[0]!.function, strict: false } }])
      expect(body.tools).not.toBe(tools)
    }
    expect(tools[0]!.function).not.toHaveProperty('strict')
    expect(parameters).not.toHaveProperty('required')
    expect(buildOAIBody(request, false, 'groq').tools).toBe(tools)
    expect(buildOAIBody(request, false, 'anthropic').tools).toEqual([{ ...tools[0], cache_control: { type: 'ephemeral' } }])
    const explicit = { ...request, tools: [{ ...tools[0]!, function: { ...tools[0]!.function, strict: true } }] }
    expect(buildOAIBody(explicit, false, 'openrouter').tools).toEqual(explicit.tools)
  })
  test('direct newer OpenAI tools fail explicitly when Chat Completions cannot support them; OpenRouter remains independent', () => {
    const tools = [{ type: 'function' as const, function: { name: 'inspect', description: 'Inspect', parameters: {} } }]
    const request = { model: 'gpt-6-astra', messages: [], tools, reasoningEffort: 'high' as const }
    expect(() => buildOAIBody(request, false, 'openai')).toThrow('unsupported_provider_transport')
    expect(() => buildOAIBody({ ...request, tools: [], reasoningEffort: 'none' }, false, 'openai')).toThrow('reasoning_effort_unsupported')
    for (const model of ['gpt-5.4', 'gpt-5.5', 'gpt-5.6']) {
      expect(() => buildOAIBody({ ...request, model }, false, 'openai')).toThrow('unsupported_provider_transport')
      expect(() => buildOAIBody({ ...request, model, reasoningEffort: undefined }, false, 'openai')).toThrow('requires explicit none')
      expect(buildOAIBody({ ...request, model, reasoningEffort: 'none' }, false, 'openai')).toHaveProperty('tools')
    }
    expect(buildOAIBody({ ...request, model: 'openai/gpt-6-astra' }, false, 'openrouter')).toMatchObject({ tools, reasoning: { effort: 'high' } })
  })
  test('explicit effort maps per provider; omitted effort and legacy think=false add no reasoning policy', () => {
    const request = { model: 'gpt-6-astra', messages: [], reasoningEffort: 'high' as const, temperature: 0.3, maxTokens: 200 }
    expect(buildOAIBody(request, false, 'openai')).toMatchObject({ reasoning_effort: 'high', max_completion_tokens: 200 })
    expect(buildOAIBody(request, false, 'openai')).not.toHaveProperty('temperature')
    expect(buildOAIBody(request, false, 'openrouter')).toHaveProperty('reasoning', { effort: 'high' })
    const unchanged = buildOAIBody({ model: 'm', messages: [], think: false }, false, 'openrouter')
    expect(unchanged).not.toHaveProperty('reasoning')
    expect(unchanged).not.toHaveProperty('reasoning_effort')
  })

  test('known unsupported effort fails locally; unknown capabilities remain provider validated', () => {
    const request = { model: 'm', messages: [], reasoningEffort: 'high' as const }
    const info = { id: 'm', provider: 'openrouter', source: 'openrouter_api', contextMax: 0 }
    expect(() => buildOAIBody(request, false, 'openrouter', { ...info, reasoning: { supportedEfforts: ['low'] } })).toThrow('reasoning_effort_unsupported')
    expect(() => buildOAIBody(request, false, 'openrouter', { ...info, supportedParameters: ['temperature'] })).toThrow('reasoning_effort_unsupported')
    expect(() => buildOAIBody({ ...request, reasoningEffort: 'none' }, false, 'openrouter', { ...info, reasoning: { mandatory: true } })).toThrow('reasoning_effort_unsupported')
    expect(buildOAIBody(request, false, 'openrouter', { ...info, reasoning: { supportedEfforts: null } })).toHaveProperty('reasoning', { effort: 'high' })
  })

  test('ordered continuation is protocol, not content, and cannot cross provider or model', () => {
    const continuation = { provider: 'openrouter' as const, model: 'qwen/r', endpointHash: 'a'.repeat(64), reasoningDetails: [{ type: 'reasoning.encrypted', data: 'signed' }, { type: 'reasoning.text', text: 'private' }], reasoning: 'raw' }
    const request = { model: 'qwen/r', messages: [{ role: 'assistant' as const, content: 'visible', continuation }] }
    expect(buildOAIBody(request, false, 'openrouter').messages).toEqual([{ role: 'assistant', content: 'visible', reasoning_details: continuation.reasoningDetails, reasoning: 'raw' }])
    expect(() => buildOAIBody(request, false, 'openai')).toThrow('provider_continuation_route_mismatch')
    expect(() => buildOAIBody({ ...request, model: 'another' }, false, 'openrouter')).toThrow('provider_continuation_route_mismatch')
  })
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
