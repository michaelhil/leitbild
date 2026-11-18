import { apiFetch } from './api-client.ts'
import { posterForRoom } from './room-poster.ts'
import { $roomMessages, $connected, $agents } from './stores.ts'
import type { UIMessage } from './render/render-types.ts'
import {
  diagramRequestPath, diagramReply, replacementFromReply,
  type DiagramRequestAccepted, type DiagramRequestBody,
} from '../../core/diagram-request.ts'

export interface DiagramChangeInput {
  readonly source: string
  readonly initialSource: string
  readonly instruction: string
  readonly messageId: string
  readonly blockIndex: number
  readonly signal: AbortSignal
}

export const requestDiagramChange = async (input: DiagramChangeInput): Promise<{ source: string; label: string }> => {
  input.signal.throwIfAborted()
  if (!$connected.get()) throw new Error('Reconnect to this Room before asking for a change')
  const answer = Object.values($roomMessages.get()).flat().find(message => message.id === input.messageId)
  if (!answer?.roomId) throw new Error('The diagram message is no longer loaded. Reopen its Room and try again.')
  const roomId = answer.roomId
  const requesterId = posterForRoom(roomId)
  if (!requesterId) throw new Error('Choose who you post as in this Room before asking for a change')
  const body: DiagramRequestBody = {
    requesterId, diagramIndex: input.blockIndex, source: input.source, initialSource: input.initialSource, instruction: input.instruction,
  }
  const response = await apiFetch(diagramRequestPath(roomId, answer.id), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: input.signal,
  })
  if (response.status !== 202) {
    const refusal: unknown = await response.json()
    if (typeof refusal === 'object' && refusal !== null && 'error' in refusal && typeof refusal.error === 'string') throw new Error(refusal.error)
    throw new Error(`Diagram request failed (HTTP ${response.status})`)
  }
  const accepted = await response.json() as DiagramRequestAccepted
  if (typeof accepted.requestId !== 'string' || typeof accepted.queued !== 'boolean') throw new Error('The server did not identify the diagram request')
  input.signal.throwIfAborted()

  const reply = await new Promise<UIMessage>((resolve, reject) => {
    const stops: Array<() => void> = []
    let settled = false
    const finish = (result: UIMessage | Error): void => {
      if (settled) return
      settled = true
      stops.forEach(stop => stop())
      input.signal.removeEventListener('abort', aborted)
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const aborted = (): void => finish(new DOMException('Stopped waiting. The Agent may still reply in chat.', 'AbortError'))
    const inspect = (): void => {
      const found = diagramReply($roomMessages.get()[roomId] ?? [], answer.id, answer.senderId, accepted.requestId)
      if (found) finish(found)
    }
    stops.push($roomMessages.listen(inspect))
    stops.push($connected.listen(connected => { if (!connected) finish(new Error('The connection closed. The Agent reply may still be saved in chat; reconnect to review it.')) }))
    stops.push($agents.listen(agents => { if (!agents[answer.senderId]) finish(new Error('The Agent is no longer available. The current diagram is preserved.')) }))
    input.signal.addEventListener('abort', aborted, { once: true })
    if (input.signal.aborted) aborted()
    else if (!$connected.get()) finish(new Error('The connection closed. Reconnect to review the Agent reply in chat.'))
    else inspect()
  })
  return { source: replacementFromReply(reply), label: `Agent: ${input.instruction}` }
}
