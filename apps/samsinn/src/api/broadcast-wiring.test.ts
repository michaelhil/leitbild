// ============================================================================
// Integration test: cookie-bound Workspaces get full broadcast wiring.
//
// The bug fixed in 5d73a8e was that wireWorkspaceRuntimeEvents was silently skipped
// for non-default Workspaces because onWorkspaceRuntimeCreated ran before the registry's
// internal map.set() — autoSaverFor(id) returned null, the `if (autoSaver)`
// guard short-circuited, and every cookie-bound Workspace booted with
// setOnEvalEvent / setOnMessagePosted / state.subscribe all unwired.
//
// This test proves end-to-end that a Workspace loaded via the registry
// path (the cookie-bound code path) has live broadcast wiring: posting a
// message into one of its rooms fans out via wsManager.broadcastToWorkspace
// scoped to that Workspace.
//
// First assertion is the harness sanity check: the system's snapshot has
// at least one room. If that fails the test setup is broken and we'd be
// chasing a phantom in the next assertions.
// ============================================================================

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeploymentRuntime } from '../core/deployment-runtime.ts'
import { createWorkspaceRuntimeRegistry } from '../core/workspaces/runtime-registry.ts'
import { createWSManager, type WSManager } from './ws-handler.ts'
import { wireWorkspaceRuntimeEvents } from './wire-workspace-runtime-events.ts'
import { makeStubGateway, makeStubSetup, stubProviderConfig as baseConfig } from './stub-gateway.ts'
import type { WSOutbound } from '../core/types/ws-protocol.ts'
import { newWorkspaceId } from '@samsinn-leitbild/platform-contracts'

const makeSetup = makeStubSetup

describe('cookie-bound Workspace broadcast wiring (regression for 5d73a8e)', () => {
  let homeDir: string

  afterEach(async () => {
    if (homeDir) await rm(homeDir, { recursive: true, force: true })
    delete process.env.SAMSINN_HOME
  })

  test('routeMessage in a cookie-bound Workspace reaches broadcastToWorkspace', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'samsinn-streaming-'))
    process.env.SAMSINN_HOME = homeDir

    const shared = createDeploymentRuntime({
      providerConfig: baseConfig,
      providerSetup: makeSetup(makeStubGateway()),
    })

    // Forward-declared wsManager — the registry's onWorkspaceRuntimeCreated closes over
    // this. The bootstrap pattern relies on wsManager being assigned before
    // any registry.getOrLoad() runs.
    let wsManager!: WSManager
    const broadcasts: Array<{ workspaceId: string; msg: WSOutbound }> = []

    const registry = createWorkspaceRuntimeRegistry({
      deployment: shared,
      onWorkspaceRuntimeCreated: async (system, id, autoSaver) => {
        // The exact same call that bootstrap.ts makes — this is the wiring
        // the bug skipped.
        wireWorkspaceRuntimeEvents(system, wsManager, autoSaver, id)
      },
    })

    // Construct wsManager AFTER registry but BEFORE the first getOrLoad.
    // Wrap broadcastToWorkspace to record what would have hit the WS.
    const baseWs = createWSManager({ getRuntime: (id) => registry.tryGetLive(id) })
    wsManager = {
      ...baseWs,
      broadcastToWorkspace: (workspaceId, msg) => {
        broadcasts.push({ workspaceId, msg })
        baseWs.broadcastToWorkspace(workspaceId, msg)
      },
    }

    // The bug only manifested for non-default Workspaces loaded by cookie. Use
    // an explicit cookie-shaped id (16 chars, lowercase alphanumeric) so we
    // exercise that exact path.
    const cookieId = newWorkspaceId()
    const sys = await registry.getOrLoad(cookieId)

    // Harness sanity: the seed should have produced at least one room.
    // If this is empty, we'd misdiagnose missing wiring as missing room.
    const rooms = sys.rooms.listAllRooms()
    expect(rooms.length).toBeGreaterThan(0)

    // Trigger a message that fires onMessagePosted. This is the chain the
    // bug broke: room.post -> onMessagePosted (via lateBinding proxy) ->
    // wireWorkspaceRuntimeEvents-installed callback -> broadcastToWorkspace.
    sys.routeMessage(
      { rooms: [rooms[0]!.id] },
      { senderId: 'system', senderName: 'system', content: 'test note', type: 'system' },
    )

    // The broadcast must have reached our instrumented broadcastToWorkspace,
    // scoped to OUR cookie-bound workspaceId. Pre-fix behavior: zero entries.
    const our = broadcasts.filter(b => b.workspaceId === cookieId)
    expect(our.length).toBeGreaterThan(0)
    expect(our.some(b => b.msg.type === 'message')).toBe(true)
  })
})
