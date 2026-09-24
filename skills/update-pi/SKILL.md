---
name: update-pi
description: Review, plan, and implement a bundled pi update with a user-approved migration spec and work log.
disable-model-invocation: true
---

# Update bundled pi

Review first, present an evidence-backed migration plan, and wait for user approval before implementing it. A green compiler is not a complete compatibility review.

## 1. Establish the versions

Read the repository instructions and `package.json`; inspect the worktree without changing existing work. Record the dependency range, exact locked and installed versions, and requested target including its `-fork.N` suffix. Verify the target exists in npm. Ask if the target is unspecified; do not silently select latest upstream or substitute the unforked package.

If the bump is already installed, recover the old version from the base lockfile and record current failures separately from known baseline results. Preserve the existing dependency-range policy unless the user requests a change.

Completion: old and target artifacts are identified, discrepancies are explained, and existing work is accounted for.

## 2. Review the actual change

Download both exact npm artifacts with `npm pack` into separate temporary directories and extract them there. Compare package metadata, declarations, and the changelog entries between the releases. Include the bundled/transitive pi packages when their types or behavior reach pictl. The published fork artifacts are authoritative; an upstream changelog alone misses fork behavior and packaging differences.

For runtime questions, compare the corresponding fork tags or commits in the pi source repository (normally `~/git/earendil-works/pi`). Verify the refs match the artifacts. Inspect focused source diffs rather than generated bundles when matching source is available; report unavailable evidence rather than assuming the checkout's HEAD matches. Keep that repository read-only: updating pictl does not authorize a fork rebase or publication.

Inventory pi imports, process invocations, and documented assumptions in pictl's source, extensions, scripts, and tests. Trace each relevant change to its consumers. Cover these seams:

- **RPC and CLI:** compare every command variant and its fields, response shapes, enum values, optional arguments, defaults, and validation. `src/core/rpc-commands.ts` promises a full mirror; its exhaustive route table catches new commands but not added optional fields or enum members omitted by local validation. Check generated help/completions and auditing too.
- **Fork contracts:** socket transport, subscribe seed and broadcasts, state folding, tree navigation, RPC image processing, and package exports. Consult `docs/pi-modifications.md` for pictl's dependency on the fork. The fork's `pi-tee-rebase` skill and validation notes can supply focused probes, but its git mutation instructions do not apply here.
- **Session and display:** entry/message unions, context projection versus raw history, compaction, branch navigation, filters, token/usage accounting, and stream control events. Trace shared conversion functions as well as formatters. Pi-aligned filters can drift without a type error. Distinguish displaying a context edit from applying it to model-visible history.
- **Lifecycle:** executable resolution, package layout, Node requirements, PTY invocation, flags/environment, trust and extension loading, socket readiness, signals/shutdown, persisted session paths, revival, and resume. Check runtime changes even when signatures are unchanged.
- **Behavior:** queue delivery, extension input hooks, retry/compaction timing, idle/turn-end semantics, and new background activity or network/cost defaults that affect observation or tests.

Read implicated files in full before editing. Classify each relevant finding as required adaptation, verification-only, optional improvement, or unresolved decision; cite the artifact/source and pictl consumer. Explicitly record reviewed seams with no required change. Separate pre-existing gaps from regressions introduced by the bump.

Completion: every relevant diff has a disposition, and unchecked assumptions are listed as risks rather than declared compatible.

## 3. Present the plan and stop

Write a living migration spec under `docs/specs/pi-updates/<target>.md` with three sections:

- **SPEC:** approved scope, measurable success criteria, behavior examples, and non-goals. Keep this stable during implementation; ask before revising scope or semantics.
- **IMPLEMENTATION IDEAS:** evidence, proposed approaches, open questions, and verification strategy. Update as discoveries refine the approach.
- **WORK LOG:** task checklist and append-only implementation history. Mark completed tasks with `[x]`; preserve earlier findings and record subsequent corrections explicitly.

Include:

- exact versions and evidence reviewed;
- relevant change → pictl impact → proposed action → verification;
- proposed subcommands, argument/flag/default changes, and rendering/filter semantics;
- ordered implementation steps, optional work kept separate, and open decisions;
- offline checks and a minimal real-process verification matrix.

Begin WORK LOG with: “Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.” Before approval, keep proposals in IMPLEMENTATION IDEAS rather than presenting them as approved SPEC requirements.

Summarize it to the user and request approval. If the initial request only authorized a version bump, that is not approval for all newly discovered behavior choices. Do not implement optional refactors as part of compatibility work.

## 4. Implement the approved scope

Update dependency and lockfile together if not already done. Confirm the installed and locked exact versions are the approved target. Review lockfile churn, including directly consumed transitive dependencies and unrelated updates.

Make one logical adaptation at a time and run focused tests. After each step—not just at the end—update IMPLEMENTATION IDEAS with discoveries and append progress, test results, and problems to WORK LOG. Record non-obvious choices under `Implementation-Time Decisions`, including rationale and alternatives. If evidence contradicts the approved spec, stop that part of implementation and return to the user.

Preserve exhaustive type checks and intentional functionality; address new variants explicitly rather than hiding failures with casts or catch-all returns. Add regression tests for new CLI inputs, message/entry shapes, and changed semantic assumptions. Use pi's canonical conversion where pictl promises model-context parity rather than duplicating it.

Run the repository's current type, lint, formatting, test, and build checks from `package.json`. Review changed API snapshots and documentation when relevant. Passing old tests is evidence only for the cases they actually cover.

## 5. Verify runtime assumptions and report

Exercise the installed bundled executable, not a global pi or an unnoticed `PICTL_PI_BIN` override. Propose isolated real-process checks for spawn → socket readiness → subscribe/state → shutdown and persisted-session revival, plus cases implicated by the diff. Await observable conditions with deadlines rather than fixed sleeps.

Use temporary pictl/pi state and a controlled working directory with extensions disabled unless they are the subject of the test. Ask before provider calls, credential copying, or tests that can spend money or affect existing agents. State assertions and time/cost limits; report skipped checks and their residual risks. Keep credentials and private transcripts out of reports.

Update the report with implemented/deferred decisions, checks and outcomes, and remaining uncertainty. Leave git staging and commits to the user unless explicitly requested.
