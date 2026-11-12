import { withPayload } from '@payloadcms/next/withPayload'

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next 16.4 writes an AGENTS.md into the app folder by default.
  agentRules: false,
  // The source imports `./x.js` for plain Node ESM, and Turbopack does not map
  // those to the `.ts` files. So the dev app runs the built `dist`, the same
  // files hosts get. `pnpm dev` builds first.
  turbopack: {
    resolveAlias: {
      'payload-mcp-toolkit': '../dist/index.js',
      'payload-mcp-toolkit/client': '../dist/components/index.js',
    },
  },
  async redirects() {
    return [{ source: '/', destination: '/admin', permanent: false }]
  },
  async headers() {
    return [{ source: '/admin/mcp-:view', headers: [
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
      { key: 'Referrer-Policy', value: 'same-origin' },
    ] }]
  },
  async rewrites() {
    return [
      { source: '/.well-known/oauth-authorization-server', destination: '/api/mcp/oauth/metadata' },
      { source: '/.well-known/oauth-protected-resource', destination: '/api/mcp/oauth/resource' },
      { source: '/.well-known/oauth-protected-resource/api/mcp', destination: '/api/mcp/oauth/resource' },
    ]
  },
}

export default withPayload(nextConfig, { devBundleServerPackages: false })
