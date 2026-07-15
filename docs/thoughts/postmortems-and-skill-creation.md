# Post-mortems and skill creation with `pictl`

This is exploratory. The idea is to use `pictl` not only for doing work, but for reflecting on how work went: agents can branch off, inspect their own transcript, identify avoidable friction, and leave structured suggestions for future tools, skills, prompts, or project conventions.

The goal is not automatic self-improvement. The safer target is a reviewable suggestion box: agents propose improvements, humans decide what to adopt, and the original agent context remains recoverable for follow-up questions.

## Experience report: fresh reviewer agent

In the first peer-review experiment, the main agent spawned a fresh reviewer to critique `docs/thoughts/metacognition-with-pictl.md`.

What worked well:

- **Fresh context was valuable.** The reviewer found omissions the author was unlikely to notice: state planes, provenance, trigger conditions, authority labels, coordination artifacts, and evaluation methodology.
- **Read-only review was enough.** The reviewer did not need edit or test tools. It read the artifact and reported findings; the main agent remained the owner.
- **Rendered streams mattered.** Piping `pictl prompt ... | ./scripts/pictl-render` kept the transcript readable and prevented raw JSONL from flooding context.
- **Critic/advocate separation helped.** The reviewer stayed in critic mode while the main agent chose which suggestions to incorporate.
- **Second-pass review was useful.** Asking the reviewer to re-read the changed file caught remaining issues: protocol weight, authority defaults, and anti-patterns.

What was awkward:

- The reviewer needed a rich prompt because it started with fresh context.
- Without a concise reviewer pattern, it would be easy to over-grant tools or ask for vague feedback.
- The main agent had to remember to archive the reviewer.
- The output protocol had to be manually specified to avoid enormous or diffuse review text.

Resulting skill updates:

- Added `skills/pictl/reviewer.md` for fresh-context read-only reviewers.
- Added `skills/pictl/tree-navigation.md` as the canonical navigation reference.
- Flattened pictl skill references into `skills/pictl/*.md` so agents can load focused guidance without chasing nested reference paths.
- Kept `reviewer.md` concise and operational.

## Capability: side-branch post-mortems

An agent can branch away from the main task, inspect what just happened, and produce a post-mortem without polluting the active working context. It can then navigate back with a compact summary or leave the post-mortem as an artifact.

### Possible uses

- Identify which instructions, skills, or docs would have prevented mistakes.
- Record confusing project structure or naming that caused wasted exploration.
- Notice repeated manual transformations that deserve tooling.
- Capture missing command examples or gotchas for an existing skill.
- Propose new skill sections after a successful new workflow.
- Suggest better rendering, logging, or inspection tools for multi-agent work.
- Summarize why an agent got stuck and what escalation signal should have fired.
- Compare the actual workflow to the ideal workflow and name the delta.

### What this enables

Normal agent work produces lots of fleeting process knowledge. A side-branch post-mortem gives that knowledge a place to go without interrupting the main task. It turns incidental friction into maintainable improvement proposals.

This is especially useful because agents experience failures humans may not see: confusing tool output, ambiguous skill text, missing examples, expensive grep loops, or uncertainty about authority. Those are exactly the raw materials for better skills and tools.

### Failure modes

- **Suggestion spam:** every minor annoyance becomes a proposal.
- **Self-justification:** the agent frames its own mistake as a tooling problem.
- **Overfitting:** a skill is changed to prevent one rare failure but becomes worse for common cases.
- **Premature automation:** the agent proposes a complex tool for a one-off task.
- **Context laundering:** a post-mortem summary may omit the actual error path and make the suggestion sound more justified than it is.
- **Privacy leakage:** post-mortems can quote sensitive transcript details into durable files.
- **Revival confusion:** if humans revive the agent at the suggestion point, the filesystem and agent fleet may have changed since then.

## Suggestion box skill design

The suggestion box probably should not be core `pictl` functionality. A better first shape is a small skill that relies on `pictl` for agent identity, transcript/tree revival, and optional helper commands.

The skill would teach agents when to leave suggestions, where to put them, what metadata to include, and how to keep proposals grounded in an actual incident. It can include a README and template in `.pictl/suggestions/` without requiring `pictl` itself to own the workflow.

A useful suggestion box should be structured enough to sort, review, and revive context, but not so heavy that agents avoid using it.

### Suggested record shape

Start with a lightweight Markdown note. Do not add fields until there is infrastructure that uses them.

Suggested header:

- title: short human-readable title
- agent_id: `PICTL_ID`
- entry_id: entry where the suggestion was made
- task: one-line user task/context
- impact: annoyance | reliability | safety | cost | speed | maintainability

Optional fields, only when they materially help review: session id, cwd, git commit, side effects, or related agents.

Suggested body:

- **Observation:** what happened, with concise evidence rather than a full transcript.
- **Why it matters:** what failure, cost, or confusion this could prevent.
- **Proposal:** what should change, concrete enough for a human to evaluate.
- **Risks / counterarguments:** how this could be wrong, overfit, unsafe, or too expensive.
- **Revival instructions:** how to inspect or revive the original context.

