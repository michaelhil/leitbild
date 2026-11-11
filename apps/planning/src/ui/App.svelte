<script lang="ts">
  import { resourceCatalogChangedMessageSchema } from '@leitbild/contracts'
  import { createPlanningClient } from './api.ts'
  import Library from './Library.svelte'
  import PlanScreen from './PlanScreen.svelte'

  // Planning inside the Workspace page: /workspaces/<id>/planning shows the plans; ?plan=<id> one plan.
  // Moving between them goes through the Workspace URL, so the Host keeps the selection in its own path.
  const match = location.pathname.match(/^\/workspaces\/([^/]+)\/planning$/)
  if (!match?.[1]) throw new Error('Planning opens inside a Workspace')
  const workspaceId = decodeURIComponent(match[1])
  const planId = new URLSearchParams(location.search).get('plan')
  const client = createPlanningClient(workspaceId)
  const host = window.parent === window ? window : window.parent
  const workspaceHref = (planning?: string) => `/workspaces/${encodeURIComponent(workspaceId)}${planning === undefined ? '' : `?planning=${encodeURIComponent(planning)}`}`

  const changed = (): void => {
    if (planId === null || window.parent === window) return
    window.parent.postMessage(resourceCatalogChangedMessageSchema.parse({
      type: 'leitbild:resource-catalog-changed',
      resource: client.planRef(planId),
    }), location.origin)
  }
  const go = (href: string): void => { host.location.assign(href) }
</script>

