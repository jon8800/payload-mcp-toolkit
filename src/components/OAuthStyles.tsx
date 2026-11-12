import React from 'react'

// Rendered as a React 19 hoisted <style>, not imported as a .css file: Node ESM
// cannot load .css imports, and hosts may load this package without a bundler.
const css = `
.mcp-oauth {
  max-width: 42rem;
  margin: calc(var(--spacer-4) * 3) auto;
  color: var(--color-text);
  font-family: var(--font-body);
}

/* Payload 4's preflight resets headings and lists, so the screen sets them with Payload's own type tokens. */
.mcp-oauth h1 { margin: 0 0 var(--spacer-4); font-size: var(--text-heading-xl-font-size); font-weight: var(--text-heading-xl-font-weight); line-height: var(--text-heading-xl-line-height); letter-spacing: var(--text-heading-xl-letter-spacing); }
.mcp-oauth h2 { margin: calc(var(--spacer-4) * 2) 0 var(--spacer-2); font-size: var(--text-heading-large-font-size); font-weight: var(--text-heading-large-font-weight); line-height: var(--text-heading-large-line-height); letter-spacing: var(--text-heading-large-letter-spacing); }
.mcp-oauth h3 { font-size: var(--text-heading-small-font-size); font-weight: var(--text-heading-small-font-weight); line-height: var(--text-heading-small-line-height); }
.mcp-oauth p { margin: 0 0 var(--spacer-2); font-size: var(--text-body-large-font-size); line-height: 1.6; }
.mcp-oauth ul { margin: 0 0 var(--spacer-3); padding-left: var(--spacer-4); list-style: disc; font-size: var(--text-body-large-font-size); line-height: 1.6; }

.mcp-oauth__details {
  margin: calc(var(--spacer-4) * 1.5) 0;
  padding: var(--spacer-4);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-medium);
}

.mcp-oauth__details dt { font-weight: var(--text-body-large-bold-font-weight); }
.mcp-oauth__details dd { margin: calc(var(--spacer-4) * .25) 0 var(--spacer-4); line-height: 1.6; overflow-wrap: anywhere; }
.mcp-oauth__details dd:last-child { margin-bottom: 0; }
.mcp-oauth__actions { display: flex; flex-wrap: wrap; gap: calc(var(--spacer-4) * .5); }
.mcp-oauth__permissions { display: flex; flex-direction: column; gap: var(--spacer-4); margin-bottom: calc(var(--spacer-4) * 1.5); }
.mcp-oauth__permissions h3 { margin: var(--spacer-4) 0 calc(var(--spacer-4) * .5); }
.mcp-oauth__permissions h3:first-child { margin-top: 0; }
.mcp-oauth__permissions p { margin: 0 0 calc(var(--spacer-4) * .5); color: var(--color-text-secondary); }
.mcp-oauth__customize {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-medium);
}
.mcp-oauth__customize > summary {
  display: flex;
  flex-direction: column;
  gap: calc(var(--spacer-4) * .15);
  padding: calc(var(--spacer-4) * .75) var(--spacer-4);
  cursor: pointer;
  list-style: none;
}
.mcp-oauth__customize > summary::-webkit-details-marker { display: none; }
/* The second value is the arrow's alt text: empty, so screen readers skip it. */
.mcp-oauth__customize > summary strong::after { content: ' ▸'; content: ' ▸' / ''; color: var(--color-text-secondary); }
.mcp-oauth__customize[open] > summary strong::after { content: ' ▾'; content: ' ▾' / ''; }
.mcp-oauth__customize > summary span { color: var(--color-text-secondary); font-size: var(--text-body-medium-font-size); }
.mcp-oauth__customize > summary:focus-visible { outline: var(--accessibility-outline); outline-offset: var(--accessibility-outline-offset); }
.mcp-oauth__customize[open] > summary { border-bottom: 1px solid var(--color-border); }
.mcp-oauth__customize-body { padding: var(--spacer-4); }
.mcp-oauth__tools { display: grid; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); gap: calc(var(--spacer-4) * .5) var(--spacer-4); }
.mcp-oauth__url { display: block; padding: var(--spacer-4); background: var(--color-bg-secondary); overflow-wrap: anywhere; }
.mcp-oauth__instructions {
  margin: 0;
  padding: var(--spacer-4);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-medium);
  font-family: var(--font-mono);
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.mcp-agent-pill {
  display: flex;
  align-items: stretch;
  max-width: 100%;
  margin: calc(var(--spacer-4) * .5) 0;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  transition: background-color 120ms ease-out, border-color 120ms ease-out;
}
.mcp-agent-pill:hover { background: var(--color-bg-secondary); border-color: var(--color-border-control-strong); }
.mcp-agent-pill button {
  appearance: none;
  background: none;
  border: 0;
  color: inherit;
  cursor: pointer;
  font: inherit;
}
.mcp-agent-pill button:focus-visible { outline: var(--accessibility-outline); outline-offset: var(--accessibility-outline-offset); }
.mcp-agent-pill__copy {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  gap: calc(var(--spacer-4) * .35);
  min-width: 0;
  padding: calc(var(--spacer-4) * .35) calc(var(--spacer-4) * .2) calc(var(--spacer-4) * .35) calc(var(--spacer-4) * .6);
  color: var(--color-text) !important;
  font-size: var(--text-body-medium-font-size) !important;
  line-height: 1.2;
  border-radius: 999px 0 0 999px;
}
.mcp-agent-pill__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcp-agent-pill__mark { flex-shrink: 0; width: 14px; height: 14px; }
.mcp-agent-pill__dismiss {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  padding: 0 calc(var(--spacer-4) * .3) 0 calc(var(--spacer-4) * .15);
  color: var(--color-icon-tertiary) !important;
  border-radius: 0 999px 999px 0;
}
.mcp-agent-pill__dismiss:hover { color: var(--color-text) !important; }
.mcp-agent-pill__dismiss svg { width: 16px; height: 16px; }
@media (prefers-reduced-motion: reduce) { .mcp-agent-pill { transition: none; } }

.mcp-oauth__copy { display: flex; flex-wrap: wrap; align-items: center; gap: calc(var(--spacer-4) * .5); margin: calc(var(--spacer-4) * .5) 0 var(--spacer-4); }
.mcp-oauth__connection { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--spacer-4); padding: var(--spacer-4) 0; border-top: 1px solid var(--color-border); }
.mcp-oauth__connection p { margin: 0; }
`

export function OAuthStyles() {
  return (
    <style href="payload-mcp-toolkit-oauth" precedence="default">
      {css}
    </style>
  )
}
