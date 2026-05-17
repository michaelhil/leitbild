import type { Map as MapLibreMap } from 'maplibre-gl'
import { iconSvgDataUrl, type IconName } from './icons.ts'
import { statusToneColor } from './status-presentation.ts'

export const registerMapIcon = async (
  map: MapLibreMap,
  iconId: string,
  iconName: IconName,
  color: string,
): Promise<void> => {
  if (map.hasImage(iconId)) return
  const image = new Image(40, 40)
  image.src = iconSvgDataUrl(iconName, { stroke: color, size: 40, strokeWidth: 2.4 })
  await image.decode()
  map.addImage(iconId, image, { pixelRatio: 2 })
}

export const registerObjectIconVariants = async (map: MapLibreMap, iconName: IconName): Promise<void> => {
  await registerMapIcon(map, `object-${iconName}-ready`, iconName, statusToneColor('ready'))
  await registerMapIcon(map, `object-${iconName}-working`, iconName, statusToneColor('working'))
  await registerMapIcon(map, `object-${iconName}-error`, iconName, statusToneColor('error'))
  await registerMapIcon(map, `object-${iconName}-idle`, iconName, statusToneColor('idle'))
}
