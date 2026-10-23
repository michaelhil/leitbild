import type { ObjectId } from '../../../core/model/index.ts'
import type { Observable } from '../../../core/observation/model.ts'
import type { ProcessSignalBinding } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { logarithmicSpan, POSITION_OPEN_ABOVE, POSITION_SHUT_BELOW } from '../quantity-text.ts'

// How a Plant reading reads in words where a number alone would mislead
// (plan v5 W4.4): an on/off signal in its component's words ("Source-range HV
// on"); a reading at an end of its instrument's span only that it is there
// ("<0 %"); a narrow range off its span by its wider range ("WR 24.0 %"); a
// valve's position SHUT and OPEN at the ends of its travel, as its drawing
// writes it; a reading outside its validity by what it waits for
// ("Source-range HV off").

/** The word a wider range reads after (its row reads "WR 24.0 %"). */
const WIDER_WORD = 'WR'

const localOf = (binding: ProcessSignalBinding, component: { readonly id: unknown }): string => String(binding.path).slice(String(component.id).length + 1)

export const readingWords = (objectId: ObjectId, plant: CompiledProcessPlant, binding: ProcessSignalBinding, declared: (path: string) => boolean): Pick<Observable, 'states' | 'span' | 'wider' | 'travel'> => {
  const graph = plant.graph
  const component = binding.owner.type === 'component' ? graph.components[binding.owner.componentIndex]! : undefined
  const words = component === undefined ? undefined : component.metadata?.presentation?.states?.[localOf(binding, component)]
  const span = binding.limits?.instrumentSpan
  const wider = component?.semantics.widerRanges.find(range => range.reading === binding.path && range.while === undefined)
  // A fraction's travel is 0 to 1; one read in percent, 0 to 100.
  const scale = binding.unit === 'percent' ? 100 : 1
  return {
    ...(binding.quantity === 'boolean' && words !== undefined ? { states: [{ value: 'true', label: words.on, active: true as const }, { value: 'false', label: words.off }] } : {}),
    ...(binding.quantity !== 'boolean' && span !== undefined && !logarithmicSpan(span) && span.max > span.min ? { span: { min: span.min, max: span.max } } : {}),
    ...(wider !== undefined && declared(String(wider.wider)) ? { wider: { ref: `${objectId}#${wider.wider}`, word: WIDER_WORD } } : {}),
    ...(binding.measurand === 'position' && (binding.unit === 'fraction' || binding.unit === 'percent')
      ? { travel: { below: POSITION_SHUT_BELOW * scale, above: POSITION_OPEN_ABOVE * scale, low: 'SHUT', high: 'OPEN' } } : {}),
  }
}

/** What a reading outside its validity waits for: its flag's off words, else its flag's label with "off". */
export const invalidWhileOf = (plant: CompiledProcessPlant, flag: string): string => {
  const binding = plant.graph.signalBindingByPath.get(flag as never)
  const component = binding?.owner.type === 'component' ? plant.graph.components[binding.owner.componentIndex] : undefined
  const off = component === undefined || binding === undefined ? undefined : component.metadata?.presentation?.states?.[localOf(binding, component)]?.off
  return (off ?? `${binding?.label ?? flag} off`).slice(0, 40)
}
