'use client'

import * as React from 'react'
import { ScopesTable } from './ScopesTable'

const ACTIONS = ['read', 'create', 'update', 'delete']
const ACTION_LABELS: Record<string, string> = {
  read: 'Read',
  create: 'Create',
  update: 'Update',
  delete: 'Delete',
}

export interface CollectionScopesMatrixProps {
  path: string
  /** Forwarded via `clientProps` from `api-keys.ts`. */
  availableCollections?: string[]
}

function CollectionScopesMatrix(props: CollectionScopesMatrixProps): React.ReactElement {
  const items = Array.isArray(props.availableCollections) ? props.availableCollections : []
  return (
    <ScopesTable
      path={props.path}
      items={items}
      actions={ACTIONS}
      actionLabels={ACTION_LABELS}
      itemHeader="Collection"
      title="Collection scopes"
      description='Check the actions this key may perform on each collection. Unchecked rows are denied outright. Configured under the "Custom" preset; once set, these overrides apply to this key regardless of which preset is later selected.'
      emptyMessage="No collections are available to scope. Add collections to your Payload config and restart the dev server."
    />
  )
}

export default CollectionScopesMatrix
