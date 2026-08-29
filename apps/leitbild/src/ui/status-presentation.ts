import type { PackObjectStatusTone } from '../core/packs/protocol.ts'

export const statusToneColor = (tone: PackObjectStatusTone): string => {
  if (tone === 'ready') return '#16834f'
  if (tone === 'working') return '#c17a13'
  if (tone === 'error') return '#c7352b'
  return '#667085'
}
