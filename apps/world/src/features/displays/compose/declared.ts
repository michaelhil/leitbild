/**
 * What the caller may know of refs and objects (architecture A2): every read
 * goes through the observation port as the caller, so a ref of an object it
 * may not inspect has no declaration and no value. A Pack that declares an
 * element's observables only when asked (a grid's) is asked for the elements
 * whose id the ref carries; its answer confirms the exact ref, never a guess.
 */
import { refObjectId } from '../../../core/model/alerts.ts'
import type { ObjectId, OperationalObject } from '../../../core/model/index.ts'
import type { ObservationDeclaration } from '../../../core/observation/capabilities.ts'
import type { Observable } from '../../../core/observation/model.ts'
import { normalized } from '../../../core/model/text-search.ts'
import { fold } from '../observation/fold.ts'
import type { SearchRun } from '../observation/search.ts'
import type { VignetteElement, VignetteValue } from './model.ts'

export interface Declared {
  readonly observable: Observable
  readonly object: OperationalObject
  readonly element?: VignetteElement
  /** Its object declares what its instruments measure: a value only its simulator computes is no reading there. */
  readonly measured?: true
}

/** Two names alike once folded: case, marks, æ/ø/å and punctuation aside. */
export const same = (left: string, right: string): boolean => normalized(fold(left)) === normalized(fold(right))

export const visibleObject = (run: SearchRun, objectId: string): OperationalObject | undefined =>
  run.denied.has(objectId) ? undefined : run.objects.find(object => object.id === objectId)

/** An object's declaration as the caller reads it (with these elements' observables), or null where it declares none to the caller. */
export const declarationOf = async (run: SearchRun, objectId: string, elementIds?: ReadonlyArray<string>): Promise<ObservationDeclaration | null> => {
  if (visibleObject(run, objectId) === undefined) return null
  const [declaration] = await run.port.declarations([objectId as ObjectId], elementIds)
  return declaration === undefined || 'refused' in declaration ? null : declaration
}

const elementOf = (declaration: ObservationDeclaration, id: string | undefined): VignetteElement | undefined =>
  id === undefined ? undefined : declaration.elements.find(entry => entry.id === id)

// Each declaration's observables by ref, with their place in it, built once: a declaration is kept by revision across
// requests, and each sample of a lead request looks its refs up several times.
const indexes = new WeakMap<ObservationDeclaration, ReadonlyMap<string, { readonly observable: ObservationDeclaration['observables'][number]; readonly at: number }>>()
const indexOf = (declaration: ObservationDeclaration) => indexes.get(declaration) ?? (() => {
  const index = new Map<string, { readonly observable: ObservationDeclaration['observables'][number]; readonly at: number }>()
  declaration.observables.forEach((observable, at) => { if (!index.has(observable.ref)) index.set(observable.ref, { observable, at }) })
  indexes.set(declaration, index)
  return index
})()

/** The declarations of these refs, by ref, in their declaration's order; a ref the caller may not read is absent. */
export const declaredRefs = async (run: SearchRun, refs: ReadonlyArray<string>): Promise<ReadonlyMap<string, Declared>> => {
  const found = new Map<string, Declared>()
  const asking = new Set(refs)
  for (const objectId of new Set(refs.map(refObjectId))) {
    const object = visibleObject(run, objectId)
    const base = await declarationOf(run, objectId)
    if (object === undefined || base === null) continue
    const measured = measuredOf(base)
    const add = (declaration: ObservationDeclaration): void => {
      const index = indexOf(declaration)
      const hits = [...asking].flatMap(ref => (found.has(ref) ? [] : index.get(ref) ?? [])).sort((left, right) => left.at - right.at)
      for (const { observable } of hits) {
        const element = elementOf(declaration, observable.element) ?? elementOf(base, observable.element)
        found.set(observable.ref, { observable, object, ...(element === undefined ? {} : { element }), ...(measured ? { measured: true } : {}) })
      }
    }
    add(base)
    const missing = refs.filter(ref => refObjectId(ref) === objectId && !found.has(ref)).map(ref => ref.slice(ref.indexOf('#') + 1))
    const asked = base.elements.filter(element => missing.some(signal => signal.includes(element.id))).map(element => element.id).slice(0, 256)
    if (asked.length > 0) {
      const extended = await declarationOf(run, objectId, asked)
      if (extended !== null) add(extended)
    }
  }
  return found
}

// Whether each declaration names an instrument reading, found once per declaration.
const measuring = new WeakMap<ObservationDeclaration, boolean>()
const measuredOf = (declaration: ObservationDeclaration): boolean => measuring.get(declaration)
  ?? measuring.set(declaration, declaration.observables.some(observable => observable.basis === 'instrument')).get(declaration)!

/**
 * An observable's label qualified with its object's ("<object> · <observable>", R25) where both fit the 80 characters
 * a label holds; else its own label whole: a label is never cut mid-word ("· Frequenc").
 */
export const qualifiedLabel = (object: string, label: string): string => {
  const both = `${object} · ${label}`
  return both.length <= 80 ? both : label
}

/** A declared observable as a vignette names it (R25). */
export const valueOf = ({ observable, object, element, measured }: Declared): VignetteValue => ({
  ref: observable.ref, label: qualifiedLabel(object.label, observable.label), quantity: observable.quantity, unit: observable.unit,
  valueType: observable.valueType, thresholds: observable.thresholds, series: observable.series,
  ...(observable.states === undefined ? {} : { states: observable.states }), ...(observable.decades === true ? { decades: true } : {}),
  ...(observable.checks === undefined ? {} : { checks: observable.checks }),
  ...(observable.shortLabel === undefined ? {} : { shortLabel: observable.shortLabel }),
  ...(observable.decidingElement === undefined ? {} : { decidingElement: observable.decidingElement }),
  ...(observable.basis === undefined ? {} : { basis: observable.basis }), ...(element === undefined ? {} : { element: named(element) }),
  ...(observable.invalidWhile === undefined ? {} : { invalidWhile: observable.invalidWhile }), ...(observable.span === undefined ? {} : { span: observable.span }),
  ...(observable.wider === undefined ? {} : { wider: observable.wider }), ...(observable.travel === undefined ? {} : { travel: observable.travel }),
  ...(measured === true && observable.basis === 'model' ? { simulated: true } : {}),
})
/** An element as a value names it: what it leads with stays in its declaration. */
const named = ({ id, class: kind, label, shortLabel, group, parent }: VignetteElement): VignetteElement =>
  ({ id, class: kind, label, ...(shortLabel === undefined ? {} : { shortLabel }), ...(group === undefined ? {} : { group }), ...(parent === undefined ? {} : { parent }) })

/** The devices an element bundles (a vessel's relief and block valves): the declared elements naming it as their parent. */
export const bundledDevices = async (run: SearchRun, objectId: string, elementId: string): Promise<ReadonlyArray<VignetteElement>> =>
  ((await declarationOf(run, objectId))?.elements ?? []).filter(element => element.parent === elementId).map(named)
