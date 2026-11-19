export type DiagramVersion = { readonly source: string; readonly label: string }

// Revisions belong to this mounted view. The original chat message is immutable.
export const createDiagramVersions = (source: string) => {
  const versions: DiagramVersion[] = [{ source, label: 'Original' }]
  let selected = 0
  let change = 0
  return {
    current: (): DiagramVersion => versions[selected]!,
    selected: (): number => selected,
    count: (): number => versions.length,
    change: (): number => change,
    select(index: number): boolean {
      if (!Number.isInteger(index) || index < 0 || index >= versions.length) return false
      selected = index; change++; return true
    },
    add(source: string, label: string, activate = true): number {
      versions.push({ source, label })
      if (activate) selected = versions.length - 1
      change++
      return versions.length - 1
    },
  }
}

export type FlowDirection = 'TD' | 'LR' | 'BT' | 'RL'
const ROOT = /^(\s*(?:flowchart|graph)\s+)(TD|TB|LR|BT|RL)(?=\s|;|$)/

const rootLine = (source: string): { lines: string[]; index: number; match: RegExpMatchArray } | undefined => {
  const lines = source.split('\n')
  // Do not rewrite frontmatter, directives, or other diagram grammars by guessing.
  const index = lines.findIndex(line => line.trim() !== '' && !/^\s*%%/.test(line))
  if (index < 0) return undefined
  const match = lines[index]!.match(ROOT)
  return match ? { lines, index, match } : undefined
}

export const flowDirection = (source: string): FlowDirection | undefined => {
  const direction = rootLine(source)?.match[2]
  return direction === 'TB' ? 'TD' : direction as FlowDirection | undefined
}

export const withFlowDirection = (source: string, direction: FlowDirection): string | undefined => {
  const root = rootLine(source)
  if (!root) return undefined
  root.lines[root.index] = root.lines[root.index]!.replace(ROOT, `$1${direction}`)
  return root.lines.join('\n')
}
