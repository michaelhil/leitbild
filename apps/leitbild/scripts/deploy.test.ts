import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  INSTALL_MANIFEST_ONLY_WORKSPACE_PATHS,
  isProductKnowledgePath,
  isProductionSourcePath,
  PRODUCTION_DEPENDENCY_WORKSPACE_PATHS,
  moduleRoutingPreflight,
  caddySnippetPreflight,
  caddySnippetDeployment,
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

test('Module routing has one production owner and cannot be overridden by provider environment files', async () => {
  for (const module of ['world', 'agents']) {
    const unit = await Bun.file(resolve(workspaceRoot, `apps/leitbild/deploy/leitbild-${module}.service`)).text()
    const example = await Bun.file(resolve(workspaceRoot, `apps/leitbild/deploy/${module}.env.example`)).text()
    expect(unit).toContain('Environment=WORKSPACE_HOST_URL=http://127.0.0.1:3100')
    expect(example).not.toMatch(/^WORKSPACE_HOST_URL=/m)
  }
  expect(moduleRoutingPreflight()).toContain('for module in world agents')
  expect(moduleRoutingPreflight()).toContain('exit 1')
  expect(moduleRoutingPreflight()).toContain('grep -Eq') // Never prints credential-file content.
  const directory = await mkdtemp(resolve(tmpdir(), 'leitbild-routing-test-'))
  try {
    const check = async () => {
      const proc = Bun.spawn(['bash', '-euc', moduleRoutingPreflight().replaceAll('/etc/leitbild', directory)], { stdout: 'pipe', stderr: 'pipe' })
      return { code: await proc.exited, error: await new Response(proc.stderr).text() }
    }
    await writeFile(resolve(directory, 'agents.env'), '# WORKSPACE_HOST_URL is service-owned\nOPENAI_API_KEY=test-secret-marker\n')
    expect((await check()).code).toBe(0)
    for (const module of ['world', 'agents']) {
      await writeFile(resolve(directory, `${module}.env`), 'WORKSPACE_HOST_URL=https://retired.invalid\nOPENAI_API_KEY=test-secret-marker\n')
      const result = await check()
      expect(result.code).toBe(1)
      expect(result.error).toContain('Remove WORKSPACE_HOST_URL')
      expect(result.error).not.toContain('test-secret-marker')
      expect(result.error).not.toContain('retired.invalid')
      await rm(resolve(directory, `${module}.env`))
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
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
  expect(isProductionSourcePath('host', 'deploy/sites/leitbild.caddy')).toBe(true)
  expect(isProductionSourcePath('host', 'deploy/sites/optifuel.caddy')).toBe(false)
  expect(isProductKnowledgePath('docs/adr/0015-leitbild-assistant-uses-an-ordinary-room.md')).toBe(true)
  expect(isProductKnowledgePath('contexts/agents/CONTEXT.md')).toBe(true)
  expect(isProductKnowledgePath('apps/world/README.md')).toBe(true)
  expect(isProductKnowledgePath('.env')).toBe(false)
})

test('public routing exposes only the bundled Agents UI asset namespace', async () => {
  const caddyfile = await Bun.file(resolve(workspaceRoot, 'apps/leitbild/deploy/sites/leitbild.caddy')).text()
  expect(caddyfile).toContain('/assets/agents/.*')
  expect(caddyfile).not.toContain('/modules/.*')
  expect(caddyfile).not.toContain('/biometrics/.*')
  expect(caddyfile).not.toContain('/dist\\.css')
})

test('Caddy root delegates site ownership and refuses unprovisioned shared layout', async () => {
  const root = await Bun.file(resolve(workspaceRoot, 'apps/leitbild/deploy/Caddyfile')).text()
  expect(root).toContain('import /etc/caddy/sites-enabled/*.caddy')
  expect(root).not.toContain('leitbild.app {')
  const directory = await mkdtemp(resolve(tmpdir(), 'leitbild-caddy-preflight-'))
  try {
    await writeFile(resolve(directory, 'Caddyfile'), 'another.example { respond "keep" }\n')
    const proc = Bun.spawn(['bash', '-euc', caddySnippetPreflight().replaceAll('/etc/caddy', directory)], { stdout: 'pipe', stderr: 'pipe' })
    expect(await proc.exited).toBe(1)
    expect(await new Response(proc.stderr).text()).toContain('Existing host configuration will not be overwritten')
    expect(await readFile(resolve(directory, 'Caddyfile'), 'utf8')).toBe('another.example { respond "keep" }\n')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

for (const outcome of ['success', 'invalid', 'reload-failed', 'public-failed'] as const) {
  test(`Caddy snippet deployment preserves foreign sites and root: ${outcome}`, async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'leitbild-caddy-deploy-'))
    try {
      const sites = resolve(directory, 'sites-enabled')
      const release = resolve(directory, 'release')
      await mkdir(sites)
      await mkdir(resolve(release, 'apps/leitbild/deploy/sites'), { recursive: true })
      const root = `# Host-owned setting\nimport ${sites}/*.caddy\n`
      const foreign = 'optifuel.mightwork.ai { reverse_proxy 127.0.0.1:8765 }\n'
      await writeFile(resolve(directory, 'Caddyfile'), root)
      await writeFile(resolve(sites, 'optifuel.caddy'), foreign)
      await writeFile(resolve(sites, 'leitbild.caddy'), 'previous Leitbild\n')
      await writeFile(resolve(release, 'apps/leitbild/deploy/sites/leitbild.caddy'), 'next Leitbild\n')
      // Execute the real deployment shell against isolated files. Only privileged
      // host commands are replaced; their failures exercise filesystem rollback.
      const script = `
release_id=test
release_dir="$TEST_RELEASE"
flock() { return 0; }
install() { cp "\${@: -2:1}" "\${@: -1}"; }
caddy() {
  test "$1" = validate && test "$2" = --config && test "$3" = "$TEST_CADDY/Caddyfile" || return 2
  test -s "$TEST_CADDY/sites-enabled/optifuel.caddy" || return 2
  test "$TEST_OUTCOME" != invalid
}
systemctl() {
  test "$1" = reload && test "$2" = caddy.service || return 2
  test "$TEST_OUTCOME" != reload-failed || ! grep -q 'next Leitbild' "$TEST_CADDY/sites-enabled/leitbild.caddy"
}
${caddySnippetDeployment().replaceAll('/etc/caddy', directory).replace('/run/lock/caddy-config.lock', resolve(directory, 'caddy-config.lock'))}
if test "$TEST_OUTCOME" = public-failed; then restore_leitbild_caddy; systemctl reload caddy.service; exit 1; fi
`
      const proc = Bun.spawn(['bash', '-euc', script], {
        env: { ...process.env, TEST_RELEASE: release, TEST_CADDY: directory, TEST_OUTCOME: outcome },
        stdout: 'pipe', stderr: 'pipe',
      })
      const error = await new Response(proc.stderr).text()
      expect(await proc.exited, error).toBe(outcome === 'success' ? 0 : 1)
      expect(await readFile(resolve(directory, 'Caddyfile'), 'utf8')).toBe(root)
      expect(await readFile(resolve(sites, 'optifuel.caddy'), 'utf8')).toBe(foreign)
      expect(await readFile(resolve(sites, 'leitbild.caddy'), 'utf8')).toBe(outcome === 'success' ? 'next Leitbild\n' : 'previous Leitbild\n')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
}
