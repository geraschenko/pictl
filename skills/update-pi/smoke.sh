#!/usr/bin/env bash
# Provider-free smoke of the bundled pi under pictl, for step 5 of SKILL.md.
# Isolated HOME, pi agent dir, registry and cwd; PI_OFFLINE=1; no MCP, skills
# or discovered extensions; no credentials. Needs `npm run build` first.
# Run under a whole-harness deadline: `timeout 150 skills/update-pi/smoke.sh`.
# Prints each step's output for review; it asserts nothing itself.
set -u
skill_dir=$(cd "$(dirname "$0")" && pwd)
repo_dir=$(cd "$skill_dir/../.." && pwd)
pictl_main=$repo_dir/dist/core/main.js
[ -f "$pictl_main" ] || { echo "missing $pictl_main; run npm run build" >&2; exit 2; }
unset PICTL_PI_BIN

# A short base dir: socket paths under PICTL_DIR must fit sun_path.
state_dir=$(mktemp -d /tmp/pictl-smoke.XXXX)
agent_cwd=$state_dir/cwd
export HOME=$state_dir/home PI_CODING_AGENT_DIR=$state_dir/pi-agent PICTL_DIR=$state_dir/registry PI_OFFLINE=1
mkdir -p "$HOME" "$PI_CODING_AGENT_DIR" "$PICTL_DIR" "$agent_cwd"

cleanup() {
  for agent_json in "$PICTL_DIR"/*/agent.json; do
    [ ! -f "$agent_json" ] || node -e 'const agent = require(process.argv[1]); for (const pid of [agent.daemonPid, agent.piPid]) try { process.kill(pid); } catch {}' "$agent_json"
  done
  rm -rf "$state_dir"
}
trap cleanup EXIT

pictl() { timeout 40 node "$pictl_main" "$@"; }
step() { echo "== $*"; }

step "bundled pi version"; "$repo_dir/node_modules/.bin/pi" --version
step spawn
agent_id=$(pictl spawn --cwd "$agent_cwd" -- --no-mcp --no-extensions --no-skills -e "$repo_dir/extensions/navigate-tree.ts")
echo "rc=$? id=$agent_id"
[ -n "$agent_id" ] || exit 1
pictl status -t "$agent_id" | grep -E '^(status|pi bin|args):'
step "get-state (expect idle, 0 pending)"
pictl get-state -t "$agent_id" | grep -E '"(sessionId|isStreaming|pendingMessageCount)"'

# Idle steer/follow-up only queue; with no model they stay pending, so
# clear-queue below is what lets suspend's idle wait finish.
step "steer while idle (expect queued)"; pictl steer -t "$agent_id" hi
step "follow-up while idle (expect queued)"; pictl follow-up -t "$agent_id" hi

# The extension command without arguments is handled (it reports an
# extension_error) and starts no turn; `turn-end` must end at the response.
step "handled prompt (expect prompt events, a cursor, prompt exit)"
prompt_start_ns=$(date +%s%N)
pictl prompt -t "$agent_id" --type events --json --timeout 30 /navigate-tree; echo "rc=$?"
echo "elapsed_ms=$((($(date +%s%N) - prompt_start_ns) / 1000000))"

step "tty modes (fresh attach)"
timeout 20 node "$skill_dir/tty-modes.mjs" "$PICTL_DIR/$agent_id/tty.sock" "$repo_dir/dist/core/index.js"

# pi writes a session file from the first user or assistant message only, which
# needs a provider; without one, revival starts a fresh session.
session_before_revive=$(pictl get-state -t "$agent_id" | grep '"sessionId"')
step "clear-queue"; pictl clear-queue -t "$agent_id"
step suspend; pictl suspend -t "$agent_id"; echo "rc=$?"
step resume; pictl resume -t "$agent_id"; echo "rc=$?"
session_after_revive=$(pictl get-state -t "$agent_id" | grep '"sessionId"')
step "session after revive (fresh is expected without a provider)"
echo "before:$session_before_revive"; echo "after: $session_after_revive"
step purge; pictl purge -t "$agent_id"; echo "rc=$?"
