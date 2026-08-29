import { describe, expect, test } from 'bun:test'
import { workspaceIdSchema } from '@samsinn-leitbild/platform-contracts'
import {
  WORKSPACE_COOKIE,
  buildWorkspaceCookie,
  getWorkspaceIdFromPath,
  getWorkspaceId,
  resolveOrMintWorkspace,
  resolveWorkspaceId,
} from './workspace-cookie.ts'

const workspaceId = workspaceIdSchema.parse('9d2bd146-dc4a-4cbf-9754-f966884c5ca9')
const request = (cookie?: string) => new Request('http://samsinn.test/', cookie ? { headers: { cookie } } : {})

describe('Workspace selection', () => {
  test('reads only a valid canonical Workspace cookie', () => {
    expect(getWorkspaceId(request(`${WORKSPACE_COOKIE}=${workspaceId}`))).toBe(workspaceId)
    expect(getWorkspaceId(request(`${WORKSPACE_COOKIE}=abcdefghijklmnop`))).toBeNull()
    expect(getWorkspaceId(request(`${WORKSPACE_COOKIE}=../etc/passwd`))).toBeNull()
    expect(getWorkspaceId(request())).toBeNull()
  })

  test('builds a development-safe cookie and enables Secure for HTTPS', () => {
    expect(buildWorkspaceCookie(workspaceId, request())).toContain(`${WORKSPACE_COOKIE}=${workspaceId}`)
    expect(buildWorkspaceCookie(workspaceId, request())).not.toContain('; Secure')
    expect(buildWorkspaceCookie(workspaceId, new Request('https://samsinn.test/'))).toContain('; Secure')
  })

  test('parses only the canonical Workspace UI path', () => {
    expect(getWorkspaceIdFromPath(`/workspaces/${workspaceId}`)).toBe(workspaceId)
    expect(getWorkspaceIdFromPath(`/workspaces/${workspaceId}/rooms`)).toBeNull()
    expect(getWorkspaceIdFromPath('/?join=abcdefghijklmnop')).toBeNull()
  })

  test('resolves path, cookie, then none', () => {
    const path = new URL(`https://samsinn.test/workspaces/${workspaceId}`)
    expect(resolveWorkspaceId(request(), path)).toEqual({ id: workspaceId, source: 'path' })
    expect(resolveWorkspaceId(request(`${WORKSPACE_COOKIE}=${workspaceId}`), new URL('https://samsinn.test/')).source).toBe('cookie')
    expect(resolveWorkspaceId(request(), new URL('https://samsinn.test/'))).toEqual({ id: null, source: 'none' })
  })

  test('a canonical path refreshes a missing or different selection cookie', () => {
    const url = new URL(`https://samsinn.test/workspaces/${workspaceId}`)
    expect(resolveOrMintWorkspace(request(), url)).toMatchObject({ workspaceId, isNew: false })
    expect(resolveOrMintWorkspace(request(), url).setCookieValue).toContain(`${WORKSPACE_COOKIE}=${workspaceId}`)
    expect(resolveOrMintWorkspace(request(`${WORKSPACE_COOKIE}=${workspaceId}`), url).setCookieValue).toBeNull()
  })

  test('mints a UUID and cookie only when no Workspace is selected', () => {
    const minted = resolveOrMintWorkspace(request(), new URL('https://samsinn.test/'))
    expect(workspaceIdSchema.safeParse(minted.workspaceId).success).toBe(true)
    expect(minted.isNew).toBe(true)
    expect(minted.setCookieValue).toContain(`${WORKSPACE_COOKIE}=${minted.workspaceId}`)
    expect(resolveOrMintWorkspace(request(`${WORKSPACE_COOKIE}=${workspaceId}`), new URL('https://samsinn.test/')))
      .toEqual({ workspaceId, setCookieValue: null, isNew: false })
  })
})
