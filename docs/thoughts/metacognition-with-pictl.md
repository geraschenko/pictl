# Metacognition enabled by `pictl`

This is exploratory. It is not a product plan or a recommendation that agents should routinely modify their own conversation state. The goal is to map the new design space opened by `pictl`: live agents can discover, observe, message, fork, clone, navigate, and sometimes supervise agents, including themselves.

`pictl` makes an agent less like an isolated chat turn and more like a process in a small operating system: it has an id, observable state, resumable history, peers, control sockets, and lifecycle operations. That creates useful metacognitive affordances, but also new ways to become confused, unsafe, expensive, or unmaintainable.

## Framing questions

For each capability, ask:

- What are all the plausible uses, including weird or marginal ones?
- Does the use enable something genuinely new, or just make an existing pattern easier?
- What are the new failure modes, including security and trust failures?
- If the use became normal and nearly automatic, how would it change human-agent work?
- What invariants, protocols, or guardrails would make the capability safe enough to use repeatedly?

## Capability: an agent controls itself with `pictl`

A spawned agent can know its own id, usually through `PI_AGENT_ID`. That lets it inspect or control itself with ordinary `pictl` commands.

### Possible uses

- Inspect own state: `get-state`, `get-session-stats`, `get-messages`, `get-tree`.
- Export or checkpoint its own transcript.
- Change own model or thinking level based on phase: cheap/low for routine edits, high for design review.
- Toggle auto-compaction or auto-retry policies.
- Abort its own stuck bash command or current generation through an external watchdog.
- Queue a follow-up to itself after a state-changing operation.
- Fork, clone, or navigate its own session tree.
- Attach external tooling to its own event stream for metrics or alarms.

### What this enables

Self-control makes the agent's context and execution policy programmable from inside the session. The agent can treat its own conversation as state it can inspect and edit, rather than a passive transcript controlled only by the human or runtime.

The genuinely new part is not `get-state`; it is the feedback loop. An agent can notice, "I am about to enter a messy exploration," create a plan for restoring itself afterward, do the exploration, then alter its own future context so it continues from a cleaner branch.

### Failure modes

- **Self-reference bugs:** the agent reasons about the state it is in, changes that state, and then incorrectly assumes the old state still applies.
- **Lost intent:** after navigation or compaction, the agent may lose the user's latest constraints or the reason it chose the operation.
- **Control-loop oscillation:** scripts repeatedly change thinking level, navigate, retry, or prompt because each sees the other's intervention as incomplete.
- **Privilege confusion:** if an agent can control itself, can it also control nearby agents? Discovery and target selection become part of the trust boundary.
- **Audit ambiguity:** a transcript after navigation may hide the exploratory path from the active context even though the tree still contains it.
- **Accidental denial of service:** self-follow-ups, retries, or overseer prompts can create infinite work queues.

## Capability: self-`navigate-tree` for deliberate context surgery

The most interesting self-control primitive is `navigate-tree`. An agent can move its active leaf back to an earlier entry and optionally summarize or replace instructions. That turns the conversation tree into a scratchpad/worktree system for cognition.

### Possible uses

1. **Exploration sandbox**
   - Save the current entry id.
   - Do messy research, web searches, dependency spelunking, or failed implementations.
   - Generate a concise summary of findings and dead ends.
   - Navigate back to the pre-exploration entry with the summary.

2. **Dead-end pruning**
   - After realizing an approach was wrong, return to the last good decision point.
   - Keep only the useful lesson: "Do not use API X; it lacks method Y."

3. **Speculative parallelism without spawning**
   - Explore approach A, navigate back, explore approach B, navigate back, then continue with a comparison summary.
   - This is cheaper than spawning several agents, but riskier because the same agent must not confuse branches.

4. **Context dieting**
   - Replace long command outputs or verbose investigations with durable conclusions.
   - Keep the active context focused while preserving full history in the tree.

5. **Mode switching**
   - Navigate from implementation mode back to design mode with a generated implementation summary.
   - Or return from review mode to coding mode with a list of required changes.

6. **Self-debugging**
   - When the agent detects it is looping, it can navigate to the decision point before the loop and resume with an explicit anti-loop instruction.

7. **Human-visible checkpoints**
   - The agent can mark a checkpoint before risky work, then offer to rewind if the human dislikes the path.