{#if planId === null}
  <Library {client} onOpen={(plan) => go(workspaceHref(plan))} />
{:else}
  <PlanScreen {client} {planId} onChanged={changed} onOpenWorkspace={() => go(workspaceHref())} onOpenLibrary={() => go(workspaceHref('library'))} />
{/if}

<style>
  :global {
    * { box-sizing: border-box; }
    :root {
      --ink: #1f3530; --ink-2: #4d6359; --ink-3: #6b7d73; --paper: #f6f7f3; --card: #ffffff; --line: #d9e2d8; --line-2: #edf1eb;
      --accent: #285e4d; --accent-2: #edf4ed; --focus: #b5652f;
      --rule: #5a2f2f; --rule-bg: #f6eaea; --estimate: #3d5a80; --estimate-bg: #e9eff7; --unknown: #6d5a1e; --unknown-bg: #fbf3d9;
      --assumption: #7a4a12; --assumption-bg: #fdf0e1; --world: #1f5a6b; --world-bg: #e5f2f5; --good: #255d3b; --good-bg: #e6f3ea; --warning: #7a4a12; --warning-bg: #fff3e0;
      --refusal: #8c2f20; --refusal-bg: #fbe9e5;
    }
    body { margin: 0; color: var(--ink); background: var(--paper); font-family: Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.5; }
    button, input, select, textarea { font: inherit; color: inherit; }
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, a:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
    h1, h2, h3, p { margin-top: 0; }
    h1 { font-size: clamp(22px, 2.2vw, 30px); line-height: 1.2; margin-bottom: 6px; font-weight: 600; }
    h2 { font-size: 16px; margin-bottom: 10px; font-weight: 600; }
    h3 { font-size: 13px; margin: 14px 0 6px; font-weight: 600; }
    button { cursor: pointer; min-height: 36px; padding: 6px 11px; background: var(--card); border: 1px solid #c4d1c7; border-radius: 6px; font-weight: 500; }
    button:hover:not(:disabled) { background: var(--accent-2); }
    button:disabled { opacity: .55; cursor: default; }
    button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
    button.quiet { min-height: 28px; padding: 2px 8px; font-size: 12px; }
    button.link { border: 0; background: none; padding: 0; min-height: 0; color: var(--accent); text-decoration: underline; text-underline-offset: 3px; text-align: left; }
    input, select, textarea { width: 100%; min-width: 0; padding: 7px 9px; border: 1px solid #c4d1c7; border-radius: 5px; background: #fff; }
    input[type='checkbox'], input[type='radio'] { width: 16px; height: 16px; margin: 0 6px 0 0; accent-color: var(--accent); }
    label { display: grid; gap: 4px; font-size: 12px; font-weight: 500; margin-bottom: 8px; }
    label.inline { display: flex; align-items: center; font-weight: 400; }
    fieldset { border: 0; padding: 0; margin: 0 0 8px; min-width: 0; }
    legend { font-size: 12px; font-weight: 600; margin-bottom: 6px; padding: 0; }
    small { display: block; color: var(--ink-3); font-size: 11px; font-weight: 400; }
    .hint { color: var(--ink-3); font-size: 12px; }
    .error { padding: 10px 12px; border-radius: 6px; border: 1px solid #e5c3b9; background: var(--refusal-bg); color: var(--refusal); }
    .notice { padding: 8px 12px; border-left: 3px solid var(--accent); background: var(--accent-2); font-size: 13px; }
    .loading { margin: 24px; color: var(--ink-3); }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .field-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .problems { color: var(--refusal); font-size: 12px; padding-left: 18px; }

    .mark { display: inline-flex; gap: 3px; align-items: center; white-space: nowrap; font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 4px; border: 1px solid currentColor; }
    .mark-plain { color: var(--ink-2); }
    .mark-rule { color: var(--rule); background: var(--rule-bg); border-radius: 0; }
    .mark-estimate { color: var(--estimate); background: var(--estimate-bg); border-style: dashed; }
    .mark-unknown { color: var(--unknown); background: var(--unknown-bg); border-style: dotted; }
    .mark-assumption { color: var(--assumption); background: var(--assumption-bg); border-style: dashed; }
    .mark-world { color: var(--world); background: var(--world-bg); border-radius: 9px; }
    .mark-good { color: var(--good); background: var(--good-bg); }
    .mark-warning { color: var(--warning); background: var(--warning-bg); }
    .mark-refusal { color: var(--refusal); background: var(--refusal-bg); border-width: 2px; }

    .library { max-width: 1060px; margin: 24px auto; padding: 0 16px; }
    .eyebrow { color: var(--ink-3); text-transform: uppercase; letter-spacing: .09em; font-size: 10px; font-weight: 700; }
    .intro { font-size: 16px; color: var(--ink-2); max-width: 720px; }
    .demo-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin: 20px 0 28px; }
    .demo-card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 20px; display: flex; flex-direction: column; align-items: flex-start; }
    .demo-card p { color: var(--ink-2); flex: 1; }
    .plan-list { list-style: none; padding: 0; }
    .plan-list li { border-top: 1px solid var(--line); padding: 12px 0; }

    .plan-screen { max-width: 1800px; margin: 0 auto; padding: 16px 20px 40px; }
    .back { margin-bottom: 8px; font-size: 12px; }
    .plan-header { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
    .plan-header .title-block { max-width: 760px; }
    .plan-header .purpose { color: var(--ink-2); }
    .plan-header .generate { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; max-width: 520px; }
    .screen-grid { display: grid; grid-template-columns: 320px minmax(0, 1fr) 340px; gap: 16px; align-items: start; }
    .col-attention, .col-main, .col-panel { min-width: 0; display: grid; gap: 16px; }
    .attention, .work-list, .options, .rules, .crews, .picker, .authoring, .job-panel, .preview, .shift-list, .shown-option, .timeline {
      background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 14px;
    }
    .cards { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
    .card { border: 1px solid var(--line); border-radius: 6px; padding: 10px; }
    .card-title { font-weight: 600; margin: 6px 0 4px; }
    .card-text { color: var(--ink-2); font-size: 13px; margin-bottom: 6px; }
    .card-steps { font-size: 12px; padding-left: 18px; margin: 0 0 8px; }
    .card-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .finish { margin-top: 14px; }
    .chain { padding-left: 18px; font-size: 13px; }
    .chain .when { color: var(--ink-3); margin-left: 4px; }
    .chain .because { display: block; color: var(--ink-2); }
    .views { display: flex; flex-wrap: wrap; gap: 6px; }
    .views button.current { background: var(--accent); color: #fff; border-color: var(--accent); }
    .status-line { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
    .goals { padding-left: 18px; font-size: 13px; }
    .goals .distance { color: var(--ink-3); }
    .details { padding-left: 18px; font-size: 13px; }
    .beside, .stale { font-size: 12px; }

    .timeline { overflow-x: auto; }
    .lane, .axis { display: grid; grid-template-columns: 220px minmax(520px, 1fr); gap: 8px; align-items: center; min-height: 26px; border-bottom: 1px solid var(--line-2); }
    .axis { border-bottom: 1px solid var(--line); font-size: 10px; color: var(--ink-3); min-height: 30px; }
    .lane-heading { margin: 12px 0 4px; }
    .lane-label { font-size: 11px; overflow: hidden; text-overflow: ellipsis; }
    .lane-label small { white-space: normal; }
    .track { position: relative; display: block; height: 22px; }
    .axis .track { height: 28px; }
    .tick { position: absolute; top: 4px; transform: translateX(-50%); white-space: nowrap; border-left: 1px solid var(--line); padding-left: 3px; transform: none; }
    .now { position: absolute; top: 0; bottom: 0; border-left: 2px dashed var(--focus); padding-left: 3px; color: var(--focus); white-space: nowrap; top: 14px; }
    .span-bar { position: absolute; top: 4px; height: 14px; background: repeating-linear-gradient(45deg, #b9c9d9, #b9c9d9 4px, #d6e1ea 4px, #d6e1ea 8px); border: 1px solid #7d95ab; }
    .span-bar.over { border: 2px solid var(--refusal); }
    .out-bar { position: absolute; top: 6px; height: 10px; background: #9fb3c4; }
    .limit { position: absolute; top: 0; font-size: 12px; transform: translateX(-50%); }
    .limit.hard { color: var(--rule); }
    .limit.guideline { color: var(--estimate); }
    .off-shift { position: absolute; top: 0; height: 22px; background: repeating-linear-gradient(-45deg, transparent, transparent 3px, #eef1ec 3px, #eef1ec 6px); }
    .load-bar { position: absolute; top: 4px; height: 14px; background: #76a98c; border: 1px solid #5a8c70; font-size: 9px; color: #fff; text-align: center; line-height: 12px; overflow: hidden; }
    .load-bar.bought { background: #c9a46a; border-color: #a5844d; }
    .load-bar.over { border: 2px solid var(--refusal); }
    .job-bar { position: absolute; top: 3px; height: 16px; min-height: 0; padding: 0; border-radius: 3px; background: #6f9f86; border: 1px solid #4f7f66; }
    .job-bar.kind-tag-out { background: #b8a26a; border-color: #8f7c48; }
    .job-bar.kind-test { background: #5d7fa6; border-color: #3f5f84; border-radius: 8px; }
    .job-bar.locked { outline: 2px solid var(--ink); }
    .job-lane.selected { background: var(--accent-2); }

    .work-list ul, .item-list, .rule-list, .option-list { list-style: none; padding: 0; margin: 0; }
    .work-list li, .item-list li, .rule-list li, .option-list > li { border-top: 1px solid var(--line-2); padding: 8px 0; }
    .work-row { display: grid; width: 100%; text-align: left; border: 0; background: none; padding: 4px; gap: 2px; border-radius: 4px; }
    .work-list li.selected .work-row { background: var(--accent-2); box-shadow: inset 3px 0 var(--accent); }
    .work-title { font-weight: 600; }
    .work-meta, .work-when, .work-float { font-size: 12px; color: var(--ink-2); }
    .work-meta span + span::before { content: ' · '; }
    .work-estimate { font-size: 12px; }
    .option-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 6px; }
    .option-list > li.selected { box-shadow: inset 3px 0 var(--accent); padding-left: 8px; }
    .facts { margin: 0 0 10px; }
    .facts > div { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 8px; border-bottom: 1px solid var(--line-2); padding: 6px 0; font-size: 12px; }
    .facts dt { color: var(--ink-3); }
    .facts dd { margin: 0; }
    .panel-heading { display: flex; justify-content: space-between; gap: 8px; align-items: start; }
    .why { margin-top: 8px; padding: 8px; background: var(--estimate-bg); border-radius: 6px; font-size: 13px; }
    .mini-form { border-top: 1px solid var(--line-2); padding-top: 10px; margin-top: 10px; }
    .authority { padding: 8px; background: var(--rule-bg); border-radius: 6px; margin: 8px 0; }
    .goal-order { padding-left: 18px; }
    .goal-order li { margin-bottom: 4px; }
    .shift-list ul { list-style: none; padding: 0; margin: 0 0 10px; }
    .shift-list li { padding: 6px 0; border-top: 1px solid var(--line-2); display: grid; font-size: 13px; }
    .shift-list .when { font-weight: 600; }
    .shift-list .who { color: var(--ink-2); font-size: 12px; }
    .phone-only { display: none; }

    @media (max-width: 1280px) {
      .screen-grid { grid-template-columns: 300px minmax(0, 1fr); }
      .col-panel { grid-column: 1 / -1; }
    }
    @media (max-width: 760px) {
      .plan-screen { padding: 12px; }
      .screen-grid { grid-template-columns: minmax(0, 1fr); }
      .desktop-only { display: none; }
      .phone-only { display: block; }
      .field-pair { grid-template-columns: minmax(0, 1fr); }
      button, input, select { min-height: 42px; }
      .plan-header .generate { max-width: none; width: 100%; }
    }
  }
</style>
