import { expect, test } from 'bun:test'
import { checkCeiling, filesAtRevision, measure } from '../display-loc.ts'

// This proof requires the recorded Git commit. The deterministic script suite
// runs separately from this historical reproduction.
// One `git show` per file in scope (139 at bacf7a115, about 2.6 s on a quiet machine): sized for a loaded one, as
// Bun's 5 s default failed under parallel lanes.
const BASELINE_READ_TIMEOUT_MS = 60_000

test('reproduces the plan baseline at bacf7a115: 32,908 lines', async () => {
  const { commit, files } = await filesAtRevision(`${import.meta.dir}/../..`, 'bacf7a115')
  const report = measure(commit, files)
  expect(report.total).toBe(32_908)
  expect(report.groups.find(group => group.name === 'World plant displays')?.lines).toBe(15_166)
  expect(checkCeiling(report, 'p0').pass).toBe(false)
}, BASELINE_READ_TIMEOUT_MS)
