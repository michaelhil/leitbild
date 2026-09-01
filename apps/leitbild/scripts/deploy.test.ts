import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  INSTALL_MANIFEST_ONLY_WORKSPACE_PATHS,
  isProductionSourcePath,
  PRODUCTION_DEPENDENCY_WORKSPACE_PATHS,
} from './deploy.ts'

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

test('production install includes manifests for development-only lockfile workspaces', () => {
  expect(INSTALL_MANIFEST_ONLY_WORKSPACE_PATHS).toEqual(['packages/integration-tests'])
})

test('production artifact excludes development-only files', () => {
  expect(isProductionSourcePath('agents', 'src/main.ts')).toBe(true)
  expect(isProductionSourcePath('agents', 'examples/scripts/demo.md')).toBe(true)
  expect(isProductionSourcePath('agents', 'src/api/server.test.ts')).toBe(false)
  expect(isProductionSourcePath('agents', 'src/packs/example/fixtures/input.json')).toBe(false)
  expect(isProductionSourcePath('agents', 'src/api/__fixtures__/stub-gateway.ts')).toBe(false)
  expect(isProductionSourcePath('agents', 'docs/packs.md')).toBe(false)
  expect(isProductionSourcePath('world', 'tests/api.test.ts')).toBe(false)
  expect(isProductionSourcePath('host', 'deploy/backup/backup-production.sh')).toBe(false)
  expect(isProductionSourcePath('host', 'deploy/Caddyfile')).toBe(true)
})
