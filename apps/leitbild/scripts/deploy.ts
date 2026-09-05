#!/usr/bin/env bun

import { chmod, copyFile, lstat, mkdir, mkdtemp, readlink, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

const APP_ID = 'leitbild-platform'
const SSH_HOST = process.env.LEITBILD_SSH_HOST ?? 'samsinn'
const WORKSPACE_ROOT = resolve(import.meta.dir, '../../..')
const HOST_ROOT = resolve(import.meta.dir, '..')
const WORLD_ROOT = resolve(WORKSPACE_ROOT, 'apps/world')
const AGENTS_ROOT = resolve(WORKSPACE_ROOT, 'apps/agents')
export const PRODUCTION_DEPENDENCY_WORKSPACE_PATHS = [
  'packages/contracts',
  'packages/module-runtime',
] as const
export const INSTALL_MANIFEST_ONLY_WORKSPACE_PATHS = [
  'packages/integration-tests',
] as const
const PRODUCTION_DEPENDENCY_WORKSPACES = PRODUCTION_DEPENDENCY_WORKSPACE_PATHS.map(target => ({
  source: resolve(WORKSPACE_ROOT, target),
  target,
}))
const DEPLOY_ROOT = '/opt/leitbild'
const CURRENT_LINK = `${DEPLOY_ROOT}/current`
const RELEASES_DIR = `${DEPLOY_ROOT}/releases`
const DEPS_DIR = `${DEPLOY_ROOT}/deps`
const STATE_ROOT = '/var/lib/leitbild'
const SERVICES = ['leitbild-world.service', 'leitbild-agents.service', 'leitbild-host.service'] as const
const SERVICE_USER = 'leitbild'
const BUN_BIN = `${DEPLOY_ROOT}/runtime/bun`
const PUBLIC_HEALTH_URL = 'https://leitbild.app/health'
const REQUIRED_BUN_VERSION = '1.4.0'

interface Options {
  readonly dryRun: boolean
  readonly yes: boolean
  readonly install: boolean
}

interface ArtifactEntry {
  readonly source: string
  readonly target: string
}

interface DeploymentManifest {
  readonly schemaVersion: 1
  readonly app: typeof APP_ID
  readonly releaseId: string
  readonly createdAt: string
  readonly baseCommit: string
  readonly branch: string
  readonly dirty: boolean
  readonly worktreeStatus: ReadonlyArray<string>
  readonly sourceDigest: string
  readonly dependencyPackagesDigest: string
  readonly fileCount: number
  readonly persistentRootsExcluded: ReadonlyArray<string>
}

const usage = (): string => `Usage: bun run deploy -- [--dry-run] [--yes] [--install]

  --dry-run  Validate and package without contacting production
  --yes      Skip the interactive production confirmation
  --install  Install the service, state directory, environment, and Caddy topology
`

export const parseDeployArgs = (args: ReadonlyArray<string>): Options => {
  let dryRun = false
  let yes = false
  let install = false
  for (const arg of args) {
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--yes') yes = true
    else if (arg === '--install') install = true
    else if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    } else throw new Error(`Unknown argument: ${arg}\n\n${usage()}`)
  }
  return { dryRun, yes, install }
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`

const run = async (label: string, command: ReadonlyArray<string>, cwd = WORKSPACE_ROOT): Promise<void> => {
  console.log(`\n→ ${label}`)
  const child = Bun.spawn([...command], { cwd, stdout: 'inherit', stderr: 'inherit' })
  const code = await child.exited
  if (code !== 0) throw new Error(`${label} failed with exit code ${code}`)
}

const capture = async (command: ReadonlyArray<string>, cwd = WORKSPACE_ROOT): Promise<string> => {
  const child = Bun.spawn([...command], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command.join(' ')} failed (${code}): ${stderr.trim()}`)
  return stdout
}

const trackedFiles = async (root: string): Promise<string[]> => {
  const raw = await capture(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], root)
  return raw.split('\0').filter(Boolean).sort()
}

const isDevelopmentOnlyPath = (path: string): boolean =>
  /(?:^|\/)(?:tests?|fixtures|__fixtures__|__tests__|__snapshots__)(?:\/|$)/.test(path)
  || /\.(?:test|spec)(?:-d)?\.[cm]?[jt]sx?$/.test(path)

