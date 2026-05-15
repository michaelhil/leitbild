import { z } from 'zod'
import type { CommandEnvelope } from '../model/index.ts'

export const participantRoleSchema = z.enum(['operator', 'supervisor', 'observer', 'experimenter', 'facilitator', 'ai_teammate'])
export type ParticipantRole = z.infer<typeof participantRoleSchema>

export interface Participant {
  readonly id: string
  readonly label: string
  readonly role: ParticipantRole
}

export const canIssueCommand = (participant: Participant, command: CommandEnvelope): boolean => {
  if (command.kind.startsWith('scenario.')) {
    return participant.role === 'experimenter' || participant.role === 'facilitator'
  }
  return participant.role === 'operator' || participant.role === 'supervisor' || participant.role === 'experimenter'
}
