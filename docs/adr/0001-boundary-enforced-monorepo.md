# Use a boundary-enforced monorepo

Samsinn, Leitbild, the optional suite, and their wire contracts live in one repository so coordinated contract and deployment changes can be tested atomically. They remain independently versioned and deployable, may not import each other, and share only the contracts package; this avoids polyrepo version choreography without creating one application runtime.
