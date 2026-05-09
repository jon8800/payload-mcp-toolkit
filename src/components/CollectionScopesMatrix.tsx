'use client'

import * as React from 'react'
import { useField } from '@payloadcms/ui'

type Action = 'read' | 'create' | 'update' | 'delete'
const ACTIONS: Action[] = ['read', 'create', 'update', 'delete']
const ACTION_LABELS: Record<Action, string> = {
  read: 'Read',
  create: 'Create',
  update: 'Update',
  delete: 'Delete',
}

interface RowValue {
  collection?: string
  actions?: Action[]
}
type MatrixValue = RowValue[]

export interface CollectionScopesMatrixProps {
  path: string
  /** Forwarded via `clientProps` from `api-keys.ts`. */
  availableCollections?: string[]
}

function rowsToMap(value: MatrixValue | null | undefined): Map<string, Set<Action>> {
  const map = new Map<string, Set<Action>>()
  if (!Array.isArray(value)) return map
  for (const row of value) {
    if (!row || typeof row.collection !== 'string') continue
    const actions = new Set<Action>()
    if (Array.isArray(row.actions)) {
      for (const a of row.actions) {
        if (typeof a === 'string' && (ACTIONS as string[]).includes(a)) actions.add(a as Action)
      }
    }
    map.set(row.collection, actions)
  }
  return map
}

function mapToRows(map: Map<string, Set<Action>>, allCollections: string[]): MatrixValue {
  // Persist only collections with at least one action checked. An empty row
  // would be indistinguishable from "collection not in scope" and bloats
  // storage; the matrix visually shows every collection regardless.
  const rows: MatrixValue = []
  for (const slug of allCollections) {
    const actions = map.get(slug)
    if (!actions || actions.size === 0) continue
    rows.push({
      collection: slug,
      actions: ACTIONS.filter((a) => actions.has(a)),
    })
  }
  return rows
}

function CollectionScopesMatrix(props: CollectionScopesMatrixProps): React.ReactElement {
  const { value, setValue } = useField<MatrixValue>({ path: props.path, hasRows: false })
  const collections: string[] = Array.isArray(props.availableCollections)
    ? props.availableCollections
    : []

  const map = React.useMemo(() => rowsToMap(value), [value])

  const update = React.useCallback(
    (mutator: (m: Map<string, Set<Action>>) => void) => {
      const next = new Map<string, Set<Action>>()
      for (const [k, v] of map) next.set(k, new Set(v))
      mutator(next)
      setValue(mapToRows(next, collections))
    },
    [map, collections, setValue],
  )

  const isCellChecked = (slug: string, action: Action): boolean => !!map.get(slug)?.has(action)
  const isRowFull = (slug: string): boolean => {
    const set = map.get(slug)
    return !!set && ACTIONS.every((a) => set.has(a))
  }
  const isColumnFull = (action: Action): boolean =>
    collections.length > 0 && collections.every((s) => map.get(s)?.has(action))
  const isAllFull = collections.length > 0 && collections.every((s) => isRowFull(s))

  const toggleCell = (slug: string, action: Action, checked: boolean) =>
    update((m) => {
      const set = m.get(slug) ?? new Set<Action>()
      if (checked) set.add(action)
      else set.delete(action)
      m.set(slug, set)
    })

  const toggleRow = (slug: string, checked: boolean) =>
    update((m) => {
      m.set(slug, checked ? new Set(ACTIONS) : new Set())
    })

  const toggleColumn = (action: Action, checked: boolean) =>
    update((m) => {
      for (const slug of collections) {
        const set = m.get(slug) ?? new Set<Action>()
        if (checked) set.add(action)
        else set.delete(action)
        m.set(slug, set)
      }
    })

  const toggleAll = (checked: boolean) =>
    update((m) => {
      for (const slug of collections) m.set(slug, checked ? new Set(ACTIONS) : new Set())
    })

  if (collections.length === 0) {
    return (
      <div className="field-type" style={{ padding: '0.5rem 0' }}>
        <label className="field-label">Collection scopes</label>
        <p style={{ color: 'var(--theme-elevation-500)', fontSize: '0.85rem', margin: '0.25rem 0 0' }}>
          No collections are available to scope. Add collections to your Payload config and restart
          the dev server.
        </p>
      </div>
    )
  }

  return (
    <div className="field-type" style={{ padding: '0.5rem 0' }}>
      <label className="field-label" htmlFor={`${props.path}-matrix`}>
        Collection scopes
      </label>
      <p
        style={{
          color: 'var(--theme-elevation-500)',
          fontSize: '0.85rem',
          margin: '0.25rem 0 0.75rem',
        }}
      >
        Check the actions this key may perform on each collection. Unchecked rows are denied
        outright. Only honoured when the preset is "Custom".
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
          <tr style={{ background: 'var(--theme-elevation-50)' }}>
            <th
              style={{
                textAlign: 'left',
                padding: '0.5rem 0.75rem',
                fontWeight: 600,
                borderBottom: '1px solid var(--theme-elevation-150)',
              }}
            >
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', margin: 0 }}>
                <input
                  type="checkbox"
                  checked={isAllFull}
                  onChange={(e) => toggleAll(e.currentTarget.checked)}
                />
                Collection
              </label>
            </th>
            {ACTIONS.map((action) => (
              <th
                key={action}
                style={{
                  textAlign: 'center',
                  padding: '0.5rem 0.5rem',
                  fontWeight: 600,
                  borderBottom: '1px solid var(--theme-elevation-150)',
                  borderLeft: '1px solid var(--theme-elevation-100)',
                }}
              >
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', justifyContent: 'center', cursor: 'pointer', margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={isColumnFull(action)}
                    onChange={(e) => toggleColumn(action, e.currentTarget.checked)}
                  />
                  {ACTION_LABELS[action]}
                </label>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {collections.map((slug, idx) => (
            <tr
              key={slug}
              style={{
                background:
                  idx % 2 === 0 ? 'var(--theme-input-bg)' : 'var(--theme-elevation-25)',
              }}
            >
              <td style={{ padding: '0.4rem 0.75rem', borderTop: idx === 0 ? 'none' : '1px solid var(--theme-elevation-100)' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={isRowFull(slug)}
                    onChange={(e) => toggleRow(slug, e.currentTarget.checked)}
                    aria-label={`Toggle all actions for ${slug}`}
                  />
                  <code style={{ fontSize: '0.9em' }}>{slug}</code>
                </label>
              </td>
              {ACTIONS.map((action) => (
                <td
                  key={action}
                  style={{
                    textAlign: 'center',
                    padding: '0.4rem 0.5rem',
                    borderLeft: '1px solid var(--theme-elevation-100)',
                    borderTop: idx === 0 ? 'none' : '1px solid var(--theme-elevation-100)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isCellChecked(slug, action)}
                    onChange={(e) => toggleCell(slug, action, e.currentTarget.checked)}
                    aria-label={`${ACTION_LABELS[action]} on ${slug}`}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default CollectionScopesMatrix
