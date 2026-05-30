export type LeitbildIconMapping = Record<string, {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly anchorX: number
  readonly anchorY: number
  readonly mask: boolean
}>

export type LeitbildSymbolId =
  | 'ambulance'
  | 'hospital'
  | 'incident'
  | 'traffic'
  | 'weather'
  | 'plant'
  | 'aircraft'
  | 'grid'
  | 'generator'
  | 'substation'
  | 'load'
  | 'storage'
  | 'generic-object'
  | 'plus'
  | 'stop'
  | 'unknown'

export interface LeitbildSymbolDefinition {
  readonly id: LeitbildSymbolId
  readonly label: string
  readonly defaultSizePx: number
  readonly canRotate: boolean
}

const symbolIds: ReadonlyArray<LeitbildSymbolId> = [
  'ambulance',
  'hospital',
  'incident',
  'traffic',
  'weather',
  'plant',
  'aircraft',
  'grid',
  'generator',
  'substation',
  'load',
  'storage',
  'generic-object',
  'plus',
  'stop',
  'unknown',
]

export const leitbildSymbolDefinitions: ReadonlyArray<LeitbildSymbolDefinition> = symbolIds.map(id => ({
  id,
  label: id.replaceAll('-', ' '),
  defaultSizePx: id === 'aircraft' ? 24 : id === 'incident' ? 25 : 23,
  canRotate: id === 'aircraft',
}))

export const leitbildSymbolIds = new Set<string>(symbolIds)

export const normalizeSymbolId = (icon: string): LeitbildSymbolId => {
  if (icon === 'crash') return 'incident'
  if (icon === 'line') return 'grid'
  if (icon === 'facility') return 'generic-object'
  if (leitbildSymbolIds.has(icon)) return icon as LeitbildSymbolId
  return 'unknown'
}

export const symbolSizePx = (symbolId: string): number =>
  leitbildSymbolDefinitions.find(symbol => symbol.id === normalizeSymbolId(symbolId))?.defaultSizePx ?? 23

const cell = 64
const atlasColumns = 8
const atlasRows = 2

const iconShape = (id: LeitbildSymbolId, x: number, y: number): string => {
  const tx = x + 8
  const ty = y + 8
  const path = (d: string): string => `<path d="${d}"/>`
  const circle = (cx: number, cy: number, r: number): string => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`
  const rect = (rx: number, ry: number, width: number, height: number, radius = 4): string =>
    `<rect x="${rx}" y="${ry}" width="${width}" height="${height}" rx="${radius}"/>`
  const group = (inner: string): string =>
    `<g transform="translate(${tx} ${ty})" fill="#fff" stroke="#fff" stroke-width="0" fill-rule="evenodd">${inner}</g>`

  switch (id) {
    case 'ambulance':
      return group(`${rect(3, 19, 36, 18, 3)}${rect(31, 25, 14, 12, 2)}${circle(13, 41, 5)}${circle(38, 41, 5)}${rect(14, 23, 4, 10, 1)}${rect(11, 26, 10, 4, 1)}`)
    case 'hospital':
      return group(`${rect(8, 5, 32, 42, 4)}${rect(20, 12, 8, 22, 1)}${rect(13, 19, 22, 8, 1)}${rect(15, 36, 6, 6, 1)}${rect(27, 36, 6, 6, 1)}`)
    case 'incident':
      return group(path('M24 2 30 17 46 10 36 25 49 34 33 33 28 49 21 34 4 37 17 25 6 11 22 17Z'))
    case 'traffic':
      return group(`${circle(24, 24, 10)}${rect(21, 2, 6, 13, 3)}${rect(21, 33, 6, 13, 3)}${rect(2, 21, 13, 6, 3)}${rect(33, 21, 13, 6, 3)}`)
    case 'weather':
      return group(path('M18 39H37C43 39 48 34 48 28 48 22 44 17 38 16 35 9 29 5 21 6 12 7 6 14 6 23 6 32 10 39 18 39ZM13 43H17V49H13ZM24 43H28V49H24ZM35 43H39V49H35Z'))
    case 'plant':
      return group(path('M5 46H46V12H36V30L25 23V30L14 23V46H5ZM12 12H22V21L12 15V12ZM33 10H43V6H33V10Z'))
    case 'aircraft':
      return group(path('M26 3 31 21 47 31 45 38 30 33 27 47 21 47 18 33 3 38 1 31 17 21 22 3Z'))
    case 'grid':
      return group(`${rect(6, 7, 8, 8, 4)}${rect(34, 7, 8, 8, 4)}${rect(6, 33, 8, 8, 4)}${rect(34, 33, 8, 8, 4)}${rect(13, 10, 22, 3, 1)}${rect(13, 36, 22, 3, 1)}${rect(9, 14, 3, 20, 1)}${rect(37, 14, 3, 20, 1)}`)
    case 'generator':
      return group(`${circle(24, 24, 20)}${path('M18 35 24 12 31 35H18Z')}${circle(24, 24, 6)}`)
    case 'substation':
      return group(`${rect(7, 9, 34, 30, 3)}${rect(14, 15, 5, 18, 2)}${rect(22, 15, 5, 18, 2)}${rect(30, 15, 5, 18, 2)}${rect(11, 39, 4, 7, 1)}${rect(33, 39, 4, 7, 1)}`)
    case 'load':
      return group(`${rect(10, 12, 28, 26, 4)}${rect(16, 18, 16, 6, 2)}${rect(16, 29, 16, 4, 2)}${path('M17 12V6H31V12Z')}`)
    case 'storage':
      return group(`${rect(8, 12, 34, 25, 5)}${rect(42, 20, 5, 9, 2)}${rect(13, 17, 19, 15, 3)}`)
    case 'generic-object':
      return group(`${circle(24, 24, 18)}${circle(24, 24, 6)}`)
    case 'plus':
      return group(`${rect(21, 8, 6, 32, 2)}${rect(8, 21, 32, 6, 2)}`)
    case 'stop':
      return group(rect(9, 9, 30, 30, 4))
    case 'unknown':
      return group(`${circle(24, 24, 19)}${path('M20 18C21 13 29 13 30 18 31 22 25 23 25 28H21C21 21 27 22 26 18 25 15 21 15 20 19V18ZM21 34H26V39H21Z')}`)
  }
}

const atlasSvg = (): string => {
  const shapes = symbolIds.map((id, index) => {
    const x = (index % atlasColumns) * cell
    const y = Math.floor(index / atlasColumns) * cell
    return iconShape(id, x, y)
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${atlasColumns * cell}" height="${atlasRows * cell}" viewBox="0 0 ${atlasColumns * cell} ${atlasRows * cell}">${shapes}</svg>`
}

export const leitbildSymbolAtlasUrl = (): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(atlasSvg())}`

export const leitbildSymbolIconMapping = (): LeitbildIconMapping =>
  Object.fromEntries(symbolIds.map((id, index) => {
    const x = (index % atlasColumns) * cell
    const y = Math.floor(index / atlasColumns) * cell
    return [id, {
      x,
      y,
      width: cell,
      height: cell,
      anchorX: cell / 2,
      anchorY: cell / 2,
      mask: true,
    }]
  })) as LeitbildIconMapping
