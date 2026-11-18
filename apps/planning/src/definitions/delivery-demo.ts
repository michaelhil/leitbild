// The guided plan and its matching World scenario use the same stable Definition id.
export const deliveryDemoDefinitionId = 'halden-delivery-planning'

// Authored map links for the demo's own assets. Other World locators remain opaque to Planning.
export const deliveryDemoMapTargets = new Map([
  ['einsatz/unit/unit%3Adelivery-truck', 'unit:delivery-truck'],
  ['einsatz/task/task%3Aschool-delivery', 'task:school-delivery'],
  ['einsatz/task/task%3Asports-hall-delivery', 'task:sports-hall-delivery'],
])
