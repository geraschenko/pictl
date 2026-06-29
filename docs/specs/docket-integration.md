# SPEC

> **Status: provisional.** This spec captures our agreed direction for using `docket` to build pictl's async orchestration skill, recorded now so it survives context rot while we implement `docket` itself. The stable parts are below; the wiring details and open questions in IMPLEMENTATION IDEAS are expected to firm up only once `docket` exists and we build against it. Do not implement from this doc until `docket` is built and we revisit.

## Problem

pictl's phase 4 calls for a supervisor/worker example and a skill teaching agents to orchestrate peers. We want to deliver that as a **secretary** capability: an agent dispatches work to other agents and is *woken* when results are ready, rather than polling. The deterministic plumbing — running async work, buffering output, notifying at opportune times, letting the owner take results — is provided by the standalone [`docket`](../../../docket/docs/specs/docket.md) tool. pictl supplies only the glue: the dispatched commands are `pictl prompt`s, and the notify hook uses `pictl wait`/`pictl prompt`.

This work replaces `skills/pictl/reviewer.md` (a reviewer becomes one ordinary use of the secretary pattern) and realizes the phase-4 deliverables.

### Why docket, not a pictl-internal loop

A relay that watches agents and wakes a recipient is the missing primitive. Building it inside pictl would mean a central daemon doing a dynamic "select" over a growing set of agents — the hard part. Expressing it through docket instead makes the hard part vanish: `pictl prompt -t <worker> "<task>"` already blocks until the worker's turn ends and streams the worker's full reply to stdout, so the *dispatched command's stdout is the result*. No cursors, no central loop — the OS selects (each job is a process), and docket buffers. docket has zero pictl knowledge; pictl enters only as the strings docket runs.

## Success criteria (provisional)

- An agent can dispatch ongoing work to other pi agents and be woken, when it is not mid-thought, with a menu of which results are ready — then take them in the order it chooses.
- The pattern is **decentralized**: no privileged "main agent." Any agent can own a docket (an inbox); an agent can be both a worker for one owner and an owner with its own docket. Graphs of agents fall out; there is no "team" concept.
- It is **resumable**: killing and restarting the orchestration mid-flight loses neither completed-untaken results nor in-flight jobs (this is the phase-4 acceptance test, generalized to docket).
- The skill **replaces `reviewer.md`**, folding fresh-context review in as one documented use of the pattern.
- **Graceful degradation to pull:** a pi owner is *pushed* (woken via `pictl prompt`); a non-pictl owner (e.g. Claude Code, no `$PI_AGENT_ID`) cannot be woken but can *read the same docket* by polling `docket status`/`docket take`. We design for the pi-push case and do not contort for the pull case.

## The wiring (provisional)

Setup (the skill does this for an owner agent whose id is `$PI_AGENT_ID`):

```bash
export DOCKET_DIR=$(docket init --notify \
  'pictl wait -t '"$PI_AGENT_ID"' --until no-activity:5; docket status | pictl prompt -t '"$PI_AGENT_ID"' -')
```

Dispatch a task to a worker (repeatable, ongoing):

```bash
worker=$(pictl spawn --cwd <anywhere> -- ...)        # raw pictl; worker may live in any cwd/worktree/repo
docket dispatch "pictl prompt -t $worker 'Do X and report back.'"
```

Owner gets woken (by the notify hook, only once it has been quiet for the gate interval) with the `docket status` menu, then chooses:

```bash
docket ready                 # which results are waiting
docket take <id>             # pull one worker's call+response, in the owner's chosen order
```

Notes:
- The `no-activity:<secs>` gate is what lets the owner converse with one worker, self-`navigate-tree` to summarize, and *then* receive the rest — the secretary never barges in mid-turn.
- The drain a worker returns naturally includes the owner's *own prompt* to it followed by the reply (call + response), which is the desired form.
- "Spawn a worker anywhere" stays raw `pictl`; docket only ever runs the resulting command string.

## Non-goals (for this provisional pass)

