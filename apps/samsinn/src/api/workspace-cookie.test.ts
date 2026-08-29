import { describe, expect, test } from 'bun:test'
import { workspaceIdSchema } from '@samsinn-leitbild/platform-contracts'
import {
  WORKSPACE_COOKIE,
  buildWorkspaceCookie,
  getJoinFromQuery,
  getWorkspaceFromQuery,
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

  test('parses canonical scripted and share-link parameters', () => {
    expect(getWorkspaceFromQuery(new URL(`https://samsinn.test/?workspace=${workspaceId}`))).toBe(workspaceId)
    expect(getJoinFromQuery(new URL(`https://samsinn.test/?join=${workspaceId}`))).toBe(workspaceId)
    expect(getWorkspaceFromQuery(new URL('https://samsinn.test/?instance=abcdefghijklmnop'))).toBeNull()
  })

  test('resolves join, cookie, query, then none', () => {
    const joined = new URL(`https://samsinn.test/?join=${workspaceId}`)
    expect(resolveWorkspaceId(request(), joined)).toEqual({ id: workspaceId, source: 'join' })
    expect(resolveWorkspaceId(request(`${WORKSPACE_COOKIE}=${workspaceId}`), new URL('https://samsinn.test/')).source).toBe('cookie')
    expect(resolveWorkspaceId(request(), new URL(`https://samsinn.test/?workspace=${workspaceId}`)).source).toBe('query')
    expect(resolveWorkspaceId(request(), new URL('https://samsinn.test/'))).toEqual({ id: null, source: 'none' })
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
