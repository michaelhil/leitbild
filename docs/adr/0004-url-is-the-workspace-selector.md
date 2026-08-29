# Workspace identity is selected only by the URL

Every Workspace-scoped UI, API, and realtime endpoint carries the Workspace id in its canonical path, and no cookie or process default may select or override it. This makes links deterministic and permits several Workspaces in concurrent browser tabs; future cookies may authenticate a caller but cannot determine the Workspace.
