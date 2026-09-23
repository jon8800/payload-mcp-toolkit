# Connect Claude with a website account

OAuth is optional. Existing API keys continue to work. Users add the connector in Claude, sign into your website, and approve access.

## Host setup

```ts
mcpToolkitPlugin({
  oauth: {
    // Required: use your own staff-access policy. Do not allow every member.
    canAuthorize: ({ user }) => user?.role === 'super-admin',
    access: 'editor', // default: 'read-only'
  },
})
```

Set Payload `serverURL` to your public HTTPS origin. HTTP loopback URLs work for local checks. The API route must remain `/api`.

By default, sign-in uses Payload's admin login. For a custom website login:

```ts
loginURL: (returnTo) => `/login?redirect=${encodeURIComponent(returnTo)}`
```

Your login page must return to the supplied same-origin path after sign-in. The account must belong to the plugin's configured user collection. The policy runs again when users approve access, refresh tokens, or make MCP requests.

Payload custom endpoints cannot serve root discovery URLs. Add these rewrites to your host's `next.config` alongside its existing rewrites:

```js
async rewrites() {
  return [
    { source: '/.well-known/oauth-authorization-server', destination: '/api/mcp/oauth/metadata' },
    { source: '/.well-known/oauth-protected-resource', destination: '/api/mcp/oauth/resource' },
    { source: '/.well-known/oauth-protected-resource/api/mcp', destination: '/api/mcp/oauth/resource' },
  ]
}
```

Enabling OAuth adds the private `payload-mcp-oauth` collection. Generate and review a Payload migration in the host application before production deployment. Keep its unique `key` constraint: it prevents concurrent code redemption and refresh replay. Do not run migrations against a local database configured with `push: true`.

The plugin adds an admin dashboard banner pointing to `/api/mcp/oauth/connections`. Regenerate the host's Payload import map after upgrading. Consent and connection management use custom Payload admin views at `/admin/mcp-authorize` and `/admin/mcp-connections` (respecting your configured admin route). They inherit the admin theme, fonts and CSS variables and use Payload UI buttons and banners. Users need access to the Payload admin, in addition to passing `canAuthorize`.

The setup page shows the connector URL and agent instructions, each with a Copy button. Users paste the instructions into their AI app, for example as Claude project instructions. The instructions tell the assistant how to connect, what the site's access level allows, and to ask before each change. Accounts that fail `canAuthorize` see a notice instead of the setup steps. Users can also disconnect their grants there. You can link to this page from your own dashboard too. Pasted instructions do not install a connector: the user still adds the connector and approves access.

ChatGPT is not supported yet. Its connector needs RFC 9207 issuer identification or a per-connection callback URL, and this release supports neither.

Keep the consent view protected against framing. Add these headers to the host's existing Next.js headers configuration, using your configured admin path:

```js
async headers() {
  return [{ source: '/admin/mcp-:view', headers: [
    { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
    { key: 'Referrer-Policy', value: 'same-origin' },
  ] }]
}
```

The authenticated data endpoints return JSON only with `Accept: application/json` and never cache consent data. Browser navigation redirects into the admin view. Approval and revocation still use the server's signed consent and origin checks.

If your existing policy restricts `form-action`, allow your trusted OAuth callback origins too. Browsers can enforce that directive on the approval redirect back to Claude.

## Claude Desktop trial

1. Deploy the host with the plugin, migration, and discovery rewrites.
2. Open `https://YOUR-SITE/.well-known/oauth-authorization-server`. Confirm it returns JSON with your HTTPS issuer.
3. In Claude Desktop, open **Settings → Connectors → Add custom connector**.
4. Enter `https://YOUR-SITE/api/mcp`. No API key or client secret is needed.
5. Sign into your website. Check the account and permissions shown. Click **Allow access**.
6. Ask: “List the content I can access. Do not change anything yet.”
7. Open `/api/mcp/oauth/connections`, disconnect Claude, and confirm another tool request requires authorization again.

Claude's remote connector runs through its cloud infrastructure. A localhost URL alone is insufficient for this trial. Use a deployed HTTPS test host. The dev app demonstrates the routes and sign-in flow locally.

The default trusted callbacks are `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`. Dynamic registration accepts one exact trusted callback per public client. Client IDs are stable per callback and installation, with no client secret. To support another client, provide its exact callback in `oauth.redirectURIs`. Wildcards and arbitrary client-metadata URL fetching are not supported.

## Permissions and lifecycle

- `mcp:read` uses the existing read-only preset.
- `mcp:write` is available when `access: 'editor'`. It permits collection reads, creates and updates. Globals remain read-only. Delete remains denied. The MCP `401` challenge then asks for `mcp:read mcp:write`, so clients request write access on first connection.
- Existing Payload access controls and plugin exclusions still apply. Custom tools must enforce Payload access with `overrideAccess: false`.
- Authorization codes expire after five minutes and require PKCE S256. Approval forms expire after ten minutes.
- Access tokens expire after one hour. Grants and rotating refresh tokens expire after 30 days. Reusing a consumed code or refresh token revokes its grant.
- OAuth bearer tokens authenticate only the MCP endpoint. They cannot authenticate Payload REST requests or approve another grant.
- Only token hashes are stored. Website passwords remain in your existing sign-in flow.
- Removing user eligibility or deleting the user blocks further MCP requests. Disconnecting blocks all tokens for that grant.
- Run `pruneOAuthRecords(payload)` periodically from your existing scheduler. It deletes expired records. Keep unexpired consumption claims intact.
- Apply request/body limits and rate limits at your existing reverse proxy, especially for sign-in and OAuth endpoints. Do not log token or consent bodies.

Sources: [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [Claude connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [Claude connector implementation](https://support.anthropic.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers).
