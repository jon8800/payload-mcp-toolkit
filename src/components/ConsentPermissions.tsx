'use client'

import React, { useEffect, useState } from 'react'
import { CheckboxInput } from '@payloadcms/ui'
import { toWords } from 'payload/shared'
import { collectionActions, globalActions, summarize, toolsFor, type Catalog, type Choice, type Level } from '../oauth-permissions'
import { ScopesMatrix } from './ScopesTable'

type Rows = { slug?: unknown; actions?: unknown }[]
const ACTION_LABELS = { read: 'Read', create: 'Create', update: 'Update' }

const fullRows = (slugs: string[], actions: string[]): Rows => slugs.map(slug => ({ slug, actions }))

// Undefined when every row has every action: the form then sends nothing for that list, which means "all".
function toMap(rows: Rows, slugs: string[], actions: string[]): Record<string, string[]> | undefined {
  const map: Record<string, string[]> = {}
  for (const row of rows) if (typeof row.slug === 'string' && Array.isArray(row.actions)) map[row.slug] = row.actions as string[]
  return slugs.every(slug => actions.every(a => map[slug]?.includes(a))) ? undefined : map
}

/**
 * Consent-screen permission picker, capped at what the app asked for (`max`). Renders the hidden
 * `permissions` field the approve form submits; the server re-checks every value.
 */
export function ConsentPermissions({ catalog, max, onEmptyChange }: { catalog: Catalog; max: Level; onEmptyChange: (empty: boolean) => void }) {
  const [level, setLevel] = useState<Level>(max)
  const [collections, setCollections] = useState<Rows>(() => fullRows(catalog.collections, collectionActions(max)))
  const [globals, setGlobals] = useState<Rows>(() => fullRows(catalog.globals, globalActions(max)))
  const [tools, setTools] = useState<string[]>(() => toolsFor(catalog, max).map(t => t.name))

  function changeLevel(next: Level) {
    // A new level starts from everything it allows; picks made at the old level do not carry over.
    setLevel(next)
    setCollections(fullRows(catalog.collections, collectionActions(next)))
    setGlobals(fullRows(catalog.globals, globalActions(next)))
    setTools(toolsFor(catalog, next).map(t => t.name))
  }

  const offered = toolsFor(catalog, level)
  const collectionMap = toMap(collections, catalog.collections, collectionActions(level))
  const globalMap = toMap(globals, catalog.globals, globalActions(level))
  const allTools = offered.every(t => tools.includes(t.name))
  // The scope checker denies account-wide tools (search, upload) once collections or globals are limited.
  const limited = Boolean(collectionMap || globalMap)
  // A tool can run only if a ticked row allows its action (account-wide tools need nothing limited).
  const reaches = (rows: Rows, action: string) => rows.some(r => Array.isArray(r.actions) && r.actions.includes(action))
  const usable = offered.filter(t => tools.includes(t.name) &&
    (t.kind === 'account' ? !limited : reaches(t.kind === 'global' ? globals : collections, t.action)))
  const empty = usable.length === 0
  useEffect(() => onEmptyChange(empty), [empty, onEmptyChange])

  const choice: Choice = { level, ...(collectionMap && { collections: collectionMap }), ...(globalMap && { globals: globalMap }), ...(!allTools && { tools }) }
  const summary = summarize({ collections: collectionMap, globals: globalMap, ...(!allTools && { tools: { allow: tools } }) }, level, catalog)

  return (
    <div className="mcp-oauth__permissions">
      <input type="hidden" name="permissions" value={JSON.stringify(choice)} />
      {max === 'editor' && (
        <CheckboxInput
          checked={level === 'editor'}
          id="mcp-oauth-level"
          label="Allow creating and updating entries"
          onToggle={e => changeLevel(e.currentTarget.checked ? 'editor' : 'read-only')}
        />
      )}
      <details className="mcp-oauth__customize">
        <summary><strong>Customize access</strong><span>{summary}</span></summary>
        <div className="mcp-oauth__customize-body">
        <h3>Collections</h3>
        <ScopesMatrix
          actionLabels={ACTION_LABELS}
          actions={collectionActions(level)}
          id="mcp-oauth-collections"
          itemHeader="Collection"
          items={catalog.collections}
          onChange={setCollections}
          value={collections}
        />
        {catalog.globals.length > 0 && (
          <>
            <h3>Global settings</h3>
            <ScopesMatrix
              actionLabels={ACTION_LABELS}
              actions={globalActions(level)}
              id="mcp-oauth-globals"
              itemHeader="Global"
              items={catalog.globals}
              onChange={setGlobals}
              value={globals}
            />
          </>
        )}
        <h3>Tools</h3>
        {limited && <p>Search and upload tools need every collection and global, so they are off while access is limited.</p>}
        <div className="mcp-oauth__tools">
          {offered.map(tool => (
            <CheckboxInput
              checked={tools.includes(tool.name) && !(limited && tool.kind === 'account')}
              id={`mcp-oauth-tool-${tool.name}`}
              key={tool.name}
              label={toWords(tool.name)}
              onToggle={e => {
                const on = e.currentTarget.checked
                setTools(current => on ? [...current, tool.name] : current.filter(name => name !== tool.name))
              }}
              readOnly={limited && tool.kind === 'account'}
            />
          ))}
        </div>
        </div>
      </details>
      {empty && <p role="alert">Pick at least one tool and one collection or global setting.</p>}
    </div>
  )
}
