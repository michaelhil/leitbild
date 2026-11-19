<script lang="ts">
  import { einsatzColors } from '../colors.ts'
  import { svgImageSource } from './einsatz-client.ts'
  import { contactIcon } from '../text.ts'
  import type { ContactRowView } from './presenters.ts'
  import type { ClickedObject } from './selection.ts'

  /**
   * The tracks this screen sees, shown only in configurations that declare
   * a sensor or an effector. A contact shows the neutral icon and nothing of
   * its type or side; an identified track its type. A row tap opens it as a
   * map click does: while a unit is armed it is that unit's engage target.
   */
  interface Props {
    readonly heading: string
    readonly empty: string
    readonly rows: ReadonlyArray<ContactRowView>
    readonly icon: (id: string) => string | undefined
    readonly open: (object: ClickedObject) => void
  }

  const props: Props = $props()
</script>

<section aria-label={props.heading}>
  <h3>{props.heading}</h3>
  {#if props.rows.length === 0}<p class="empty">{props.empty}</p>{/if}
  <ol class="rows">
    {#each props.rows as row (row.id)}
      {@const svg = props.icon(row.icon)}
      <li>
        <button type="button" class="row" class:selected={row.selected} class:destroyed={row.destroyed} aria-pressed={row.selected} onclick={() => props.open({ id: row.id, kind: 'track' })}>
          <span class="badge" style:background={row.icon === contactIcon ? einsatzColors.contact : einsatzColors.identified} aria-hidden="true">{#if svg !== undefined}<img src={svgImageSource(svg)} alt="" />{/if}</span>
          <strong>{row.label}</strong>
          <span class="sub">{row.text}</span>
          {#if row.age !== null}<span class="num age">{row.age}</span>{/if}
        </button>
      </li>
    {/each}
  </ol>
</section>

<style>
  section { display: grid; gap: 4px; }
  h3 { margin: 6px 0 0; color: var(--muted); font-size: 11px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
  .empty { margin: 0; color: var(--muted); }
  .rows { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .row { width: 100%; min-height: 44px; display: flex; gap: 8px; align-items: center; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: inherit; font: inherit; text-align: left; cursor: pointer; touch-action: manipulation; }
  .row.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .row.destroyed { opacity: .6; }
  .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .badge { flex: none; width: 22px; height: 22px; display: inline-grid; place-items: center; border-radius: 50%; }
  .badge img { width: 15px; height: 15px; }
  .sub { color: var(--muted); font-size: 12px; }
  .age { margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums; }
</style>
