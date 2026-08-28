#!/usr/bin/env bun

import { chmod, copyFile, lstat, mkdir, mkdtemp, readlink, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

const APP_ID = 'samsinn'
const SSH_HOST = process.env.SAMSINN_SSH_HOST ?? 'samsinn'
const DEPLOY_ROOT = '/opt/samsinn-deploy'
const CURRENT_LINK = `${DEPLOY_ROOT}/current`
const RELEASES_DIR = `${DEPLOY_ROOT}/releases`
const DEPS_DIR = `${DEPLOY_ROOT}/deps`
const SERVICE = 'samsinn.service'
const SERVICE_USER = 'samsinn'
const BUN_BIN = '/home/samsinn/.bun/bin/bun'
const LOCAL_HEALTH_URL = 'http://127.0.0.1:3000/health'
const PUBLIC_URLS = ['https://samsinn.app/health', 'https://leitbild.samsinn.app/health'] as const

export interface DeployOptions {
  readonly dryRun: boolean
  readonly yes: boolean
  readonly updateService: boolean
  readonly list: boolean
  readonly rollback: string | null
}

export interface DeploymentManifest {
  readonly schemaVersion: 1
  readonly app: string
  readonly releaseId: string
  readonly createdAt: string
  readonly baseCommit: string
  readonly branch: string
  readonly dirty: boolean
  readonly worktreeStatus: ReadonlyArray<string>
  readonly sourceDigest: string
  readonly fileCount: number
  readonly validation: 'full'
  readonly validationCommands: ReadonlyArray<string>
}

const usage = (): string => `Usage:
  bun run deploy -- [--dry-run] [--yes] [--update-service]
  bun run deploy -- --list
  bun run deploy -- --rollback <release-id> [--yes]

Options:
  --dry-run         Validate and package locally without contacting production
  --yes             Skip the interactive confirmation (automation only)
  --update-service  Install the release-layout systemd unit with rollback backup
  --list            List deployed releases and the active target (read-only)
  --rollback ID     Atomically reactivate an earlier release
`

export const isSafeReleaseId = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)

