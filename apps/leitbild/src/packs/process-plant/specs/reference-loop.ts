export const fourLoopReferenceLetters = ['A', 'B', 'C', 'D'] as const
export const sixLoopReferenceLetters = ['A', 'B', 'C', 'D', 'E', 'F'] as const

export type ProcessPlantReferenceLoop = string

const defaultReferenceLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

export const referenceLoopLettersForCount = (count: number): ReadonlyArray<ProcessPlantReferenceLoop> => {
  if (!Number.isInteger(count) || count < 2 || count > defaultReferenceLetters.length) {
    throw new Error(`reference PWR loop count must be an integer between 2 and ${defaultReferenceLetters.length}: ${count}`)
  }
  return defaultReferenceLetters.slice(0, count)
}
