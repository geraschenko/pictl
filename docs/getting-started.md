# getting started

Purpose: practical alpha setup and first-use examples for pictl. This document assumes you are working from a cloned pictl repo. It will need to change once pictl has a packaged install path.

Question answered: **what do I need to do to use pictl?**

## Alpha assumptions

For now:

- build pictl from this repo;
- use the forked pi package installed in `node_modules`;
- do **not** replace your normal `pi` binary;
- point pictl at the fork with `PICTL_PI_BIN`;
- use the normal pictl registry under `PICTL_DIR`.

The default `PICTL_DIR` is under your pi state directory. Agents you spawn during the demo will show up in normal `pictl list` output until you archive or purge them.

## Install pictl locally

From the pictl repo:

```sh
npm install
npm run build
npm link
```

Check that `pictl` is now on your `PATH`:

```sh
pictl --version
```

## Use the bundled forked pi

`npm install` installs the forked pi package that pictl currently depends on. Use that binary explicitly:

```sh
export PICTL_PI_BIN="$PWD/node_modules/.bin/pi"
```

Confirm it is the forked binary:

```sh
"$PICTL_PI_BIN" --version
```

This lets you keep any normal `pi` installation on `PATH` unchanged. pictl will use `PICTL_PI_BIN` whenever it spawns or revives an agent.

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

Send a prompt programmatically and wait for the turn to finish:

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

From the pictl repo:

```sh
export PICTL_PI_BIN="$PWD/node_modules/.bin/pi"
export PICTL_TARGET="$(pictl spawn)"
echo "$PICTL_TARGET"
pictl attach
```

Leave Terminal A attached.

### Terminal B: control the attached agent

From the same pictl repo, paste the agent id printed by Terminal A:

```sh
export PICTL_PI_BIN="$PWD/node_modules/.bin/pi"
export PICTL_TARGET="<agent-id-from-terminal-a>"
```

Now send prompts from Terminal B and watch Terminal A update:

TDC: how is the agent going to know what demo is currently happening? If we want the agent to know something about pictl, it needs to learn that information somehow.
```sh
pictl prompt "Explain in one short paragraph what is happening in this demo."

pictl prompt "List three things a script can do to this same live agent while a human is attached."

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

- `PICTL_TARGET` is just an ergonomic default. Any command can still use `--target <agent-id-or-prefix>` explicitly.
- `pictl spawn` prints the agent id and returns only once the agent is reachable.
- `pictl attach` requires a real terminal.
- `pictl archive` hides an agent from normal `pictl list` output but keeps it resumable.
- `pictl purge` permanently deletes the agent record from `PICTL_DIR`.