export const isProductionSourcePath = (workspace: 'host' | 'world' | 'agents' | 'package', path: string): boolean => {
  if (isDevelopmentOnlyPath(path)) return false
  if (workspace === 'host') {
    return path === 'package.json'
      || path.startsWith('src/')
      || path === 'deploy/Caddyfile'
      || /^deploy\/leitbild-(?:host|world|agents)\.service$/.test(path)
      || path.startsWith('deploy/retired/')
  }
  if (workspace === 'world') return path === 'package.json' || path.startsWith('src/')
  if (workspace === 'agents') {
    return path === 'package.json'
      || path === 'mcp-servers.json'
      || path.startsWith('src/')
      || path.startsWith('examples/scripts/')
      || path.startsWith('skills/')
      || path.startsWith('tools/')
  }
  return path === 'package.json' || path.startsWith('src/')
}

export const isProductKnowledgePath = (path: string): boolean =>
  path === 'README.md'
  || path === 'CONTEXT-MAP.md'
  || path.startsWith('docs/')
  || path.startsWith('contexts/')
  || /^apps\/[^/]+\/README\.md$/.test(path)
  || /^packages\/[^/]+\/README\.md$/.test(path)

const directoryFiles = async (root: string, child: string): Promise<string[]> => {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else files.push(relative(root, path))
    }
  }
  await visit(join(root, child))
  return files
}

const entriesFor = async (
  root: string,
  targetRoot: string,
  workspace: 'host' | 'world' | 'agents' | 'package',
  extra: ReadonlyArray<string> = [],
): Promise<ArtifactEntry[]> => {
  const entries: ArtifactEntry[] = []
  for (const path of [...new Set([...await trackedFiles(root), ...extra])].sort()) {
    if (path.startsWith('/') || path.split('/').includes('..')) throw new Error(`Unsafe source path: ${path}`)
    if (!isProductionSourcePath(workspace, path)) continue
    const source = join(root, path)
    const stat = await lstat(source).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (stat === null) continue
    if (stat.isFile() || stat.isSymbolicLink()) entries.push({ source, target: join(targetRoot, path) })
  }
  return entries
}

const digestEntries = async (entries: ReadonlyArray<ArtifactEntry>): Promise<string> => {
  const hasher = new Bun.CryptoHasher('sha256')
  for (const entry of [...entries].sort((left, right) => left.target.localeCompare(right.target))) {
    const stat = await lstat(entry.source)
    hasher.update(entry.target)
    hasher.update('\0')
    if (stat.isSymbolicLink()) hasher.update(await readlink(entry.source))
    else hasher.update(await Bun.file(entry.source).arrayBuffer())
    hasher.update('\0')
  }
  return hasher.digest('hex')
}

const sha256File = async (path: string): Promise<string> => {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(await Bun.file(path).arrayBuffer())
  return hasher.digest('hex')
}

const copyEntries = async (entries: ReadonlyArray<ArtifactEntry>, stageRoot: string): Promise<void> => {
  for (const entry of entries) {
    const target = join(stageRoot, entry.target)
    const stat = await lstat(entry.source)
    await mkdir(dirname(target), { recursive: true })
    if (stat.isSymbolicLink()) await symlink(await readlink(entry.source), target)
    else {
      await copyFile(entry.source, target)
      await chmod(target, stat.mode & 0o777)
    }
  }
}

