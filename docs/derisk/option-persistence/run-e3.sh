#!/usr/bin/env bash
# E3 driver: TUI-driven mutations. With a passive raw tail running, attach to
# the agent under a scripted PTY and press Shift+Tab (cycle thinking level)
# and Ctrl+P (cycle model), then compare the broadcast events with get-state.
# Artifacts land in ./artifacts-e3/.
set -euo pipefail

EXP_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$EXP_DIR/../../.." && pwd)"
SCRATCH=/tmp/pictl-option-derisk
ART="$EXP_DIR/artifacts-e3"

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

step "start raw tail"
pictl tail -f --type raw > "$ART/events.jsonl" &
TAIL_PID=$!

pictl get-state > "$ART/state-1-before.json"

step "attach under scripted PTY; press shift+tab then ctrl+p, then detach"
node --disable-warning=ExperimentalWarning - "$REPO" <<'EOF'
const [repo] = process.argv.slice(2);
const pty = await import(`${repo}/node_modules/node-pty/lib/index.js`);
const child = pty.spawn("node", [`${repo}/src/core/main.ts`, "attach"], {
  name: "xterm-256color", cols: 80, rows: 24,
  cwd: process.cwd(), env: process.env,
});
let output = "";
child.onData((d) => { output += d; });
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
// The TUI has no "ready" event visible to the attach client; each wait below
// is a human-scale settle delay for pi to process the keypress and repaint.
// This is demonstration-style TUI driving, not production code.
await settle(2000);
child.write("\x1b[Z");   // shift+tab: cycle thinking level
await settle(1000);
child.write("\x10");     // ctrl+p: cycle model
await settle(1000);
child.write("\x1d");     // ctrl+]: detach
await new Promise((r) => child.onExit(r));
EOF

pictl get-state > "$ART/state-2-after.json"

step "suspend to end the tail cleanly"
pictl suspend > /dev/null
wait "$TAIL_PID" || true

step "cleanup"
pictl purge > /dev/null

echo
echo "=== TUI mutations: state change and broadcast events ==="
python3 - "$ART" <<'EOF'
import json, sys
art = sys.argv[1]
s1 = json.load(open(f"{art}/state-1-before.json"))
s2 = json.load(open(f"{art}/state-2-after.json"))
print(f"model:         {s1['model']['id']} -> {s2['model']['id']}")
print(f"thinkingLevel: {s1['thinkingLevel']} -> {s2['thinkingLevel']}")
print("events observed by passive tail:")
for line in open(f"{art}/events.jsonl"):
    e = json.loads(line)
    if e["type"] not in ("agent_start","agent_end","turn_start","turn_end",
                         "message_start","message_update","message_end"):
        print(f"  {e}")
EOF
