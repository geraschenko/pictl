---
name: team
description: Delegate or parallelize work across pi agents, message a peer asynchronously and collect the reply later, or get a fresh-context review.
---

team lets a manager agent run a team of worker pi agents without babysitting them: you dispatch tasks asynchronously, keep working, and collect each worker's reply when it is ready. The `team` script is the executable file `team` in this skill's directory; it is not on `PATH` — invoke it by that path every time. Examples write `<skill-dir>/team`; substitute this skill's actual directory.

## Core model

- **You have one inbox**, derived from your identity — no configuration, no state to carry between commands. A restarted pi manager recovers the same inbox automatically.
- **Workers are ordinary pi agents.** Spawn, converse with, and archive them with raw `pictl` (see the pictl skill). `team` only handles async messaging and result collection.
- `team dispatch` sends a message to a worker and returns immediately with a job id. When the worker's reply is complete, the result lands in your inbox.
- **One worker = one serial queue.** Dispatches to the same worker run one after another in that worker's single conversation. For independent parallel tasks, spawn one worker each.
- If you are a pi agent (`$PICTL_ID` set) or an agent running in a tmux pane, you are **woken with the ready list** once you have been quiet for a moment — results never barge in mid-thought. Otherwise, poll `team ready`.

## Commands

```bash
<skill-dir>/team start                       # ensure your inbox exists; print its path (idempotent)
<skill-dir>/team dispatch <worker> "task"    # async message to a worker; prints a job id
<skill-dir>/team dispatch <worker> - < f.md  # longer task from stdin
<skill-dir>/team ready                       # results ready to take
<skill-dir>/team take <id>                   # print one result, mark it taken (unique prefix ok)
<skill-dir>/team status                      # everything, including still-running jobs
<skill-dir>/team cancel <id>                 # stop waiting for a result (does NOT stop the worker)
```

On non-Linux systems without `$PICTL_ID`, call `team` only as a plain simple command — never in a pipeline or `$(...)` (see Caveats).

`team start` is optional setup (`dispatch` creates the inbox automatically); run it when you want your inbox path, e.g. for debugging. To stop a worker's actual work, use `pictl abort -t <worker>`; `team cancel` only abandons the local wait.

## The loop

Spawn one worker per independent task, dispatch, and keep working. When woken — or when polling shows results — take **every** ready result and act on it: incorporate it, dispatch a follow-up, or explicitly defer it. You are done only when every dispatched job has been taken and accounted for and your workers are archived.

## A typical session

```bash
worker=$(pictl spawn --tag helper)
<skill-dir>/team dispatch "$worker" "Summarize the failures in test.log and propose a fix."
# ... keep working; you'll be woken with the ready list (or poll `team ready`) ...
<skill-dir>/team take <id>   # the worker's full reply, ending with a [cursor: ...] line
pictl archive -t "$worker"
```

Dispatching to a **busy** worker is fine: the message queues as the worker's next turn. The captured reply may then include the tail of the worker's in-flight turn — extra context, never a lost reply.

## Worked example: fresh-context review

Use a team worker for blind-spot review: peer review, adversarial review, second opinion, or critique. The reviewer is the critic; you are the owner/advocate — reviewers report findings, they don't edit.

```bash
reviewer=$(pictl spawn --tag reviewer -- --tools read,grep,find,ls)
<skill-dir>/team dispatch "$reviewer" - <<EOF
You are a fresh-context reviewer. Be critical and look for blind spots.

Context:
- Goal: <short task context>
- Artifact: <path, branch, or diff>
- Review focus: <correctness/security/clarity/maintainability/omissions>

Return:
1. High-confidence issues.
2. Speculative concerns.
3. Vague, misleading, or overconfident parts.
4. Concrete recommended edits.
EOF
# ... continue your own work until woken ...
<skill-dir>/team take <id>
```

Then iterate as a conversation: address findings, dispatch a short follow-up ("I addressed X by doing Y; I chose not to do Z because... Does that resolve the blocker?"), and repeat until you both approve or remaining objections are explicitly deferred. Archive the reviewer when done.

Prompt knobs that sharpen a review: "Red-team this for hidden assumptions and unsafe failure modes." / "Separate high-confidence issues from speculative concerns." / "Do not rewrite; report findings and suggested edits."

## Caveats

- **Without `$PICTL_ID`** (e.g. a non-pi manager), your inbox is scoped to your session process. On Linux this is stable across invocations and pipelines/`$(team ...)` are safe; on other systems, invoke `team` only as a plain simple command — a pipeline or subshell silently derives the wrong inbox (a mis-routed `dispatch` loses work), and job ids are always visible via `team status`/`team ready` so you never need to capture `dispatch` output. If `team` reports it cannot determine your tmux pane, follow its instructions.
- Dispatched messages are spooled to files that are not garbage-collected; long-running managers accumulate them in a per-inbox directory beside the inbox.
- One inbox per manager; there is no way to share an inbox or point at someone else's.
- If a command fails with an error mentioning `docket`, the backend queue tool is missing from `PATH` — it must be available both where you run `team` and in the environment dispatched jobs run in (likewise `pictl`).