const createArtifact = async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'leitbild-release-'))
  const stageRoot = join(tempRoot, 'stage')
  const archivePath = join(tempRoot, 'release.tgz')
  await mkdir(stageRoot)
  const hostEntries = await entriesFor(HOST_ROOT, 'apps/leitbild', 'host', await directoryFiles(HOST_ROOT, 'src/ui/dist'))
  const worldEntries = await entriesFor(WORLD_ROOT, 'apps/world', 'world', await directoryFiles(WORLD_ROOT, 'src/ui/dist'))
  const agentsEntries = await entriesFor(AGENTS_ROOT, 'apps/agents', 'agents', [
    'src/ui/dist.css',
    ...await directoryFiles(AGENTS_ROOT, 'src/ui/dist'),
  ])
  const rootEntries: ArtifactEntry[] = ['package.json', 'bun.lock'].map(path => ({ source: join(WORKSPACE_ROOT, path), target: path }))
  const productKnowledgeEntries: ArtifactEntry[] = (await trackedFiles(WORKSPACE_ROOT))
    .filter(path => isProductKnowledgePath(path) && !isDevelopmentOnlyPath(path))
    .map(path => ({ source: join(WORKSPACE_ROOT, path), target: path }))
  const installManifestEntries: ArtifactEntry[] = INSTALL_MANIFEST_ONLY_WORKSPACE_PATHS.map(path => ({
    source: join(WORKSPACE_ROOT, path, 'package.json'),
    target: join(path, 'package.json'),
  }))
  const dependencyPackageEntries = (await Promise.all(
    PRODUCTION_DEPENDENCY_WORKSPACES.map(workspace => entriesFor(workspace.source, workspace.target, 'package')),
  )).flat()
  const entries = [
    ...rootEntries,
    ...productKnowledgeEntries,
    ...hostEntries,
    ...worldEntries,
    ...agentsEntries,
    ...dependencyPackageEntries,
    ...installManifestEntries,
  ]
  const sourceDigest = await digestEntries(entries)
  const dependencyPackagesDigest = await digestEntries(dependencyPackageEntries)
  const createdAt = new Date().toISOString()
  const baseCommit = (await capture(['git', 'rev-parse', 'HEAD'])).trim()
  const branch = (await capture(['git', 'branch', '--show-current'])).trim() || '(detached)'
  const worktreeStatus = (await capture(['git', 'status', '--porcelain=v1', '--untracked-files=all'])).split('\n').filter(Boolean)
  const manifest: DeploymentManifest = {
    schemaVersion: 1,
    app: APP_ID,
    releaseId: `${createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${baseCommit.slice(0, 10)}-${sourceDigest.slice(0, 10)}`,
    createdAt,
    baseCommit,
    branch,
    dirty: worktreeStatus.length > 0,
    worktreeStatus,
    sourceDigest,
    dependencyPackagesDigest,
    fileCount: entries.length,
    persistentRootsExcluded: [STATE_ROOT],
  }
  await copyEntries(entries, stageRoot)
  await writeFile(join(stageRoot, 'DEPLOYMENT.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
  await run('Create immutable Leitbild artifact', ['tar', '--no-mac-metadata', '--no-xattrs', '-czf', archivePath, '-C', stageRoot, '.'])
  return {
    archivePath,
    archiveChecksum: await sha256File(archivePath),
    lockChecksum: await sha256File(join(WORKSPACE_ROOT, 'bun.lock')),
    manifest,
    cleanup: () => rm(tempRoot, { recursive: true, force: true }),
  }
}

export const moduleRoutingPreflight = (): string => `for module in world agents; do
  env_file="/etc/leitbild/$module.env"
  if test -f "$env_file" && grep -Eq '^[[:space:]]*WORKSPACE_HOST_URL[[:space:]]*=' "$env_file"; then
    echo "Remove WORKSPACE_HOST_URL from $env_file: production Module routing is owned by its service definition, not provider settings." >&2
    exit 1
  fi
done`

const remotePreflight = (install: boolean): string => `set -euo pipefail
${moduleRoutingPreflight()}
test "$(/opt/leitbild/runtime/bun --version)" = ${shellQuote(REQUIRED_BUN_VERSION)}
test "$(systemctl is-active caddy.service)" = active
test "$(systemctl is-active docker.service)" = active
test "$(df --output=avail /opt | tail -n 1 | tr -d ' ')" -gt 2097152
if test ${install ? '0' : '1'} -eq 1; then
  ${SERVICES.map(service => `test "$(systemctl is-active ${service})" = active`).join('\n  ')}
fi
`

const remoteDeploy = (artifact: Awaited<ReturnType<typeof createArtifact>>, remoteArchive: string, install: boolean): string => {
  const id = artifact.manifest.releaseId
  return `set -euo pipefail
exec 9>/run/lock/leitbild-deploy.lock
flock -n 9 || { echo "Another stack deployment is active" >&2; exit 1; }
${remotePreflight(install)}
release_id=${shellQuote(id)}
release_dir=${shellQuote(`${RELEASES_DIR}/${id}`)}
archive=${shellQuote(remoteArchive)}
incoming=${shellQuote(`${RELEASES_DIR}/.incoming-${id}`)}
dep_dir=${shellQuote(`${DEPS_DIR}/${artifact.lockChecksum}-${artifact.manifest.dependencyPackagesDigest}`)}
previous=""
test ! -e "$release_dir"
if test -L ${shellQuote(CURRENT_LINK)}; then previous="$(readlink -f ${shellQuote(CURRENT_LINK)})"; fi
cleanup() { rm -rf -- "$incoming"; rm -f -- "$archive"; }
trap cleanup EXIT
if test ${install ? '1' : '0'} -eq 1; then
  id -u ${SERVICE_USER} >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin ${SERVICE_USER}
  install -d -o ${SERVICE_USER} -g ${SERVICE_USER} -m 0700 ${shellQuote(`${STATE_ROOT}/host`)} ${shellQuote(`${STATE_ROOT}/world`)} ${shellQuote(`${STATE_ROOT}/agents`)}
  install -d -o root -g root -m 0755 ${shellQuote(DEPLOY_ROOT)}
  install -d -o root -g root -m 0755 /etc/leitbild
  cat > /etc/leitbild/platform.env <<'EOF'
WORKSPACE_HOST_URL=https://leitbild.app
WORKSPACE_MODULES=[{"moduleId":"world","internalBaseUrl":"http://127.0.0.1:4177","manifestPath":"/.well-known/workspace-module"},{"moduleId":"agents","internalBaseUrl":"http://127.0.0.1:3000","manifestPath":"/.well-known/workspace-module"}]
EOF
  chmod 0600 /etc/leitbild/platform.env
fi
mkdir -p ${shellQuote(RELEASES_DIR)} ${shellQuote(DEPS_DIR)}
printf '%s  %s\n' ${shellQuote(artifact.archiveChecksum)} "$archive" | sha256sum --check --status
mkdir "$incoming"
tar -xzf "$archive" --no-same-owner -C "$incoming"
test "$(jq -r .app "$incoming/DEPLOYMENT.json")" = ${shellQuote(APP_ID)}
test "$(jq -r .releaseId "$incoming/DEPLOYMENT.json")" = "$release_id"
if test ! -d "$dep_dir/node_modules"; then
  dep_tmp="${DEPS_DIR}/.incoming-${artifact.lockChecksum}-$$"
  rm -rf -- "$dep_tmp"
  mkdir -p "$dep_tmp/apps/leitbild" "$dep_tmp/apps/world" "$dep_tmp/apps/agents" "$dep_tmp/packages"
  cp "$incoming/package.json" "$incoming/bun.lock" "$dep_tmp/"
  cp "$incoming/apps/leitbild/package.json" "$dep_tmp/apps/leitbild/"
  cp "$incoming/apps/world/package.json" "$dep_tmp/apps/world/"
  cp "$incoming/apps/agents/package.json" "$dep_tmp/apps/agents/"
  ${PRODUCTION_DEPENDENCY_WORKSPACES.map(workspace => `cp -a "$incoming/${workspace.target}" "$dep_tmp/packages/"`).join('\n  ')}
  ${INSTALL_MANIFEST_ONLY_WORKSPACE_PATHS.map(path => `mkdir -p "$dep_tmp/${path}"; cp "$incoming/${path}/package.json" "$dep_tmp/${path}/"`).join('\n  ')}
  chown -R ${SERVICE_USER}:${SERVICE_USER} "$dep_tmp"
  sudo -u ${SERVICE_USER} sh -c 'cd "$1" && exec "$2" install --frozen-lockfile --production' sh "$dep_tmp" ${shellQuote(BUN_BIN)}
  mv "$dep_tmp" "$dep_dir"
fi
ln -s "$dep_dir/node_modules" "$incoming/node_modules"
ln -s "$dep_dir/apps/leitbild/node_modules" "$incoming/apps/leitbild/node_modules"
ln -s "$dep_dir/apps/world/node_modules" "$incoming/apps/world/node_modules"
ln -s "$dep_dir/apps/agents/node_modules" "$incoming/apps/agents/node_modules"
mv "$incoming" "$release_dir"
next_link="${DEPLOY_ROOT}/.next-$release_id"
ln -s "$release_dir" "$next_link"
mv -Tf "$next_link" ${shellQuote(CURRENT_LINK)}
if test ${install ? '1' : '0'} -eq 1; then
  for service in ${SERVICES.join(' ')}; do cp "$release_dir/apps/leitbild/deploy/$service" "/etc/systemd/system/$service"; done
  systemctl daemon-reload
  systemctl enable ${SERVICES.join(' ')}
fi
systemctl reset-failed ${SERVICES.join(' ')} || true
if ! systemctl restart ${SERVICES.join(' ')}; then
  if test -n "$previous"; then ln -sfn "$previous" ${shellQuote(CURRENT_LINK)}; systemctl restart ${SERVICES.join(' ')}; fi
  exit 1
fi
for port in 3000 4177 3100; do for attempt in $(seq 1 60); do curl -fsS -o /dev/null "http://127.0.0.1:$port/health" && break; sleep 1; done; curl -fsS -o /dev/null "http://127.0.0.1:$port/health"; done
# Verify the effective process routing, not just standalone service health.
for module in world agents; do
  module_pid="$(systemctl show "leitbild-$module" --property=MainPID --value)"
  if ! tr '\\0' '\\n' < "/proc/$module_pid/environ" | grep -Fx 'WORKSPACE_HOST_URL=http://127.0.0.1:3100' > /dev/null; then
    echo "leitbild-$module is not routed to the internal Workspace Host" >&2
    exit 1
  fi
done
curl -fsS -o /dev/null http://127.0.0.1:3100/api/workspaces
caddy_backup="/etc/caddy/Caddyfile.pre-leitbild-$release_id"
cp /etc/caddy/Caddyfile "$caddy_backup"
caddy validate --config "$release_dir/apps/leitbild/deploy/Caddyfile"
install -o root -g root -m 0644 "$release_dir/apps/leitbild/deploy/Caddyfile" /etc/caddy/Caddyfile
if ! systemctl reload caddy.service; then
  cp "$caddy_backup" /etc/caddy/Caddyfile
  systemctl reload caddy.service || true
  exit 1
fi
public_ready=0
for attempt in $(seq 1 60); do
  if curl -fsS -o /dev/null ${shellQuote(PUBLIC_HEALTH_URL)}; then public_ready=1; break; fi
  sleep 1
done
if test "$public_ready" -ne 1; then
  cp "$caddy_backup" /etc/caddy/Caddyfile
  systemctl reload caddy.service || true
  exit 1
fi
find ${shellQuote(RELEASES_DIR)} -mindepth 1 -maxdepth 1 -type d ! -path "$release_dir" -exec rm -rf -- {} +
find ${shellQuote(DEPS_DIR)} -mindepth 1 -maxdepth 1 -type d ! -path "$dep_dir" -exec rm -rf -- {} +
printf 'activated_release=%s previous=%s\n' "$release_id" "\${previous:-none}"
`
}

const confirmMutation = (id: string, yes: boolean): void => {
  if (yes) return
  if (!process.stdin.isTTY) throw new Error('Refusing production mutation without --yes')
  if (prompt(`Deploy Leitbild ${id} to production? Type "deploy" to continue:`) !== 'deploy') throw new Error('Deployment cancelled')
}

const main = async (): Promise<void> => {
  const options = parseDeployArgs(process.argv.slice(2))
  if (Bun.version !== REQUIRED_BUN_VERSION) throw new Error(`Bun ${REQUIRED_BUN_VERSION} required; found ${Bun.version}`)
  await run('Platform checks', ['bun', 'run', 'check'])
  await run('Platform tests', ['bun', 'run', 'test'])
  await run('Build Leitbild host UI', ['bun', 'run', 'build:ui'], HOST_ROOT)
  await run('Build World UI', ['bun', 'run', 'build:ui'], WORLD_ROOT)
  await run('Build Agents UI', ['bun', 'run', 'build:ui'], AGENTS_ROOT)
  const artifact = await createArtifact()
  try {
    console.log(`\nRelease: ${artifact.manifest.releaseId}`)
    console.log(`Dirty worktree: ${artifact.manifest.dirty ? 'yes' : 'no'}`)
    console.log(`Files: ${artifact.manifest.fileCount}`)
    if (options.dryRun) return console.log('\n✓ Dry run complete; production was not changed')
    confirmMutation(artifact.manifest.releaseId, options.yes)
    await run('Production preflight', ['ssh', SSH_HOST, remotePreflight(options.install)])
    const remoteArchive = `/tmp/leitbild-${artifact.manifest.releaseId}.tgz`
    await run('Upload immutable Leitbild artifact', ['scp', artifact.archivePath, `${SSH_HOST}:${remoteArchive}`])
    await run('Activate Leitbild release', ['ssh', SSH_HOST, remoteDeploy(artifact, remoteArchive, options.install)])
    for (const url of [PUBLIC_HEALTH_URL]) {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`${url} returned ${response.status}`)
      console.log(`✓ ${url} ${response.status}`)
    }
  } finally {
    await artifact.cleanup()
  }
}

if (import.meta.main) await main()
