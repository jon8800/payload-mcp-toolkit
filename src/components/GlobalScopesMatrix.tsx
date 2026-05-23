'use client'

import * as React from 'react'
import { ScopesTable } from './ScopesTable'

const ACTIONS = ['read', 'update']
const ACTION_LABELS: Record<string, string> = {
  read: 'Read',
  update: 'Update',
}

export interface GlobalScopesMatrixProps {
  path: string
  /** Forwarded via `clientProps` from `api-keys.ts`. */
  availableGlobals?: string[]
}

function GlobalScopesMatrix(props: GlobalScopesMatrixProps): React.ReactElement {
  const items = Array.isArray(props.availableGlobals) ? props.availableGlobals : []
  return (
    <ScopesTable
      path={props.path}
      items={items}
      actions={ACTIONS}
      actionLabels={ACTION_LABELS}
      itemHeader="Global"
      title="Global scopes"
      description='Check the actions this key may perform on each global. Globals only support Read and Update (singletons cannot be created or deleted). Only honoured when the preset is "Custom".'
      emptyMessage="No globals are available to scope. Add globals to your Payload config and restart the dev server."
    />
  )
}

export default GlobalScopesMatrix