8. **Instruction repair**
   - If a later message polluted the context with a false premise, navigate to before it and carry forward a corrected summary.

### What this enables

This is a form of transactional cognition. The agent can run an exploratory transaction, commit only a summary, and discard the detailed working set from active context. It resembles `git rebase`, database transactions, notebook checkpointing, and scratch branches.

It could reduce the need for subagents for small exploratory tasks. Today, a common reason to spawn a worker is to isolate messy context. Self-navigation gives the same agent an isolation mechanism while preserving identity, local filesystem state, and rapport with the human.

### Dangerous edge cases

- **The summary is now the memory.** If the summary omits a crucial constraint, the active branch may be worse than the original despite the full tree being recoverable.
- **The agent may not know it is confused.** After navigation, it may continue confidently with a malformed model of what happened.
- **Tool side effects are not reverted.** `navigate-tree` rewinds conversation state, not the filesystem, network calls, tickets, database writes, or spawned processes.
- **Branch identity can be misleading.** The same agent id continues after navigation, but its active conversation is now a different leaf.
- **The user may be attached live.** A human watching the TUI could see apparent discontinuities or lose the visible rationale unless the operation is announced.
- **Self-continuation problem.** If navigation interrupts the current turn or changes active context, the agent may need an external mechanism to prompt it afterward.
- **Instruction precedence hazards.** Replacing instructions during navigation could accidentally drop system/project constraints or user intent if the API permits too much freedom.

### Possible self-navigation protocol

A safe-ish protocol might require the agent to write a recovery packet before navigation:

```md
## Self-navigation recovery packet

- Agent id:
- Current target entry id:
- Entry to navigate back to:
- User task being preserved:
- Non-negotiable constraints:
- Files changed / side effects created:
- Commands still running:
- Summary to carry forward:
- Next prompt to send after navigation:
- Abort condition / how a human can recover:
```

Then an external script performs the operation and sends the continuation prompt. This avoids relying on the pre-navigation turn to keep executing correctly after changing its own context.

### Self-continuation mechanisms

- A wrapper command: `pictl self-navigate --back-to <entry> --summary-file summary.md --continue-prompt prompt.md`.
- A one-shot helper process that waits for navigation to complete, then prompts the same agent.
- A tiny peer agent whose only job is to execute the recovery packet.
- A durable local state file consumed by a daemon-like workflow runner.
- A `navigate-tree` API extension that atomically carries a continuation message.

The important invariant: continuation should be explicit, durable, and inspectable before the context surgery happens.

### If this became normal

Agents would start treating context as something closer to version-controlled memory. Humans might expect agents to keep active context clean by default: explore, summarize, rewind, continue. Reviews would need to inspect not only the final branch but also pruned exploratory branches when trust matters.

This would change prompt engineering. Instead of writing one perfect linear prompt, users and agent frameworks might define memory-management policies: when to branch, what summaries must contain, when to ask before rewinding, and how to audit discarded exploration.

The biggest cultural risk is over-normalizing self-editing. If every agent silently rewrites its active context, failures may become harder to diagnose. The transcript tree preserves history, but the human-facing story becomes curated by the same process being evaluated.

## Capability: self-monitoring scripts

A script can watch an agent's structured stream and intervene through `steer`, `follow-up`, `abort`, model changes, or thinking-level changes.

### Possible uses

- Detect repeated command failures and suggest a new diagnostic path.
- Detect long inactivity and ask whether the agent is waiting on a human, stuck, or running a long command.
- Raise thinking level before high-risk edits or architectural decisions.
- Lower thinking level for mechanical cleanup.
- Export checkpoints after major milestones.
- Warn when token/cost budgets cross thresholds.
- Abort runaway shell commands.
- Detect policy violations such as attempting destructive commands without confirmation.
- Track whether the agent answered the user's question before editing.

### What this enables

This gives agents a local autonomic nervous system: cheap, specialized monitors can handle simple meta-level concerns without spending the main agent's context. It also creates a path for organization-specific practices to become executable policies.

### Failure modes

- **False positives:** a monitor interrupts useful deep work because it resembles a loop.
- **False negatives:** the monitor sees only high-level events and misses semantic drift.
- **Context injection:** monitor messages become part of the agent conversation and can accidentally override the user.
- **Alert fatigue:** if monitors comment too often, agents and humans learn to ignore them.
- **Policy laundering:** a script may enforce a policy that was never reviewed by the human.
- **Race conditions:** steering a live generation can land at surprising times.

