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

## Second pass

After incorporating feedback, ask the same reviewer for a narrow second pass:

```bash
pictl prompt -t "$reviewer" - <<'EOF' | ./scripts/pictl-render
I incorporated your main feedback. Re-read the updated artifact and give a brief second-pass review.

Return only:
1. Whether the main concerns were addressed.
2. Any overcorrection, redundancy, or misleading framing.
3. The top 3 remaining edits.
EOF
```

TDC: I think it's worth saying something like "iterate back and forth until you and the reviewer are both satisfied". The goal should be to keep the reviewer in a different headspace than the main agent so that they don't simply agree with each other. The review agent can play critic and main agent can play advocate. Consider phrasing like this (this is borrowed from collaborative spec review, but could be adapted to review more generally):
> You and MUST collaboratively review until BOTH approve the FINAL on-disk version. Apply proof standard — you must prove correctness; probe weaknesses.
> 
> **Review Checklist:** (1) Flesh out underspecified details (2) Challenge assumptions (inspect repos, use web search) (3) Check logic correctness/completeness (4) Seek more elegant solutions (5) Ensure spec is standalone
>
> Both must read the FINAL on-disk version before approving. Any edit invalidates prior approval — re-read required.

Archive reviewers you spawned when done:

```bash
pictl archive -t "$reviewer"
```
