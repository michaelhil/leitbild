import { createMesh, palette as p, type Mesh } from '../mesh.ts'
import type { Element, Parameters } from './source.ts'

type Point = [number, number, number]
type Profile = ReadonlyArray<readonly [number, number, number]>

/** Metres-native families. Parts are fractions of one admitted bounding envelope. */
const radialY = (mesh: Mesh, cx: number, cz: number, profile: Profile, material: number, segments = 24): void => {
  const point = (row: number, column: number): Point => {
    const [y, rx, rz] = profile[row]!, angle = column * Math.PI * 2 / segments
    return [cx + Math.cos(angle) * rx, y, cz + Math.sin(angle) * rz]
  }
  for (let row = 0; row < profile.length - 1; row++) for (let column = 0; column < segments; column++)
    mesh.quad(point(row, column), point(row, column + 1), point(row + 1, column + 1), point(row + 1, column), material)
  for (const row of [0, profile.length - 1]) for (let column = 0; column < segments; column++) {
    const centre: Point = [cx, profile[row]![0], cz]
    mesh.tri(centre, point(row, column + (row === 0 ? 1 : 0)), point(row, column + (row === 0 ? 0 : 1)), material)
    mesh.line(point(row, column), point(row, column + 1))
  }
}

const horizontal = (mesh: Mesh, dimensions: Parameters, material: number): void => {
  const { length: l, width: w, height: h } = dimensions
  mesh.box(.07 * l, 0, .07 * w, .86 * l, .08 * h, .86 * w, p.plinth)
  for (const x of [.2, .72]) mesh.box(x * l, .08 * h, .17 * w, .08 * l, .2 * h, .66 * w, p.dark)
  mesh.loftX(.04 * l, .5 * h, .5 * w, [[0, .1 * h, .1 * w], [.08 * l, .36 * h, .42 * w], [.84 * l, .36 * h, .42 * w], [.92 * l, .1 * h, .1 * w]], material, 24)
  for (const x of [.14, .84]) mesh.loftX(0, .5 * h, .5 * w, [[x * l, .38 * h, .44 * w], [(x + .018) * l, .38 * h, .44 * w]], p.light, 24)
}

const insulator = (mesh: Mesh, x: number, z: number, y: number, height: number, radius: number): void => {
  mesh.cylinder([x, y, z], [x, y + height, z], radius * .54, p.dark, 10)
  for (let index = 1; index <= 6; index++) mesh.cylinder([x, y + index * height / 7, z], [x, y + index * height / 7 + height * .035, z], radius, p.light, 10)
}

