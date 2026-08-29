import { describe, expect, test } from 'bun:test'
import { createLeitbildCommandTools, toLeitbildSlug } from './command-tools.ts'
import { createLeitbildModuleBinding } from './client.ts'
import { workspaceIdSchema } from '@samsinn-leitbild/platform-contracts'

describe('toLeitbildSlug', () => {
  test('lowercases and replaces spaces with hyphens', () => {
    expect(toLeitbildSlug('Ambulance Specialist')).toBe('ambulance-specialist')
  })
  test('strips disallowed chars; keeps allowed punctuation', () => {
    expect(toLeitbildSlug('Op@Halden!')).toBe('ophalden')
    expect(toLeitbildSlug('worker.v1:north')).toBe('worker.v1:north')
  })
  test('collapses repeated hyphens; trims edges', () => {
    expect(toLeitbildSlug('  --foo--bar--  ')).toBe('foo-bar')
  })
  test('falls back to "unknown" on empty-after-strip', () => {
    expect(toLeitbildSlug('!!!')).toBe('unknown')
  })
})

describe('lb_command', () => {
  const baseBinding = {
    moduleBinding: createLeitbildModuleBinding('https://example.test'),
    workspaceId: workspaceIdSchema.parse('44444444-4444-4444-8444-444444444444'),
    simulationRunId: 'run-44444444-4444-4444-8444-444444444444',
    role: 'operator' as const,
  }

  test('exposes one tool named lb_command', () => {
    const tools = createLeitbildCommandTools({ getBinding: () => baseBinding })
    expect(tools.map(t => t.name)).toEqual(['lb_command'])
  })

  test('refuses when agent has no binding', async () => {
    const [tool] = createLeitbildCommandTools({ getBinding: () => undefined })
    const r = await tool!.execute({ kind: 'k', targets: [], payload: {} }, { callerId: 'a', callerName: 'A' })
    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('No Leitbild Simulation Run')
  })

  test('refuses observer role', async () => {
    const [tool] = createLeitbildCommandTools({ getBinding: () => ({ ...baseBinding, role: 'observer' }) })
    const r = await tool!.execute({ kind: 'k', targets: [], payload: {} }, { callerId: 'a', callerName: 'A' })
    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('operator')
  })

  test('rejects missing kind', async () => {
    const [tool] = createLeitbildCommandTools({ getBinding: () => baseBinding })
    const r = await tool!.execute({ kind: '', targets: [], payload: {} }, { callerId: 'a', callerName: 'A' })
    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('kind')
  })

  test('rejects non-array targets', async () => {
    const [tool] = createLeitbildCommandTools({ getBinding: () => baseBinding })
    const r = await tool!.execute({ kind: 'k', targets: 'not-an-array' as unknown as string[], payload: {} }, { callerId: 'a', callerName: 'A' })
    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('targets')
  })
})
