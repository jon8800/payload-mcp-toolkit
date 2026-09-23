'use client'

import React, { useEffect, useState } from 'react'
import { Banner, Button, Gutter } from '@payloadcms/ui'
import { agentInstructions } from './agentInstructions'
import './oauth.css'

type Consent = { consent: string; clientName: string; account: string; scope: string }
type Connections = { resource: string; access: 'read-only' | 'editor'; eligible: boolean; grants: Omit<Consent, 'account'>[] }

function CopyButton({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState('')
  async function copy() {
    setStatus('')
    try {
      await navigator.clipboard.writeText(text)
      setStatus('Copied.')
    } catch {
      setStatus('Copy failed. Select the text and copy it.')
    }
  }
  return (
    <div className="mcp-oauth__copy">
      <Button type="button" buttonStyle="secondary" size="small" margin={false} onClick={copy}>{label}</Button>
      <span role="status">{status}</span>
    </div>
  )
}

export function OAuthView({ mode }: { mode: 'authorize' | 'connections' }) {
  const [data, setData] = useState<Consent | Connections | null>(null)
  const [error, setError] = useState('')
  const endpoint = `/api/mcp/oauth/${mode}`

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch(`${endpoint}${window.location.search}`, {
          headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        })
        if (response.redirected) {
          const destination = new URL(response.url)
          if (destination.origin === window.location.origin) window.location.assign(destination.href)
          return
        }
        if (!response.ok) {
          setError(response.status === 403 ? 'Your account cannot authorize this connection.' : 'This request could not be loaded. Start the connection again from your AI app.')
          return
        }
        setData(await response.json())
      } catch {
        if (!controller.signal.aborted) setError('The connection could not be loaded. Check your connection and reload this page.')
      }
    }
    void load()
    return () => controller.abort()
  }, [endpoint])

  const approval = data && 'account' in data ? data : null
  const connections = data && 'grants' in data ? data : null
  const instructions = connections ? agentInstructions(connections.resource, connections.access) : ''

  return (
    <Gutter>
      <main className="mcp-oauth">
        <h1>{mode === 'authorize' ? 'Connect your account' : 'AI connections'}</h1>
        {error ? <Banner type="error"><span role="alert">{error}</span></Banner> : !data ? <p role="status">Loading connection…</p> : null}
        {approval && (
          <>
            <p><strong>{approval.clientName}</strong> is requesting access to your website account.</p>
            <dl className="mcp-oauth__details">
              <dt>Signed in as</dt><dd>{approval.account}</dd>
              <dt>Permissions</dt><dd>{approval.scope.split(' ').includes('mcp:write') ? 'Read content. Create and update collection entries. Global settings remain read-only.' : 'Read content.'} Your website permissions still apply. Deleting content is not allowed.</dd>
              <dt>Duration</dt><dd>Up to 30 days. You can disconnect at any time.</dd>
            </dl>
            <form action={endpoint} method="post" className="mcp-oauth__actions">
              <input type="hidden" name="consent" value={approval.consent} />
              <Button type="submit" margin={false} extraButtonProps={{ name: 'decision', value: 'allow' }}>Allow access</Button>
              <Button type="submit" buttonStyle="secondary" margin={false} extraButtonProps={{ name: 'decision', value: 'deny' }}>Cancel</Button>
            </form>
          </>
        )}
        {connections && (
          <>
            {connections.eligible ? (
              <>
                <p>Add this URL as a custom connector in your AI app. Then sign in and approve access.</p>
                <ul>
                  <li><strong>Claude:</strong> Settings → Connectors → Add custom connector.</li>
                  <li><strong>ChatGPT (web):</strong> turn on Developer mode in Settings, then create an app with this URL and OAuth sign-in.</li>
                </ul>
                <code className="mcp-oauth__url">{connections.resource}</code>
                <CopyButton text={connections.resource} label="Copy URL" />
                <h2>Agent instructions</h2>
                <p>Paste these into your AI app, for example as project instructions. They tell the assistant how to connect and how to work with your content.</p>
                <pre className="mcp-oauth__instructions">{instructions}</pre>
                <CopyButton text={instructions} label="Copy instructions" />
              </>
            ) : <p>Your account cannot connect AI apps. Ask a site administrator for access.</p>}
            <h2>Connected apps</h2>
            {connections.grants.length ? connections.grants.map(grant => (
              <div className="mcp-oauth__connection" key={grant.consent}>
                <div><strong>{grant.clientName}</strong><p>{grant.scope.split(' ').includes('mcp:write') ? 'Read, create and update content' : 'Read content'}</p></div>
                <form action={endpoint} method="post">
                  <input type="hidden" name="consent" value={grant.consent} />
                  <Button type="submit" buttonStyle="secondary" margin={false}>Disconnect</Button>
                </form>
              </div>
            )) : <p>No active connections.</p>}
          </>
        )}
      </main>
    </Gutter>
  )
}
