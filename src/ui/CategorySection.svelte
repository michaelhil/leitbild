<script lang="ts">
  import { ChevronDown, ChevronRight, Plus } from 'lucide-svelte'
  import type { OperationalObject } from '../core/model/index.ts'
  import type { PackCreateObjectType } from '../core/packs/protocol.ts'
  import IconButton from './components/IconButton.svelte'
  import FieldVisibilityMenu from './FieldVisibilityMenu.svelte'
  import ObjectRow from './ObjectRow.svelte'
  import { iconHtml, type IconName } from './icons.ts'
  import type { CategoryRow } from './types.ts'
  import type { FieldVisibilityOption, PresentedObjectRow } from './control-rail-presenter.ts'

  interface Props {
    readonly row: CategoryRow
    readonly headerIcon: IconName | null
    readonly collapsed: boolean
    readonly fieldMenuOpen: boolean
    readonly fieldOptions: ReadonlyArray<FieldVisibilityOption>
    readonly presentedRows: ReadonlyArray<PresentedObjectRow>
    readonly selectedControllerId: string | null
    readonly isFieldVisible: (categoryId: string, field: string) => boolean
    readonly toggleField: (categoryId: string, field: string) => void
    readonly toggleFieldMenu: (categoryId: string) => void
    readonly toggleCategory: (categoryId: string) => void
    readonly beginPlacement: (type: PackCreateObjectType) => void
    readonly markSeen: (object: OperationalObject) => void
    readonly selectObject: (object: OperationalObject) => void
    readonly deleteObject: (object: OperationalObject) => Promise<void>
  }

  let {
    row,
    headerIcon,
    collapsed,
    fieldMenuOpen,
    fieldOptions,
    presentedRows,
    selectedControllerId,
    isFieldVisible,
    toggleField,
    toggleFieldMenu,
    toggleCategory,
    beginPlacement,
    markSeen,
    selectObject,
    deleteObject,
  }: Props = $props()
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
