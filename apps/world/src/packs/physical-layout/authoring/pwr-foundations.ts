import type { Source, Element } from '../native/architecture/source.ts'
import { parameters, elementWorld } from '../native/architecture/source.ts'
import type { Foundation } from '../native/drafting/foundation.ts'

type FoundationElement = Element & { foundation?: Foundation }
/** Restore the accepted study's actual foundation outlines and condenser
 * exhaust apertures as source facts. The reusable renderer knows no PWR ids. */
export const restorePwrFoundations = (source: Source): void => {
  const equipment = source.elements.filter(element => element.kind === 'equipment' && element.buildingId === 'building/turbine-hall') as FoundationElement[]
  for (const element of equipment) {
    const d = parameters(source, element)
    if (element.equipmentKind === 'hp') element.foundation = { offset: [-.3, 0], length: d.length + .6, width: d.width, height: .3 }
    else if (element.equipmentKind === 'generator') element.foundation = { offset: [-.25, -.4], length: d.length + .5, width: d.width + 2, height: .3 }
    else if (element.equipmentKind === 'exciter') element.foundation = { offset: [-.2, 0], length: d.length + .4, width: d.width, height: .3 }
    else if (element.equipmentKind === 'lp') {
      const matchingId = `condenser-${element.id.slice(element.id.lastIndexOf('-') + 1)}`, condenser = equipment.find(candidate => candidate.id === matchingId)
      if (!condenser) throw Error(`LP foundation requires its authored condenser aperture: ${element.id}`)
      const pose = elementWorld(source, element), cp = elementWorld(source, condenser), cd = parameters(source, condenser), cc = Math.cos(cp.yaw), cs = Math.sin(cp.yaw), c = Math.cos(pose.yaw), s = Math.sin(pose.yaw)
      if (cp.yaw !== pose.yaw) throw Error(`The retained PWR study requires aligned LP/condenser exhaust frames: ${element.id}`)
      const world = [cp.position[0] + cc * 1.3 - cs * 3.6, cp.position[1] + cs * 1.3 + cc * 3.6], delta = [world[0]! - pose.position[0], world[1]! - pose.position[1]], offset = [-.35, 0] as const
      element.foundation = { offset, length: d.length + .7, width: d.width, height: .3, holes: [{ x: c * delta[0]! + s * delta[1]! - offset[0], y: -s * delta[0]! + c * delta[1]! - offset[1], length: cd.length - 2.6, width: cd.width - 7.2 }] }
    }
  }
}