export const parseDeployArgs = (args: ReadonlyArray<string>): DeployOptions => {
  let dryRun = false
  let yes = false
  let updateService = false
  let list = false
  let rollback: string | null = null

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--yes') yes = true
    else if (arg === '--update-service') updateService = true
    else if (arg === '--list') list = true
    else if (arg === '--rollback') {
      rollback = args[i + 1] ?? null
      if (!rollback) throw new Error('--rollback requires a release id')
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`)
    }
  }

  const modes = Number(list) + Number(rollback !== null)
  if (modes > 1) throw new Error('--list and --rollback are mutually exclusive')
  if (dryRun && modes > 0) throw new Error('--dry-run is only valid for a new deployment')
  if (updateService && modes > 0) throw new Error('--update-service is only valid for a new deployment')
  if (rollback && !isSafeReleaseId(rollback)) throw new Error(`Invalid release id: ${rollback}`)
  return { dryRun, yes, updateService, list, rollback }
}

const run = async (label: string, command: ReadonlyArray<string>, cwd = process.cwd()): Promise<void> => {
  console.log(`\n→ ${label}`)
  const child = Bun.spawn([...command], { cwd, stdout: 'inherit', stderr: 'inherit' })
  const code = await child.exited
  if (code !== 0) throw new Error(`${label} failed with exit code ${code}`)
}

const capture = async (command: ReadonlyArray<string>, cwd = process.cwd()): Promise<string> => {
  const child = Bun.spawn([...command], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command.join(' ')} failed (${code}): ${stderr.trim()}`)
  return stdout
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`

const sha256File = async (path: string): Promise<string> => {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(await Bun.file(path).arrayBuffer())
  return hasher.digest('hex')
}

const collectArtifactPaths = async (repoRoot: string): Promise<string[]> => {
  const raw = await capture(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], repoRoot)
  const candidates = raw.split('\0').filter(Boolean)
  const paths: string[] = []
  for (const path of candidates) {
    if (path.startsWith('/') || path.split('/').includes('..')) throw new Error(`Unsafe repository path: ${path}`)
    try {
      const stat = await lstat(join(repoRoot, path))
      if (stat.isFile() || stat.isSymbolicLink()) paths.push(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  // Production CSS is intentionally ignored in Git but is part of the
  // verified runtime artifact. It must never be rebuilt during activation.
  const cssPath = 'src/ui/dist.css'
  const cssStat = await lstat(join(repoRoot, cssPath))
  if (!cssStat.isFile()) throw new Error(`${cssPath} was not produced by build:css`)
  paths.push(cssPath)
  return [...new Set(paths)].sort()
}

const sourceDigest = async (repoRoot: string, paths: ReadonlyArray<string>): Promise<string> => {
  const hasher = new Bun.CryptoHasher('sha256')
  for (const path of paths) {
    const absolute = join(repoRoot, path)
    const stat = await lstat(absolute)
    hasher.update(path)
    hasher.update('\0')
    if (stat.isSymbolicLink()) {
      hasher.update('symlink\0')
      hasher.update(await readlink(absolute))
    } else {
      hasher.update('file\0')
      hasher.update(await Bun.file(absolute).arrayBuffer())
    }
    hasher.update('\0')
  }
  return hasher.digest('hex')
}

export const makeReleaseId = (createdAt: string, shortCommit: string, digest: string): string => {
  const timestamp = createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const releaseId = `${timestamp}-${shortCommit}-${digest.slice(0, 10)}`
  if (!isSafeReleaseId(releaseId)) throw new Error(`Generated unsafe release id: ${releaseId}`)
  return releaseId
}

const copyArtifactFiles = async (repoRoot: string, stageRoot: string, paths: ReadonlyArray<string>): Promise<void> => {
  for (const path of paths) {
    const source = join(repoRoot, path)
    const target = join(stageRoot, path)
    const stat = await lstat(source)
    await mkdir(dirname(target), { recursive: true })
    if (stat.isSymbolicLink()) await symlink(await readlink(source), target)
    else {
      await copyFile(source, target)
      await chmod(target, stat.mode & 0o777)
    }
  }
  // bootstrap.ts checks mtimes even in production. Ensure the verified CSS
  // artifact is newer than every copied source so startup never downloads or
  // builds packages on the production host.
  const now = new Date()
  await utimes(join(stageRoot, 'src/ui/dist.css'), now, now)
}

const createArtifact = async (repoRoot: string): Promise<{
  readonly archivePath: string
  readonly archiveChecksum: string
  readonly lockChecksum: string
  readonly manifest: DeploymentManifest
  readonly cleanup: () => Promise<void>
}> => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'samsinn-release-'))
  const stageRoot = join(tempRoot, 'stage')
  const archivePath = join(tempRoot, 'release.tgz')
  await mkdir(stageRoot)

  const paths = await collectArtifactPaths(repoRoot)
  const digest = await sourceDigest(repoRoot, paths)
  const createdAt = new Date().toISOString()
  const baseCommit = (await capture(['git', 'rev-parse', 'HEAD'], repoRoot)).trim()
  const branch = (await capture(['git', 'branch', '--show-current'], repoRoot)).trim() || '(detached)'
  const worktreeStatus = (await capture(['git', 'status', '--porcelain=v1', '--untracked-files=all'], repoRoot))
    .split('\n').filter(Boolean)
  const manifest: DeploymentManifest = {
    schemaVersion: 1,
    app: APP_ID,
    releaseId: makeReleaseId(createdAt, baseCommit.slice(0, 10), digest),
    createdAt,
    baseCommit,
    branch,
    dirty: worktreeStatus.length > 0,
    worktreeStatus,
    sourceDigest: digest,
    fileCount: paths.length,
    validation: 'full',
    validationCommands: ['bun run check', 'bun run test:unit', 'bun run build:css'],
  }

  await copyArtifactFiles(repoRoot, stageRoot, paths)
  await writeFile(join(stageRoot, 'DEPLOYMENT.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
  await run('Create immutable release artifact', ['tar', '-czf', archivePath, '-C', stageRoot, '.'], repoRoot)
  return {
    archivePath,
    archiveChecksum: await sha256File(archivePath),
    lockChecksum: await sha256File(join(repoRoot, 'bun.lock')),
    manifest,
    cleanup: () => rm(tempRoot, { recursive: true, force: true }),
  }
}

const confirmMutation = (description: string, yes: boolean): void => {
  if (yes) return
  if (!process.stdin.isTTY) throw new Error('Refusing a production mutation without --yes in a non-interactive shell')
  const answer = prompt(`${description}\nType "deploy" to continue:`)
  if (answer !== 'deploy') throw new Error('Deployment cancelled')
}

export const remotePreflightScript = (updateService: boolean): string => `
set -euo pipefail
test "$(systemctl is-active caddy.service)" = active
test "$(systemctl is-active leitbild.service)" = active
test "$(systemctl is-active ${SERVICE})" = active
curl -fsS -o /dev/null ${LOCAL_HEALTH_URL}
curl -fsS -o /dev/null http://127.0.0.1:4177/health
available_kb="$(df --output=avail /opt | tail -n 1 | tr -d ' ')"
test "$available_kb" -gt 2097152
diag="$(curl -fsS http://127.0.0.1:3000/api/system/diagnostics)"
generating="$(printf '%s' "$diag" | jq '[.instances[].generatingAgentCount // 0] | add // 0')"
sessions="$(printf '%s' "$diag" | jq '.wsSessions // 0')"
test "$generating" -eq 0 || { echo "Refusing deploy: $generating agent generation(s) active" >&2; exit 1; }
printf 'preflight_ok available_kb=%s ws_sessions=%s generating=%s\n' "$available_kb" "$sessions" "$generating"
working="$(systemctl show ${SERVICE} -p WorkingDirectory --value)"
if test "$working" != ${shellQuote(CURRENT_LINK)} && test ${updateService ? '1' : '0'} -ne 1; then
  echo "Service still uses $working; first release deploy requires --update-service" >&2
  exit 1
fi
`

export const remoteDeployScript = (artifact: {
  readonly manifest: DeploymentManifest
  readonly archiveChecksum: string
  readonly lockChecksum: string
}, remoteArchive: string, updateService: boolean): string => {
  const releaseId = artifact.manifest.releaseId
  const releaseDir = `${RELEASES_DIR}/${releaseId}`
  return `
${remotePreflightScript(updateService)}
set -euo pipefail
deploy_root=${shellQuote(DEPLOY_ROOT)}
current_link=${shellQuote(CURRENT_LINK)}
releases_dir=${shellQuote(RELEASES_DIR)}
deps_dir=${shellQuote(DEPS_DIR)}
release_id=${shellQuote(releaseId)}
release_dir=${shellQuote(releaseDir)}
archive=${shellQuote(remoteArchive)}
archive_sha=${shellQuote(artifact.archiveChecksum)}
lock_sha=${shellQuote(artifact.lockChecksum)}
incoming="$releases_dir/.incoming-$release_id"
dep_dir="$deps_dir/$lock_sha"
unit_backup="/etc/systemd/system/${SERVICE}.pre-release-$release_id"
previous=""
if test -L "$current_link"; then previous="$(readlink -f "$current_link")"; fi
unit_changed=0

cleanup_incoming() {
  rm -rf -- "$incoming"
  rm -f -- "$archive"
}
rollback_activation() {
  echo "Activation failed; restoring previous service target" >&2
  if test -n "$previous" && test -d "$previous"; then
    next_link="$deploy_root/.rollback-current-$release_id"
    ln -s "$previous" "$next_link"
    mv -Tf "$next_link" "$current_link"
  fi
  if test "$unit_changed" -eq 1 && test -f "$unit_backup"; then
    cp "$unit_backup" /etc/systemd/system/${SERVICE}
    systemctl daemon-reload
  fi
  systemctl restart ${SERVICE} || true
}
wait_for_health() {
  for attempt in $(seq 1 30); do
    if systemctl is-active --quiet ${SERVICE} && curl -fsS -o /dev/null ${LOCAL_HEALTH_URL}; then
      return 0
    fi
    sleep 1
  done
  return 1
}
trap cleanup_incoming EXIT
mkdir -p "$releases_dir" "$deps_dir"
test ! -e "$release_dir" || { echo "Release already exists: $release_id" >&2; exit 1; }
printf '%s  %s\n' "$archive_sha" "$archive" | sha256sum --check --status
mkdir "$incoming"
tar -xzf "$archive" --no-same-owner -C "$incoming"
test "$(jq -r '.app' "$incoming/DEPLOYMENT.json")" = ${shellQuote(APP_ID)}
test "$(jq -r '.releaseId' "$incoming/DEPLOYMENT.json")" = "$release_id"
test "$(sha256sum "$incoming/bun.lock" | cut -d ' ' -f 1)" = "$lock_sha"
test ! -e "$incoming/node_modules"

if test ! -d "$dep_dir/node_modules"; then
  dep_tmp="$deps_dir/.incoming-$lock_sha-$$"
  rm -rf -- "$dep_tmp"
  mkdir "$dep_tmp"
  cp "$incoming/package.json" "$incoming/bun.lock" "$dep_tmp/"
  chown -R ${SERVICE_USER}:${SERVICE_USER} "$dep_tmp"
  if ! sudo -u ${SERVICE_USER} sh -c 'cd "$1" && exec "$2" install --frozen-lockfile' sh "$dep_tmp" ${shellQuote(BUN_BIN)}; then
    rm -rf -- "$dep_tmp"
    exit 1
  fi
  mv "$dep_tmp" "$dep_dir"
fi
ln -s "$dep_dir/node_modules" "$incoming/node_modules"
mv "$incoming" "$release_dir"
trap 'rm -f -- "$archive"' EXIT

next_link="$deploy_root/.next-current-$release_id"
ln -s "$release_dir" "$next_link"
mv -Tf "$next_link" "$current_link"

if test ${updateService ? '1' : '0'} -eq 1; then
  cp /etc/systemd/system/${SERVICE} "$unit_backup"
  cp "$release_dir/deploy/samsinn.service" /etc/systemd/system/${SERVICE}
  systemctl daemon-reload
  unit_changed=1
fi

if ! systemctl restart ${SERVICE} || ! wait_for_health; then
  rollback_activation
  exit 1
fi
if ! (set -a; . /etc/samsinn/env; set +a; cd "$current_link"; ${BUN_BIN} run scripts/smoke-streaming.ts); then
  rollback_activation
  exit 1
fi
rm -f -- "$archive"
printf 'activated_release=%s previous=%s\n' "$release_id" "\${previous:-none}"
`
}

const verifyPublicHealth = async (): Promise<void> => {
  for (const url of PUBLIC_URLS) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Public verification failed: ${url} returned ${response.status}`)
    console.log(`✓ ${url} ${response.status}`)
  }
}

