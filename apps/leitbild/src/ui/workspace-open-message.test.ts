import { expect, test } from 'bun:test'
import { acceptedWorkspaceOpen } from './workspace-open-message.ts'

const origin = 'https://leitbild.test'
const source = {} as Window
const workspaceId = '0b4b9a52-2f7e-4c1a-9d3e-00000000000a'
const current = { origin, source, workspaceId }
const open = (address: string) => ({ type: 'leitbild:workspace-open', address })

test('the frame the Host shows may show another address of this Workspace in place', () => {
  const address = `/workspaces/${workspaceId}?world=run-1&planning=plan-1`
  expect(acceptedWorkspaceOpen({ origin, source, data: open(address) }, current)).toBe(address)
  expect(acceptedWorkspaceOpen({ origin, source, data: open(`/workspaces/${workspaceId}`) }, current)).toBe(`/workspaces/${workspaceId}`)
  // A Workspace id is compared as the path names it, decoded.
  expect(acceptedWorkspaceOpen({ origin, source, data: open('/workspaces/a%2Fb?planning=library') }, { ...current, workspaceId: 'a/b' })).toBe('/workspaces/a%2Fb?planning=library')
})

test('another origin, another window or no shown frame is not taken', () => {
  const data = open(`/workspaces/${workspaceId}?planning=library`)
  expect(acceptedWorkspaceOpen({ origin: 'https://other.test', source, data }, current)).toBeNull()
  expect(acceptedWorkspaceOpen({ origin, source: {} as Window, data }, current)).toBeNull()
  expect(acceptedWorkspaceOpen({ origin, source: null, data }, current)).toBeNull()
  expect(acceptedWorkspaceOpen({ origin, source, data }, { ...current, source: null })).toBeNull()
})

test('another Workspace, an address that is not one, or another message is not taken', () => {
  for (const data of [
    open(`/workspaces/${crypto.randomUUID()}?planning=library`),
    open(`/workspaces/${workspaceId}/planning?plan=plan-1`),
    open(`https://leitbild.test/workspaces/${workspaceId}`),
    open(`/workspaces/${workspaceId}#plan`),
    open('/workspaces/%E0%A4%A?planning=library'),
    { ...open(`/workspaces/${workspaceId}`), extra: true },
    { type: 'leitbild:resource-catalog-changed', address: `/workspaces/${workspaceId}` },
    null,
    'ping',
  ]) expect(acceptedWorkspaceOpen({ origin, source, data }, current)).toBeNull()
})
