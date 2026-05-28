import type { DatasetStyleModule } from '../../../ui/map/reference-layer-factory.ts'

interface GridCategoryStyle {
  readonly fillColor: string
  readonly fillOpacity: number
  readonly lineColor: string
  readonly lineOpacity: number
  readonly lineWidth: number
  readonly circleColor: string
  readonly circleRadius: number
}

const styles: Readonly<Record<string, GridCategoryStyle>> = {
  line:        { fillColor: '#64748b', fillOpacity: 0.00, lineColor: '#64748b', lineOpacity: 0.70, lineWidth: 1.6, circleColor: '#64748b', circleRadius: 3.5 },
  cable:       { fillColor: '#0f766e', fillOpacity: 0.00, lineColor: '#0f766e', lineOpacity: 0.70, lineWidth: 1.4, circleColor: '#0f766e', circleRadius: 3.5 },
  substation:  { fillColor: '#475569', fillOpacity: 0.10, lineColor: '#334155', lineOpacity: 0.75, lineWidth: 1.2, circleColor: '#475569', circleRadius: 5.0 },
  transformer: { fillColor: '#7c3aed', fillOpacity: 0.07, lineColor: '#7c3aed', lineOpacity: 0.65, lineWidth: 1.0, circleColor: '#7c3aed', circleRadius: 4.2 },
  plant:       { fillColor: '#15803d', fillOpacity: 0.08, lineColor: '#166534', lineOpacity: 0.70, lineWidth: 1.0, circleColor: '#15803d', circleRadius: 5.0 },
  generator:   { fillColor: '#16a34a', fillOpacity: 0.08, lineColor: '#15803d', lineOpacity: 0.65, lineWidth: 1.0, circleColor: '#16a34a', circleRadius: 4.5 },
  load:        { fillColor: '#2563eb', fillOpacity: 0.07, lineColor: '#1d4ed8', lineOpacity: 0.65, lineWidth: 1.0, circleColor: '#2563eb', circleRadius: 4.0 },
  unknown:     { fillColor: '#94a3b8', fillOpacity: 0.05, lineColor: '#94a3b8', lineOpacity: 0.35, lineWidth: 0.8, circleColor: '#94a3b8', circleRadius: 3.0 },
}

const styleFor = (category: string): GridCategoryStyle => styles[category] ?? styles.unknown!

export const gridNorwayStyleModule: DatasetStyleModule = {
  outputLayer: 'grid',
  fillFor: (category) => {
    const style = styleFor(category)
    return {
      'fill-color': style.fillColor,
      'fill-opacity': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        Math.min(0.22, style.fillOpacity + 0.10),
        style.fillOpacity,
      ],
    }
  },
  lineFor: (category) => {
    const style = styleFor(category)
    return {
      'line-color': style.lineColor,
      'line-opacity': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        Math.min(0.95, style.lineOpacity + 0.20),
        style.lineOpacity,
      ],
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        5,
        style.lineWidth,
        12,
        style.lineWidth * 1.8,
      ],
      ...(category === 'cable' ? { 'line-dasharray': [4, 3] } : {}),
    }
  },
  pointFor: (category) => {
    if (category === 'line' || category === 'cable') return null
    const style = styleFor(category)
    return {
      paint: {
        'circle-color': style.circleColor,
        'circle-radius': style.circleRadius,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.2,
      },
    }
  },
  labelFor: (category) => {
    if (category === 'line' || category === 'cable' || category === 'unknown') return null
    return {
      layout: {
        'text-field': ['coalesce', ['get', 'name'], ['get', 'externalId']],
        'text-size': 11,
        'text-offset': [0, 1.15],
        'text-anchor': 'top',
        'text-allow-overlap': false,
        'text-optional': true,
      },
      paint: {
        'text-color': '#172033',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.4,
      },
    }
  },
}
