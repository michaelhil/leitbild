# Samsinn–Leitbild Workspace walkthrough

This walkthrough creates one shared Workspace, provisions it in both applications, starts a Leitbild Simulation Run, and binds a Samsinn Room and Agent to that Run.

Set the application origins:

```sh
SAMSINN=https://samsinn.app
LEITBILD=https://leitbild.samsinn.app
```

If Samsinn uses shared-token auth, authenticate first and add `-b "$COOKIE_JAR"` to the Samsinn calls below.

## 1. Create one Workspace identity

```sh
WORKSPACE_ID=$(curl -fsS -X POST "$SAMSINN/api/workspaces" \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"Integrated Exercise"}' | jq -r '.workspace.id')
```

Create the complete Module Binding set and PUT the same metadata into both applications:

```sh
WORKSPACE_BODY=$(jq -n \
  --arg samsinn "$SAMSINN" \
  --arg leitbild "$LEITBILD" \
  '{
    displayName: "Integrated Exercise",
    modules: [
      {
        moduleId: "samsinn",
        baseUrl: $samsinn,
        discoveryUrl: ($samsinn + "/.well-known/samsinn")
      },
      {
        moduleId: "leitbild",
        baseUrl: $leitbild,
        discoveryUrl: ($leitbild + "/.well-known/leitbild")
      }
    ]
  }')

curl -fsS -X PUT "$SAMSINN/api/workspaces/$WORKSPACE_ID" \
  -H 'Content-Type: application/json' -d "$WORKSPACE_BODY"

curl -fsS -X PUT "$LEITBILD/api/workspaces/$WORKSPACE_ID" \
  -H 'Content-Type: application/json' -d "$WORKSPACE_BODY"
```

The optional suite performs exactly this coordination automatically. It stores only Workspace metadata, Module Bindings, and provisioning status.

## 2. Create a Simulation Run

List the Workspace's available Scenarios, then start one immutable revision:

```sh
curl -fsS "$LEITBILD/api/workspaces/$WORKSPACE_ID/scenarios" | jq

RUN_ID=$(curl -fsS -X POST \
  "$LEITBILD/api/workspaces/$WORKSPACE_ID/simulation-runs" \
  -H 'Content-Type: application/json' \
  -d '{"scenarioId":"oslo-ambulance"}' | jq -r '.id')
```

`RUN_ID` is an opaque `run-<uuid>`. The Run manifest pins the Scenario Revision and active Pack/runtime versions.

## 3. Create and bind a Samsinn Room

```sh
SCOPE="$SAMSINN/api/workspaces/$WORKSPACE_ID"

curl -fsS -X POST "$SCOPE/rooms" \
  -H 'Content-Type: application/json' \
  -d '{"name":"dispatch"}'

curl -fsS -X PUT "$SCOPE/rooms/dispatch/leitbild-mirror" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg run "$RUN_ID" '{simulationRunId:$run,format:"summary"}')"
```

The Room stores only `simulationRunId` and mirror format. It resolves the Leitbild origin from the Workspace Module Binding.

## 4. Create a Run-aware Agent

```sh
curl -fsS -X POST "$SCOPE/agents" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg run "$RUN_ID" '{
    name: "DispatchSpecialist",
    model: "gpt-5.4",
    persona: "Monitor the operation and advise the dispatcher concisely.",
    tools: ["lb_state","lb_object","lb_query","lb_scenario","lb_command"],
    leitbildBinding: {simulationRunId:$run,role:"operator"}
  }')"

curl -fsS -X POST "$SCOPE/rooms/dispatch/members" \
  -H 'Content-Type: application/json' \
  -d '{"agentName":"DispatchSpecialist"}'
```

Use role `observer` to omit mutation authority. The Agent binding also contains no base URL; topology remains Workspace-owned.

## 5. Verify the integration

```sh
curl -fsS "$LEITBILD/api/workspaces/$WORKSPACE_ID/simulation-runs/$RUN_ID/capabilities" | jq
curl -fsS "$SCOPE/rooms/dispatch/leitbild-mirror" | jq
curl -fsS "$SCOPE/agents/DispatchSpecialist" | jq '{leitbildBinding,tools}'
```

Leitbild events now enter the Room in sequence. Direct Agent tools read the same Run through discovery-advertised links. Reset is an explicit event boundary that causes the integration to refetch the snapshot before resuming.

## Share links

- Samsinn Workspace: `$SAMSINN/workspaces/$WORKSPACE_ID`
- Leitbild Workspace: `$LEITBILD/workspaces/$WORKSPACE_ID`
- Leitbild Run: `$LEITBILD/workspaces/$WORKSPACE_ID/simulation-runs/$RUN_ID`

Each application remains usable at its direct link if the suite is offline.