### If this became normal

Every serious agent might have sidecar monitors: budget, safety, progress, style, and escalation. Humans would stop supervising raw agents and start supervising agent-plus-monitor bundles. The unit of deployment becomes a small society, not a single model session.

That could improve reliability but complicate accountability. When an agent fails, was it the main agent, the monitor, the monitor prompt, the orchestration script, or their interaction?

## Capability: metacognitive overseer agents

Instead of a script, spawn a small peer agent that watches a summarized stream and gives high-level feedback.

### Possible uses

- Detect loops, rabbit holes, or fixation on the wrong subtask.
- Maintain a task-level plan independent of the main agent's detailed context.
- Notice that the user asked for analysis but the agent started implementing.
- Ask the main agent to escalate to the human after repeated uncertainty.
- Track project-specific rules and remind the main agent when violated.
- Summarize long tool outputs before they enter another agent's context.
- Serve as a debate moderator among multiple worker agents.

### What this enables

An overseer agent can reason semantically over behavior, unlike a simple script. It can notice, "You are optimizing the test harness, but the user asked for design brainstorming," or "You have tried three fixes without re-reading the API types."

The overseer can also intentionally omit huge tool outputs. It sees a progress log, not the raw firehose, so it keeps a stable high-level model while the worker burns context on details.

### Failure modes

- **Authority confusion:** does the worker obey the overseer, the user, or its own judgment?
- **Overseer hallucination:** the overseer sees summaries and may invent causes.
- **Collusion / groupthink:** agents may reinforce each other's mistaken framing.
- **Adversarial prompt surface:** if a worker output contains malicious text, the overseer may ingest it and steer the worker incorrectly.
- **Cost explosion:** every agent gets another agent, which may get another monitor.
- **Privacy leakage:** overseers may see data the user expected to stay in the main session.

### If this became normal

The default worker might always be paired with an overseer. Agent UIs could show two channels: the worker's actions and the overseer's critique. Humans may intervene less often but rely more on meta-level summaries.

This pushes orchestration frameworks toward explicit roles, permissions, and message routing. The key design question becomes: what powers should an overseer have? Read-only critique is safer; direct `steer`, `abort`, or `navigate-tree` is powerful but risky.

## Capability: peer review and adversarial agents

`pictl spawn`, `clone`, `fork`, and `prompt` can create review agents, including agents forked from earlier context snapshots.

### Possible uses

- Code review from a clean pre-implementation perspective.
- Document review by an agent that did not watch the messy drafting process.
- Security review by an adversarial agent instructed to find exploit paths.
- Regression review: fork from before a decision and argue for the alternative.
- Product review: one agent represents the user, another implementation constraints.
- Red-team prompt injection review for outputs generated by another agent.

### What this enables

Peer agents can create cognitive diversity. A reviewer forked from an earlier snapshot has the original task framing without the implementation agent's sunk-cost bias. That is different from asking the same agent to review its own work after it has accumulated justifications.

### Failure modes

- **Review theater:** if the reviewer inherits too much context or the same assumptions, it may rubber-stamp.
- **Unbounded debate:** adversarial agents can consume time arguing without converging.
- **Merge problem:** someone must integrate critique into an actionable plan.
- **Authority ambiguity:** can a review agent block changes, or only advise?
- **Prompt leakage:** review agents may receive secrets or irrelevant context by default.

### If this became normal

Agent workflows may look like lightweight organizations: implementer, reviewer, security reviewer, documentation reviewer, release manager. Humans might approve role policies rather than individual prompts.

This could make high-quality work more routine, but it risks recreating bureaucracy in miniature. The useful norm is probably selective spawning based on risk, not automatic committees for every task.

## Capability: agent discovery and opportunistic collaboration

Agents can list nearby agents by cwd, tag, and status. They can discover peers without a central orchestrator.

### Possible uses

- Find a worker already investigating the same repository.
- Reuse an existing dormant specialist agent instead of spawning a new one.
- Broadcast a question to agents tagged `reviewer` or `docs`.
- Detect that another agent is editing the same files and coordinate.
- Build ad hoc swarms: one agent discovers others and assigns subtasks.
- Let a newly spawned agent find its supervisor by cwd and tag.

