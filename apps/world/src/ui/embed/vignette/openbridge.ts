// The one loader of the OpenBridge a vignette draws, in the embed bundle only
// (D-03, T28; policy §5): the palettes' tokens (day, dusk, night by
// data-obc-theme on <html>) and every element and icon the vignette renders,
// each by a bare import, which is what defines it. A type or enum import
// beside one never stands in for it.
import '@oicl/openbridge-webcomponents/dist/openbridge.css'
// Its font, the subset whose widths the composer reserves text by.
import './noto-sans.ts'
import '@oicl/openbridge-webcomponents/dist/icons/icon-ai.js'
import '@oicl/openbridge-webcomponents/dist/building-blocks/readout-block/readout-block.js'
// A values row's declared span bar where it has no record (W4.2, W9.3).
import '@oicl/openbridge-webcomponents/dist/building-blocks/bar-horizontal/bar-horizontal.js'
// A values section's rows (W4.2): OpenBridge's readout list aligns their values and units.
import '@oicl/openbridge-webcomponents/dist/navigation-instruments/readout-list/readout-list.js'
import '@oicl/openbridge-webcomponents/dist/navigation-instruments/readout-list-item/readout-list-item.js'
import '@oicl/openbridge-webcomponents/dist/components/status-indicator/status-indicator.js'
import '@oicl/openbridge-webcomponents/dist/components/button/button.js'
import '@oicl/openbridge-webcomponents/dist/components/alert-icon/alert-icon.js'
// An alerts section's counts and tiles (W2.1, W2.2).
import '@oicl/openbridge-webcomponents/dist/components/alert-counter-item/alert-counter-item.js'
import '@oicl/openbridge-webcomponents/dist/components/alert-subsystem-counter/alert-subsystem-counter.js'
import '@oicl/openbridge-webcomponents/dist/components/badge/badge.js'
import '@oicl/openbridge-webcomponents/dist/automation/bus/bus.js'
import '@oicl/openbridge-webcomponents/dist/automation/switch/switch.js'
import '@oicl/openbridge-webcomponents/dist/automation/transformer/transformer.js'
import '@oicl/openbridge-webcomponents/dist/automation/source/source.js'
import '@oicl/openbridge-webcomponents/dist/automation/automation-button/automation-button.js'
import '@oicl/openbridge-webcomponents/dist/automation/automation-tank/automation-tank.js'
import '@oicl/openbridge-webcomponents/dist/automation/heat-exchanger/heat-exchanger.js'
import '@oicl/openbridge-webcomponents/dist/automation/valve-analoge-two-way-icon/valve-analog-two-way-icon.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-pump-on-horizontal.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-pump-off-horizontal.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-pump-static-horizontal.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-pump-on-vertical.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-pump-off-vertical.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-pump-static-vertical.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-electric-generator-ac-on.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-electric-generator-ac-off.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-electric-generator-ac-static.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-twoway-digital-static.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-switch-01-on.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-switch-01-off.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-transformer-01.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-transformer-01-on.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-transformer-01-off.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-sources-01.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-sources-01-on.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-sources-01-off.js'
// The faceplate card (W3.2, W3.3): OpenBridge's card, its pin, handle and corner, and its buttons.
import '@oicl/openbridge-webcomponents/dist/components/card/card.js'
import '@oicl/openbridge-webcomponents/dist/components/icon-button/icon-button.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-pin-google.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-pin-selected-google.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-drag-horizontal.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-resize-corner.js'
// What waits on an item (W3.6): OpenBridge's automation badge with its command request and AI pending glyphs.
import '@oicl/openbridge-webcomponents/dist/automation/automation-badge/automation-badge.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-command-request.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-ai-pending.js'
