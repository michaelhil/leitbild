import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { PRODUCTION_DEPENDENCY_WORKSPACE_PATHS } from './deploy.ts'

const workspaceRoot = resolve(import.meta.dir, '../../..')
const productionAppPaths = ['apps/leitbild', 'apps/world', 'apps/agents'] as const

interface PackageJson {
  readonly name: string
  readonly dependencies?: Readonly<Record<string, string>>
}

test('production artifact includes every local workspace dependency', async () => {
  const includedPaths = [...productionAppPaths, ...PRODUCTION_DEPENDENCY_WORKSPACE_PATHS]
  const packages = await Promise.all(includedPaths.map(async path =>
    await Bun.file(resolve(workspaceRoot, path, 'package.json')).json() as PackageJson))
  const includedNames = new Set(packages.map(packageJson => packageJson.name))

  for (const packageJson of packages) {
    for (const [dependency, version] of Object.entries(packageJson.dependencies ?? {})) {
      if (version.startsWith('workspace:')) expect(includedNames.has(dependency)).toBe(true)
    }
  }
})
