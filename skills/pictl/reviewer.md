# pictl reviewer agents

Use this branch for a fresh-context blind-spot review: peer review, adversarial review, second opinion, or critique. Reviewers have bounded authority: they report findings; they do not edit, test, or take over unless explicitly asked.

## Review philosophy

Reviewer agents are not a bureaucratic checkbox. Use them because a fresh, critical mind can make the artifact better.

Treat the reviewer as a collaborator with a distinct role: they are the critic; you are the owner/advocate. Build a substantive exchange. Explain what you are trying to improve, what tradeoffs you made, and what kind of pressure would be most useful.

Do not cargo-cult the prompts below. They are scaffolds, not rituals. Tune your prompt to the review moment. A good follow-up may be short and conversational: "I addressed your concern about X by doing Y; I chose not to do Z because... Does that resolve the risk, or do you still see a blocker?"

## Starting pattern

This is a useful first-pass prompt. Adapt it freely based on what you're trying to achieve with this review.

Spawn a read-only reviewer:

```bash
reviewer=$(pictl spawn --tag reviewer -- --tools read,grep,find,ls)
pictl prompt -t "$reviewer" - <<EOF
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
```

If a finding needs tests or edits, the main agent should perform that follow-up.

To dispatch a review with `prompt -d` and keep working until it is ready, use the async check-back pattern in [orchestration.md](orchestration.md).

## Prompt knobs

Use these when helpful:

- "Red-team this for hidden assumptions and unsafe failure modes."
- "Focus on what is missing, misleading, or unsafe."
- "Do not rewrite; report findings and suggested edits."
- "Separate high-confidence issues from speculative concerns."

## Critic/advocate loop

For high-stakes reviews, keep roles separate: the reviewer is the critic; the main agent is the advocate/owner. Iterate until both approve the final on-disk artifact, or until remaining objections are explicitly deferred.

## Follow-up style

After edits, talk to the reviewer directly. Summarize what changed and why. Invite them to stay critical, but avoid repeating a large boilerplate prompt unless it is useful.

Example:

```bash
pictl prompt -t "$reviewer" - <<'EOF'
I addressed your concern about the parser contract by adding explicit assertion functions and defining malformed known-type entries as invalid input.

I intentionally did not add a fallback for malformed known types because that would hide schema drift.

Re-read the spec and tell me whether this resolves your blocker. If not, name the smallest remaining edit needed for approval.
EOF
```

Use structured return formats when they clarify the task; otherwise prefer a natural review conversation.

Archive reviewers you spawned when done:

```bash
pictl archive -t "$reviewer"
```
