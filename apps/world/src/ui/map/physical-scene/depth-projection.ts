/**
 * The homogeneous W at the host perspective near plane. Clip Z/W is A+B/W;
 * solving its near-plane value (-1) recovers n in the host's own W units.
 * Orthographic projections already have linear depth and return zero.
 */
export const physicalPerspectiveNear = (matrix: ArrayLike<number>): number => {
  let axis = 0
  for (let candidate = 1; candidate < 3; candidate++) if (Math.abs(matrix[candidate * 4 + 3]!) > Math.abs(matrix[axis * 4 + 3]!)) axis = candidate
  const w = matrix[axis * 4 + 3]!
  if (w === 0) return 0
  const a = matrix[axis * 4 + 2]! / w, b = matrix[14]! - a * matrix[15]!, near = -b / (1 + a)
  if (!(near > 0) || !Number.isFinite(near)) throw Error('Physical perspective projection has no finite positive near plane')
  return near
}
