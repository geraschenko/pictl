#!/usr/bin/env bash
# E1+E2 driver: restore-on-revival + RPC-driven event observability.
# See README.md. Artifacts land in ./artifacts/. Usage:
#   ./run-e1e2.sh                # suspend/resume variant (E1)
#   ./run-e1e2.sh sigkill       # crash variant (E1b); artifacts in ./artifacts-sigkill/
#   ./run-e1e2.sh settings-wipe # delete settings.json between suspend and revive:
#                               # separates session-file restore from settings restore
set -euo pipefail

VARIANT="${1:-suspend}"
EXP_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$EXP_DIR/../../.." && pwd)"
SCRATCH=/tmp/pictl-option-derisk
ART="$EXP_DIR/artifacts"
[ "$VARIANT" != "suspend" ] && ART="$EXP_DIR/artifacts-$VARIANT"

rm -rf "$SCRATCH" "$ART"
mkdir -p "$SCRATCH"/{pictl,agent,sessions,cwd} "$ART"
cp ~/.pi/agent/auth.json "$SCRATCH/agent/"

export PICTL_DIR="$SCRATCH/pictl"
export PI_CODING_AGENT_DIR="$SCRATCH/agent"
export PI_CODING_AGENT_SESSION_DIR="$SCRATCH/sessions"

pictl() { node --disable-warning=ExperimentalWarning "$REPO/src/core/main.ts" "$@"; }

step() { echo "=== $*" >&2; }

step "spawn"
PICTL_TARGET=$(pictl spawn --cwd "$SCRATCH/cwd")
export PICTL_TARGET
echo "$PICTL_TARGET" > "$ART/agent-id.txt"

step "start raw tail (passive event observer)"
pictl tail -f --type raw > "$ART/events.jsonl" &
TAIL_PID=$!

step "cheap model for the one real turn"
pictl set-model anthropic claude-haiku-4-5 > /dev/null

step "one real turn so the session file exists on disk"
pictl prompt "Reply with exactly: OK" > "$ART/prompt-output.txt"

step "baseline get-state"
pictl get-state > "$ART/state-1-baseline.json"

step "mutate all candidate fields to non-defaults"
# model twice: does the LATEST model_change entry win on revival? Both are
# reasoning models — a non-reasoning model would clamp the thinking level
# (observed: claude-3-5-haiku forced high -> off, confounding that field).
pictl set-model anthropic claude-3-7-sonnet-20250219 > /dev/null
pictl set-model anthropic claude-opus-4-5            > /dev/null
pictl set-thinking-level high                        > /dev/null
pictl set-steering-mode all                         > /dev/null
pictl set-follow-up-mode all                        > /dev/null
pictl set-auto-compaction off                       > /dev/null
# get_state has no auto-retry field; the raw response is the only record.
pictl set-auto-retry off --raw > "$ART/set-auto-retry-response.json"
pictl set-session-name "derisk-option-persistence"  > /dev/null

step "confirm mutations took"
pictl get-state > "$ART/state-2-mutated.json"

step "session file + settings.json forensics"
SESSION_FILE=$(python3 -c "import json;print(json.load(open('$ART/state-2-mutated.json'))['sessionFile'])")
cp "$SESSION_FILE" "$ART/session-before-revival.jsonl"
cp "$SCRATCH/agent/settings.json" "$ART/settings-after-mutations.json" 2>/dev/null \
  || echo "(no settings.json written)" > "$ART/settings-after-mutations.json"

if [ "$VARIANT" = "sigkill" ]; then
  step "SIGKILL pi + daemon (crash variant)"
  AGENT_JSON="$PICTL_DIR/$PICTL_TARGET/agent.json"
  PI_PID=$(python3 -c "import json;print(json.load(open('$AGENT_JSON'))['piPid'])")
  DAEMON_PID=$(python3 -c "import json;print(json.load(open('$AGENT_JSON'))['daemonPid'])")
  kill -9 "$PI_PID" "$DAEMON_PID"
  wait "$TAIL_PID" || true   # tail ends when the socket dies
else
  step "suspend (graceful; ends the tail)"
  pictl suspend
  wait "$TAIL_PID" || true
fi

if [ "$VARIANT" = "settings-wipe" ]; then
  step "delete settings.json (fields that survive are session-restored)"
  rm -f "$SCRATCH/agent/settings.json"
fi

step "get-state (transparently revives) and diff"
pictl get-state > "$ART/state-3-revived.json"

step "post-revival session file"
SESSION_FILE_3=$(python3 -c "import json;print(json.load(open('$ART/state-3-revived.json'))['sessionFile'])")
cp "$SESSION_FILE_3" "$ART/session-after-revival.jsonl"

step "cleanup"
pictl purge > /dev/null

echo
echo "=== field comparison (mutated -> revived) ==="
python3 - "$ART" <<'EOF'
import json, sys
art = sys.argv[1]
s2 = json.load(open(f"{art}/state-2-mutated.json"))
s3 = json.load(open(f"{art}/state-3-revived.json"))
fields = [
    ("model", lambda s: s.get("model", {}).get("id")),
    ("thinkingLevel", lambda s: s.get("thinkingLevel")),
    ("steeringMode", lambda s: s.get("steeringMode")),
    ("followUpMode", lambda s: s.get("followUpMode")),
    ("autoCompactionEnabled", lambda s: s.get("autoCompactionEnabled")),
    ("sessionName", lambda s: s.get("sessionName")),
]
for name, get in fields:
    a, b = get(s2), get(s3)
    print(f"{name:24} {str(a):30} -> {str(b):30} {'RESTORED' if a == b else 'REVERTED'}")
print(f"{'autoRetry':24} (not in get_state; see set-auto-retry-response.json)")
EOF
