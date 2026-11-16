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
      --ink: #1f3530; --ink-2: #4d6359; --ink-3: #56665d; --paper: #f6f7f3; --card: #ffffff; --line: #d9e2d8; --line-2: #edf1eb;
      --accent: #285e4d; --accent-strong: #1d4a3c; --accent-2: #edf4ed; --focus: #9a4f1f; --on-accent: #ffffff;
      --load-fill: #3f7258; --load-line: #2f5a45; --load-text: #ffffff; --load-bought-fill: #c9a46a; --load-bought-line: #a5844d; --load-bought-text: #1f3530;
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
    button.primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
    /* A primary button keeps its strong look under the pointer, so it never reads as disabled after a click. */
    button.primary:hover:not(:disabled) { background: var(--accent-strong); border-color: var(--accent-strong); }
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
    .error-words { margin: 0; }
    .error-detail { margin-top: 6px; font-size: 11px; color: var(--ink-2); }
    .error-detail pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 200px; overflow: auto; margin: 4px 0 0; }
    .notice { padding: 8px 12px; border-left: 3px solid var(--accent); background: var(--accent-2); font-size: 13px; }
    .loading { margin: 24px; color: var(--ink-3); }
    .outcome.refused { border-left-color: var(--refusal); }
    .outcome { padding: 6px 12px; border-left: 3px solid var(--accent); background: var(--card); margin: 6px 0 10px; font-size: 13px; overflow-wrap: anywhere; }
    .outcome-title { font-weight: 600; margin: 0; }
    .outcome ul { margin: 4px 0 0; padding-left: 18px; }
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
    /* A long mark (a what-if's "best found with … first") wraps inside its card, never past it (walk V5). */
    .what-if-card .mark, .goals .mark { white-space: normal; max-width: 100%; overflow-wrap: anywhere; }

    .library { max-width: 1060px; margin: 24px auto; padding: 0 16px; }
    .eyebrow { color: var(--ink-3); text-transform: uppercase; letter-spacing: .09em; font-size: 10px; font-weight: 700; }
    .intro { font-size: 16px; color: var(--ink-2); max-width: 720px; }
    .demo-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin: 20px 0 28px; }
    .demo-card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 20px; display: flex; flex-direction: column; align-items: flex-start; }
    .demo-card p { color: var(--ink-2); flex: 1; }
    .plan-list { list-style: none; padding: 0; }
    .plan-list li { border-top: 1px solid var(--line); padding: 12px 0; }

    .plan-screen { max-width: 1800px; margin: 0 auto; padding: 12px 20px 40px; }
    .back { margin: 0 0 2px; font-size: 12px; }
    /* The header: title and the Generate toolbar on one row, the purpose, then window, now, zone and size on one line. */
    .plan-header { margin-bottom: 8px; }
    .plan-header .title-row { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 6px 24px; }
    .plan-header h1 { font-size: clamp(20px, 1.8vw, 24px); margin: 0; }
    .plan-header .purpose { color: var(--ink-2); margin: 2px 0 0; }
    .plan-header .generate { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; min-width: 0; }
    .plan-header .generate .choice { margin: 0; }
    .plan-header .generate .choice.radios legend { float: left; margin: 0 10px 0 0; line-height: 24px; }
    .plan-header .generate label.inline { display: inline-flex; margin: 0 10px 0 0; font-size: 13px; line-height: 24px; }
    .plan-header .generate label.days-only { margin-right: 0; }
    .plan-header .generate .choice.list { display: flex; align-items: center; gap: 8px; position: relative; }
    .context-line { display: flex; flex-wrap: wrap; gap: 2px 18px; align-items: baseline; margin-top: 2px; }
    .size-evidence summary { cursor: pointer; }
    .size-evidence p { margin: 4px 0 0; max-width: 620px; }
    /* Attention on the left; the views and, under them, the work in the middle; the detail on the right. */
    .screen-grid { display: grid; grid-template-columns: 300px minmax(0, 1fr) 360px; grid-template-rows: auto 1fr; grid-template-areas: "attention views views" "attention main panel"; gap: 10px 16px; align-items: start; }
    /* With nothing open in the detail column, the work takes its width. */
    .screen-grid.no-detail { grid-template-areas: "attention views views" "attention main main"; }
    .screen-grid.no-detail .col-panel { display: none; }
    .col-attention { grid-area: attention; }
    .views { grid-area: views; }
    .col-main { grid-area: main; }
    .col-panel { grid-area: panel; }
    /* Each column is one track that may shrink to its box; long text wraps instead of widening it. */
    .col-attention, .col-main, .col-panel, .desktop-only { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; align-content: start; }
    .attention, .glance, .work-list, .options, .rules, .crews, .picker, .authoring, .job-panel, .preview, .shift-list, .shown-option, .timeline, .options-glance, .finish-panel,
    .ladder, .what-if-panel, .why-panel, .compare-panel {
      background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 14px; min-width: 0; overflow-wrap: anywhere;
    }
    .cards { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
    .card { border: 1px solid var(--line); border-radius: 6px; padding: 10px; }
    .card-title { font-weight: 600; margin: 6px 0 4px; }
    .card-text { color: var(--ink-2); font-size: 13px; margin-bottom: 6px; }
    .card-steps { font-size: 12px; padding-left: 18px; margin: 0 0 8px; }
    .card-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    /* An explanation is a short list: the job (its only link), its time, one plain sentence. */
    .limiting { font-size: 13px; padding: 8px 10px; background: var(--accent-2); border-radius: 6px; margin-bottom: 8px; }
    .chain { list-style: none; padding: 0; margin: 0; font-size: 13px; }
    .chain li { padding: 7px 0; border-top: 1px solid var(--line-2); }
    .chain .step-name { font-weight: 600; }
    .chain .when { color: var(--ink-3); }
    .chain .because { color: var(--ink-2); }
    .chain .due { display: block; margin-top: 2px; }
    .proof-headline { font-weight: 600; color: var(--refusal); margin: 8px 0 4px; }
    .proof-text { font-size: 13px; margin: 8px 0 2px; }
    /* All views on one row: from 1280 px the row spans the work and the detail column, which holds them all. */
    .views { display: flex; flex-wrap: nowrap; gap: 4px; min-width: 0; overflow-x: auto; padding: 3px; margin: -3px; }
    .views button { flex: none; white-space: nowrap; min-height: 32px; padding: 4px 10px; font-size: 13px; }
    .views button.current { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
    /* The options side by side: one row per option, a click shows it on the timeline. */
    .options-glance { padding: 6px 12px 8px; }
    /* The table fits its column from 1024 px to 1440 px (layout.test.ts); a plan with many goals scrolls it here. */
    .glance-scroll { overflow-x: auto; }
    .options-glance table { width: 100%; border-collapse: collapse; font-size: 13px; overflow-wrap: break-word; }
    .options-glance th, .options-glance td { padding: 5px 6px; text-align: left; vertical-align: top; border-top: 1px solid var(--line-2); font-weight: 400; }
    .options-glance thead th { border-top: 0; font-size: 11px; font-weight: 600; color: var(--ink-3); vertical-align: bottom; line-height: 1.3; }
    .options-glance .number { text-align: right; }
    /* An option is two rows: its values, then its status and any caution across the whole width, which wrap. */
    .options-glance tbody { cursor: pointer; }
    .options-glance tbody:hover, .options-glance tbody.selected { background: var(--accent-2); }
    .options-glance tbody.selected { box-shadow: inset 3px 0 var(--accent); }
    .options-glance tr.chips-row td { border-top: 0; padding-top: 0; }
    .options-glance .chips { display: flex; flex-wrap: wrap; gap: 4px 6px; }
    .options-glance .beside { margin: 4px 0 0; }
    .options-glance button.option-name { font-weight: 600; color: var(--ink); text-decoration: none; margin-right: 6px; }
    .options-glance button.option-name:hover:not(:disabled) { background: none; text-decoration: underline; }
    .options-glance td strong, .options-glance .goal-word { white-space: nowrap; }
    .options-glance .cause { color: var(--refusal); }
    .legend { margin: 6px 0 0; padding: 0 8px; font-size: 11px; color: var(--ink-3); }
    .legend-word { font-weight: 600; }
    /* The questions about the options, one quiet row under the table; each opens beside the timeline. */
    .choose { display: flex; flex-wrap: wrap; gap: 4px 6px; margin: 6px 0 0; padding: 0 8px; }
    .choose button.current { background: var(--accent-2); border-color: var(--accent); }
    .shown-what-if { margin: 6px 0 0; padding: 0 8px; font-size: 12px; }
    .not-yet { padding: 8px 10px; border-left: 3px solid var(--line); background: var(--line-2); font-size: 13px; color: var(--ink-2); }
    /* What overtime buys: numbered rungs, and between two rungs the Module's word for the step up. */
    .rungs { list-style: none; padding: 0; margin: 0 0 10px; }
    .rung { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 8px; padding: 8px 0; border-top: 1px solid var(--line-2); }
    .rung.selected { box-shadow: inset 3px 0 var(--accent); padding-left: 4px; }
    .rung-number { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; border: 1px solid var(--accent); color: var(--accent); font-weight: 600; font-size: 12px; }
    .rung-body p { margin: 0 0 4px; }
    .rung-name { font-weight: 600; }
    .rung-outcome { font-size: 13px; }
    .rung-use { font-size: 12px; color: var(--ink-2); }
    .ladder-step { margin: 0 0 0 12px; padding: 4px 0 4px 22px; border-left: 2px solid var(--accent); font-size: 13px; }
    .ladder-word { font-weight: 600; color: var(--accent-strong); }
    .ladder-difference { color: var(--ink-2); }
    .ladder-finish { display: block; color: var(--ink-2); font-size: 12px; }
    .finer { margin-top: 8px; }
    .ladder-method { font-weight: 600; margin: 0 0 6px; }
    .ladder-legend { padding: 0; }
    /* What-ifs: a card per answer, apart from the plan's options. */
    .what-if-cards { display: grid; gap: 10px; }
    .what-if-card { border: 1px dashed var(--estimate); border-radius: 6px; padding: 10px; background: var(--card); min-width: 0; }
    .what-if-card.selected { box-shadow: inset 3px 0 var(--accent); }
    .what-if-head { margin: 0 0 4px; display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
    .what-if-apart { font-size: 12px; color: var(--estimate); margin-bottom: 6px; }
    .what-if-outage { font-size: 13px; margin: 4px 0; }
    .what-if-against { font-size: 13px; margin: 4px 0; color: var(--ink-2); }
    .why-policy { font-size: 13px; list-style: none; padding: 0; margin: 0 0 8px; }
    .why-policy li { margin-bottom: 2px; }
    .why-decided { font-size: 13px; margin-bottom: 4px; }
    .why-trade { font-size: 13px; padding: 6px 8px; background: var(--accent-2); border-radius: 6px; }
    /* Goals side by side in the right column: the names wrap, the values stay whole. */
    .why-goals, .compare-goals { width: 100%; border-collapse: collapse; font-size: 12px; margin: 6px 0 8px; table-layout: fixed; }
    .why-goals th, .why-goals td, .compare-goals th, .compare-goals td { padding: 4px 4px; text-align: left; vertical-align: top; border-top: 1px solid var(--line-2); font-weight: 400; overflow-wrap: anywhere; }
    .why-goals thead th, .compare-goals thead th { border-top: 0; font-weight: 600; color: var(--ink-3); font-size: 11px; }
    .why-goals .number, .compare-goals .number { text-align: right; }
    .why-goals tr.deciding th, .why-goals tr.deciding td, .compare-goals tr.changed td { font-weight: 600; }
    .previous-set { list-style: none; padding: 0; margin: 0 0 8px; font-size: 13px; }
    .previous-set li { padding: 3px 0; }
    .compare-line { font-size: 13px; margin: 4px 0; }
    .compare-outages { list-style: none; padding: 0; margin: 6px 0; font-size: 12px; }
    .compare-outages li { padding: 4px 0; border-top: 1px solid var(--line-2); display: grid; gap: 2px; }
    .compare-outages li.changed .outage-figures { font-weight: 600; }
    /* A dominated option is folded under the table; its name says which option dominates it. */
    .dominated-by { display: block; margin-top: 2px; }
    .dominated-line { margin: 6px 0 0; padding: 0 8px; font-size: 12px; }
    .why-lines { padding-left: 18px; font-size: 13px; margin: 0 0 8px; }
    .unpriced p { margin: 0 0 2px; }
    .unpriced { margin-bottom: 8px; }
    .unpriced-others { padding-left: 18px; font-size: 12px; color: var(--ink-2); }
    /* The goals editor: one row per goal, its words, Up and Down, then its threshold and step. */
    .goal-rows { list-style: none; padding: 0; margin: 0 0 8px; }
    .goal-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 8px; padding: 8px 0; border-top: 1px solid var(--line-2); }
    .goal-row .goal-text { display: grid; gap: 2px; min-width: 0; }
    .goal-row .goal-move { display: flex; gap: 4px; align-items: start; }
    .goal-row .goal-fields { grid-column: 1 / -1; }
    .goal-row .goal-fields label { margin-bottom: 0; }
    .status-line { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
    .goals { padding-left: 18px; font-size: 13px; }
    .goals .distance { color: var(--ink-3); }
    .details { padding-left: 18px; font-size: 13px; }
    .beside, .stale { font-size: 12px; }

    /* The right padding holds the last tick's label, so a label at the window's end never starts a scroll bar. */
    .timeline { overflow-x: auto; padding: 8px 52px 12px 12px; }
    .lane, .axis { display: grid; grid-template-columns: minmax(150px, 200px) minmax(380px, 1fr); gap: 8px; align-items: center; min-height: 24px; border-bottom: 1px solid var(--line-2); }
    .axis { border-bottom: 1px solid var(--line); font-size: 10px; color: var(--ink-3); min-height: 30px; }
    .lane-heading { margin: 10px 0 2px; }
    .lane-heading .key { display: inline; margin-left: 8px; }
    .group-head { margin: 6px 0 0; font-size: 12px; }
    .lane-summary { color: var(--ink-3); font-size: 11px; }
    .group-lane .lane-label { color: var(--ink-3); }
    .lane-label { font-size: 11px; overflow: hidden; text-overflow: ellipsis; }
    .lane-label small { white-space: normal; }
    .track { position: relative; display: block; height: 22px; }
    .axis .track { height: 28px; }
    .tick { position: absolute; top: 4px; transform: translateX(-50%); white-space: nowrap; border-left: 1px solid var(--line); padding-left: 3px; transform: none; }
    .now { position: absolute; top: 0; bottom: 0; border-left: 2px dashed var(--focus); padding-left: 3px; color: var(--focus); white-space: nowrap; top: 14px; }
    .span-bar { position: absolute; top: 4px; height: 14px; background: repeating-linear-gradient(45deg, #b9c9d9, #b9c9d9 4px, #d6e1ea 4px, #d6e1ea 8px); border: 1px solid #7d95ab; }
    .span-bar.over { border: 2px solid var(--refusal); }
    /* An item's outage is a band behind the bars of the jobs on it. */
    .out-bar { position: absolute; top: 2px; bottom: 2px; background: #dfe7ee; border-radius: 2px; }
    .limit { position: absolute; top: 0; font-size: 12px; transform: translateX(-50%); }
    .limit.hard { color: var(--rule); }
    .limit.guideline { color: var(--estimate); }
    .off-shift { position: absolute; top: 0; height: 22px; background: repeating-linear-gradient(-45deg, transparent, transparent 3px, #eef1ec 3px, #eef1ec 6px); }
    .load-bar { position: absolute; top: 4px; height: 14px; background: var(--load-fill); border: 1px solid var(--load-line); font-size: 9px; color: var(--load-text); text-align: center; line-height: 12px; overflow: hidden; }
    .load-bar.bought { background: var(--load-bought-fill); border-color: var(--load-bought-line); color: var(--load-bought-text); }
    .load-bar.over { border: 2px solid var(--refusal); }
    .job-bar { position: absolute; top: 3px; height: 14px; min-height: 0; padding: 0; border-radius: 3px; background: #6f9f86; border: 1px solid #4f7f66; }
    .job-bar:hover:not(:disabled) { background: var(--accent); }
    .job-bar.current { outline: 2px solid var(--focus); outline-offset: 1px; }
    .job-bar.kind-tag-out { background: #b8a26a; border-color: #8f7c48; }
    .job-bar.kind-test { background: #5d7fa6; border-color: #3f5f84; border-radius: 8px; }
    .job-bar.locked { outline: 2px solid var(--ink); }
    .job-lane.selected, .item-lane.selected { background: var(--accent-2); }

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
    .panel-heading h2 { min-width: 0; }
    /* A short button never wraps or shrinks beside a long title (the Close button at 1440 px). */
    .panel-heading button, button.quiet { white-space: nowrap; flex: none; }
    .why { margin-top: 8px; padding: 8px; background: var(--estimate-bg); border-radius: 6px; font-size: 13px; }
    .mini-form { border-top: 1px solid var(--line-2); padding-top: 10px; margin-top: 10px; }
    .authority { padding: 8px; background: var(--rule-bg); border-radius: 6px; margin: 8px 0; }
    .goal-order { padding-left: 18px; }
    .goal-order li { margin-bottom: 4px; }
    .shift-list ul { list-style: none; padding: 0; margin: 0 0 10px; }
    .shift-list li { padding: 6px 0; border-top: 1px solid var(--line-2); display: grid; font-size: 13px; }
    .shift-list .when { font-weight: 600; }
    .shift-list .who { color: var(--ink-2); font-size: 12px; }
    .glance ul { list-style: none; padding: 0; margin: 0 0 6px; font-size: 12px; }
    .glance li { padding: 3px 0; }
    .jump { margin: 0; font-size: 13px; }
    .choice.list { display: grid; gap: 4px; margin-bottom: 8px; min-width: 0; }
    .choice-label { font-size: 12px; font-weight: 500; }
    .choice-current { display: flex; justify-content: space-between; gap: 8px; text-align: left; }
    .choice-options ul { list-style: none; padding: 0; margin: 4px 0; max-height: 260px; overflow-y: auto; border: 1px solid var(--line); border-radius: 6px; }
    .choice-options li button { width: 100%; text-align: left; border: 0; border-radius: 0; min-height: 32px; }
    .choice-options li button[aria-pressed='true'] { background: var(--accent-2); font-weight: 600; }
    .choice.radios label.inline { margin-bottom: 4px; }
    a.name { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
    /* A name inside a sentence of causes: selectable, and quiet until pointed at or focused. */
    a.name.quiet { color: var(--ink); font-weight: 500; text-decoration: none; }
    a.name.quiet:hover, a.name.quiet:focus-visible { color: var(--accent); text-decoration: underline; }
    .phone-only { display: none; }

    /* Below 1280 px the detail column stacks under the other two; on a phone everything is one column. */
    @media (max-width: 1279px) {
      .screen-grid, .screen-grid.no-detail { grid-template-columns: 300px minmax(0, 1fr); grid-template-rows: auto 1fr auto; grid-template-areas: "attention views" "attention main" "panel panel"; }
      /* A narrower row wraps, so no view is out of sight. */
      .views { flex-wrap: wrap; overflow-x: visible; }
    }
    @media (max-width: 760px) {
      .plan-screen { padding: 12px; }
      .screen-grid, .screen-grid.no-detail { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto; grid-template-areas: "attention" "views" "main" "panel"; }
      .desktop-only { display: none; }
      .phone-only { display: block; }
      .field-pair { grid-template-columns: minmax(0, 1fr); }
      button, input, select { min-height: 42px; }
      .plan-header .generate { width: 100%; }
      .plan-header .generate .choice.radios legend { float: none; }
    }
  }
</style>
