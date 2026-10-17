import { describe, expect, test } from 'bun:test'
import { matrixRebuildOwner, matrixRebuildSection } from './reference-design-operating-joined'

const block = {
  decision: 'owner request 7 P (MR-1), 17 October 2026, conditional',
  appliesFrom: 'S3',
  rebuildEverySteps: 25,
  mechanism: 'stock IDAS check points',
  adoption: 'gate runs only once C2 measures at most 0.5',
  guard: 'a test fails if a SUNDIALS upgrade stops the forced rebuild',
}
const page = (value: unknown, heading: string = matrixRebuildOwner.heading) =>
  `# Operating equations\n\n### ${heading}\n\n\`\`\`${matrixRebuildOwner.fence}\n${JSON.stringify(value)}\n\`\`\`\n\n## Next\n`

describe('the joined packet\'s matrixRebuild section (MR-1, R7-P)', () => {
  test('carries the owner\'s block verbatim with the page it was read from', () => {
    const text = page(block)
    const section = matrixRebuildSection(text)
    expect(section.rebuildEverySteps).toBe(25)
    expect(section.appliesFrom).toBe('S3')
    expect(section.provenance.consumed[0]!.name).toBe(matrixRebuildOwner.page)
    expect(section.provenance.consumed[0]!.sha256).toHaveLength(64)
  })
  test('refuses a missing or misplaced block, an unknown key, another step or scope', () => {
    expect(() => matrixRebuildSection('# Operating equations\n')).toThrow()
    expect(() => matrixRebuildSection(page(block, 'Another heading'))).toThrow()
    expect(() => matrixRebuildSection(page({ ...block, extra: 1 }))).toThrow()
    expect(() => matrixRebuildSection(page({ ...block, rebuildEverySteps: 0 }))).toThrow()
    expect(() => matrixRebuildSection(page({ ...block, rebuildEverySteps: 2.5 }))).toThrow()
    expect(() => matrixRebuildSection(page({ ...block, appliesFrom: 'S2' }))).toThrow()
  })
})
