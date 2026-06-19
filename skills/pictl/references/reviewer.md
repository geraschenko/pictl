# pictl reviewer agents

Use this branch when the user asks for a peer review, adversarial review, second opinion, or fresh-context critique. The goal is cognitive diversity with bounded authority: reviewers report findings; they do not take over the work unless explicitly asked.

## Default pattern

Spawn a read-only reviewer unless the task requires tests or edits:

```bash
reviewer=$(pictl spawn --tag reviewer -- --approve --tools read,grep,find,ls)
main_agent=${PI_AGENT_ID:-unknown}
pictl prompt -t "$reviewer" - <<EOF | ./scripts/pictl-render
You are a fresh peer review agent.

Context:
- Main agent id: $main_agent
- Repository/task context: <short context>
- Artifact to review: <path or branch/diff>

Please review <path>. Be constructively critical and look for blind spots, not just copyedits.

Return:
1. Strongest parts.
2. Important missing issues or underdeveloped ideas.
3. Risks, failure modes, or security concerns.
4. Places that are vague, misleading, or too optimistic.
5. Concrete recommended edits.
EOF
```

If `scripts/pictl-render` is unavailable, use an equivalent renderer or keep the prompt narrow. Do not flood your own context with raw JSONL from a large review.

## Choose reviewer authority deliberately

- **Read-only reviewer:** default for document review, architecture critique, security review, and adversarial review. Tools: `read,grep,find,ls`.
- **Verification reviewer:** can run tests or typechecks, but should not edit. Add only the minimum tool needed, usually `bash`.
- **Patch reviewer/fixer:** can edit only when the user explicitly asks the reviewer to change files.

Read-only reviewers reduce accidental edits, shell side effects, and prompt-injection impact. They also make the role contract clear: report findings to the main agent or human.

## Prompting guidance

A fresh reviewer starts with little context. Give it:

- its role and authority boundaries;
- the artifact path, diff, or branch to review;
- enough task context to evaluate intent;
- the kind of critique wanted: correctness, security, clarity, maintainability, novelty, omissions;
- output shape, so findings are easy to merge;
- permission to be critical.

Ask for blind spots the main agent is likely to miss. Useful reviewer prompts include:

- "Assume the author is overconfident; find hidden assumptions."
- "Focus on what is missing, misleading, or unsafe."
- "Do not rewrite; report concrete findings and suggested edits."
- "Separate high-confidence issues from speculative concerns."

## Work with the reviewer, not just once

A second pass is often high-leverage: after incorporating feedback, ask the same reviewer to inspect the delta for overcorrection, redundancy, or remaining high-value issues.

```bash
pictl prompt -t "$reviewer" - <<'EOF' | ./scripts/pictl-render
I incorporated your main feedback. Please re-read the updated artifact and give a brief second-pass review.
Focus only on high-value remaining issues:
- Did the changes address your main concerns?
- Did they introduce redundancy, over-structure, or misleading framing?
- What are the top 3 remaining edits you would make?
EOF
```

Use additional passes only with narrow scopes. Open-ended third and fourth passes tend to produce diminishing returns.

## Hygiene

- Tag reviewers clearly, e.g. `reviewer`, `security-reviewer`, or `docs-reviewer`.
- Keep the reviewer id in a variable or state file while using it.
- Archive reviewers you spawned when done:

```bash
pictl archive -t "$reviewer"
```

- Do not purge reviewers unless the user explicitly asks for permanent deletion.
- If the reviewer finds a major issue, preserve its id and cursor so the human can revive or interview it later.
