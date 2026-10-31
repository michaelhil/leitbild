import { expect, test } from 'bun:test'
import { physicalPerspectiveNear } from '../src/ui/map/physical-scene/depth-projection.ts'
import { multiply, transform } from '../src/ui/map/physical-scene/math.ts'

const perspective = (near: number, far: number) => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0])
test('camera depth recovers the same near plane through translated and rotated camera frames', () => {
  const p = perspective(.13, 8300)
  const frames = [new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 200, -500, -3000, 1]), new Float64Array([0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 200, -500, -3000, 1])]
  for (const frame of frames) {
    const matrix = multiply(p, frame), before = [...matrix]
    expect(physicalPerspectiveNear(matrix)).toBeCloseTo(.13, 9)
    expect([...matrix]).toEqual(before)
  }
})
test('homogeneous camera-unit scaling preserves reversed depth and screen coverage', () => {
  const matrix = perspective(.13, 8300), scaled = matrix.map(value => value * 4.86e-8), point = [4, 8, -3000] as const
  expect(transform(scaled, point).slice(0, 2)).toEqual(transform(matrix, point).slice(0, 2))
  expect(physicalPerspectiveNear(scaled) / (3000 * 4.86e-8)).toBeCloseTo(physicalPerspectiveNear(matrix) / 3000, 13)
})
test('reversed floating depth separates a real60mm front/back gap without changing clipping', () => {
  const matrix = perspective(2.83, 8300), near = physicalPerspectiveNear(matrix)
  const front = Math.fround(near / 3000), back = Math.fround(near / 3000.06)
  expect(front).toBeGreaterThan(back)
  expect(front).toBeGreaterThan(0)
  expect(front).toBeLessThan(1)
  expect(transform(matrix, [0, 0, -2.83])[2]).toBeCloseTo(-1, 12)
  expect(transform(matrix, [0, 0, -8300])[2]).toBeCloseTo(1, 12)
})
test('orthographic cameras retain their already linear fragment depth', () => {
  expect(physicalPerspectiveNear(new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]))).toBe(0)
})
