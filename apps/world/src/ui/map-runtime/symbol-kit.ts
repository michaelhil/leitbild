import common from '../../core/map-symbols/common.json'

export type LeitbildSymbolId = keyof typeof common
export type LeitbildIconMapping = Record<string, { x: number; y: number; width: number; height: number; anchorX: number; anchorY: number; mask: boolean }>
const symbolIds = Object.keys(common) as LeitbildSymbolId[]
export const leitbildSymbolDefinitions = symbolIds.map(id => ({ id, label: id.replaceAll('-', ' '), defaultSizePx: 23 }))
export const leitbildSymbolIds = new Set<string>(symbolIds)
export const normalizeSymbolId = (icon: string): LeitbildSymbolId => {
  if (!leitbildSymbolIds.has(icon)) throw new Error('Unknown operational map icon: ' + icon)
  return icon as LeitbildSymbolId
}
export const symbolSizePx = (_symbolId: string): number => 23
const cell = 64, columns = 8
export const leitbildSymbolAtlasUrl = (): string => {
  const body = symbolIds.map((id, index) => `<g transform="translate(${index % columns * cell + 8} ${Math.floor(index / columns) * cell + 8}) scale(2)" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${common[id]}</g>`).join('')
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${columns * cell}" height="${Math.ceil(symbolIds.length / columns) * cell}">${body}</svg>`)
}
export const leitbildSymbolIconMapping = (): LeitbildIconMapping => Object.fromEntries(symbolIds.map((id, index) => [id, { x: index % columns * cell, y: Math.floor(index / columns) * cell, width: cell, height: cell, anchorX: cell / 2, anchorY: cell / 2, mask: true }]))
