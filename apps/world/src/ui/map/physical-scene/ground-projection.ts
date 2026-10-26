/** One revision's ground-plane projection. Retain only X/Y/W rows: source
 * admission can change clip-Z near/far without changing this ground mapping. */
export const createPhysicalGroundProjector = (snapshot: () => { readonly matrix: ArrayLike<number>; readonly width: number; readonly height: number }) => {
  let frame: { revision: number; x: readonly number[]; y: readonly number[]; w: readonly number[]; width: number; height: number } | null = null
  return (revision: number, point: { readonly x: number; readonly y: number }): { x: number; y: number } => {
    if (frame?.revision !== revision) {
      const value = snapshot(), m = value.matrix
      frame = { revision, x: [m[0]!, m[4]!, m[8]!, m[12]!], y: [m[1]!, m[5]!, m[9]!, m[13]!], w: [m[3]!, m[7]!, m[11]!, m[15]!], width: value.width, height: value.height }
    }
    const { x, y, w, width, height } = frame
    const denominator = w[0]! * point.x + w[1]! * point.y + w[2]! * 0 + w[3]!
    const px = (x[0]! * point.x + x[1]! * point.y + x[2]! * 0 + x[3]!) / denominator, py = (y[0]! * point.x + y[1]! * point.y + y[2]! * 0 + y[3]!) / denominator
    return { x: (px + 1) * width / 2, y: (1 - py) * height / 2 }
  }
}
