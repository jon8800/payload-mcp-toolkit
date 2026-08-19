import { describe, expect, it } from 'vitest'
import type { Config, PayloadRequest } from 'payload'
import { z } from 'zod'
import { mcpToolkitPlugin } from '../index'
import { buildScopeChecker, createInitializeServer } from '../registry'
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
 * so reading the real option values proves a custom tool was registered before
 * the snapshot — and proves the built-ins kept their slots.
 */
function toolOptions(cfg: Config): string[] {
  const keys = (cfg.collections ?? []).find((c) => c.slug === 'payload-mcp-api-keys')
  const fields = (keys?.fields ?? []) as Array<Record<string, unknown>>
  const collapsible = fields.find((f) => Array.isArray(f.fields) &&
    (f.fields as Array<{ name?: string }>).some((sub) => sub.name === 'toolAllow'))
  const toolAllow = ((collapsible?.fields ?? []) as Array<{ name?: string; options?: unknown }>)
    .find((f) => f.name === 'toolAllow')
  const options = (toolAllow?.options ?? []) as Array<{ value: string } | string>
  return options.map((o) => (typeof o === 'string' ? o : o.value))
}

describe('customTools', () => {
  it('registers a host tool and offers it as an API-key scope option', () => {
    const cfg = mcpToolkitPlugin({ customTools: [customTool('countMembers')] })(baseConfig())
    const options = toolOptions(cfg)
    expect(options).toContain('countMembers')
    // The custom tool goes on the end; every built-in keeps its slot.
    expect(options).toContain('findDocument')
    expect(options[options.length - 1]).toBe('countMembers')
  })

  it('leaves the built-in tools alone when no custom tools are passed', () => {
    const options = toolOptions(mcpToolkitPlugin()(baseConfig()))
    expect(options).toContain('findDocument')
    expect(options).not.toContain('countMembers')
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

  it('denies a collection-routed custom tool that carries no collection argument', () => {
    // The trap: a host tool declares collection routing but hard-codes its
    // target, so the scope check has nothing to read. Allowing it would walk
    // straight past the key's collection whitelist.
    const tool: ToolFactoryOutput = {
      ...customTool('countMembers'),
      parameters: { since: z.string().optional() },
    }
    const check = buildScopeChecker([tool])
    const scoped = { collections: { posts: ['read' as const] } }
    expect(check(scoped, 'countMembers', undefined).allowed).toBe(false)
    expect(check(scoped, 'countMembers', 'posts').allowed).toBe(true)
    expect(check(scoped, 'countMembers', 'memberships').allowed).toBe(false)
  })

  it('gates an account-routed custom tool by preset instead of a target', () => {
    const tool: ToolFactoryOutput = {
      ...customTool('countMembers'),
      routing: { kind: 'account', action: 'read' },
    }
    const check = buildScopeChecker([tool])
    expect(check({ preset: 'read-only' }, 'countMembers', undefined).allowed).toBe(true)
    // No preset and a collection-scoped key: an account tool would broaden the
    // surface, so it stays denied.
    expect(check({ collections: { posts: ['read'] } }, 'countMembers', undefined).allowed).toBe(
      false,
    )
  })

  it('runs a registered custom tool through the wrapper: scope check, then handler', async () => {
    const seen: Array<Record<string, unknown>> = []
    const tool: ToolFactoryOutput = {
      ...customTool('countMembers'),
      handler: async (args, req) => {
        seen.push({ collection: args.collection, stamped: req.context?.source })
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    }
    const registered = new Map<string, (args: Record<string, unknown>, extra: unknown) => Promise<unknown>>()
    const server = {
      registerTool: (name: string, _meta: unknown, fn: never) => registered.set(name, fn),
      registerPrompt: () => {},
      registerResource: () => {},
    }
    const req = {
      payload: { logger: {} },
      context: {},
      user: { _mcpKey: { keyId: 1, keyPrefix: null, scopes: { collections: { posts: ['read'] } } } },
    } as unknown as PayloadRequest

    createInitializeServer({ tools: [tool] })(req)(server as never)
    const call = registered.get('countMembers')!

    const denied = (await call({ collection: 'memberships' }, undefined)) as { isError?: boolean }
    expect(denied.isError).toBe(true)
    expect(seen).toHaveLength(0)

    const allowed = (await call({ collection: 'posts' }, undefined)) as { isError?: boolean }
    expect(allowed.isError).toBeUndefined()
    expect(seen).toEqual([{ collection: 'posts', stamped: 'mcp' }])
  })

  it('passes the request through to the handler', async () => {
    const tool = customTool('countMembers')
    const req = { payload: {} } as PayloadRequest
    const result = await tool.handler({ collection: 'users' }, req, undefined)
    expect(result.content[0].text).toBe('users')
  })
})
