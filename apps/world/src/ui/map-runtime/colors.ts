import type { ColorRgba } from './types.ts'

const clampByte = (value: number): number =>
  Math.max(0, Math.min(255, Math.round(value)))

export const rgba = (red: number, green: number, blue: number, alpha = 255): ColorRgba =>
  [clampByte(red), clampByte(green), clampByte(blue), clampByte(alpha)]

export const colorWithAlpha = (color: ColorRgba, alpha: number): ColorRgba =>
  [color[0], color[1], color[2], clampByte(alpha)]

export const hexToRgba = (value: string, alpha = 255): ColorRgba => {
  const cleaned = value.trim().replace(/^#/, '')
  if (cleaned.length === 3) {
    const red = Number.parseInt(`${cleaned[0]}${cleaned[0]}`, 16)
    const green = Number.parseInt(`${cleaned[1]}${cleaned[1]}`, 16)
    const blue = Number.parseInt(`${cleaned[2]}${cleaned[2]}`, 16)
    if ([red, green, blue].every(Number.isFinite)) return rgba(red, green, blue, alpha)
  }
  if (cleaned.length === 6) {
    const red = Number.parseInt(cleaned.slice(0, 2), 16)
    const green = Number.parseInt(cleaned.slice(2, 4), 16)
    const blue = Number.parseInt(cleaned.slice(4, 6), 16)
    if ([red, green, blue].every(Number.isFinite)) return rgba(red, green, blue, alpha)
  }
  return rgba(100, 116, 139, alpha)
}

export const toneColor = (tone: string): ColorRgba => {
  if (tone === 'ready') return hexToRgba('#16834f')
  if (tone === 'working') return hexToRgba('#c17a13')
  if (tone === 'error') return hexToRgba('#c7352b')
  return hexToRgba('#667085')
}

export const white = (alpha = 255): ColorRgba =>
  rgba(255, 255, 255, alpha)

export const darkStroke = (alpha = 255): ColorRgba =>
  rgba(15, 23, 42, alpha)
