'use client'

import * as React from 'react'
import { CheckboxInput, useField } from '@payloadcms/ui'
import { toWords } from 'payload/shared'

/**
 * Reusable matrix renderer for "items × actions" scope tables.
 *
 * Used by both CollectionScopesMatrix (collections × 4 actions) and
 * GlobalScopesMatrix (globals × 2 actions). The stored shape is
 * `Array<{ slug: string; actions: string[] }>` — the parent field name
 * (`collectionScopes` vs `globalScopes`) already encodes which axis the
 * slugs belong to, so the row payload no longer mirrors that distinction.
 */

interface RowValue {
  slug?: unknown
  actions?: unknown
}
type MatrixValue = RowValue[]

export interface ScopesTableProps {
  path: string
  /** Slugs to render as rows. */
  items: string[]
  /** Action columns shown to the operator. */
  actions: string[]
  /** Display label per action (e.g. { read: 'Read', update: 'Update' }). */
  actionLabels: Record<string, string>
  /** Header label for the leftmost column. */
  itemHeader: string
  /** Page-level title rendered above the table. */
  title: string
  /** Helper sentence rendered between title and table. */
  description: string
  /** Copy shown when `items` is empty. */
  emptyMessage: string
}

function rowsToMap(
  value: MatrixValue | null | undefined,
  allowedActions: Set<string>,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  if (!Array.isArray(value)) return map
  for (const row of value) {
    if (!row || typeof row.slug !== 'string') continue
    const slug = row.slug
    const actions = new Set<string>()
    if (Array.isArray(row.actions)) {
      for (const a of row.actions) {
        if (typeof a === 'string' && allowedActions.has(a)) actions.add(a)
      }
    }
    map.set(slug, actions)
  }
  return map
}

function mapToRows(
  map: Map<string, Set<string>>,
  items: string[],
  actions: string[],
): MatrixValue {
  const rows: MatrixValue = []
  for (const slug of items) {
    const set = map.get(slug)
    if (!set || set.size === 0) continue
    rows.push({
      slug,
      actions: actions.filter((a) => set.has(a)),
    })
  }
  return rows
}

const cellStyle: React.CSSProperties = {
  textAlign: 'center',
  padding: '0.5rem 0.5rem',
  borderLeft: '1px solid var(--theme-elevation-100)',
  verticalAlign: 'middle',
}

const headerCellStyle: React.CSSProperties = {
  ...cellStyle,
  background: 'var(--theme-elevation-50)',
  borderBottom: '1px solid var(--theme-elevation-150)',
  fontWeight: 600,
}

const labelCellStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '0.5rem 0.75rem',
  verticalAlign: 'middle',
}

