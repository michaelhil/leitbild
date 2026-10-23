import type { ProcessSignalBinding } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'

// What a row, a chip or a card line names a reading by where room is short
// (plan v5 W4.2): at most 24 characters, as crews say it, never cut. Its
// component's presentation names it where it declares a short name
// ("Subcooling", "RVLIS level"); a reading crews have a standard name for
// reads by it ("CET", "Tavg", "Reactor power"), a loop's with its loop
// ("Thot A"); else the component's short name with what the label measures,
// the words the label shares with the component's own name or kind dropped
// ("Pressurizer pressure" → "PZR pressure", "Bus voltage" → "Bus A
// voltage", "Tank level" → "CST level"), a line's flow by what feeds it
// ("AFW valve A flow"), another line reading by its ends; else the label
// where it is short enough; else none, and a display gives the whole label
// room by whole words.

/** The most characters a short label has (core's Observable shortLabel). */
const MOST = 24

const capitalized = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`
/** A name's words, lower case: "Condensate Storage Tank" → condensate, storage, tank; a kind's camel case split: "processHeader" → process, header. */
const wordsOf = (text: string): ReadonlyArray<string> => text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s-]+/).filter(word => word !== '')

/** A reading's short label, or none where nothing short reads as crews say it. `name`: what crews call it (declarations.ts operatorName). */
export const shortLabelOf = (plant: CompiledProcessPlant, binding: ProcessSignalBinding, name: string | undefined): string | undefined => {
  const graph = plant.graph
  const fits = (text: string): string | undefined => (text.length <= MOST ? text : undefined)
  if (binding.owner.type === 'link') {
    const link = graph.links[binding.owner.linkIndex]!
    const loop = link.metadata?.loopId
    if (name !== undefined) return fits(loop === undefined ? name : `${name} ${loop}`)
    // A line's flow by what feeds it ("AFW valve A flow"); another reading by its ends and what it measures ("PZR →
    // Relief header temperature").
    const end = (index: number): string => graph.components[index]!.metadata?.presentation?.shortLabel ?? graph.components[index]!.label
    const measures = binding.label.split(' ').at(-1)!
    return fits(measures === 'flow' ? `${end(link.fromComponentIndex)} flow` : `${end(link.fromComponentIndex)} → ${end(link.toComponentIndex)} ${measures}`)
  }
  const component = graph.components[binding.owner.componentIndex]!
  const presentation = component.metadata?.presentation
  const local = String(binding.path).slice(String(component.id).length + 1)
  const declared = presentation?.shortNames?.[local]
  if (declared !== undefined) return declared
  const short = presentation?.shortLabel ?? component.label
  const loop = component.metadata?.loopId
  if (name !== undefined) {
    // A name that names its equipment ("Relief header pressure") is whole; one that does not reads with its loop where it has one.
    const whole = name.toLowerCase().includes(short.toLowerCase())
    return fits(whole || loop === undefined ? capitalized(name) : `${capitalized(name)} ${loop}`)
  }
  const own = new Set([...wordsOf(component.label), ...wordsOf(component.kind)])
  // A valve's effective position is its position: the word says only that it is not the demand.
  const words = binding.label.split(' ').filter(word => word !== 'effective')
  let at = 0
  while (at < words.length - 1 && own.has(words[at]!.toLowerCase())) at += 1
  const rest = words.slice(at).join(' ')
  // The label's first word reads lower case after the short name, unless it is an acronym ("RCS leak rate").
  const lower = at > 0 || /^.[A-Z]/.test(rest) ? rest : `${rest.charAt(0).toLowerCase()}${rest.slice(1)}`
  const named = short.toLowerCase().includes(rest.toLowerCase()) ? short : `${short} ${lower}`
  return fits(named) ?? fits(binding.label)
}
