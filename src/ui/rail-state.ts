export const railStorageKey = 'leitbild.controlRailWidth'
export const defaultRailWidth = 360
export const minRailWidth = 280
export const maxRailWidth = 560
export const collapseThreshold = 180

export const readStoredRailWidth = (): number => {
  try {
    const raw = localStorage.getItem(railStorageKey)
    if (!raw) return defaultRailWidth
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0) return defaultRailWidth
    return parsed === 0 ? 0 : Math.max(minRailWidth, Math.min(maxRailWidth, parsed))
  } catch (error) {
    console.warn('Unable to read Leitbild rail width preference', error)
    return defaultRailWidth
  }
}

export const storeRailWidth = (width: number): void => {
  try {
    localStorage.setItem(railStorageKey, String(width))
  } catch (error) {
    console.warn('Unable to store Leitbild rail width preference', error)
  }
}

export const railWidthFromPointer = (clientX: number): number => {
  const clamped = Math.max(0, Math.min(maxRailWidth, clientX))
  return clamped < collapseThreshold ? 0 : Math.max(minRailWidth, clamped)
}
