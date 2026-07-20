# Handoff: harden pictl's RPC response serialization (crash class found in clauctl)

## What happened (in clauctl)

clauctl's daemon crashed whenever a client requested `get-tree` on a long
session (5213 entries). Root cause, two layers:

1. **Wire shape**: the session tree was serialized as _nested_ JSON — one
   nesting level per entry on a mostly-linear session. `JSON.stringify`
   overflows the call stack near depth ~5000 (Node 23); `JSON.parse` survives
   6000+, so the writer dies before any reader could.
2. **No serialization guard**: the daemon's socket `respond()` called
   `JSON.stringify(response)` bare. The `RangeError: Maximum call stack size
   exceeded` propagated out of the request handler path and killed the whole
   daemon — one bad response, every client's agent gone.

## The fix pattern (apply the equivalent in pictl)

1. `respond()` wraps `JSON.stringify` in try/catch; on failure it sends a
   per-request error response built only from safe scalars:

   ```ts
   const respond = (response: SdkResponse): void => {
     let line: string;
     try {
       line = JSON.stringify(response);
     } catch (error) {
       const failure: SdkResponse = {
         id: response.id,
         ok: false,
         error: `response serialization failed: ${String(error)}`,
       };
       line = JSON.stringify(failure);
     }
     connection.write(`${line}\n`);
   };
   ```

   The client gets a request rejection; the daemon keeps serving.

2. **Never put recursion-depth-proportional nesting on the wire.** clauctl
   replaced the nested tree with a flat parent relation
   (`Map<occurrenceKey, {ref, parent}>` serialized as entries + a leaf
   pointer); clients rebuild structure locally. If pictl serializes any
   session-tree/AST-like structure whose depth grows with session length,
   the same overflow is latent.

## Why this matters for pictl

pictl's daemon/server presumably has the same shape: a socket loop that
`JSON.stringify`s handler results. Any handler that can return a cyclic,
deeply nested, or otherwise unserializable value is a daemon-wide crash.
Check every `JSON.stringify` on the response path.

## Test pattern

clauctl pinned it with one test (`src/core/daemon/sdk-server.test.ts` in the
clauctl repo, branch `tree-refactor`): a handler returns a cyclic object for
one request type; assert the request rejects with
`/response serialization failed/` AND a subsequent request on the same
connection still succeeds.

## References (clauctl repo, branch tree-refactor)

- `docs/specs/session-snapshot-and-forest.md` — full spec incl. crash
  mechanics and the flat-forest design.
- `src/core/daemon/sdk-server.ts` — hardened `respond()`.
- `src/core/tree.ts` — flat `Forest` types.

## Suggested skills

- `/spec` if the pictl change grows beyond a mechanical respond() guard (e.g.
  a wire-format change).
- `/reviewer` for a fresh-context review of the fix.
