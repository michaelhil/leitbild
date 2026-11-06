import { z } from 'zod'
import { workspaceDefinitionRevisionReferenceSchema } from './definitions.ts'

export const scenarioEditorRevisionSchema = workspaceDefinitionRevisionReferenceSchema.refine(
  subject => subject.moduleId === 'world' && subject.type === 'world.scenario',
  'The editor must identify a World Scenario revision',
)

const editorDocument = { documentId: z.uuid() }
const editorStart = { ...editorDocument, requestId: z.number().int().positive() }

export const scenarioEditorMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...editorDocument, type: z.literal('leitbild:scenario-dirty'), dirty: z.boolean() }),
  z.strictObject({
    ...editorDocument, type: z.literal('leitbild:scenario-saved'), dirty: z.boolean(), subject: scenarioEditorRevisionSchema.nullable(),
  }),
  z.strictObject({ ...editorStart, type: z.literal('leitbild:scenario-start'), subject: scenarioEditorRevisionSchema }),
])
export type ScenarioEditorMessage = z.infer<typeof scenarioEditorMessageSchema>

export const scenarioEditorStartIssueSchema = z.strictObject({
  ...editorStart, type: z.literal('leitbild:scenario-start-issue'), action: z.enum(['retry', 'check']), message: z.string().min(1),
})
export type ScenarioEditorStartIssue = z.infer<typeof scenarioEditorStartIssueSchema>
