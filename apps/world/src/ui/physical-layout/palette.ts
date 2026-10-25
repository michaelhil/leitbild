import type { Color, PhysicalScenePalette } from '../map/physical-scene/types.ts'

/** Resolve the host's actual theme tokens; geometry carries roles, never operational colours. */
export const physicalLayoutPalette = (container: HTMLElement): PhysicalScenePalette => {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  container.append(probe)
  const token = (name: string): Color => {
    probe.style.color = `var(${name})`
    const resolved = getComputedStyle(probe).color
    const channels = resolved.match(/[\d.]+/g)?.slice(0, 3).map(Number)
    if (channels?.length !== 3 || channels.some(channel => !Number.isFinite(channel))) throw new Error(`Physical layout colour token ${name} did not resolve: ${resolved}`)
    return [channels[0]! / 255, channels[1]! / 255, channels[2]! / 255]
  }
  try {
    const metal = token('--muted'), floor = token('--panel-strong'), wall = token('--border'), line = token('--text')
    return { materials: { metal, equipment: metal, wall, floor, door: token('--accent'), pipe: metal, glass: floor, context: wall, line }, defaultMaterial: metal, line }
  } finally { probe.remove() }
}
