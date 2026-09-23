'use client'

import React from 'react'

export function OAuthConnectBanner() {
  return (
    <section style={{ padding: '1.5rem', marginBottom: '2rem', border: '1px solid var(--theme-elevation-150)', borderRadius: 'var(--style-radius-m)' }}>
      <h2 style={{ margin: '0 0 .5rem' }}>Connect your AI assistant</h2>
      <p>Connect Claude with your website account. Review access before you approve it.</p>
      <a href="/api/mcp/oauth/connections">Set up or manage connections →</a>
    </section>
  )
}
