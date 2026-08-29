#!/usr/bin/env bun

import { chmod, copyFile, lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const APP_ID = 'suite'
const SSH_HOST = process.env.SAMSINN_SSH_HOST ?? 'samsinn'
const WORKSPACE_ROOT = resolve(import.meta.dir, '../../..')
const APP_ROOT = resolve(import.meta.dir, '..')
const CONTRACTS_ROOT = resolve(WORKSPACE_ROOT, 'packages/platform-contracts')
const DEPLOY_ROOT = '/opt/samsinn-suite'
const CURRENT_LINK = `${DEPLOY_ROOT}/current`
const RELEASES_DIR = `${DEPLOY_ROOT}/releases`
const DEPS_DIR = `${DEPLOY_ROOT}/deps`
const STATE_ROOT = '/var/lib/samsinn-suite'
const SERVICE = 'samsinn-suite.service'
const SERVICE_USER = 'samsinn-suite'
const BUN_BIN = '/opt/leitbild/runtime/bun'
const LOCAL_HEALTH_URL = 'http://127.0.0.1:3100/health'
const PUBLIC_HEALTH_URL = 'https://samsinn.app/suite/health'
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
  --install  First production installation of the service and /suite/ route
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

const entriesFor = async (root: string, targetRoot: string): Promise<ArtifactEntry[]> => {
  const entries: ArtifactEntry[] = []
  for (const path of await trackedFiles(root)) {
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
    if (stat.isSymbolicLink()) {
      hasher.update('symlink\0')
      hasher.update(await readlink(entry.source))
    } else {
      hasher.update('file\0')
      hasher.update(await Bun.file(entry.source).arrayBuffer())
    }
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

const releaseId = (createdAt: string, commit: string, digest: string): string =>
  `${createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${commit.slice(0, 10)}-${digest.slice(0, 10)}`

const createArtifact = async (): Promise<{
  readonly archivePath: string
  readonly archiveChecksum: string
  readonly lockChecksum: string
  readonly manifest: DeploymentManifest
  readonly cleanup: () => Promise<void>
}> => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'suite-release-'))
  const stageRoot = join(tempRoot, 'stage')
  const archivePath = join(tempRoot, 'release.tgz')
  await mkdir(stageRoot)

  const appEntries = await entriesFor(APP_ROOT, 'apps/suite')
  const contractEntries = await entriesFor(CONTRACTS_ROOT, 'packages/platform-contracts')
  const rootEntries: ArtifactEntry[] = ['package.json', 'bun.lock'].map(path => ({
    source: join(WORKSPACE_ROOT, path),
    target: path,
  }))
  const entries = [...rootEntries, ...appEntries, ...contractEntries]
  const sourceDigest = await digestEntries(entries)
  const contractsDigest = await digestEntries(contractEntries)
  const createdAt = new Date().toISOString()
  const baseCommit = (await capture(['git', 'rev-parse', 'HEAD'])).trim()
  const branch = (await capture(['git', 'branch', '--show-current'])).trim() || '(detached)'
  const worktreeStatus = (await capture(['git', 'status', '--porcelain=v1', '--untracked-files=all']))
    .split('\n').filter(Boolean)
  const manifest: DeploymentManifest = {
    schemaVersion: 1,
    app: APP_ID,
    releaseId: releaseId(createdAt, baseCommit, sourceDigest),
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
  const tarCommand = process.platform === 'darwin'
    ? ['tar', '--no-mac-metadata', '--no-xattrs', '-czf', archivePath, '-C', stageRoot, '.']
    : ['tar', '-czf', archivePath, '-C', stageRoot, '.']
  await run('Create immutable suite artifact', tarCommand)
  return {
    archivePath,
    archiveChecksum: await sha256File(archivePath),
    lockChecksum: await sha256File(join(WORKSPACE_ROOT, 'bun.lock')),
    manifest,
    cleanup: () => rm(tempRoot, { recursive: true, force: true }),
  }
}

export const remotePreflightScript = (install: boolean): string => `set -euo pipefail
test "$(${BUN_BIN} --version)" = ${shellQuote(REQUIRED_BUN_VERSION)}
test "$(systemctl is-active caddy.service)" = active
test "$(systemctl is-active samsinn.service)" = active
test "$(systemctl is-active leitbild.service)" = active
curl -fsS -o /dev/null http://127.0.0.1:3000/health
curl -fsS -o /dev/null http://127.0.0.1:4177/health
available_kb="$(df --output=avail /opt | tail -n 1 | tr -d ' ')"
test "$available_kb" -gt 2097152
diag="$(curl -fsS http://127.0.0.1:3000/api/system/diagnostics)"
generating="$(printf '%s' "$diag" | jq '[.. | objects | .generatingAgentCount? // empty] | add // 0')"
test "$generating" -eq 0 || { echo "Refusing deploy: $generating agent generation(s) active" >&2; exit 1; }
if test ${install ? '1' : '0'} -eq 0; then
  test "$(systemctl is-active ${SERVICE})" = active
  test "$(systemctl show ${SERVICE} -p WorkingDirectory --value)" = ${shellQuote(`${CURRENT_LINK}/apps/suite`)}
  grep -q 'handle_path /suite/\\*' /etc/caddy/Caddyfile
  curl -fsS -o /dev/null ${LOCAL_HEALTH_URL}
fi
printf 'preflight_ok available_kb=%s generating=%s\n' "$available_kb" "$generating"
`

export const remoteDeployScript = (artifact: {
  readonly archiveChecksum: string
  readonly lockChecksum: string
  readonly manifest: DeploymentManifest
}, remoteArchive: string, install: boolean): string => {
  const id = artifact.manifest.releaseId
  return `set -euo pipefail
exec 9>/run/lock/samsinn-stack-deploy.lock
flock -n 9 || { echo "Another stack deployment is active" >&2; exit 1; }
${remotePreflightScript(install)}
release_id=${shellQuote(id)}
release_dir=${shellQuote(`${RELEASES_DIR}/${id}`)}
archive=${shellQuote(remoteArchive)}
archive_sha=${shellQuote(artifact.archiveChecksum)}
lock_sha=${shellQuote(artifact.lockChecksum)}
contracts_sha=${shellQuote(artifact.manifest.contractsDigest)}
incoming=${shellQuote(`${RELEASES_DIR}/.incoming-${id}`)}
dep_dir="${DEPS_DIR}/$lock_sha-$contracts_sha"
previous=""
if test -L ${shellQuote(CURRENT_LINK)}; then previous="$(readlink -f ${shellQuote(CURRENT_LINK)})"; fi
caddy_backup="/etc/caddy/Caddyfile.pre-suite-$release_id"
caddy_changed=0

cleanup() {
  rm -rf -- "$incoming"
  rm -f -- "$archive"
}
wait_for_health() {
  for attempt in $(seq 1 30); do
    if systemctl is-active --quiet ${SERVICE} && curl -fsS -o /dev/null ${LOCAL_HEALTH_URL}; then return 0; fi
    sleep 1
  done
  return 1
}
rollback() {
  echo "Suite activation failed; restoring previous state" >&2
  if test "$caddy_changed" -eq 1 && test -f "$caddy_backup"; then
    cp "$caddy_backup" /etc/caddy/Caddyfile
    caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy.service || true
  fi
  if test -n "$previous" && test -d "$previous"; then
    rollback_link="${DEPLOY_ROOT}/.rollback-$release_id"
    ln -s "$previous" "$rollback_link"
    mv -Tf "$rollback_link" ${shellQuote(CURRENT_LINK)}
    systemctl reset-failed ${SERVICE} || true
    systemctl restart ${SERVICE} && wait_for_health || return 1
  else
    systemctl disable --now ${SERVICE} || true
  fi
}
trap cleanup EXIT

if test ${install ? '1' : '0'} -eq 1; then
  test ! -e ${shellQuote(CURRENT_LINK)}
  test ! -e /etc/systemd/system/${SERVICE}
  test "$(grep -c '^[[:space:]]*reverse_proxy 127.0.0.1:3000[[:space:]]*$' /etc/caddy/Caddyfile)" -eq 1
  ! grep -q 'handle_path /suite/\\*' /etc/caddy/Caddyfile
  id -u ${SERVICE_USER} >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin ${SERVICE_USER}
  install -d -o ${SERVICE_USER} -g ${SERVICE_USER} -m 0700 ${shellQuote(STATE_ROOT)}
fi

mkdir -p ${shellQuote(RELEASES_DIR)} ${shellQuote(DEPS_DIR)}
test ! -e "$release_dir"
printf '%s  %s\n' "$archive_sha" "$archive" | sha256sum --check --status
mkdir "$incoming"
tar -xzf "$archive" --no-same-owner -C "$incoming"
test "$(jq -r '.app' "$incoming/DEPLOYMENT.json")" = ${shellQuote(APP_ID)}
test "$(jq -r '.releaseId' "$incoming/DEPLOYMENT.json")" = "$release_id"
test "$(sha256sum "$incoming/bun.lock" | cut -d ' ' -f 1)" = "$lock_sha"
test ! -e "$incoming/apps/suite/node_modules"

if test ! -d "$dep_dir/apps/suite/node_modules"; then
  dep_tmp="${DEPS_DIR}/.incoming-$lock_sha-$contracts_sha-$$"
  rm -rf -- "$dep_tmp"
  mkdir -p "$dep_tmp/apps/suite" "$dep_tmp/packages"
  cp "$incoming/package.json" "$incoming/bun.lock" "$dep_tmp/"
  cp "$incoming/apps/suite/package.json" "$dep_tmp/apps/suite/"
  cp -a "$incoming/packages/platform-contracts" "$dep_tmp/packages/"
  chown -R ${SERVICE_USER}:${SERVICE_USER} "$dep_tmp"
  if ! sudo -u ${SERVICE_USER} sh -c 'cd "$1" && exec "$2" install --frozen-lockfile --production' sh "$dep_tmp" ${shellQuote(BUN_BIN)}; then
    rm -rf -- "$dep_tmp"
    exit 1
  fi
  mv "$dep_tmp" "$dep_dir"
fi
ln -s "$dep_dir/apps/suite/node_modules" "$incoming/apps/suite/node_modules"
mv "$incoming" "$release_dir"
trap 'rm -f -- "$archive"' EXIT

next_link="${DEPLOY_ROOT}/.next-$release_id"
ln -s "$release_dir" "$next_link"
mv -Tf "$next_link" ${shellQuote(CURRENT_LINK)}

if test ${install ? '1' : '0'} -eq 1; then
  cp "$release_dir/apps/suite/deploy/samsinn-suite.service" /etc/systemd/system/${SERVICE}
  systemctl daemon-reload
  systemctl enable ${SERVICE}
fi
systemctl reset-failed ${SERVICE} || true
if ! systemctl restart ${SERVICE} || ! wait_for_health; then rollback || exit 2; exit 1; fi

if test ${install ? '1' : '0'} -eq 1; then
  cp /etc/caddy/Caddyfile "$caddy_backup"
  caddy_candidate="/etc/caddy/Caddyfile.suite-$release_id"
  awk -v snippet="$release_dir/apps/suite/deploy/caddy-route.caddy" '
    /^[[:space:]]*reverse_proxy 127[.]0[.]0[.]1:3000[[:space:]]*$/ {
      while ((getline line < snippet) > 0) print line
      close(snippet)
      next
    }
    { print }
  ' /etc/caddy/Caddyfile > "$caddy_candidate"
  caddy validate --config "$caddy_candidate"
  install -o root -g root -m 0644 "$caddy_candidate" /etc/caddy/Caddyfile
  rm -f -- "$caddy_candidate"
  systemctl reload caddy.service
  caddy_changed=1
fi

curl -fsS -o /dev/null ${shellQuote(PUBLIC_HEALTH_URL)} || { rollback || exit 2; exit 1; }
curl -fsS -o /dev/null https://samsinn.app/health || { rollback || exit 2; exit 1; }
curl -fsS -o /dev/null https://leitbild.samsinn.app/health || { rollback || exit 2; exit 1; }
printf 'activated_release=%s previous=%s\n' "$release_id" "\${previous:-none}"
`
}

const confirmMutation = (id: string, yes: boolean): void => {
  if (yes) return
  if (!process.stdin.isTTY) throw new Error('Refusing production mutation without --yes')
  if (prompt(`Deploy suite ${id} to production? Type "deploy" to continue:`) !== 'deploy') {
    throw new Error('Deployment cancelled')
  }
}

const main = async (): Promise<void> => {
  const options = parseDeployArgs(process.argv.slice(2))
  if (Bun.version !== REQUIRED_BUN_VERSION) throw new Error(`Bun ${REQUIRED_BUN_VERSION} required; found ${Bun.version}`)
  await run('Platform boundary and type checks', ['bun', 'run', 'check'])
  await run('Suite tests', ['bun', 'run', 'test:suite'])
  const artifact = await createArtifact()
  try {
    console.log(`\nRelease: ${artifact.manifest.releaseId}`)
    console.log(`Base commit: ${artifact.manifest.baseCommit}`)
    console.log(`Dirty worktree: ${artifact.manifest.dirty ? 'yes' : 'no'}`)
    console.log(`Files: ${artifact.manifest.fileCount}`)
    console.log(`Source digest: ${artifact.manifest.sourceDigest}`)
    console.log(`Persistent suite directory: excluded`)
    if (options.dryRun) {
      console.log('\n✓ Dry run complete; production was not contacted or changed')
      return
    }
    confirmMutation(artifact.manifest.releaseId, options.yes)
    await run('Production preflight', ['ssh', SSH_HOST, remotePreflightScript(options.install)])
    const remoteArchive = `/tmp/samsinn-suite-${artifact.manifest.releaseId}.tgz`
    await run('Upload immutable suite artifact', ['scp', artifact.archivePath, `${SSH_HOST}:${remoteArchive}`])
    await run('Install and activate suite release', [
      'ssh', SSH_HOST, remoteDeployScript(artifact, remoteArchive, options.install),
    ])
    for (const url of [PUBLIC_HEALTH_URL, 'https://samsinn.app/health', 'https://leitbild.samsinn.app/health']) {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`${url} returned ${response.status}`)
      console.log(`✓ ${url} ${response.status}`)
    }
    console.log(`\n✓ Suite ${artifact.manifest.releaseId} is active at https://samsinn.app/suite/`)
  } finally {
    await artifact.cleanup()
  }
}

if (import.meta.main) await main()
