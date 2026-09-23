import { withPayload } from '@payloadcms/next/withPayload'

/** @type {import('next').NextConfig} */
const nextConfig = {
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
  webpack: (webpackConfig) => {
    webpackConfig.resolve.extensionAlias = {
      '.cjs': ['.cts', '.cjs'],
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    }
    return webpackConfig
  },
}

export default withPayload(nextConfig, { devBundleServerPackages: false })
