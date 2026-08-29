#!/usr/bin/env bun

import { chmod, copyFile, lstat, mkdir, mkdtemp, readlink, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

const APP_ID = 'workspace-host'
const SSH_HOST = process.env.SAMSINN_SSH_HOST ?? 'samsinn'
const WORKSPACE_ROOT = resolve(import.meta.dir, '../../..')
const APP_ROOT = resolve(import.meta.dir, '..')
const CONTRACTS_ROOT = resolve(WORKSPACE_ROOT, 'packages/platform-contracts')
const DEPLOY_ROOT = '/opt/workspace-platform'
const CURRENT_LINK = `${DEPLOY_ROOT}/current`
const RELEASES_DIR = `${DEPLOY_ROOT}/releases`
const DEPS_DIR = `${DEPLOY_ROOT}/deps`
const STATE_ROOT = '/var/lib/workspace-host'
const SERVICE = 'workspace-host.service'
const SERVICE_USER = 'workspace-host'
const BUN_BIN = `${DEPLOY_ROOT}/runtime/bun`
const LOCAL_HEALTH_URL = 'http://127.0.0.1:3100/health'
const PUBLIC_HEALTH_URL = 'https://samsinn.app/health'
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
  readonly contractsDigest: string
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

const entriesFor = async (root: string, targetRoot: string, extra: ReadonlyArray<string> = []): Promise<ArtifactEntry[]> => {
  const entries: ArtifactEntry[] = []
  for (const path of [...new Set([...await trackedFiles(root), ...extra])].sort()) {
    if (path.startsWith('/') || path.split('/').includes('..')) throw new Error(`Unsafe source path: ${path}`)
    const source = join(root, path)
    const stat = await lstat(source)
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
  const tempRoot = await mkdtemp(join(tmpdir(), 'workspace-host-release-'))
  const stageRoot = join(tempRoot, 'stage')
  const archivePath = join(tempRoot, 'release.tgz')
  await mkdir(stageRoot)
  const appEntries = await entriesFor(APP_ROOT, 'apps/workspace-host', await directoryFiles(APP_ROOT, 'src/ui/dist'))
  const contractEntries = await entriesFor(CONTRACTS_ROOT, 'packages/platform-contracts')
  const rootEntries: ArtifactEntry[] = ['package.json', 'bun.lock'].map(path => ({ source: join(WORKSPACE_ROOT, path), target: path }))
  const entries = [...rootEntries, ...appEntries, ...contractEntries]
  const sourceDigest = await digestEntries(entries)
  const contractsDigest = await digestEntries(contractEntries)
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
    contractsDigest,
    fileCount: entries.length,
    persistentRootsExcluded: [STATE_ROOT],
  }
  await copyEntries(entries, stageRoot)
  await writeFile(join(stageRoot, 'DEPLOYMENT.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
  await run('Create immutable Workspace Host artifact', ['tar', '--no-mac-metadata', '--no-xattrs', '-czf', archivePath, '-C', stageRoot, '.'])
  return {
    archivePath,
    archiveChecksum: await sha256File(archivePath),
    lockChecksum: await sha256File(join(WORKSPACE_ROOT, 'bun.lock')),
    manifest,
    cleanup: () => rm(tempRoot, { recursive: true, force: true }),
  }
}

const remotePreflight = (install: boolean): string => `set -euo pipefail
test "$(/opt/leitbild/runtime/bun --version)" = ${shellQuote(REQUIRED_BUN_VERSION)}
test "$(systemctl is-active caddy.service)" = active
test "$(systemctl is-active samsinn.service)" = active
test "$(systemctl is-active leitbild.service)" = active
curl -fsS -o /dev/null http://127.0.0.1:3000/health
curl -fsS -o /dev/null http://127.0.0.1:4177/health
test "$(df --output=avail /opt | tail -n 1 | tr -d ' ')" -gt 2097152
if test ${install ? '0' : '1'} -eq 1; then
  test "$(systemctl is-active ${SERVICE})" = active
  curl -fsS -o /dev/null ${LOCAL_HEALTH_URL}
fi
`

const remoteDeploy = (artifact: Awaited<ReturnType<typeof createArtifact>>, remoteArchive: string, install: boolean): string => {
  const id = artifact.manifest.releaseId
  return `set -euo pipefail
exec 9>/run/lock/samsinn-stack-deploy.lock
flock -n 9 || { echo "Another stack deployment is active" >&2; exit 1; }
${remotePreflight(install)}
release_id=${shellQuote(id)}
release_dir=${shellQuote(`${RELEASES_DIR}/${id}`)}
archive=${shellQuote(remoteArchive)}
incoming=${shellQuote(`${RELEASES_DIR}/.incoming-${id}`)}
dep_dir=${shellQuote(`${DEPS_DIR}/${artifact.lockChecksum}-${artifact.manifest.contractsDigest}`)}
previous=""
test ! -e "$release_dir"
if test -L ${shellQuote(CURRENT_LINK)}; then previous="$(readlink -f ${shellQuote(CURRENT_LINK)})"; fi
cleanup() { rm -rf -- "$incoming"; rm -f -- "$archive"; }
trap cleanup EXIT
if test ${install ? '1' : '0'} -eq 1; then
  test ! -e /etc/systemd/system/${SERVICE}
  id -u ${SERVICE_USER} >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin ${SERVICE_USER}
  install -d -o ${SERVICE_USER} -g ${SERVICE_USER} -m 0700 ${shellQuote(STATE_ROOT)}
  install -d -o root -g root -m 0755 ${shellQuote(DEPLOY_ROOT)}
  install -d -o root -g root -m 0755 /etc/workspace-host
  ln -sfn /opt/leitbild/runtime ${shellQuote(`${DEPLOY_ROOT}/runtime`)}
  cat > /etc/workspace-host/env <<'EOF'
WORKSPACE_HOST_URL=https://samsinn.app
WORKSPACE_MODULES=[{"moduleId":"microworld","baseUrl":"https://leitbild.samsinn.app","manifestPath":"/.well-known/workspace-module"},{"moduleId":"collaboration","baseUrl":"https://samsinn.app","manifestPath":"/.well-known/workspace-module/collaboration"},{"moduleId":"agents","baseUrl":"https://samsinn.app","manifestPath":"/.well-known/workspace-module/agents"}]
WORKSPACE_EXPERIENCES=[{"id":"leitbild","title":"Leitbild","requiredModules":["microworld"],"entryModuleId":"microworld"},{"id":"samsinn","title":"Samsinn","requiredModules":["collaboration","agents"],"entryModuleId":"collaboration"}]
INITIAL_EXPERIENCE_IDS=["leitbild","samsinn"]
EOF
  chmod 0600 /etc/workspace-host/env
fi
mkdir -p ${shellQuote(RELEASES_DIR)} ${shellQuote(DEPS_DIR)}
printf '%s  %s\n' ${shellQuote(artifact.archiveChecksum)} "$archive" | sha256sum --check --status
mkdir "$incoming"
tar -xzf "$archive" --no-same-owner -C "$incoming"
test "$(jq -r .app "$incoming/DEPLOYMENT.json")" = ${shellQuote(APP_ID)}
test "$(jq -r .releaseId "$incoming/DEPLOYMENT.json")" = "$release_id"
if test ! -d "$dep_dir/apps/workspace-host/node_modules"; then
  dep_tmp="${DEPS_DIR}/.incoming-${artifact.lockChecksum}-$$"
  rm -rf -- "$dep_tmp"
  mkdir -p "$dep_tmp/apps/workspace-host" "$dep_tmp/packages"
  cp "$incoming/package.json" "$incoming/bun.lock" "$dep_tmp/"
  cp "$incoming/apps/workspace-host/package.json" "$dep_tmp/apps/workspace-host/"
  cp -a "$incoming/packages/platform-contracts" "$dep_tmp/packages/"
  chown -R ${SERVICE_USER}:${SERVICE_USER} "$dep_tmp"
  sudo -u ${SERVICE_USER} sh -c 'cd "$1" && exec "$2" install --frozen-lockfile --production' sh "$dep_tmp" ${shellQuote(BUN_BIN)}
  mv "$dep_tmp" "$dep_dir"
fi
ln -s "$dep_dir/apps/workspace-host/node_modules" "$incoming/apps/workspace-host/node_modules"
mv "$incoming" "$release_dir"
next_link="${DEPLOY_ROOT}/.next-$release_id"
ln -s "$release_dir" "$next_link"
mv -Tf "$next_link" ${shellQuote(CURRENT_LINK)}
if test ${install ? '1' : '0'} -eq 1; then
  cp "$release_dir/apps/workspace-host/deploy/workspace-host.service" /etc/systemd/system/${SERVICE}
  systemctl daemon-reload
  systemctl enable ${SERVICE}
fi
systemctl reset-failed ${SERVICE} || true
if ! systemctl restart ${SERVICE}; then
  if test -n "$previous"; then ln -sfn "$previous" ${shellQuote(CURRENT_LINK)}; systemctl restart ${SERVICE}; fi
  exit 1
fi
for attempt in $(seq 1 30); do curl -fsS -o /dev/null ${LOCAL_HEALTH_URL} && break; sleep 1; done
curl -fsS -o /dev/null ${LOCAL_HEALTH_URL}
caddy_backup="/etc/caddy/Caddyfile.pre-workspace-host-$release_id"
cp /etc/caddy/Caddyfile "$caddy_backup"
caddy validate --config "$release_dir/apps/workspace-host/deploy/Caddyfile"
install -o root -g root -m 0644 "$release_dir/apps/workspace-host/deploy/Caddyfile" /etc/caddy/Caddyfile
if ! systemctl reload caddy.service || ! curl -fsS -o /dev/null ${shellQuote(PUBLIC_HEALTH_URL)}; then
  cp "$caddy_backup" /etc/caddy/Caddyfile
  systemctl reload caddy.service || true
  exit 1
fi
printf 'activated_release=%s previous=%s\n' "$release_id" "\${previous:-none}"
`
}

const confirmMutation = (id: string, yes: boolean): void => {
  if (yes) return
  if (!process.stdin.isTTY) throw new Error('Refusing production mutation without --yes')
  if (prompt(`Deploy Workspace Host ${id} to production? Type "deploy" to continue:`) !== 'deploy') throw new Error('Deployment cancelled')
}

const main = async (): Promise<void> => {
  const options = parseDeployArgs(process.argv.slice(2))
  if (Bun.version !== REQUIRED_BUN_VERSION) throw new Error(`Bun ${REQUIRED_BUN_VERSION} required; found ${Bun.version}`)
  await run('Platform checks', ['bun', 'run', 'check'])
  await run('Workspace Host tests', ['bun', 'run', 'test:host'])
  const artifact = await createArtifact()
  try {
    console.log(`\nRelease: ${artifact.manifest.releaseId}`)
    console.log(`Dirty worktree: ${artifact.manifest.dirty ? 'yes' : 'no'}`)
    console.log(`Files: ${artifact.manifest.fileCount}`)
    if (options.dryRun) return console.log('\n✓ Dry run complete; production was not changed')
    confirmMutation(artifact.manifest.releaseId, options.yes)
    await run('Production preflight', ['ssh', SSH_HOST, remotePreflight(options.install)])
    const remoteArchive = `/tmp/workspace-host-${artifact.manifest.releaseId}.tgz`
    await run('Upload immutable Workspace Host artifact', ['scp', artifact.archivePath, `${SSH_HOST}:${remoteArchive}`])
    await run('Activate Workspace Host release', ['ssh', SSH_HOST, remoteDeploy(artifact, remoteArchive, options.install)])
    for (const url of [PUBLIC_HEALTH_URL, 'https://leitbild.samsinn.app/health']) {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`${url} returned ${response.status}`)
      console.log(`✓ ${url} ${response.status}`)
    }
  } finally {
    await artifact.cleanup()
  }
}

if (import.meta.main) await main()