- No changes to pictl's CLI surface or to `PICTL_DIR` layout. If the integration seems to need either, that is a signal we have stopped *using* pictl as a component — stop and reconsider.
- docket itself is specified and built separately; this doc does not design docket.
- The richer `take`-menu interaction beyond "notify with the ready list; owner takes by id" is deferred.

# IMPLEMENTATION IDEAS

## Skill shape (provisional)

- A **router skill** (per `writing-great-skills`): overhaul `skills/pictl/SKILL.md` to name the orchestration patterns and point to sub-skills for each. `reviewer.md` is demoted to a sub-skill reached from the router. **Secretary** is the leading word for the async-inbox pattern in the description and prose; `docket` is the mechanism the prose tells the agent to drive.
- The skill detects mode by `$PI_AGENT_ID`: present ⇒ push (notify hook prompts the owner); absent ⇒ pull (tell the agent to poll `docket status`/`take` itself).
- Keep the skill's scripts thin: setup is `docket init --notify ...`; dispatch is `docket dispatch "pictl prompt ..."`. We may add a *small* convenience wrapper so the agent does not hand-assemble the notify hook, but resist re-wrapping pictl or docket commands that already do the job.

## Open questions (resolve when we build against docket)

1. **Echo on direct conversation.** If the owner converses with a worker *directly* (raw `pictl prompt -t worker`) rather than via a docket dispatch, that turn is not a docket job, so it is not captured — good. But if the owner dispatched the worker earlier *and* the worker keeps producing turns, only dispatched turns are captured. We believe expressing each interaction as a dispatch keeps this clean; confirm once we try it. (Earlier worry about a relay re-injecting the owner's own conversation is moot under the docket model — only dispatched commands are captured.)
2. **The `take` menu UX.** v1 is "notify with the ready list; owner takes by id." A richer "X and Y are ready, which first?" stateful exchange is deferred; revisit if the simple menu is awkward in practice.
3. **Notify gate interval.** `no-activity:5` is a placeholder; tune against real agent pacing.
4. **Does docket graduate to a standalone product?** Built now as an independent repo/package but validated solely through this integration. Decide later whether it earns first-class product status (its own README-as-product, broader feature set) or stays a focused tool.
5. **Capture format of the dispatched `pictl prompt`.** `pictl prompt` streams *formatted* (possibly ANSI-styled) output by default, which docket captures verbatim into the job's `stdout` and the owner later receives via `take`. Decide whether dispatch should use plain/`--json` output for cleaner re-injection, or whether formatted text is fine to feed back into the owner's prompt.

## Acceptance test (provisional)

1. Owner agent `O` (pi) inits a docket with the notify hook above.
2. `O` spawns workers (possibly in different cwds) and dispatches several tasks over time, not as one static batch.
3. As each worker finishes, `O` is woken — but only once it has been quiet — with the ready menu, and takes results in its chosen order.
4. Kill and restart the orchestration mid-flight; confirm no completed-untaken result and no in-flight job is lost.
5. A fresh-context reviewer dispatched the same way returns a critique the owner takes and acts on (the `reviewer.md` replacement path).

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [ ] (Blocked on docket) Build the secretary router skill; demote `reviewer.md` to a sub-skill.
- [ ] (Blocked on docket) Wire `docket init --notify` setup and `docket dispatch "pictl prompt ..."` dispatch; `$PI_AGENT_ID` push/pull branch.
- [ ] (Blocked on docket) Run the acceptance test; record findings; firm up the open questions.

## Decisions captured (2026-06-28 discussion)

- Reframed away from "main agent is the loop" and from tag-based "teams": the abstraction is a per-owner **inbox** (docket), addressed by agent id, cwd-agnostic. An agent can be a worker for many owners and own its own docket — graphs, no teams.
- The loop is *code* (docket), never an agent; agents do reasoning, code does deterministic plumbing.
- Push (wake the owner) is the goal for pi owners; pull is the graceful degradation for non-pictl owners. We will not cripple the pi design for the non-pictl case.
- The relay's cursor/drain machinery collapses because `pictl prompt` already blocks-and-captures a turn; docket multiplexes *processes*, not cursors.
- Leading word **secretary** (skill prose) backed by the **docket** mechanism (a secretary keeps a docket).
