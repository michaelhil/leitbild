import { describe, expect, test } from 'bun:test'
import { workspaceOpenMessageSchema } from './resources.ts'

describe('workspace open message', () => {
  test('accepts a Workspace address with or without a query', () => {
    expect(workspaceOpenMessageSchema.parse({ type: 'leitbild:workspace-open', address: '/workspaces/ws-1' }).address).toBe('/workspaces/ws-1')
    expect(workspaceOpenMessageSchema.parse({ type: 'leitbild:workspace-open', address: '/workspaces/ws-1?world=run-1&planning=library' }).address)
      .toBe('/workspaces/ws-1?world=run-1&planning=library')
  })

  test('refuses other addresses, fragments and extra fields', () => {
    const refused = (data: unknown) => workspaceOpenMessageSchema.safeParse(data).success
    expect(refused({ type: 'leitbild:workspace-open', address: 'https://example.com/workspaces/ws-1' })).toBe(false)
    expect(refused({ type: 'leitbild:workspace-open', address: '/workspaces/ws-1/planning?plan=p' })).toBe(false)
    expect(refused({ type: 'leitbild:workspace-open', address: '/workspaces/ws-1#view=x' })).toBe(false)
    expect(refused({ type: 'leitbild:workspace-open', address: '/wiki' })).toBe(false)
    expect(refused({ type: 'leitbild:workspace-open', address: '/workspaces/ws-1', extra: true })).toBe(false)
  })
})
