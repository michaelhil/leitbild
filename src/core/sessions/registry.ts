import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { SessionId } from '../model/index.ts'
import type { SimulationAdapter } from '../../simulation/protocol.ts'
import { createJsonlEventLog } from './event-log.ts'
import { createStudySession, type StudySession } from './session.ts'

export interface SessionRegistry {
  readonly create: () => Promise<StudySession>
  readonly get: (id: SessionId) => StudySession | undefined
  readonly list: () => ReadonlyArray<StudySession>
  readonly close: (id: SessionId) => Promise<boolean>
}

export const createSessionRegistry = (config: {
  readonly dataDir: string
  readonly simulationAdapter: SimulationAdapter
}): SessionRegistry => {
  const sessions = new Map<SessionId, StudySession>()

  const create = async (): Promise<StudySession> => {
    const id = `session:${randomUUID()}` as SessionId
    const simulation = await config.simulationAdapter.connect({ sessionId: id })
    const eventLog = createJsonlEventLog(join(config.dataDir, 'sessions', id, 'events.jsonl'))
    const session = await createStudySession({ id, simulation, eventLog })
    sessions.set(id, session)
    return session
  }

  const close = async (id: SessionId): Promise<boolean> => {
    const session = sessions.get(id)
    if (!session) return false
    await session.close()
    sessions.delete(id)
    return true
  }

  return {
    create,
    get: (id: SessionId) => sessions.get(id),
    list: () => [...sessions.values()],
    close,
  }
}
