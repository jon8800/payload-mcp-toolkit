/** Plain-text instructions a user pastes into an AI app (for example as project instructions). */
export function agentInstructions(resource: string, access: 'read-only' | 'editor'): string {
  const editor = access === 'editor'
  const rules = editor
    ? [
      'Start by listing the content you can access. Do not change anything yet.',
      'Read a document before you change it.',
      'Before you create or update anything, show me the change and wait for my approval.',
      'Save changes as drafts where the collection supports drafts. Publish only when I ask.',
      'After each change, tell me which document changed and what changed.',
    ]
    : [
      'Start by listing the content you can access.',
      'Do not try to change content. If I ask for a change, tell me which document and field to edit.',
    ]
  return [
    `You help me manage the content of ${new URL(resource).host} through its MCP connector.`,
    '',
    'Connection',
    `- Connector URL: ${resource}`,
    '- Sign-in: OAuth with my website account. No API key or client secret is necessary.',
    '- If you cannot see tools from this connector, stop. Tell me to add a custom connector with the URL above, sign in and approve access. In Claude: Settings > Connectors > Add custom connector.',
    '',
    'Access',
    editor
      ? '- You can read content and create or update collection entries. Global settings are read-only.'
      : '- You can read content only.',
    '- You cannot delete content. My website permissions still apply.',
    `- Access lasts up to 30 days. I can disconnect at ${resource}/oauth/connections.`,
    '',
    'How to work',
    ...rules.map((rule, index) => `${index + 1}. ${rule}`),
    `${rules.length + 1}. If a tool call fails because of authorization, tell me to reconnect. Do not retry.`,
  ].join('\n')
}
