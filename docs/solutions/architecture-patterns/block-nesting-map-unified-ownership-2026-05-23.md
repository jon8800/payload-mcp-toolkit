---
title: Unify composition-lookup maps across resource kinds via a discriminated ownerType and a collision-detection invariant
date: 2026-05-23
category: docs/solutions/architecture-patterns
module: payload-mcp-toolkit
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - Validating composed structures (blocks, slots, nested layouts) that can be owned by multiple resource kinds (collections, globals, blocks themselves)
  - Choosing between one unified lookup map vs. one map per owner kind for an introspection layer that downstream code does a single lookup against
  - Designing introspection data structures where the keyspace is implicitly shared (e.g. slug strings) and silent collisions would corrupt validator behaviour
tags: [payload-cms, introspection, block-composition, ownership-discriminator, invariant-checks]
---

# Unify composition-lookup maps across resource kinds via a discriminated `ownerType` and a collision-detection invariant

## Context

`BlockNestingMap` records, for every `blocks`-typed field anywhere in the schema, `{owner, ownerType, fieldPath, acceptedBlockSlugs, maxRows}`. The validator in `patchLayout` looks up `<owner>.<fieldPath>` and recurses. v0.3 introduced this with `ownerType: 'collection' | 'block'`. v0.6 added globals.

The intuitive design choice was a parallel map: `BlockNestingMap` for collections+blocks, `GlobalBlockNestingMap` for globals. `patchLayout` would query the first, `patchGlobalLayout` the second. The map shapes are identical, so the duplication felt cheap.

It wasn't. Two problems:

1. **The `blocks://nesting` MCP resource exposes the map verbatim to AI clients.** Two resources (`blocks://nesting` and `globals://blocks-nesting`) would force the AI to query both before composing, with no benefit — they answer the same question. One resource is honest about the underlying schema model: every `blocks`-typed field has a position, regardless of where in the tree that position sits.
2. **`patchLayout` and `patchGlobalLayout` share a validator (`validateBlockList`).** A unified map lets them share the lookup function unchanged; two maps would force a dispatch parameter that every recursive call has to thread.

But unifying introduces a subtle risk that two separate maps don't have: Payload allows a collection slug and a global slug to coexist if they're spelled differently, but doesn't enforce uniqueness across collections × globals × block slugs in the toolkit's combined keyspace. A `(owner, fieldPath)` collision between resource kinds would silently pick the first match and corrupt validator behaviour with no diagnostic.

## Guidance

**Use one unified map with a discriminated ownership tag, AND add a runtime invariant check that throws on `(owner, fieldPath)` collisions across different `ownerType` values.**

```ts
export interface BlockNestingEdge {
  owner: string                                       // collection / global / block slug
  ownerType: 'collection' | 'block' | 'global'        // discriminator
  fieldPath: string                                   // e.g. 'layout' or 'header.links'
  acceptedBlockSlugs: string[]
  maxRows?: number
}

function assertBlockNestingMapInvariant(edges: BlockNestingMap): void {
  const seen = new Map<string, BlockNestingEdge['ownerType']>()
  for (const edge of edges) {
    const key = `${edge.owner}.${edge.fieldPath}`
    const prior = seen.get(key)
    if (prior && prior !== edge.ownerType) {
      throw new Error(
        `Block-nesting map invariant violated: "${key}" appears as both ` +
        `"${prior}" and "${edge.ownerType}". A collection and a global cannot ` +
        `share a slug; rename one.`,
      )
    }
    seen.set(key, edge.ownerType)
  }
}
```

Called once at the tail of `buildBlockNestingMap`, so a misconfigured host fails plugin boot with an actionable message naming both the colliding key and the conflicting kinds. Same-`ownerType` duplicates are allowed (the builder may legitimately emit the same edge twice for a multi-rooted walk) — the invariant only fires on cross-kind collisions, which are the corrupting case.

### Why one map, not two

- **Schema honesty.** Payload's actual model is "every `blocks`-typed field has a position." A single map mirrors that 1:1. Two maps impose an external taxonomy ("collection-rooted" vs. "global-rooted") that the schema itself doesn't carry.
- **Validator reuse.** `validateBlockList` recurses without caring which kind it started from. Two maps would either duplicate the recursion or thread a "which map?" parameter through every call.
- **Resource surface.** One `blocks://nesting` MCP resource for AI clients to consult before composing. Two resources would be a leaky abstraction over the unified validation rule.
- **No measurable cost.** The map is built once at plugin init from a finite schema. The discriminator field is 5 bytes per edge.

### Why the invariant is non-optional

Without the assertion, a collection slug colliding with a global slug (which Payload's slug registry should — but doesn't always — prevent) produces a silent first-match win in `Map.get`. The validator would accept blocks at one owner's positions when called for the other, with no error and no log. The throw at boot is the only place this surfaces before a user-visible data corruption.

The same pattern applies to any introspection map where:
- The keyspace is a string-based identifier the host framework doesn't strictly enforce uniqueness on.
- Downstream code does single-key lookups (so collisions silently resolve, rather than producing duplicate-key errors).
- Different `ownerType` values would imply different validation rules.

## How to Apply

**When adding a 4th `ownerType`** (e.g. `'field-group'` for reusable field groups that themselves contain blocks):

1. Widen `BlockNestingEdge['ownerType']`.
2. Add a walker for the new owner kind (`collectBlocksFieldEdges(...)` already takes an `ownerType` arg; reuse it).
3. The invariant picks up the new kind automatically — no changes to `assertBlockNestingMapInvariant`. Add one test case for the new collision permutation.

**When porting to a different composition system** (slot-based UIs, schema validators with named refs):

- Keep one map, not N.
- Tag every edge with the `ownerType` it came from.
- Run a collision assertion at construction time.
- Expose the map verbatim to downstream consumers; don't synthesise a different shape for each consumer.

**When evaluating an existing two-map design:** unify if (a) consumers always merge the maps before lookup, or (b) the validator/walker would be identical against either map. Keep separate if the validation rules genuinely differ per kind (rare; usually a sign that the kinds are doing different things and the lookup keyspace isn't actually shared).

## Why This Matters

The single most expensive class of introspection bug is the silent-wrong-answer kind: the lookup returns *something*, the validator accepts the *something*, and the corruption surfaces three deploys later as "why is this global accepting block types that aren't in its allow list?" The invariant turns that class of bug into a boot-time error with the offending slug pair named.

Unifying the map also keeps the AI-facing surface honest. `payload-mcp-toolkit`'s downstream consumer is an LLM that reads `blocks://nesting` and composes layouts against it. Two resources answering "where can blocks go?" with overlapping but non-identical scopes is exactly the kind of inconsistency that produces hallucinated compositions Payload then rejects.

## Related

- [[payload-plugin-config-inference-2026-05-04]] — established `BlockNestingEdge` as the schema-mirroring data structure. This solution extends `ownerType` and adds the cross-kind invariant.
- [[multi-resource-scope-routing-2026-05-23]] — companion pattern for the scope-evaluation layer; both share the "different resource kinds, one validation pathway, fail-closed on ambiguity" stance.
- `src/introspection.ts` — `buildBlockNestingMap`, `assertBlockNestingMapInvariant`.
- `src/tools/patch-layout.ts`, `src/tools/patch-global-layout.ts` — the two callers that share the unified lookup.
