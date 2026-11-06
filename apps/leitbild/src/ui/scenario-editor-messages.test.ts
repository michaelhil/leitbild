import { expect, test } from 'bun:test'
import { scenarioEditorRevisionSchema } from '@leitbild/contracts'
import { readScenarioEditorMessage, sameSavedScenario } from './scenario-editor-messages.ts'
import { revision, WS } from './workspace-page.test-support.ts'

const origin = 'https://leitbild.test'
const source = {} as Window
const documentId = '6174f46b-f26f-42db-ad13-adb76ae4bb59'
const workspaceId = WS
const editor = { origin, source, documentId, workspaceId }
const subject = scenarioEditorRevisionSchema.parse({
  workspaceId, moduleId: 'world', type: 'world.scenario', id: 'my-scenario', revisionId: revision('a'),
})
const data = { type: 'leitbild:scenario-start', documentId, requestId: 1, subject }

test('editor start must come from the active same-origin Workspace document', () => {
  expect(readScenarioEditorMessage({ origin, source, data }, editor)).toEqual(data)
  expect(readScenarioEditorMessage({ origin: 'https://other.test', source, data }, editor)).toBeNull()
  expect(readScenarioEditorMessage({ origin, source: {} as Window, data }, editor)).toBeNull()
  expect(readScenarioEditorMessage({ origin, source, data: { ...data, documentId: crypto.randomUUID() } }, editor)).toBeNull()
  expect(readScenarioEditorMessage({
    origin, source, data: { ...data, subject: { ...subject, workspaceId: crypto.randomUUID() } },
  }, editor)).toBeNull()
  expect(readScenarioEditorMessage({
    origin, source, data: { ...data, subject: { ...subject, moduleId: 'agents', type: 'agents.room-definition' } },
  }, editor)).toBeNull()
})

test('an editor start matches the acknowledged revision, even when the Scenario id is unchanged', () => {
  expect(sameSavedScenario(subject, { ...subject })).toBe(true)
  expect(sameSavedScenario(subject, scenarioEditorRevisionSchema.parse({ ...subject, revisionId: revision('b') }))).toBe(false)
})
