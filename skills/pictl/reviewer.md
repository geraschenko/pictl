# pictl reviewer agents

Use this branch for a fresh-context blind-spot review: peer review, adversarial review, second opinion, or critique. Reviewers have bounded authority: they report findings; they do not edit, test, or take over unless explicitly asked.

## Default pattern

Spawn a read-only reviewer:

```bash
reviewer=$(pictl spawn --tag reviewer -- --tools read,grep,find,ls)
pictl prompt -t "$reviewer" - <<EOF | ./scripts/pictl-render
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

## Prompt knobs

Use these when helpful:

- "Red-team this for hidden assumptions and unsafe failure modes."
- "Focus on what is missing, misleading, or unsafe."
- "Do not rewrite; report findings and suggested edits."
- "Separate high-confidence issues from speculative concerns."

## Critic/advocate loop

For high-stakes reviews, keep roles separate: the reviewer is the critic; the main agent is the advocate/owner. Iterate until both approve the final on-disk artifact, or until remaining objections are explicitly deferred.

After edits, ask for an additional pass:

```bash
pictl prompt -t "$reviewer" - <<'EOF' | ./scripts/pictl-render
I incorporated your feedback. Re-read the final on-disk artifact.

Stay in critic mode. Probe weaknesses; do not merely agree.

Return only:
1. Whether your main concerns were addressed.
2. Any remaining high-confidence issues.
3. Any overcorrection, redundancy, or misleading framing.
4. Approve, or name the smallest next edit needed for approval.
EOF
```

Archive reviewers you spawned when done:

```bash
pictl archive -t "$reviewer"
```
