# philosophy

Purpose: develop the broader argument for pictl. This is a **preliminary sketch**, not authoritative documentation.

Question answered: **why build it this way?**

Topics to cover:

- Progressive automation:
  - start with normal interactive agent use;
  - notice repeated patterns;
  - move stable patterns into scripts or classical code;
  - keep full interactivity throughout.
- Why simultaneous access matters:
  - a human can attach while automation is running;
  - scripts can observe and steer without owning the whole interaction;
  - other agents can participate through the same control surface.
- Why giving agents the same tools humans use may matter:
  - agents can spawn peers;
  - agents can inspect or prompt other agents;
  - humans can debug the resulting system using the same commands.
- Cognitive-load offloading:
  - humans and agents should hand repetitive control flow to classical algorithms;
  - agents remain useful for judgment, interpretation, and language-heavy tasks;
  - scripts handle bookkeeping, waiting, retrying, cursor persistence, and fan-out.
- Possible contrast with existing orchestration systems:
  - avoid premature claims until `alternatives.md` has real research;
  - likely axis: sealed automation vs inspectable, steerable, progressive automation.
- Keep this grounded in concrete examples as they are developed.
