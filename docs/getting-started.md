# getting started

Purpose: practical alpha setup and first-use examples for pictl. This document assumes the current GitHub install path. It will need to change once pictl has a normal package release.

Question answered: **what do I need to do to use pictl?**

## Install pictl

Install the alpha from GitHub:

```sh
npm install -g github:geraschenko/pictl
```

Check that `pictl` is now on your `PATH`:

```sh
pictl --version
```

## Demo 1: try pictl in one terminal

Start an agent and make it the default target for subsequent commands:

```sh
export PICTL_TARGET="$(pictl spawn)"
echo "$PICTL_TARGET"
```

Inspect it:

```sh
pictl list
pictl status
```

Send a prompt programmatically. By default, `pictl prompt` streams messages as they appear and waits for the turn to finish:

```sh
pictl prompt "Say hello in one sentence."
```

Print the last assistant response:

```sh
pictl get-last-assistant-text
```

Attach to the live interactive TUI:

```sh
pictl attach
```

Detach with `ctrl+]`. Detaching does not stop the agent.

Archive, resume, and purge the agent:

```sh
pictl archive
pictl list --all
pictl resume
pictl purge
```

## Demo 2: two-terminal video script

This is the more visual demo: one terminal is attached to the pi TUI while another terminal drives the same live agent through pictl commands.

### Terminal A: spawn and attach

```sh
export PICTL_TARGET="$(pictl spawn)"
echo "$PICTL_TARGET"
pictl attach
```

Leave Terminal A attached.

### Terminal B: control the attached agent

Paste the agent id printed by Terminal A:

```sh
export PICTL_TARGET="<agent-id-from-terminal-a>"
```

Now send prompts from Terminal B and watch Terminal A update. These prompts can either explain the demo context directly or ask the agent to read the repo docs / pictl skill to understand what pictl is.

```sh
pictl prompt "You are being controlled through pictl from another terminal while a human watches your live TUI. Explain what this demonstrates in one short paragraph."

pictl prompt "Given that context, list three things a script can do to this same live agent while a human remains attached."

pictl get-last-assistant-text
```

Optional: show that the session is also machine-readable:

```sh
pictl tail
```

### Cleanup

Detach Terminal A with `ctrl+]`, then in either terminal:

```sh
pictl archive
pictl list --all
pictl purge
```

## Notes

- `PICTL_TARGET` is just an ergonomic default. Any command can still use `-t <agent-id-or-prefix>` explicitly.
- `pictl spawn` prints the agent id and returns only once the agent is reachable.
- `pictl attach` requires a real terminal.
- `pictl archive` hides an agent from normal `pictl list` output but keeps it resumable.
- `pictl purge` permanently deletes the agent record from `PICTL_DIR`.
