# getting started

Purpose: give practical installation and first-use guidance. This is a **preliminary sketch**, not authoritative documentation.

Question answered: **what do I need to do to use pictl?**

Topics to cover:

- Install/build pictl:
  - `npm install`;
  - `npm run build`;
  - `npm link` for local development.
- Install/build the pi fork pictl currently requires, @geraschenko/pi-coding-agent.
- Running alongside regular pi:
  - keep normal `pi` on `PATH` if desired;
  - set `PICTL_PI_BIN=/path/to/forked/pi` for pictl.
- First-use examples:
  - spawn an agent;
  - send a prompt from the CLI;
  - wait for a turn;
  - attach interactively with `pictl attach`;
  - detach without killing the agent;
  - archive, resume, and purge.
- Mention trust/project approval issues, e.g. when `-- --approve` is needed.
- Keep this document concrete; multi-agent workflows can be added later.
