// Aero-Norway visual style. VATSIM-Radar-inspired recipe: subtle base fill
// (~0.05–0.10 α), thin 1 px stroke, hover bump via MapLibre feature-state.
// Restricted/prohibited/danger use dashed strokes to read distinctly even at
// low zoom. Airports render as small circle markers with halo at high zoom.

import type { DatasetStyleModule } from '../../../ui/map/reference-layer-factory.ts'

interface CategoryStyle {
  readonly fillColor: string
  readonly fillOpacity: number
  readonly fillHoverOpacity: number
  readonly lineColor: string
  readonly lineOpacity: number
  readonly lineHoverOpacity: number
  readonly lineWidth: number
  readonly lineDasharray?: ReadonlyArray<number>
}

const styleByCategory: Readonly<Record<string, CategoryStyle>> = {
  fir:        { fillColor: '#334155', fillOpacity: 0.04, fillHoverOpacity: 0.10, lineColor: '#94a3b8', lineOpacity: 0.50, lineHoverOpacity: 0.85, lineWidth: 1.2 },
  uir:        { fillColor: '#334155', fillOpacity: 0.04, fillHoverOpacity: 0.10, lineColor: '#94a3b8', lineOpacity: 0.50, lineHoverOpacity: 0.85, lineWidth: 1.2 },
  cta:        { fillColor: '#0ea5e9', fillOpacity: 0.06, fillHoverOpacity: 0.18, lineColor: '#7dd3fc', lineOpacity: 0.55, lineHoverOpacity: 0.85, lineWidth: 1.0 },
  tma:        { fillColor: '#0ea5e9', fillOpacity: 0.06, fillHoverOpacity: 0.18, lineColor: '#7dd3fc', lineOpacity: 0.55, lineHoverOpacity: 0.85, lineWidth: 1.0 },
  ctr:        { fillColor: '#38bdf8', fillOpacity: 0.08, fillHoverOpacity: 0.22, lineColor: '#bae6fd', lineOpacity: 0.65, lineHoverOpacity: 0.85, lineWidth: 1.0 },
  atz:        { fillColor: '#7dd3fc', fillOpacity: 0.06, fillHoverOpacity: 0.18, lineColor: '#e0f2fe', lineOpacity: 0.55, lineHoverOpacity: 0.85, lineWidth: 0.8 },
  restricted: { fillColor: '#dc2626', fillOpacity: 0.10, fillHoverOpacity: 0.25, lineColor: '#fca5a5', lineOpacity: 0.70, lineHoverOpacity: 0.90, lineWidth: 1.2 },
  prohibited: { fillColor: '#991b1b', fillOpacity: 0.14, fillHoverOpacity: 0.30, lineColor: '#dc2626', lineOpacity: 0.80, lineHoverOpacity: 0.95, lineWidth: 1.6, lineDasharray: [4, 2] },
  danger:     { fillColor: '#f59e0b', fillOpacity: 0.10, fillHoverOpacity: 0.25, lineColor: '#fcd34d', lineOpacity: 0.70, lineHoverOpacity: 0.90, lineWidth: 1.2, lineDasharray: [8, 5] },
  warning:    { fillColor: '#fbbf24', fillOpacity: 0.08, fillHoverOpacity: 0.22, lineColor: '#fde68a', lineOpacity: 0.60, lineHoverOpacity: 0.85, lineWidth: 1.0 },
  rmz:        { fillColor: '#8b5cf6', fillOpacity: 0.06, fillHoverOpacity: 0.18, lineColor: '#c4b5fd', lineOpacity: 0.55, lineHoverOpacity: 0.85, lineWidth: 1.0, lineDasharray: [6, 4] },
  tmz:        { fillColor: '#a78bfa', fillOpacity: 0.06, fillHoverOpacity: 0.18, lineColor: '#ddd6fe', lineOpacity: 0.55, lineHoverOpacity: 0.85, lineWidth: 1.0, lineDasharray: [6, 4] },
  matz:       { fillColor: '#8b5cf6', fillOpacity: 0.06, fillHoverOpacity: 0.18, lineColor: '#c4b5fd', lineOpacity: 0.55, lineHoverOpacity: 0.85, lineWidth: 1.0, lineDasharray: [6, 4] },
  training:   { fillColor: '#a855f7', fillOpacity: 0.08, fillHoverOpacity: 0.22, lineColor: '#d8b4fe', lineOpacity: 0.60, lineHoverOpacity: 0.85, lineWidth: 1.0, lineDasharray: [6, 4] },
  exclusion:  { fillColor: '#dc2626', fillOpacity: 0.12, fillHoverOpacity: 0.28, lineColor: '#fca5a5', lineOpacity: 0.75, lineHoverOpacity: 0.92, lineWidth: 1.4, lineDasharray: [2, 2] },
  reference:  { fillColor: '#64748b', fillOpacity: 0.05, fillHoverOpacity: 0.15, lineColor: '#cbd5e1', lineOpacity: 0.50, lineHoverOpacity: 0.80, lineWidth: 0.8, lineDasharray: [3, 3] },
}

const airportStyle = {
  circleColor: '#0284c7',
  circleHaloColor: '#bae6fd',
  circleRadius: 5,
  circleHaloWidth: 1.5,
  labelColor: '#0c4a6e',
  labelHaloColor: '#ffffff',
}

const DEFAULT_CATEGORY_STYLE: CategoryStyle = {
  fillColor: '#94a3b8',
  fillOpacity: 0.05,
  fillHoverOpacity: 0.15,
  lineColor: '#cbd5e1',
  lineOpacity: 0.50,
  lineHoverOpacity: 0.80,
  lineWidth: 0.8,
}

export const aeroNorwayStyleModule: DatasetStyleModule = {
  outputLayer: 'aero',
  fillFor: (category) => {
    const s = styleByCategory[category] ?? DEFAULT_CATEGORY_STYLE
    return {
      'fill-color': s.fillColor,
      'fill-opacity': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        s.fillHoverOpacity,
        s.fillOpacity,
      ],
    }
  },
  lineFor: (category) => {
    const s = styleByCategory[category] ?? DEFAULT_CATEGORY_STYLE
    const paint: Record<string, unknown> = {
      'line-color': s.lineColor,
      'line-opacity': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        s.lineHoverOpacity,
        s.lineOpacity,
      ],
      'line-width': s.lineWidth,
    }
    if (s.lineDasharray) paint['line-dasharray'] = s.lineDasharray
    return paint
  },
  pointFor: (category) => {
    if (category !== 'airport') return null
    return {
      paint: {
        'circle-color': airportStyle.circleColor,
        'circle-radius': airportStyle.circleRadius,
        'circle-stroke-color': airportStyle.circleHaloColor,
        'circle-stroke-width': airportStyle.circleHaloWidth,
      },
    }
  },
  labelFor: (category) => {
    if (category !== 'airport') return null
    return {
      layout: {
        'text-field': ['coalesce', ['get', 'icao'], ['get', 'name']],
        'text-size': 11,
        'text-offset': [0, 1.2],
        'text-anchor': 'top',
        'text-allow-overlap': false,
        'text-optional': true,
      },
      paint: {
        'text-color': airportStyle.labelColor,
        'text-halo-color': airportStyle.labelHaloColor,
        'text-halo-width': 1.2,
      },
    }
  },
}
