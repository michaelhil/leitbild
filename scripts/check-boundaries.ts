import { relative, resolve, sep } from 'node:path'
import { existsSync } from 'node:fs'

interface Boundary {
  readonly owner: string
  readonly root: string
  readonly forbidden: ReadonlyArray<RegExp>
}

const repositoryRoot = resolve(import.meta.dir, '..')
const appImport = (names: string): RegExp => new RegExp(`(?:from\\s*|import\\s*)[('"\\x60][^'"\\x60]*apps/(?:${names})(?:/|['"\\x60])`)
const packageImport = (names: string): RegExp => new RegExp(`(?:from\\s*|import\\s*)[('"\\x60]@leitbild/(?:${names})(?:/|['"\\x60])`)

const boundaries: ReadonlyArray<Boundary> = [
  { owner: 'World', root: resolve(repositoryRoot, 'apps/world'), forbidden: [appImport('agents|leitbild'), packageImport('agents|host')] },
  { owner: 'Agents', root: resolve(repositoryRoot, 'apps/agents'), forbidden: [appImport('world|leitbild'), packageImport('world|host')] },
  { owner: 'Leitbild Host', root: resolve(repositoryRoot, 'apps/leitbild'), forbidden: [appImport('world|agents'), packageImport('world|agents')] },
  { owner: 'Contracts', root: resolve(repositoryRoot, 'packages/contracts'), forbidden: [appImport('world|agents|leitbild'), packageImport('world|agents|host')] },
]

const sourceGlob = new Bun.Glob('**/*.{ts,tsx,svelte}')
const scanBoundary = async (boundary: Boundary): Promise<ReadonlyArray<string>> => {
  const violations: string[] = []
  if (!existsSync(boundary.root)) return violations
  for await (const localPath of sourceGlob.scan({ cwd: boundary.root, onlyFiles: true })) {
    const absolutePath = resolve(boundary.root, localPath)
    const content = await Bun.file(absolutePath).text()
    for (const forbidden of boundary.forbidden) {
      if (forbidden.test(content)) violations.push(`${boundary.owner}: ${relative(repositoryRoot, absolutePath).split(sep).join('/')}`)
    }
  }
  return violations
}

const violations = (await Promise.all(boundaries.map(scanBoundary))).flat()
if (violations.length > 0) {
  console.error('Application boundary violations:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}

const browserPackBuild = await Bun.build({
  entrypoints: [resolve(repositoryRoot, 'apps/world/src/ui/pack-loader.ts')],
  target: 'browser',
  splitting: true,
  write: false,
})
if (!browserPackBuild.success) {
  console.error('World browser Pack boundary violations:')
  for (const log of browserPackBuild.logs) console.error(log)
  process.exit(1)
}
console.log('Application boundaries are intact.')
