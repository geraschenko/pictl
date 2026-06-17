# architecture

Purpose: explain how pictl works under the hood. This is a **preliminary sketch**, not authoritative documentation.

Question answered: **how does pictl work?**

Topics to cover:

- No central daemon:
  - one daemon process per agent;
  - daemon is launched as `pictl _daemon`.
- `PICTL_DIR` as the registry:
  - default location;
  - one directory per agent;
  - metadata persisted to disk.
- Agent directory contents:
  - `agent.json`;
  - `pi.sock`;
  - `tty.sock`;
  - logs / markers such as archive or tombstone files.
- The two real protocols:
  - `pi.sock`: pi RPC JSONL protocol;
  - `tty.sock`: terminal attach protocol.
- Daemon responsibilities:
  - allocate PTY;
  - run pi with `--rpc-socket`;
  - maintain screen state with a headless terminal;
  - serve attach clients;
  - write lifecycle metadata.
- Dormant agents and revival.
- pictl CLI as the "shell SDK": a language-neutral control surface usable by humans, agents, and scripts.