export function ScopesTable(props: ScopesTableProps): React.ReactElement {
  const { value, setValue } = useField<MatrixValue>({ path: props.path, hasRows: false })
  const allowedActionsSet = React.useMemo(() => new Set(props.actions), [props.actions])

  const map = React.useMemo(
    () => rowsToMap(value, allowedActionsSet),
    [value, allowedActionsSet],
  )

  const update = React.useCallback(
    (mutator: (m: Map<string, Set<string>>) => void) => {
      const next = new Map<string, Set<string>>()
      for (const [k, v] of map) next.set(k, new Set(v))
      mutator(next)
      setValue(mapToRows(next, props.items, props.actions))
    },
    [map, props.items, props.actions, setValue],
  )

  const isCellChecked = (slug: string, action: string): boolean =>
    !!map.get(slug)?.has(action)
  const isRowFull = (slug: string): boolean => {
    const set = map.get(slug)
    return !!set && props.actions.every((a) => set.has(a))
  }
  const isRowPartial = (slug: string): boolean => {
    const set = map.get(slug)
    return !!set && set.size > 0 && set.size < props.actions.length
  }
  const isColumnFull = (action: string): boolean =>
    props.items.length > 0 && props.items.every((s) => map.get(s)?.has(action))
  const isColumnPartial = (action: string): boolean => {
    if (props.items.length === 0) return false
    const checked = props.items.filter((s) => map.get(s)?.has(action)).length
    return checked > 0 && checked < props.items.length
  }
  const allCheckedCount = props.items.reduce((sum, s) => sum + (map.get(s)?.size ?? 0), 0)
  const allTotalCount = props.items.length * props.actions.length
  const isAllFull = allTotalCount > 0 && allCheckedCount === allTotalCount
  const isAllPartial = allCheckedCount > 0 && allCheckedCount < allTotalCount

  const toggleCell = (slug: string, action: string, checked: boolean) =>
    update((m) => {
      const set = m.get(slug) ?? new Set<string>()
      if (checked) set.add(action)
      else set.delete(action)
      m.set(slug, set)
    })

  const toggleRow = (slug: string, checked: boolean) =>
    update((m) => {
      m.set(slug, checked ? new Set(props.actions) : new Set())
    })

  const toggleColumn = (action: string, checked: boolean) =>
    update((m) => {
      for (const slug of props.items) {
        const set = m.get(slug) ?? new Set<string>()
        if (checked) set.add(action)
        else set.delete(action)
        m.set(slug, set)
      }
    })

  const toggleAll = (checked: boolean) =>
    update((m) => {
      for (const slug of props.items) m.set(slug, checked ? new Set(props.actions) : new Set())
    })

  if (props.items.length === 0) {
    return (
      <div className="field-type" style={{ padding: '0.5rem 0' }}>
        <label className="field-label">{props.title}</label>
        <p style={{ color: 'var(--theme-elevation-500)', fontSize: '0.85rem', margin: '0.25rem 0 0' }}>
          {props.emptyMessage}
        </p>
      </div>
    )
  }

  return (
    <div className="field-type" style={{ padding: '0.5rem 0' }}>
      <label className="field-label" htmlFor={`${props.path}-matrix`}>
        {props.title}
      </label>
      <p
        style={{
          color: 'var(--theme-elevation-500)',
          fontSize: '0.85rem',
          margin: '0.25rem 0 0.75rem',
        }}
      >
        {props.description}
      </p>
      <table
        id={`${props.path}-matrix`}
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: '0.9rem',
          background: 'var(--theme-input-bg)',
          border: '1px solid var(--theme-elevation-150)',
          borderRadius: '4px',
          overflow: 'hidden',
        }}
      >
        <thead>
          <tr>
            <th style={{ ...headerCellStyle, textAlign: 'left' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <span>{props.itemHeader}</span>
                <CheckboxInput
                  checked={isAllFull}
                  partialChecked={isAllPartial && !isAllFull}
                  onToggle={(e) => toggleAll(e.currentTarget.checked)}
                  label="All"
                />
              </div>
            </th>
            {props.actions.map((action) => (
              <th key={action} style={headerCellStyle}>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '0.35rem',
                  }}
                >
                  <span>{props.actionLabels[action] ?? action}</span>
                  <CheckboxInput
                    checked={isColumnFull(action)}
                    partialChecked={isColumnPartial(action) && !isColumnFull(action)}
                    onToggle={(e) => toggleColumn(action, e.currentTarget.checked)}
                  />
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.items.map((slug, idx) => {
            const niceName = toWords(slug)
            return (
              <tr
                key={slug}
                style={{
                  background:
                    idx % 2 === 0 ? 'var(--theme-input-bg)' : 'var(--theme-elevation-25)',
                }}
              >
                <td
                  style={{
                    ...labelCellStyle,
                    borderTop: idx === 0 ? 'none' : '1px solid var(--theme-elevation-100)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <CheckboxInput
                      checked={isRowFull(slug)}
                      partialChecked={isRowPartial(slug) && !isRowFull(slug)}
                      onToggle={(e) => toggleRow(slug, e.currentTarget.checked)}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span>{niceName}</span>
                      <code
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--theme-elevation-500)',
                          background: 'transparent',
                          padding: 0,
                        }}
                      >
                        {slug}
                      </code>
                    </div>
                  </div>
                </td>
                {props.actions.map((action) => (
                  <td
                    key={action}
                    style={{
                      ...cellStyle,
                      borderTop: idx === 0 ? 'none' : '1px solid var(--theme-elevation-100)',
                    }}
                  >
                    <CheckboxInput
                      checked={isCellChecked(slug, action)}
                      onToggle={(e) => toggleCell(slug, action, e.currentTarget.checked)}
                    />
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
