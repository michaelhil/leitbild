import type { Color, PhysicalScenePalette } from '../map/physical-scene/types.ts'
import './materials.css'

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
    const names = ['floor', 'wall', 'steel', 'dark', 'machine', 'hood', 'motor', 'light', 'plinth', 'pipe', 'steam', 'crane', 'access', 'outage', 'waterbox', 'ground', 'glass', 'line', 'pavement', 'marking'] as const
    const roles = Object.fromEntries(names.map(name => [name, token(`--physical-${name}`)])) as Record<typeof names[number], Color>
    const palette = { materials: { ...roles, metal: roles.steel, equipment: roles.machine, door: roles.crane, context: roles.ground }, defaultMaterial: roles.machine, line: roles.line, lineOpacity: .26, contextLineOpacity: .10 }
    return palette
  } finally { probe.remove() }
}
