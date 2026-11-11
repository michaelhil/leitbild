// Test child for store.test.ts: saves one plan over and over and prints each acknowledged revision, until killed.
import type { WorkspaceId } from '@leitbild/contracts'
import { createPlanStore } from '../store.ts'

const [root, workspaceId, planId] = process.argv.slice(2) as [string, WorkspaceId, string]
const store = createPlanStore(root)
for (;;) {
  const saved = await store.update(workspaceId, planId, { expectedRevision: undefined, required: false }, plan => ({
    ...plan, revision: plan.revision + 1, updatedAt: new Date().toISOString(),
    inputs: { ...plan.inputs, settings: { ...plan.inputs.settings, title: `Saved ${plan.revision + 1}` } },
  }))
  process.stdout.write(`${saved.revision}\n`)
}