const listReleases = async (): Promise<void> => {
  await run('List Samsinn releases', ['ssh', SSH_HOST, `set -e
    if test -L ${shellQuote(CURRENT_LINK)}; then
      printf 'current='; readlink -f ${shellQuote(CURRENT_LINK)}
    else
      printf 'current=legacy-layout\n'
    fi
    if test -d ${shellQuote(RELEASES_DIR)}; then
      find ${shellQuote(RELEASES_DIR)} -mindepth 1 -maxdepth 1 -type d ! -name '.incoming-*' -printf '%f\n' | sort -r
    fi
  `])
}

const rollbackRelease = async (releaseId: string, yes: boolean): Promise<void> => {
  confirmMutation(`Rollback Samsinn production to ${releaseId}?`, yes)
  await run('Production preflight', ['ssh', SSH_HOST, remotePreflightScript(false)])
  const target = `${RELEASES_DIR}/${releaseId}`
  await run('Activate previous release', ['ssh', SSH_HOST, `set -euo pipefail
    target=${shellQuote(target)}
    current=${shellQuote(CURRENT_LINK)}
    test -d "$target"
    test "$(jq -r '.app' "$target/DEPLOYMENT.json")" = ${shellQuote(APP_ID)}
    previous="$(readlink -f "$current")"
    next=${shellQuote(`${DEPLOY_ROOT}/.rollback-${releaseId}`)}
    ln -s "$target" "$next"
    mv -Tf "$next" "$current"
    if systemctl restart ${SERVICE}; then
      for attempt in $(seq 1 30); do
        if curl -fsS -o /dev/null ${LOCAL_HEALTH_URL}; then exit 0; fi
        sleep 1
      done
    fi
    restore=${shellQuote(`${DEPLOY_ROOT}/.restore-${releaseId}`)}
    ln -s "$previous" "$restore"
    mv -Tf "$restore" "$current"
    systemctl restart ${SERVICE}
    exit 1
  `])
  await verifyPublicHealth()
}

