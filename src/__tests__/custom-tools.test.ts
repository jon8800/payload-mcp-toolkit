import { describe, expect, it } from 'vitest'
import type { Config, PayloadRequest } from 'payload'
import { z } from 'zod'
import { mcpToolkitPlugin } from '../index'
import { assertNoToolNameConflict } from '../conflict-detection'
import type { ToolFactoryOutput } from '../registry'

function baseConfig(): Config {
  return {
    serverURL: 'https://app.example.com',
    secret: 'test-secret',
    admin: { user: 'users' },
    collections: [
      { slug: 'users', auth: true, fields: [{ name: 'email', type: 'email', required: true }] },
      { slug: 'posts', fields: [{ name: 'title', type: 'text' }] },
    ],
    endpoints: [],
  } as never
}

function customTool(name: string): ToolFactoryOutput {
  return {
    name,
    description: 'A host-supplied tool.',
    parameters: { collection: z.string() },
    routing: { kind: 'collection', action: 'read' },
    handler: async (args) => ({ content: [{ type: 'text', text: String(args.collection) }] }),
  }
}

/**
 * The api-keys collection's tool dropdowns are built from the final tool list,
 * so finding a custom name there proves it was registered before the snapshot.
 */
function toolOptions(cfg: Config): string[] {
  const keys = (cfg.collections ?? []).find((c) => c.slug === 'payload-mcp-api-keys')
  const json = JSON.stringify(keys)
  return json.includes('"countMembers"') ? ['countMembers'] : []
}

describe('customTools', () => {
  it('registers a host tool and offers it as an API-key scope option', () => {
    const cfg = mcpToolkitPlugin({ customTools: [customTool('countMembers')] })(baseConfig())
    expect(toolOptions(cfg)).toContain('countMembers')
  })

  it('leaves the built-in tools alone when no custom tools are passed', () => {
    const cfg = mcpToolkitPlugin()(baseConfig())
    expect(toolOptions(cfg)).toHaveLength(0)
  })

  it('throws when a custom tool shadows a built-in name', () => {
    expect(() =>
      mcpToolkitPlugin({ customTools: [customTool('findDocument')] })(baseConfig()),
    ).toThrow(/reuses a built-in tool name/)
  })

  it('throws on two custom tools with the same name', () => {
    expect(() => assertNoToolNameConflict([], [customTool('dup'), customTool('dup')])).toThrow(
      /two entries named "dup"/,
    )
  })

  it('passes the request through to the handler', async () => {
    const tool = customTool('countMembers')
    const req = { payload: {} } as PayloadRequest
    const result = await tool.handler({ collection: 'users' }, req, undefined)
    expect(result.content[0].text).toBe('users')
  })
})
