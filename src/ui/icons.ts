export type IconName = 'ambulance' | 'hospital' | 'crash' | 'plus' | 'x' | 'stop' | 'traffic' | 'weather'

const paths: Readonly<Record<IconName, string>> = {
  ambulance: '<path d="M10 10H6"/><path d="M14 18V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12"/><path d="M14 9h4l3 3v6h-7"/><path d="M6 18H3"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/><path d="M8 6v4"/><path d="M6 8h4"/>',
  hospital: '<path d="M12 6v4"/><path d="M10 8h4"/><path d="M14 14h.01"/><path d="M14 18h.01"/><path d="M10 14h.01"/><path d="M10 18h.01"/><path d="M18 10h.01"/><path d="M18 14h.01"/><path d="M18 18h.01"/><path d="M6 10h.01"/><path d="M6 14h.01"/><path d="M6 18h.01"/><path d="M18 2H6a2 2 0 0 0-2 2v18h16V4a2 2 0 0 0-2-2Z"/>',
  crash: '<path d="m13 2-2 8 7-4-4 8 8-2-8 4 4 7-7-5-2 8-2-8-7 5 4-7-8-4 8 2-4-8 7 4z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  stop: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
  traffic: '<path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93 7.76 7.76"/><path d="m16.24 16.24 2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="m4.93 19.07 2.83-2.83"/><path d="m16.24 7.76 2.83-2.83"/><circle cx="12" cy="12" r="3"/>',
  weather: '<path d="M17.5 19H9a6 6 0 1 1 5.6-8.2A4.5 4.5 0 1 1 17.5 19Z"/><path d="M8 22v-1"/><path d="M12 22v-1"/><path d="M16 22v-1"/>',
}

export const isIconName = (name: string): name is IconName =>
  Object.hasOwn(paths, name)

export const iconHtml = (name: IconName, options: {
  readonly size?: number
  readonly className?: string
  readonly title?: string
} = {}): string => {
  const size = options.size ?? 20
  const cls = options.className ? ` class="${options.className}"` : ''
  const title = options.title ? `<title>${options.title}</title>` : ''
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"${cls}>${title}${paths[name]}</svg>`
}

export const iconSvgDataUrl = (name: IconName, options: {
  readonly stroke: string
  readonly size?: number
  readonly strokeWidth?: number
}): string => {
  const size = options.size ?? 40
  const strokeWidth = options.strokeWidth ?? 2.2
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${options.stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
