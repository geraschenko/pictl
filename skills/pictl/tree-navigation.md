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
  pictl prompt -t <agent> --type detach '<summary and continuation>'
```

For self-navigation, prefer the second pattern when you can supply the recovery summary in the post-navigation prompt: it is explicit, visible, and carries the next action. It also avoids relying on pi's default branch-summary prompt.

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

## Self-navigation safety

Before an agent navigates itself, prepare a recovery packet somewhere durable or in the post-navigation prompt:

- target entry id;
- why navigation is happening;
- summary to carry forward;
- side effects that remain after navigation;
- next action;
- how the human can recover if the agent gets confused.
