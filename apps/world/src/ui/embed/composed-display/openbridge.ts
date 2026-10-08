// OpenBridge web components used by composed displays. Importing a module
// registers its custom element; Svelte then sets properties, not attributes,
// because the element is defined before the first render. The global stylesheet
// carries the day/night palettes selected by data-obc-theme on <html>.
import '@oicl/openbridge-webcomponents/dist/openbridge.css'
import '@oicl/openbridge-webcomponents/dist/navigation-instruments/readout/readout.js'
