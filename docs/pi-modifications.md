# pi modifications

Purpose: explain the changes needed in pi for pictl to work. This is a **preliminary sketch**, not authoritative documentation.

Question answered: **what changed in pi?**

Topics to cover:

- `pi --rpc-socket <path>` mode:
  - pi remains an interactive TUI;
  - it also exposes JSONL RPC over a Unix domain socket;
  - multiple clients can connect simultaneously.
- Why simultaneous access matters:
  - TUI, scripts, and agents can all observe/control the same process;
  - pictl should not need to screen-scrape.
- RPC protocol visibility/control additions:
  - broadcast events;
  - `session_changed` on connect and when sessions are replaced;
  - `get_entries`, `get_tree`, `navigate_tree`;
  - enough state to wait, tail, resume, and supervise reliably.
- Difference between ephemeral events and durable session entries.
- Which pieces are fork-only today and which should ideally be upstreamed.
- Any compatibility/version-skew issues pictl should document.
