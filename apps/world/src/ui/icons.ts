import common from '../core/map-symbols/common.json'
export type IconName = keyof typeof common
export const isIconName = (name: string): name is IconName => Object.hasOwn(common, name)
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
export const iconHtml = (name: IconName, options: { size?: number; className?: string; title?: string } = {}): string => {
  const size = options.size ?? 20
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="${escape(options.className ?? '')}">${options.title ? '<title>' + escape(options.title) + '</title>' : ''}${common[name]}</svg>`
}
export const iconSvgDataUrl = (name: IconName, options: { stroke: string; size?: number; strokeWidth?: number }): string =>
  'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${options.size ?? 40}" height="${options.size ?? 40}" viewBox="0 0 24 24" fill="none" stroke="${escape(options.stroke)}" stroke-width="${options.strokeWidth ?? 2.2}" stroke-linecap="round" stroke-linejoin="round">${common[name]}</svg>`)