### What this enables

This creates ambient multi-agent collaboration. Orchestration does not have to be fully predeclared; agents can discover local social context and adapt.

### Failure modes

- **Wrong target:** cwd or tag matching may select an unrelated human's agent.
- **Information leakage:** listing agents reveals active projects and paths.
- **Unwanted interruption:** agents may message peers that are human-attached or busy.
- **Emergent spam:** many agents discover and prompt each other recursively.
- **Trust by proximity:** sharing a cwd is not the same as sharing authorization.

### If this became normal

Agent orchestration frameworks may shift from static DAGs to service discovery. Agents advertise capabilities and current load; other agents route work dynamically. That implies a need for permissions, namespaces, etiquette, and rate limits.

Tags become a primitive coordination API. If tags are informal strings, large systems will drift. If tags become structured contracts, `pictl` starts resembling a local agent registry.

## Capability: agents generate and maintain their own orchestration scripts

An agent can notice a repeated workflow, write a shell script around `pictl`, and then use or refine it.

### Possible uses

- A project-specific `review-with-agent.sh`.
- A watchdog that pairs every spawned worker with an overseer.
- A recovery script for self-navigation.
- A multi-agent release checklist.
- A transcript summarizer that persists cursors.
- A cost monitor that archives idle agents.

### What this enables

Workflows can accrete incrementally from practice. Instead of a human designing an orchestration framework upfront, agents can script the coordination patterns they repeatedly need.

### Failure modes

- **Script sprawl:** many half-maintained scripts with overlapping behavior.
- **Hidden policy:** scripts quietly decide when to abort, prompt, or archive agents.
- **State incompatibility:** cursor files, agent ids, and session ids become fragile local databases.
- **Security holes:** scripts may pass untrusted agent output into shell commands or prompts.
- **Unreviewed autonomy creep:** a script that began as a helper becomes a de facto supervisor.

### If this became normal

Repositories may grow `agent-ops/` directories: local conventions, roles, monitors, and workflows. Maintainability becomes a software engineering problem. These scripts need tests, docs, versioning, and clear ownership, not just clever prompts.

The upside is large: agent workflows become inspectable artifacts. The downside is that every repo develops a bespoke mini-orchestrator unless common patterns are factored into libraries or `pictl` itself.

## Capability: transcript and context as an audit substrate

`tail`, `get-entries`, `get-tree`, and `export-html` make sessions inspectable. Navigation and forking make the active transcript non-linear.

### Possible uses

- Record why an agent made a decision.
- Compare branches after divergent explorations.
- Train monitors on real failure patterns.
- Let humans audit summaries against raw branches.
- Build dashboards for cost, latency, retries, and intervention frequency.
- Detect when a self-navigation summary omitted important facts.

### What this enables

Metacognition needs memory about cognition. Structured transcripts are the raw data for improving agent behavior, debugging failures, and designing better monitors.

### Failure modes

- **Surveillance creep:** every agent action becomes logged and analyzed.
- **Sensitive data retention:** exported transcripts may contain secrets or private user data.
- **Misleading metrics:** easy-to-measure signals like retries or token usage may dominate quality.
- **Branch opacity:** humans may only inspect the active branch and miss important side branches.

### If this became normal

Agent observability may become as important as application observability. Teams will want traces, spans, events, and dashboards for cognitive work. That suggests `pictl` streams may eventually feed standard observability tools, but the semantics are richer and more privacy-sensitive than normal logs.

## Capability: lifecycle management as cognitive hygiene

Agents can suspend, resume, archive, purge, clone, and switch sessions. These are operational controls, but they affect cognition.

### Possible uses

- Archive completed specialists to reduce clutter.
- Suspend idle agents instead of leaving stale processes.
- Resume a dormant reviewer when a new patch appears.
- Clone before a risky instruction change.
- Purge only after explicit human confirmation.
- Use session names and tags as a memory index.

### What this enables

Long-running work can persist across days without every agent staying live. Agents become durable collaborators rather than one-off prompts.

### Failure modes

- **Zombie expertise:** old agents resume with stale assumptions.
- **Namespace clutter:** many dormant agents with unclear purpose.
- **Accidental deletion:** purging removes recoverability.
- **Stale authority:** a resumed overseer may still think it is supervising an old task.

### If this became normal

