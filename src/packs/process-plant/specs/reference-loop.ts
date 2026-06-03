export const fourLoopReferenceLetters = ['A', 'B', 'C', 'D'] as const
export const sixLoopReferenceLetters = ['A', 'B', 'C', 'D', 'E', 'F'] as const

export type ProcessPlantReferenceLoop = typeof sixLoopReferenceLetters[number]
