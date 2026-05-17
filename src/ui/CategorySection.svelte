<script lang="ts">
  import { ChevronDown, ChevronRight, Plus } from 'lucide-svelte'
  import type { OperationalObject } from '../core/model/index.ts'
  import type { PackCreateObjectType, PackObjectField, PackObjectPresentation, PackObjectStatusPresentation } from '../core/packs/protocol.ts'
  import IconButton from './components/IconButton.svelte'
  import FieldVisibilityMenu, { type FieldVisibilityOption } from './FieldVisibilityMenu.svelte'
  import ObjectRow from './ObjectRow.svelte'
  import { iconHtml, type IconName } from './icons.ts'
  import type { CategoryRow } from './types.ts'

  export interface PresentedObjectRow {
    readonly object: OperationalObject
    readonly presentation: PackObjectPresentation
    readonly status: PackObjectStatusPresentation
    readonly visibleFields: ReadonlyArray<PackObjectField>
    readonly hasNewInfo: boolean
  }

  export let row: CategoryRow
  export let headerIcon: IconName | null
  export let collapsed: boolean
  export let fieldMenuOpen: boolean
  export let fieldOptions: ReadonlyArray<FieldVisibilityOption>
  export let presentedRows: ReadonlyArray<PresentedObjectRow>
  export let selectedControllerId: string | null
  export let isFieldVisible: (categoryId: string, field: string) => boolean
  export let toggleField: (categoryId: string, field: string) => void
  export let toggleFieldMenu: (categoryId: string) => void
  export let toggleCategory: (categoryId: string) => void
  export let beginPlacement: (type: PackCreateObjectType) => void
  export let markSeen: (object: OperationalObject) => void
  export let selectObject: (object: OperationalObject) => void
  export let deleteObject: (object: OperationalObject) => Promise<void>
</script>

<section class="category">
  <div class="category-header">
    <div class="category-title">
      {#if headerIcon}
        <span class="category-icon">{@html iconHtml(headerIcon, { size: 17 })}</span>
      {/if}
      <h2>{row.category.label} <span>({row.objects.length})</span></h2>
      <span class="category-actions">
        <FieldVisibilityMenu
          categoryLabel={row.category.label}
          open={fieldMenuOpen}
          fields={fieldOptions}
          isVisible={(field) => isFieldVisible(row.category.id, field)}
          toggleOpen={() => toggleFieldMenu(row.category.id)}
          toggleField={(field) => toggleField(row.category.id, field)}
        />
        {#if row.createType}
          <IconButton
            label="Add {row.category.label.toLowerCase()}"
            title="Add {row.category.label.toLowerCase()}"
            icon={Plus}
            size={14}
            variant="bare"
            onClick={() => row.createType && beginPlacement(row.createType)}
          />
        {/if}
      </span>
    </div>
    <IconButton
      label="{collapsed ? 'Expand' : 'Collapse'} {row.category.label.toLowerCase()}"
      title="{collapsed ? 'Expand' : 'Collapse'} {row.category.label.toLowerCase()}"
      icon={collapsed ? ChevronRight : ChevronDown}
      size={15}
      variant="ghost"
      onClick={() => toggleCategory(row.category.id)}
    />
  </div>
  {#if !collapsed}
    {#if row.objects.length === 0}
      <div class="empty-row">{row.category.emptyLabel}</div>
    {/if}
    {#each presentedRows as entry (entry.object.id)}
      <ObjectRow
        object={entry.object}
        presentation={entry.presentation}
        statusPresentation={entry.status}
        selected={selectedControllerId === entry.object.id}
        hasNewInfo={entry.hasNewInfo}
        visibleFields={entry.visibleFields}
        {markSeen}
        {selectObject}
        {deleteObject}
      />
    {/each}
  {/if}
</section>
