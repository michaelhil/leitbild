import { describe, expect, test } from 'bun:test'
import { selectDeployTestFiles } from './deploy-tests.ts'

describe('deploy-safe test selection', () => {
  test('excludes only external-network integrations and sorts the rest', () => {
    expect(selectDeployTestFiles([
      'tools/web.test.ts',
      'src/z.test.ts',
      'README.md',
      'tools/research.test.ts',
      'src/a.test.ts',
    ])).toEqual(['src/a.test.ts', 'src/z.test.ts'])
  })
})