Humans may manage portfolios of agents: active, dormant, archived, specialist, reviewer. Good naming, tagging, and retirement practices become necessary. Without them, the local agent fleet becomes another messy inbox.

## Security and trust boundaries

Metacognitive control turns prompts into operations. A message can ask an agent to steer another agent, navigate its own tree, export transcripts, or run shell commands via `bash`.

Important risks:

- **Prompt injection into control plane:** untrusted text tells an agent to run `pictl` commands.
- **Cross-agent data exfiltration:** one agent asks another to summarize sensitive context.
- **Privilege escalation by discovery:** an agent finds a more privileged human-attached agent and prompts it.
- **Confused deputy:** a low-trust agent convinces a high-trust overseer to act.
- **Command injection in scripts:** agent-generated text flows into shell commands.
- **Denial of wallet:** agents spawn monitors, reviewers, and retries recursively.

Possible mitigations:

- Capability-scoped tokens or allowlists for agent control operations.
- Read-only vs write/control permissions for overseers.
- Per-agent namespaces; cwd matching should not imply authorization.
- Explicit human confirmation for destructive lifecycle and self-navigation operations.
- Structured recovery packets for context surgery.
- Rate limits and budgets for spawning, prompting, and retries.
- Audit logs that distinguish human prompts, agent prompts, script prompts, and overseer prompts.

## Design patterns worth exploring

### 1. Transactional exploration

A first-class command or skill for:

1. capture current entry id;
2. perform exploration;
3. produce summary and side-effect report;
4. navigate back;
5. continue from summary.

Key challenge: filesystem and external side effects are not transactional. The summary must report them.

### 2. Read-only overseer by default

An overseer watches and comments but cannot directly steer, abort, or navigate. It can recommend an intervention to the main agent or human. Escalate to write powers only for specific workflows.

### 3. Intervention budgets

Every monitor or overseer gets a small budget: number of prompts, aborts, or steering messages per task. This prevents noisy metacognition from dominating object-level work.

### 4. Branch-aware summaries

After navigation, the active context should include branch metadata:

- where we branched;
- what happened off-branch;
- what was intentionally omitted;
- how to inspect the branch;
- confidence level of the summary.

### 5. Agent social etiquette

Before messaging a peer, check status, tag, cwd, and possibly an advertised role. Prefer follow-up over steer unless urgent. Do not interrupt human-attached agents unless invited.

### 6. Role contracts

Agents spawned as reviewers, overseers, or workers should get explicit contracts:

- what they may read;
- whom they may message;
- whether they may use control commands;
- when to escalate;
- when to archive themselves.

### 7. Human-visible metacognition

Self-navigation, overseer interventions, and peer reviews should be visible as events, not hidden implementation details. Humans should be able to ask: "What meta-level actions changed this session?"

## Open questions

- Should `navigate-tree` support an atomic continuation prompt?
- Should self-navigation require confirmation by default when a human is attached?
- How can an agent reliably identify the entry id to return to?
- What summary schema is sufficient for safe context surgery?
- Should `pictl` distinguish human-originated prompts from agent-originated prompts in the transcript?
- How should permissions work for agent-to-agent control?
- Should agents advertise capabilities and control policies in their registry records?
- Can overseers be useful with only summarized streams, or do they need selective access to raw tool output?
- What is the right default: no overseer, read-only overseer, or active overseer?
- How do we prevent recursive monitor spawning?
- What UI affordances make non-linear conversation trees understandable to humans?
- How should scripts persist cursor/session state so workflows remain robust after forks, clones, and session switches?
- When should agent-created orchestration scripts be promoted into maintained project infrastructure?

## Tentative conclusion

`pictl` makes metacognition operational. Agents can now inspect, supervise, branch, rewind, and coordinate around their own work. The biggest opportunity is deliberate context management: agents can isolate exploration and carry forward distilled conclusions instead of dragging every dead end through the active context.

The biggest pitfall is that the same mechanisms can make agents harder to understand. Self-editing context, peer interventions, and automatic overseers create non-linear causality. To use these powers safely, workflows need explicit protocols, durable recovery records, visible audit trails, and conservative permissions.

The promising direction is not fully autonomous self-modification. It is structured, inspectable metacognition: agents get tools to manage their cognitive workspace, but the operations are logged, reversible where possible, and bounded by human-approved policies.
