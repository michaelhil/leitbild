/** Client-only inspection settings. None changes physical coordinates or Run state. */
export interface PhysicalLayoutView {
  readonly mode: '2d' | '3d'
  readonly levelId: string | 'all'
  readonly separation: number
  readonly cutaway: boolean
  readonly detail: 'auto' | 'hidden'
  readonly live: boolean
  readonly surroundings?: boolean
  readonly hiddenLayerIds?: ReadonlyArray<string>
  readonly wallOpacity?: number
  readonly floorOpacity?: number
}

export interface PhysicalLayoutLevel {
  readonly id: string
  readonly label: string
  readonly elevation: number
}

export const initialPhysicalLayoutView = (levels: ReadonlyArray<PhysicalLayoutLevel>): PhysicalLayoutView => {
  const first = levels[0]
  if (first === undefined) throw new Error('A physical layout needs at least one level')
  return { mode: '2d', levelId: first.id, separation: 0, cutaway: true, detail: 'auto', live: true, surroundings: false }
}

/** A plan has one selected level; an explicit 3D view can show all levels. */
export const changePhysicalLayoutView = (current: PhysicalLayoutView, patch: Partial<PhysicalLayoutView>, levels: ReadonlyArray<PhysicalLayoutLevel>): PhysicalLayoutView => {
  const next = { ...current, ...patch }
  if (!Number.isFinite(next.separation) || next.separation < 0) throw new Error('Level separation must be a finite, non-negative distance')
  for (const opacity of [next.wallOpacity, next.floorOpacity]) if (opacity !== undefined && (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)) throw new Error('Architecture opacity must be between zero and one')
  if (next.levelId !== 'all' && !levels.some(level => level.id === next.levelId)) throw new Error(`Unknown layout level: ${next.levelId}`)
  if (next.mode === '2d') return { ...next, levelId: next.levelId === 'all' ? initialPhysicalLayoutView(levels).levelId : next.levelId, separation: 0 }
  return next
}

export const levelLabel = (level: PhysicalLayoutLevel): string => `${level.label} · ${level.elevation > 0 ? '+' : ''}${level.elevation} m`
