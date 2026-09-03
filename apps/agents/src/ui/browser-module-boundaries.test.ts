import { describe, expect, test } from 'bun:test'

describe('browser module serving boundary', () => {
  test('runtime imports remain browser-resolvable after per-file transpilation', async () => {
    const root = import.meta.dir
    const transpiler = new Bun.Transpiler({ loader: 'ts' })
    const invalid: string[] = []
    for await (const relativePath of new Bun.Glob('**/*.ts').scan({ cwd: root })) {
      if (relativePath.endsWith('.test.ts')) continue
      const output = transpiler.transformSync(await Bun.file(`${root}/${relativePath}`).text())
      for (const imported of new Bun.Transpiler({ loader: 'js' }).scan(output).imports) {
        const specifier = imported.path
        if (!specifier.startsWith('.') && !specifier.startsWith('/')) invalid.push(`${relativePath}: ${specifier}`)
      }
    }
    expect(invalid).toEqual([])
  })
})
