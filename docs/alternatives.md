Hey, you're not supposed to be reading this; it's unfinished. But if you care about alternatives, you may want to look at [agent-harness-landscape.md](agent-harness-landscape.md) (AI-generated overview of the ecosystem).

# alternatives

Purpose: collect research notes on other agent orchestration/control systems and compare assumptions. This is a **preliminary sketch**, not authoritative documentation.

Question answered: **what else exists, and what is pictl trying to do differently?**

Topics to research:

- General categories rather than only individual products:
  - sealed subagent/task APIs;
  - workflow DAG frameworks;
  - IDE-integrated agents;
  - chat-first interactive agents;
  - autonomous agent platforms / dashboards;
  - tmux/screen-style ad hoc CLI orchestration;
  - library-first multi-agent frameworks.
- For each category, compare:
  - interactivity while automation is running;
  - whether humans can attach to worker agents;
  - scriptability from ordinary shell tools;
  - durable state / resumability;
  - multi-client access to the same live agent;
  - philosophy: sealed automation vs progressive automation.
- Be explicit about uncertainty: this needs research, not vibes.
- Possible conclusion to test: many systems optimize for either interactive use or orchestration, but not for a smooth path between them.
