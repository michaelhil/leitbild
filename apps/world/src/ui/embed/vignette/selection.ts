// How a part of a vignette asks its drawing to show an element (plan v5 §3, W2.5, W3.1): an alert row, a chip or a
// tile names the element, and the drawing that draws it answers. 'select' outlines the drawn item and opens its
// faceplate (L2); 'detail' opens the element's default as the next deck entry (L3). Each vignette is its own document,
// so the listeners are its own drawings.

export interface ElementRequest {
  readonly objectId: string
  readonly elementId: string
  readonly how: 'select' | 'detail'
}

/** A drawing's answer: true where it draws the element and has shown it. */
type Listener = (request: ElementRequest) => boolean

const listeners = new Set<Listener>()

/** A drawing listens while it is mounted; the returned function stops it. */
export const onElementRequest = (listener: Listener): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Asks this vignette's drawings to show the element; false where none draws it (the caller then opens its detail). */
export const requestElement = (request: ElementRequest): boolean => [...listeners].some(listener => listener(request))

/** The elements a pressed alert tile points out on a drawing of their object (W2.2); null clears them. */
export interface ElementMarks { readonly objectId: string; readonly elementIds: ReadonlyArray<string> }
const markers = new Set<(marks: ElementMarks | null) => void>()

/** A drawing marks what it is told while it is mounted; the returned function stops it. */
export const onElementMarks = (marker: (marks: ElementMarks | null) => void): (() => void) => {
  markers.add(marker)
  return () => { markers.delete(marker) }
}

/** Points out these elements on this vignette's drawings (the activated mark), or clears them with null. */
export const markElements = (marks: ElementMarks | null): void => { for (const marker of markers) marker(marks) }
