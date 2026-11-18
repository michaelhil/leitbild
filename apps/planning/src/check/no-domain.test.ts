import { describe, expect, test } from 'bun:test'

// Acceptance row 4: the Supply run is solved by the same core with no domain branch. The core folders may
// not name a Pack, a flagship item or a Supply-run item in code. Comments and the planner-facing field
// descriptions of the published schemas (`.describe(...)`, examples for people) are not code and are left out.
const root = new URL('..', import.meta.url).pathname
const folders = ['solve', 'check', 'plan', 'time']
const domain: ReadonlyArray<readonly [string, RegExp]> = [
  ['a Pack id', /process-plant|einsatz/i],
  ['a flagship item', /\bpwr\b|train-?a\b|\bpumps?\b|\bSW[AB]\b|\bCCW|\bRHR|\bHHSI|\bAFW|cooling|crane|eddy|\bECT\b|contractor|reactor|\bplant\b|feedwater|heat exchanger/i],
  ['a Supply-run item', /\btrucks?\b|payload|depot|sports-hall|field-kitchen|supply-run|\bvehicle/i],
]

/** The file with comments and published field descriptions removed. */
const codeOnly = (text: string): string => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\.describe\(\s*(['"`])(?:\\.|(?!\1)[^\\])*\1\s*\)/g, '')
  .split('\n').map(line => line.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n')

const coreFiles = (): string[] => folders.flatMap(folder => [...new Bun.Glob(`${folder}/**/*.ts`).scanSync({ cwd: root })])
  .filter(path => !path.endsWith('.test.ts') && !path.includes('/fixtures/'))

describe('no domain code in the core', () => {
  test('the scan sees the checker and the plan schema', () => {
    const files = coreFiles()
    expect(files).toContain('check/check.ts')
    expect(files).toContain('plan/schema.ts')
  })
  test('the scan finds a domain branch when there is one', () => {
    expect(domain.some(([, pattern]) => pattern.test(codeOnly("if (job.key === 'SWA-TAG') return"))))
      .toBe(true)
    expect(domain.some(([, pattern]) => pattern.test(codeOnly("// the SW A pump\nconst limit = 1\nz.string().describe('tool: crane, truck')")))).toBe(false)
  })
  test('solve/, check/, plan/ and time/ name no Pack, flagship or Supply-run item in code', async () => {
    const found: string[] = []
    for (const path of coreFiles()) {
      const code = codeOnly(await Bun.file(`${root}${path}`).text())
      code.split('\n').forEach((line, index) => {
        for (const [what, pattern] of domain) if (pattern.test(line)) found.push(`${path}:${index + 1} names ${what}: ${line.trim()}`)
      })
    }
    expect(found).toEqual([])
  })
})