Example revival commands:

```bash
pictl navigate-tree -t <agent_id> <entry_id>
pictl attach -t <agent_id>
```

If the suggestion involved navigation or file edits, note side effects that may no longer match the revived conversation state.

### Storage options

- `.pictl/suggestions/` for local, agent-generated suggestions that are not project docs yet. A suggestion-box skill could create or document this directory with a README and template.
- `docs/thoughts/suggestions/` for suggestions worth preserving in the repository.
- Issue tracker integration for accepted suggestions.
- A JSONL append-only log for scripts, plus rendered Markdown for human review.

The important field is not the prose; it is the revival pointer. In the simplest case, that is just agent id plus entry id. Other context should be optional until tooling proves it is useful.

### Possible skill contents

A suggestion-box skill could include:

- when to write a suggestion and when not to;
- a `README.md` explaining human review and revival;
- a `TEMPLATE.md` with the lightweight header/body fields;
- examples of good suggestions and overfit/bad suggestions;
- guidance to redact sensitive transcript details;
- a reminder that suggestions are proposals, not permission to edit skills or tools;
- an optional helper to capture the current entry id and agent id once `pictl-render` or another tool exposes those cleanly.

Agents cannot rely on exported shell variables persisting across separate tool calls. For repeated commands against a spawned agent, a workflow can record the agent id in a uniquely named temp file or state file, but should not recommend a fixed path that multiple agents might clobber.

## Human review workflow

A human reviewing suggestions should be able to:

1. list suggestions by title, impact, repository, or task;
2. read the rendered suggestion;
3. inspect the originating transcript around the entry id;
4. revive or clone the agent at that point for interview;
5. accept, reject, defer, or ask for a patch;
6. link implemented changes back to the suggestion.

A good UI might show the suggestion next to a small transcript window and buttons for: "open tree", "clone at entry", "ask agent for more detail", "mark accepted", "convert to issue".

## Post-mortem trigger conditions

Post-mortems should be cheap but not constant. Good triggers:

- the human explicitly asks for one;
- the agent used a new workflow, such as peer review or self-navigation;
- the agent got stuck, looped, or needed rescue;
- a skill was loaded but failed to answer a practical question;
- the agent made a preventable mistake;
- a manual edit pattern repeated several times;
- a tool output was too noisy for agent consumption;
- a reviewer or overseer found a systemic issue.

Avoid post-mortems for trivial successful tasks unless there is a clear reusable lesson.

## Skill creation and pruning

Post-mortems should suggest both additions and deletions. Skills can fail by being too sparse, but also by being too long, redundant, or overly specific.

Useful suggestion types:

- add a missing command example;
- add a warning for a real failure mode;
- split a large skill into focused references;
- prune stale or verbose prompting;
- move rare details out of the main skill file;
- add a checklist for a high-risk operation;
- name an anti-pattern;
- add a small helper script instead of more prose.

A useful standard is: if the proposed skill text would have changed the agent's behavior in the originating incident, it is worth considering. If it merely sounds generally wise, it should probably stay in a thought doc.

## Tool creation suggestions

Agents are well positioned to notice transformations that are conceptually simple but operationally annoying.

Examples:

- render raw JSONL into compact transcripts;
- extract entry ids and session ids from `pictl` streams;
- create self-navigation recovery packets;
- diff skill behavior before/after a prompt change;
- batch-rename or codemod repetitive code edits;
- turn reviewer findings into checklist items;
- detect stale agent ids or archived reviewers;
- summarize tool-result blobs without losing command/error provenance.

Tool suggestions should include the manual steps the agent actually performed. That keeps the proposal grounded and helps humans judge whether automation is worthwhile.

## Relationship to `navigate-tree`

Post-mortems are a safer early use of navigation than high-stakes context surgery. The agent can branch off, reflect, write a suggestion, and return with a summary. If it gets confused, the human can recover from the tree.

However, navigation does not roll back post-mortem side effects. If the branch writes suggestion files or edits skills, those edits remain after returning. The recovery summary must say what changed on disk.

## Open questions

- Should suggestion records live in `.pictl/`, project docs, or both?
- What should the first suggestion-box skill include beyond a README and template?
- Should a helper script eventually pre-fill current `agent_id` and `entry_id`, or is that premature?
- Should post-mortem branches be labeled in the conversation tree?
- What should a non-core post-mortem utility look like if it is enabled by `pictl` but not part of `pictl` itself?
- How do we prevent suggestion spam while still capturing valuable process knowledge?
- How should sensitive transcript details be redacted from durable suggestions?
- Should accepted suggestions become tests for skills or orchestration scripts?

## Tentative conclusion

Post-mortems and skill creation are a practical metacognitive use of `pictl`: they let agents convert lived friction into reviewable infrastructure proposals. The key is keeping the loop human-mediated. Agents can notice patterns and draft suggestions; humans decide which changes become durable skills, tools, or project conventions.