export const campusEquipmentMesh = (element: Element, dimensions: Parameters): Mesh => {
  const mesh = createMesh(), { length: l, width: w, height: h } = dimensions
  switch (element.equipmentKind) {
    case 'reactor-vessel':
    case 'steam-generator':
    case 'pressurizer':
    case 'tank': {
      const kind = element.equipmentKind, bulge = kind === 'steam-generator' ? .46 : .4
      mesh.box(.12 * l, 0, .12 * w, .76 * l, .07 * h, .76 * w, p.plinth)
      radialY(mesh, l / 2, w / 2, [
        [.07 * h, .13 * l, .13 * w], [.12 * h, .32 * l, .32 * w],
        [.22 * h, .39 * l, .39 * w], [.62 * h, bulge * l, bulge * w],
        [.85 * h, bulge * l, bulge * w], [.93 * h, .31 * l, .31 * w], [.97 * h, .04 * l, .04 * w],
      ], p.machine, 32)
      for (const y of [.24, .79]) radialY(mesh, l / 2, w / 2, [[y * h, .405 * l, .405 * w], [(y + .015) * h, .405 * l, .405 * w]], p.light, 32)
      if (kind === 'reactor-vessel') {
        for (let index = 0; index < 8; index++) {
          const angle = index * Math.PI / 4
          mesh.cylinder([l / 2 + .24 * l * Math.cos(angle), .91 * h, w / 2 + .24 * w * Math.sin(angle)], [l / 2 + .24 * l * Math.cos(angle), h, w / 2 + .24 * w * Math.sin(angle)], .025 * Math.min(l, w), p.dark, 8)
        }
      }
      if (kind !== 'tank') for (const side of [-1, 1]) mesh.cylinder([l / 2 + side * .26 * l, .25 * h, w / 2], [l / 2 + side * .5 * l, .25 * h, w / 2], .07 * Math.min(l, w), p.light, 16)
      break
    }
    case 'heat-exchanger': horizontal(mesh, dimensions, p.machine); break
    case 'pump': {
      mesh.box(.03 * l, 0, .04 * w, .94 * l, .1 * h, .92 * w, p.plinth)
      mesh.cylinder([.12 * l, .44 * h, .5 * w], [.42 * l, .44 * h, .5 * w], .29 * Math.min(w, h), p.machine, 24)
      mesh.cylinder([.42 * l, .44 * h, .5 * w], [.6 * l, .44 * h, .5 * w], .055 * Math.min(w, h), p.dark, 10)
      mesh.loftX(.59 * l, .49 * h, .5 * w, [[0, .25 * h, .28 * w], [.08 * l, .32 * h, .35 * w], [.3 * l, .32 * h, .35 * w], [.36 * l, .25 * h, .28 * w]], p.motor, 20)
      for (let index = 0; index < 6; index++) mesh.loftX((.65 + index * .042) * l, .49 * h, .5 * w, [[0, .335 * h, .365 * w], [.012 * l, .335 * h, .365 * w]], p.light, 16)
      mesh.cylinder([.22 * l, .45 * h, .5 * w], [.22 * l, .45 * h, .03 * w], .11 * w, p.machine, 12)
      mesh.cylinder([.33 * l, .44 * h, .5 * w], [.33 * l, .96 * h, .5 * w], .11 * w, p.light, 12)
      break
    }
    case 'reactor-coolant-pump': {
      mesh.box(.06 * l, 0, .06 * w, .88 * l, .05 * h, .88 * w, p.plinth)
      radialY(mesh, l / 2, w / 2, [[.05 * h, .4 * l, .4 * w], [.18 * h, .46 * l, .46 * w], [.31 * h, .31 * l, .31 * w], [.4 * h, .17 * l, .17 * w]], p.machine)
      mesh.cylinder([l / 2, .35 * h, w / 2], [l / 2, .55 * h, w / 2], .12 * Math.min(l, w), p.dark, 16)
      radialY(mesh, l / 2, w / 2, [[.5 * h, .26 * l, .26 * w], [.56 * h, .34 * l, .34 * w], [.91 * h, .34 * l, .34 * w], [.98 * h, .26 * l, .26 * w]], p.motor)
      for (let index = 0; index < 7; index++) radialY(mesh, l / 2, w / 2, [[(.57 + index * .047) * h, .36 * l, .36 * w], [(.58 + index * .047) * h, .36 * l, .36 * w]], p.light, 20)
      break
    }
    case 'valve': {
      mesh.cylinder([0, .3 * h, w / 2], [l, .3 * h, w / 2], .19 * Math.min(w, h), p.machine, 16)
      mesh.frustum(.25 * l, .12 * h, .2 * w, .5 * l, .6 * w, .45 * h, .25 * l, .3 * w, p.machine)
      mesh.cylinder([l / 2, .5 * h, w / 2], [l / 2, .88 * h, w / 2], .035 * Math.min(l, w), p.dark, 10)
      mesh.cylinder([l / 2, .88 * h, w / 2], [l / 2, .96 * h, w / 2], .24 * Math.min(l, w), p.crane, 16)
      break
    }
    case 'diesel-generator': {
      mesh.box(.02 * l, 0, .02 * w, .96 * l, .12 * h, .96 * w, p.plinth)
      mesh.box(.08 * l, .12 * h, .2 * w, .55 * l, .47 * h, .6 * w, p.machine)
      for (let index = 0; index < 6; index++) mesh.box((.1 + index * .083) * l, .59 * h, .17 * w, .055 * l, .14 * h, .66 * w, p.light)
      mesh.loftX(.66 * l, .43 * h, .5 * w, [[0, .28 * h, .34 * w], [.06 * l, .34 * h, .41 * w], [.29 * l, .34 * h, .41 * w]], p.motor, 24)
      mesh.cylinder([.18 * l, .6 * h, .5 * w], [.18 * l, h, .5 * w], .06 * w, p.dark, 12)
      mesh.box(.35 * l, .76 * h, .24 * w, .2 * l, .14 * h, .52 * w, p.dark)
      break
    }
    case 'cabinet': {
      mesh.box(0, 0, 0, l, h, w, p.light)
      const doors = Math.max(1, Math.round(l / Math.max(w * 1.1, .5)))
      for (let index = 0; index < doors; index++) {
        const x = index * l / doors
        mesh.box(x + .025 * l / doors, .04 * h, -.001 * w, .95 * l / doors, .91 * h, .025 * w, p.dark)
        mesh.box(x + .05 * l / doors, .07 * h, -.002 * w, .88 * l / doors, .85 * h, .025 * w, p.light)
        mesh.box(x + .79 * l / doors, .42 * h, -.015 * w, .045 * l / doors, .14 * h, .045 * w, p.dark)
      }
      break
    }
    case 'battery': {
      for (const x of [.02, .95]) mesh.box(x * l, 0, .04 * w, .03 * l, h, .92 * w, p.steel)
      for (let row = 0; row < 3; row++) {
        mesh.box(.03 * l, (.05 + row * .3) * h, .03 * w, .94 * l, .03 * h, .94 * w, p.steel)
        for (let cell = 0; cell < 8; cell++) mesh.box((.05 + cell * .113) * l, (.08 + row * .3) * h, .1 * w, .09 * l, .23 * h, .8 * w, p.machine)
      }
      break
    }
    case 'transformer': {
      mesh.box(.02 * l, 0, .02 * w, .96 * l, .07 * h, .96 * w, p.plinth)
      mesh.box(.2 * l, .1 * h, .2 * w, .6 * l, .48 * h, .6 * w, p.machine)
      for (let index = 0; index < 9; index++) for (const z of [.06, .83]) mesh.box((.17 + index * .074) * l, .17 * h, z * w, .025 * l, .36 * h, .11 * w, p.light)
      mesh.loftX(.22 * l, .7 * h, .5 * w, [[0, .07 * h, .1 * w], [.56 * l, .07 * h, .1 * w]], p.dark, 16)
      for (let phase = 0; phase < 3; phase++) insulator(mesh, (.3 + phase * .2) * l, .29 * w, .58 * h, .38 * h, .07 * w)
      break
    }
    case 'breaker':
    case 'disconnector': {
      mesh.box(.02 * l, 0, .04 * w, .96 * l, .04 * h, .92 * w, p.plinth)
      for (let phase = 0; phase < 3; phase++) {
        const x = (.15 + phase * .35) * l
        mesh.box(x - .045 * l, .04 * h, .24 * w, .09 * l, .15 * h, .52 * w, p.steel)
        insulator(mesh, x, .5 * w, .19 * h, .53 * h, Math.min(.035 * l, .18 * w))
        if (element.equipmentKind === 'breaker') mesh.cylinder([x, .78 * h, .12 * w], [x, .78 * h, .88 * w], .065 * h, p.machine, 16)
        else {
          insulator(mesh, x, .13 * w, .19 * h, .53 * h, Math.min(.035 * l, .12 * w))
          mesh.cylinder([x, .75 * h, .13 * w], [x, .91 * h, .82 * w], Math.min(.012 * l, .03 * w), p.light, 8)
        }
      }
      break
    }
    case 'bus-support': {
      mesh.box(.04 * l, 0, .04 * w, .92 * l, .04 * h, .92 * w, p.plinth)
      mesh.cylinder([l / 2, .04 * h, w / 2], [l / 2, .67 * h, w / 2], .12 * Math.min(l, w), p.steel, 8)
      insulator(mesh, l / 2, w / 2, .67 * h, .33 * h, .36 * Math.min(l, w))
      break
    }
    case 'pylon': {
      const radius = Math.max(.035, Math.min(l, w) * .009), stages = [0, .22, .44, .63, .8, .98]
      const corner = (stage: number, index: number): Point => {
        const y = stages[stage]!, halfX = l * (.24 - y * .2), halfZ = w * (.43 - y * .35)
        return [l / 2 + (index & 1 ? halfX : -halfX), y * h, w / 2 + (index & 2 ? halfZ : -halfZ)]
      }
      for (let stage = 0; stage < stages.length - 1; stage++) for (let index = 0; index < 4; index++) {
        mesh.cylinder(corner(stage, index), corner(stage + 1, index), radius, p.steel, 6)
        for (const neighbour of [index ^ 1, index ^ 2]) if (index < neighbour) {
          mesh.cylinder(corner(stage, index), corner(stage + 1, neighbour), radius * .7, p.steel, 6)
          mesh.cylinder(corner(stage, neighbour), corner(stage + 1, index), radius * .7, p.steel, 6)
          mesh.cylinder(corner(stage, index), corner(stage, neighbour), radius * .7, p.steel, 6)
        }
      }
      for (const elevation of [.54, .7, .85]) {
        mesh.cylinder([.02 * l, elevation * h, .5 * w], [.98 * l, elevation * h, .5 * w], radius * 1.2, p.steel, 6)
        for (const x of [.03, .97]) insulator(mesh, x * l, w / 2, (elevation - .08) * h, .075 * h, radius * 2)
      }
      break
    }
    default: throw new Error(`No campus equipment geometry for ${element.equipmentKind}`)
  }
  return mesh
}
