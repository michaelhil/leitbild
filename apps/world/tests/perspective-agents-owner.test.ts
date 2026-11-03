import { expect, test } from 'bun:test'
import { agentsPerspectiveRoomAdmissionSchema, newWorkspaceId, type AgentsPerspectiveRoomAdmission } from '@leitbild/contracts'
import { createPerspectiveAgentsOwner } from '../src/core/perspectives/agents-owner.ts'

test('the production World owner client uses exact loopback owner ports and reconciles an accepted uncertain revoke', async () => {
  const workspaceId = newWorkspaceId(), stamp = new Date().toISOString()
  let peer = agentsPerspectiveRoomAdmissionSchema.parse({ perspective: { workspaceId, moduleId: 'world', type: 'world.perspective', id: 'perspective' },
    room: { workspaceId, moduleId: 'agents', type: 'agents.room', id: 'room' }, actualAgentId: 'actual', runtimeGeneration: crypto.randomUUID(), admissionGeneration: crypto.randomUUID(),
    templateId: 'template', templateRevision: 'configuration-exact', status: 'bound', revision: 1, createdAt: stamp, updatedAt: stamp })
  const requests: Array<{ url: string; body: { input: unknown; actor: unknown; perspectiveOrigin: unknown } }> = []
  const client = createPerspectiveAgentsOwner('http://127.0.0.1:3100', (async (url, init) => {
    expect(init!.signal).toBeInstanceOf(AbortSignal)
    expect(init!.signal!.aborted).toBe(false)
    const body = JSON.parse(String(init!.body))
    requests.push({ url: String(url), body })
    if (String(url).includes('.revoke/')) { peer = { ...peer, revision: 2, status: 'revoked' }; return new Response('Accepted but reply lost', { status: 503 }) }
    return Response.json({ result: peer })
  }))
  expect(await client.readAgentsAdmission(peer)).toEqual(peer)
  expect((await client.revokeAgentsAdmission(peer, 'End rehearsal')).status).toBe('revoked')
  expect(requests.map(item => item.url.split('/capabilities/')[1])).toEqual(['agents.perspective-room.read/invoke', 'agents.perspective-room.read/invoke', 'agents.perspective-room.revoke/invoke', 'agents.perspective-room.read/invoke'])
  expect(requests.every(item => JSON.stringify(item.body.actor) === '{"kind":"system","id":"world"}' && JSON.stringify(item.body.perspectiveOrigin) === '{"kind":"owner","moduleId":"world"}')).toBe(true)
  expect(requests[2]!.body.input).toEqual({ expectedRevision: 1, reason: 'End rehearsal' })
  const substitute: AgentsPerspectiveRoomAdmission = { ...peer, actualAgentId: 'another-runtime' }
  const wrong = createPerspectiveAgentsOwner('http://127.0.0.1:3100', async () => Response.json({ result: substitute }))
  await expect(wrong.revokeAgentsAdmission(peer, 'Must not mutate a substitute')).rejects.toThrow('different Perspective binding')
  const wrongSubject = createPerspectiveAgentsOwner('http://127.0.0.1:3100', async () => Response.json({ result: { ...peer, room: { ...peer.room, id: 'substitute-room' } } }))
  await expect(wrongSubject.readAgentsAdmission(peer)).rejects.toMatchObject({ code: 'perspective_peer_binding_mismatch' })
  for (const response of [new Response('unavailable', { status: 503 }), new Response('not-json'), Response.json({ result: {} })]) {
    const invalid = createPerspectiveAgentsOwner('http://127.0.0.1:3100', async () => response)
    await expect(invalid.readAgentsAdmission(peer)).rejects.toMatchObject({ code: response.status === 503 ? 'perspective_peer_unavailable' : 'perspective_peer_contract_invalid' })
  }
  const stillBound = { ...peer, status: 'bound' }
  let attempts = 0
  const conflict = createPerspectiveAgentsOwner('http://127.0.0.1:3100', (async url => {
    if (String(url).includes('.revoke/')) { attempts++; return new Response('CAS changed', { status: 409 }) }
    return Response.json({ result: stillBound })
  }))
  await expect(conflict.revokeAgentsAdmission(peer, 'Refuse false success')).rejects.toMatchObject({ code: 'perspective_peer_unavailable' })
  expect(attempts).toBe(1)
})
