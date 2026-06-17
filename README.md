# pictl

`pictl` is a control plane for pi coding-agent instances.

This README is currently a **non-authoritative outline**. The docs below are sketches for a discussion-driven writeup, not final documentation.

## Document map

These documents are meant to answer different questions:

- **What is required to use this?**\
  [`docs/getting-started.md`](docs/getting-started.md) — practical install and first-use notes.

- **What changed in pi?**\
  [`docs/pi-modifications.md`](docs/pi-modifications.md) — the pi fork changes pictl depends on, especially `--rpc-socket` mode.

- **How does pictl work?**\
  [`docs/architecture.md`](docs/architecture.md) — holder processes, `PICTL_DIR`, `pi.sock`, `tty.sock`, and pictl as a shell SDK.

- **Why build it this way?**\
  [`docs/philosophy.md`](docs/philosophy.md) — progressive automation, simultaneous human/script/agent access, and the collaboration model.

- **What else exists?**\
  [`docs/alternatives.md`](docs/alternatives.md) — research notes on other agent orchestration/control systems and how their assumptions compare.

## Very short working description

pictl aims to let humans, scripts, and other agents interact with the same live pi agents through one binary. The goal is to preserve full interactivity while making the same actions scriptable, so useful manual workflows can gradually become automation.
