/** Pixel scans of a screenshot for the rendering matrix (plan v5 §5.5 "Colour at rest": a pixel scan of Run B finds
 * no alarm, warning or caution colour). The PNG is decoded and scanned in a blank tab of the same headless Chrome
 * (createImageBitmap, OffscreenCanvas), so no image library is needed and nothing is drawn in the app's tabs. */
import type { Page } from './browser.ts'

export interface ColourHit { readonly colour: string; readonly pixels: number; readonly cells: ReadonlyArray<{ readonly x: number; readonly y: number; readonly pixels: number }> }

const rgbOf = (css: string): [number, number, number] | null => {
  const parts = css.match(/[\d.]+/g)
  return parts === null || parts.length < 3 ? null : [Number(parts[0]), Number(parts[1]), Number(parts[2])]
}

/** Counts the pixels of `rect` (page px) within `tolerance` of each named colour, in 16 px cells (page coordinates). */
export const colourScan = async (scratch: Page, pngBase64: string, rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }, colours: Readonly<Record<string, string>>, tolerance = 10): Promise<ReadonlyArray<ColourHit>> => {
  const targets = Object.entries(colours).map(([name, css]) => ({ name, rgb: rgbOf(css) })).filter((entry): entry is { name: string; rgb: [number, number, number] } => entry.rgb !== null)
  return scratch.eval<ReadonlyArray<ColourHit>>(`(async () => {
    const rect = ${JSON.stringify({ x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), w: Math.round(rect.w), h: Math.round(rect.h) })}
    const targets = ${JSON.stringify(targets)}
    const tolerance = ${tolerance}
    const bytes = Uint8Array.from(atob(${JSON.stringify(pngBase64)}), c => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const w = Math.min(rect.w, bitmap.width - rect.x), h = Math.min(rect.h, bitmap.height - rect.y)
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, -rect.x, -rect.y)
    const data = ctx.getImageData(0, 0, w, h).data
    return targets.map(target => {
      let pixels = 0
      const cells = new Map()
      for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4
        if (Math.abs(data[i] - target.rgb[0]) <= tolerance && Math.abs(data[i + 1] - target.rgb[1]) <= tolerance && Math.abs(data[i + 2] - target.rgb[2]) <= tolerance) {
          pixels += 1
          const key = Math.floor((rect.x + x) / 16) * 16 + ',' + Math.floor((rect.y + y) / 16) * 16
          cells.set(key, (cells.get(key) || 0) + 1)
        }
      }
      const top = [...cells.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key, n]) => ({ x: Number(key.split(',')[0]), y: Number(key.split(',')[1]), pixels: n }))
      return { colour: target.name, pixels, cells: top }
    })
  })()`)
}
