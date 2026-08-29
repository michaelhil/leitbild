import type { Pack } from './types.ts'

interface Version {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

const parseVersion = (value: string): Version => {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
  if (!match) throw new Error(`unsupported Pack version ${value}`)
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

const compareVersions = (left: Version, right: Version): number =>
  left.major - right.major || left.minor - right.minor || left.patch - right.patch

export const satisfiesPackVersion = (version: string, range: string): boolean => {
  const actual = parseVersion(version)
  if (!range.startsWith('^')) return compareVersions(actual, parseVersion(range)) === 0

  const minimum = parseVersion(range.slice(1))
  if (compareVersions(actual, minimum) < 0) return false
  if (minimum.major > 0) return actual.major === minimum.major
  if (minimum.minor > 0) return actual.major === 0 && actual.minor === minimum.minor
  return actual.major === 0 && actual.minor === 0 && actual.patch === minimum.patch
}

/** Validates Pack identity/dependencies and returns a deterministic dependency-first order. */
export const resolvePackLoadOrder = (packs: ReadonlyArray<Pack>): ReadonlyArray<Pack> => {
  const byId = new Map<string, Pack>()
  for (const pack of packs) {
    if (byId.has(pack.id)) throw new Error(`duplicate Pack id ${pack.id}`)
    byId.set(pack.id, pack)
  }

  for (const pack of packs) {
    for (const dependency of pack.manifest.descriptor.dependencies) {
      const installed = byId.get(dependency.id)
      if (!installed) {
        throw new Error(`Pack ${pack.id} requires missing Pack ${dependency.id} ${dependency.versionRange}`)
      }
      if (!satisfiesPackVersion(installed.manifest.descriptor.version, dependency.versionRange)) {
        throw new Error(
          `Pack ${pack.id} requires ${dependency.id} ${dependency.versionRange}, installed version is ${installed.manifest.descriptor.version}`,
        )
      }
    }
  }

  const ordered: Pack[] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (pack: Pack): void => {
    if (visited.has(pack.id)) return
    if (visiting.has(pack.id)) {
      throw new Error(`Pack dependency cycle includes ${pack.id}`)
    }
    visiting.add(pack.id)
    for (const dependency of pack.manifest.descriptor.dependencies) {
      visit(byId.get(dependency.id)!)
    }
    visiting.delete(pack.id)
    visited.add(pack.id)
    ordered.push(pack)
  }
  for (const pack of [...packs].sort((left, right) => left.id.localeCompare(right.id))) visit(pack)
  return ordered
}
