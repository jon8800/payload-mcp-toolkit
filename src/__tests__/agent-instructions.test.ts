import { describe, expect, it } from 'vitest'
import { agentInstructions } from '../components/agentInstructions'

describe('agentInstructions', () => {
  const resource = 'https://app.example.com/api/mcp'

  it('names the connector, sign-in and disconnect page', () => {
    const text = agentInstructions(resource, 'read-only')
    expect(text).toContain('content of app.example.com')
    expect(text).toContain(`Connector URL: ${resource}`)
    expect(text).toContain('No API key or client secret')
    expect(text).toContain(`${resource}/oauth/connections`)
  })

  it('matches the rules to the access level', () => {
    const readOnly = agentInstructions(resource, 'read-only')
    expect(readOnly).toContain('You can read content only.')
    expect(readOnly).not.toContain('drafts')
    expect(readOnly).toMatch(/^3\. If a tool call fails/m)
    const editor = agentInstructions(resource, 'editor')
    expect(editor).toContain('create or update collection entries. Global settings are read-only.')
    expect(editor).toContain('wait for my approval')
    expect(editor).toMatch(/^6\. If a tool call fails/m)
  })
})
