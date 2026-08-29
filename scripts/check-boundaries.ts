import { relative, resolve, sep } from 'node:path'
import { existsSync } from 'node:fs'

interface Boundary {
  readonly owner: string
  readonly root: string
  readonly forbidden: ReadonlyArray<RegExp>
}

const repositoryRoot = resolve(import.meta.dir, '..')

const boundaries: ReadonlyArray<Boundary> = [
  {
    owner: 'Samsinn',
    root: resolve(repositoryRoot, 'apps/samsinn'),
    forbidden: [
      /(?:from\s*|import\s*)[('"`]@samsinn-leitbild\/leitbild(?:\/|['"`])/,
      /(?:from\s*|import\s*)[('"`][^'"`]*apps\/leitbild(?:\/|['"`])/,
    ],
  },
  {
    owner: 'Leitbild',
    root: resolve(repositoryRoot, 'apps/leitbild'),
    forbidden: [
      /(?:from\s*|import\s*)[('"`]@samsinn-leitbild\/samsinn(?:\/|['"`])/,
      /(?:from\s*|import\s*)[('"`][^'"`]*apps\/samsinn(?:\/|['"`])/,
    ],
  },
  {
    owner: 'Platform contracts',
    root: resolve(repositoryRoot, 'packages/platform-contracts'),
    forbidden: [
      /(?:from\s*|import\s*)[('"`][^'"`]*apps\/(?:samsinn|leitbild)(?:\/|['"`])/,
      /(?:from\s*|import\s*)[('"`]@samsinn-leitbild\/(?:samsinn|leitbild)(?:\/|['"`])/,
    ],
  },
]

const sourceGlob = new Bun.Glob('**/*.{ts,tsx,svelte}')
const manifestGlob = new Bun.Glob('package.json')

const scanBoundary = async (boundary: Boundary): Promise<ReadonlyArray<string>> => {
  const violations: string[] = []
  if (!existsSync(boundary.root)) return violations

  const sourceFiles = await Array.fromAsync(sourceGlob.scan({ cwd: boundary.root, onlyFiles: true }))
  const manifestFiles = await Array.fromAsync(manifestGlob.scan({ cwd: boundary.root, onlyFiles: true }))
  for (const localPath of [...sourceFiles, ...manifestFiles]) {
    const absolutePath = resolve(boundary.root, localPath)
    const content = await Bun.file(absolutePath).text()
    for (const forbidden of boundary.forbidden) {
      if (forbidden.test(content)) {
        violations.push(`${boundary.owner}: ${relative(repositoryRoot, absolutePath).split(sep).join('/')}`)
      }
      forbidden.lastIndex = 0
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

console.log('Application boundaries are intact.')
