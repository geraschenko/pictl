# pictl navigation

Use this branch when using `pictl navigate-tree` to move an agent's active conversation leaf. Navigation changes conversation state; it does not roll back files, processes, spawned agents, or external side effects.

## Choose summary placement

Two useful patterns:

```bash
# Pi summarizes the abandoned branch during navigation.
pictl navigate-tree -t <agent> <target-id> --summarize \
  --custom-instructions '<summary prompt>' --replace-instructions

# Navigate first, then send your own summary as the next prompt.
pictl navigate-tree -t <agent> <target-id> && \
  pictl prompt -t <agent> -d '<summary and continuation>'
```

Both patterns require the target to be **idle**: `navigate_tree` is rejected while the target is streaming. They are for a script, peer, or human navigating an idle agent. An agent navigating **itself** from inside its own turn is streaming, so it cannot use these — see [Self-navigation](#self-navigation) below.

When the target is idle and you can supply the recovery summary in the post-navigation prompt, prefer the second pattern: it is explicit, visible, and carries the next action. It also avoids relying on pi's default branch-summary prompt.

## Custom summary instructions

When using `--summarize`, usually provide `--custom-instructions`. Pi's default branch-summary prompt is opinionated: goal, constraints, progress, decisions, next steps, concise paths/errors. That can be useful, but it may not match the recovery packet you need.

Use `--replace-instructions` only with `--summarize --custom-instructions`: it makes your custom instructions the entire summarizer prompt. Without it, pi uses the default branch-summary prompt and appends your text as “Additional focus”. This affects only the summarizer prompt, not navigation, target selection, or the main agent prompt.

Good recovery-summary instructions should ask for:

- user intent and non-negotiable constraints;
- useful findings from the abandoned branch;
- files changed and other side effects that still exist;
- claims with provenance: user-stated, file-observed, test-observed, inferred, unverified;
- confidence, known gaps, and next action.

## What gets summarized

For `navigate-tree --summarize`, pi computes the abandoned branch before calling the summarizer:

1. old leaf = current entry;
2. destination = target entry;
3. find the deepest common ancestor;
4. collect entries from old leaf back to, but excluding, that ancestor;
5. reverse them into chronological order;
6. serialize those entries inside a `<conversation>...</conversation>` block.

The summarizer sees only that `<conversation>` block plus the summary instructions, not the whole session. The common ancestor is excluded. Tool-result entries are skipped, but relevant tool-call context may remain in assistant messages. Existing compaction and branch summaries may appear as messages. If the branch is too large, pi keeps the newest relevant messages that fit the token budget. The inserted summary is prefixed as a returned-branch summary.

## Labels

`pictl navigate-tree --label <label>` labels where navigation lands, not the abandoned leaf:

- if navigation creates a branch summary, the label is applied to the new summary entry;
- without a summary, the label is applied to the target entry.

Labels are metadata for tree display and do not change LLM context.

## Self-navigation

An agent **cannot** navigate its own tree with `pictl navigate-tree -t $PICTL_ID ...`: that command runs while the agent's turn is streaming, and `navigate_tree` is rejected during streaming. The `/navigate-tree` pi extension (`extensions/navigate-tree.ts`) exists for this case. The agent runs:

```bash
pictl prompt "/navigate-tree <target-id> --continue <recovery summary and next action>"
```

The slash command is accepted inline during streaming, returns immediately, and defers the navigation until the run settles — then optionally sends the `--continue` text as a fresh prompt on the new branch. See `docs/specs/self-navigation-extension.md`.

The extension is standalone; it must be loaded by the agent's pi for `/navigate-tree` to exist. Whether pictl bundles it into spawned agents is not yet decided.

### Recovery packet

The `--continue` text becomes the agent's memory of the abandoned branch, so it should carry a recovery packet:

- target entry id;
- why navigation is happening;
- summary to carry forward;
- side effects that remain after navigation;
- next action;
- how the human can recover if the agent gets confused.
