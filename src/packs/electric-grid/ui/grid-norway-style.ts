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

const voltageColorExpression: ReadonlyArray<unknown> = [
  'case',
  ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 400],
  '#c0262d',
  ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 300],
  '#b34ac0',
  ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 220],
  '#c56a00',
  ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 132],
  '#229746',
  ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 110],
  '#35a853',
  ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 66],
  '#b59a00',
  '#6f9fc7',
]

const voltageOpacityExpression: ReadonlyArray<unknown> = [
  'case',
  ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 300],
  0.94,
  ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 132],
  ['interpolate', ['linear'], ['zoom'], 5, 0.68, 9, 0.88],
  ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 66],
  ['interpolate', ['linear'], ['zoom'], 5, 0.10, 8, 0.42, 11, 0.78],
  ['interpolate', ['linear'], ['zoom'], 8, 0.00, 10, 0.28, 12, 0.58],
]

const voltageWidthExpression: ReadonlyArray<unknown> = [
  'interpolate',
  ['linear'],
  ['zoom'],
  5,
  ['case',
    ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 400], 3.4,
    ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 300], 3.0,
    ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 132], 1.7,
    0.55,
  ],
  12,
  ['case',
    ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 400], 6.0,
    ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 300], 5.2,
    ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 132], 3.2,
    ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 66], 2.0,
    1.35,
  ],
]

const siteRadiusExpression: ReadonlyArray<unknown> = [
  'interpolate',
  ['linear'],
  ['zoom'],
  7,
  ['case',
    ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 300], 4.2,
    ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 132], 3.1,
    2.0,
  ],
  13,
  ['case',
    ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 300], 6.0,
    ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 132], 4.4,
    3.0,
  ],
]

const visibleVoltageLabelExpression: ReadonlyArray<unknown> = [
  '>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 220,
]

const voltageTextExpression: ReadonlyArray<unknown> = [
  'case',
  visibleVoltageLabelExpression,
  ['concat', ['to-string', ['round', ['get', 'maxVoltageKv']]], ' kV'],
  '',
]

const siteLabelExpression: ReadonlyArray<unknown> = [
  'case',
  ['all', ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 300], ['has', 'name']],
  ['get', 'name'],
  '',
]

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
    if (category === 'line' || category === 'cable') {
      return {
        'line-color': voltageColorExpression,
        'line-opacity': [
          'case',
          ['boolean', ['feature-state', 'hover'], false],
          0.96,
          voltageOpacityExpression,
        ],
        'line-width': voltageWidthExpression,
        ...(category === 'cable' ? { 'line-dasharray': [4, 2] } : {}),
      }
    }
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
    if (category === 'substation' || category === 'transformer') {
      return {
        paint: {
          'circle-color': voltageColorExpression,
          'circle-opacity': [
            'case',
            ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 132],
            0.94,
            ['interpolate', ['linear'], ['zoom'], 8, 0.25, 12, 0.78],
          ],
          'circle-radius': siteRadiusExpression,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-opacity': 0.92,
          'circle-stroke-width': [
            'case',
            ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 300],
            1.5,
            1.0,
          ],
        },
      }
    }
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
    if (category === 'line' || category === 'cable') {
      return {
        layout: {
          'symbol-placement': 'line',
          'text-field': [
            'case',
            ['>', ['coalesce', ['get', 'maxVoltageKv'], 0], 0],
            voltageTextExpression,
            '',
          ],
          'text-size': ['interpolate', ['linear'], ['zoom'], 8, 9, 13, 11],
          'text-allow-overlap': false,
          'text-optional': true,
        },
        paint: {
          'text-color': '#283241',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.8,
        },
      }
    }
    if (category === 'unknown') return null
    const textField = category === 'substation' || category === 'transformer'
      ? siteLabelExpression
      : ['coalesce', ['get', 'name'], ['get', 'operator'], '']
    return {
      layout: {
        'text-field': textField,
        'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 13, 11.5],
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