const deploy = async (options: DeployOptions): Promise<void> => {
  const repoRoot = resolve(import.meta.dir, '..')
  await run('TypeScript checks', ['bun', 'run', 'check'], repoRoot)
  await run('Deterministic unit test suite', ['bun', 'run', 'test:unit'], repoRoot)
  await run('Build production CSS', ['bun', 'run', 'build:css'], repoRoot)

  const artifact = await createArtifact(repoRoot)
  try {
    const size = Bun.file(artifact.archivePath).size
    console.log(`\nRelease: ${artifact.manifest.releaseId}`)
    console.log(`Base commit: ${artifact.manifest.baseCommit}`)
    console.log(`Dirty worktree: ${artifact.manifest.dirty ? 'yes' : 'no'}`)
    console.log(`Files: ${artifact.manifest.fileCount}`)
    console.log(`Artifact: ${(size / 1024 / 1024).toFixed(2)} MiB`)
    console.log(`Source digest: ${artifact.manifest.sourceDigest}`)

    if (options.dryRun) {
      console.log('\n✓ Dry run complete; production was not contacted or changed')
      return
    }

    confirmMutation(`Deploy ${artifact.manifest.releaseId} to Samsinn production?`, options.yes)
    await run('Production preflight', ['ssh', SSH_HOST, remotePreflightScript(options.updateService)])
    const remoteArchive = `/tmp/samsinn-${artifact.manifest.releaseId}.tgz`
    await run('Upload immutable artifact', ['scp', artifact.archivePath, `${SSH_HOST}:${remoteArchive}`])
    await run('Install and activate release', [
      'ssh', SSH_HOST,
      remoteDeployScript(artifact, remoteArchive, options.updateService),
    ])
    await verifyPublicHealth()
    console.log(`\n✓ Samsinn ${artifact.manifest.releaseId} is active`)
  } finally {
    await artifact.cleanup()
  }
}

const main = async (): Promise<void> => {
  const options = parseDeployArgs(process.argv.slice(2))
  if (options.list) return listReleases()
  if (options.rollback) return rollbackRelease(options.rollback, options.yes)
  return deploy(options)
}

if (import.meta.main) {
  main().catch(error => {
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
