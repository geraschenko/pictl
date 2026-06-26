https://claude.ai/chat/967ad11f-fce9-4ebb-9699-f243a74a2101
Generated from this prompt:
I'd like to research the landscape of AI agent harnesses and orchestration systems (e.g. claude code, codex, gemini, pi, cursor, conductor, hermes, openclaw, LangGraph, AutoGen, Gastown, various extension systems like pi-subagents). I want to understand the kinds of problems these systems aim to solve. (Note: I expect I'm missing representatives of important categories; don't assume my list is anything like complete!) For each product, I want to understand what makes it awesome _on its own terms_. What makes it special? What workflows does it make beautiful? What are the philosophies of their creators and passionate users? I'm interested in any recurring concepts, beautiful unique ideas (e.g. I'm shocked other harnesses haven't adopted pi's beautiful `/tree` for fine-grained context management), design tensions, and unmet needs.

# The Landscape of AI Agent Harnesses and Orchestration Systems

_A philosophy-first survey — what each system is beautiful at, on its own terms — as of June 2026._

---

## How to read this

This is organized by **layer**, not by vendor, because the single most clarifying idea in the space right now is the distinction between the _model_ and the _harness_. The community slogan, from the HKUDS OpenHarness project, is blunt: "The model is the agent. The code is the harness." The harness is everything you wrap around a stateless model to make it an agent — the loop, the tool-calling layer, context management, memory, permissions, the execution sandbox, the platform integrations, and the supply chain that ships it. Once you have that lens, the whole field sorts itself into layers that solve genuinely different problems, and you stop comparing things that aren't competitors (pi and Devin are not rivals; they live three layers apart).

A few epistemic warnings, since you asked for the real picture:

- **This moves weekly.** Between roughly January and June 2026, Cursor shipped three Composer model generations, OpenAI rebuilt Codex into a multi-surface umbrella, Google launched Antigravity and then folded Gemini CLI into it, AutoGen got absorbed into the Microsoft Agent Framework, and an entire pi-based ecosystem (pi → OpenClaw → Hermes) materialized. Treat any specific version number here as a snapshot.
- **Star counts are noise.** Secondary sources cite the same repositories at wildly different numbers. I've avoided quoting them; where popularity matters I've said so qualitatively.
- **Attribution over confidence.** Where a claim is load-bearing I've named the source in prose. A short "Sources" section at the end groups the primary references.

---

## The layered map (what you were missing)

Your list spans three or four layers but is densest in the coding-harness band. Here's the full stack, roughly bottom-to-top by abstraction:

1. **Harness primitives / minimal harnesses** — the loop and context engine as a reusable thing. _pi, Claude Agent SDK, OpenHarness._
2. **First-party coding CLIs / platforms** — vendor-blessed terminal agents tied (loosely or tightly) to a model. _Claude Code, Codex, Gemini CLI → Antigravity CLI._
3. **Open-source terminal harnesses** — model-agnostic CLI agents with strong opinions. _Aider, OpenCode, Goose, Amp, OpenHands, Cline, SWE-agent._
4. **Agent-first IDEs & editor agents** — the agent as a first-class object in a GUI. _Cursor, Antigravity, Windsurf, Kiro, GitHub Copilot._
5. **Parallel runners / orchestration GUIs** — "one human, many agents," usually over git worktrees. _Conductor, Sculptor, opcode, Intent, the Codex app, Antigravity's Manager._
6. **Multi-agent orchestrators ("the factory")** — agents supervising agents at scale. _Gastown, Claude-Flow, claude-squad/herdr._
7. **Personal-assistant harnesses (beyond code)** — the agent as a cross-channel companion. _OpenClaw, Hermes._
8. **Autonomous / cloud SWE agents** — delegate a whole bounded task, async. _Devin, Jules, Factory, GitHub Copilot coding agent, OpenHands Cloud._
9. **Agent frameworks / SDKs (build-your-own)** — libraries for assembling agents in code. _LangGraph, AutoGen → Microsoft Agent Framework, CrewAI, OpenAI Agents SDK, Google ADK, Pydantic AI, plus durable-execution engines._
10. **The interop layer (protocols)** — the connective tissue. _MCP, A2A, the three ACPs, AG-UI, AGENTS.md._

The rest of the document walks these, then steps back to the cross-cutting ideas, tensions, and gaps — which is where the real intellectual payoff is.

---

## Layer 1–3: The harness band (where you live)

### pi — the minimal harness as a statement of principle

pi (Mario Zechner / _badlogic_, of libGDX fame; shipped under Earendil Inc. at pi.dev, npm `@earendil-works/pi-coding-agent`) is the purest articulation in the field of a single idea: **the harness should be a small, legible core with maximum extension surface and minimum product opinion.** Its own positioning is that it's a _reference implementation_ of the harness layer — task intake, context management, tool execution, loop control — and almost nothing else. It deliberately omits the things every other agent bakes in: no built-in subagents, no plan mode, no permission popups, no todo system, no background bash in the core. Those become _your_ extensions, or community packages, rather than the tool's opinions. The fact that "pi-subagents" exists as an _extension_ rather than a core feature is the philosophy working exactly as intended: the maintainer refuses to ship the abstraction, and the community adds it for the people who want it.

What makes it beautiful on its own terms is the `/tree` model, which you've already clocked. A pi session isn't a linear chat transcript; it's a tree where every message has an `id` and a `parentId`, and your current position is the active leaf. `/tree` moves that leaf anywhere in the tree and continues from there; `/fork` spins a past point into a new session. The whole history stays in one JSONL file. As StackToHeap's write-up puts it, you can treat a session like a branching workspace: explore aggressively down a branch, keep the useful outcome, hop back to your clean trunk, and you've gotten most of the benefit of subagents without ever leaving one agent or one context. (There's a related extension, `pi-context`, explicitly inspired by kimi-cli's "d-mail" time-travel, that adds lossless context navigation as first-class tools.) The reason this is _special_ and not just nice is architectural: branching requires modeling the session as a tree from the start. Most harnesses treat the session as an append-only log, and you can't retrofit cheap branching onto an append-only log. pi made the tree the substrate, so the feature falls out for free. More on why nobody copied it in the "beautiful ideas" section — it's one of the genuine puzzles of the field.

The passionate-user pitch (well captured by the "I love Pi, but I can't use it" review genre) is that pi is what you reach for when you want to _own_ your harness — embed `@earendil-works/pi-agent-core` in a Node app, drive it over RPC, build your scaffolding as reusable packages instead of re-prompting a product every session. The counter-pull is exactly that it gives you building blocks, not a finished product, which is friction if you just want to ship.

### Claude Code — the unopinionated platform that became a standard

Claude Code's original framing (Boris Cherny's) was "low-level and unopinionated" — a Unix-y building block, not a product with a workflow. What's interesting is how that minimalism evolved into a _layered platform_ whose formats became de facto industry standards. An April 2026 arXiv analysis dissects it as a 7-component, 5-layer system, and the practitioner framing (Hamza Farooq, the "boringbot" piece) is the most useful lens: Claude Code gives you a set of primitives at different context costs, and the whole craft is _using the right primitive at the right layer_.

- **CLAUDE.md** — persistent repo/user memory, loaded into context.
- **Skills** — markdown directories that load _progressively and contextually_ (the model reads a one-line description, pulls the full SKILL.md only when relevant). This is the breakout idea.
- **Subagents** — isolated fresh-context workers for parallel or exploratory work; the answer to context rot.
- **Hooks** — code that intercepts the tool lifecycle to _enforce_ rules deterministically (surface a type error and force the agent to keep working until it's gone).
- **Plugins** — bundles of MCP servers + skills + subagents + hooks, distributed through marketplaces.
- **MCP** — the external-tool integration path.

The deepest idea here belongs to the Skills concept, and the clearest statement of it comes from Jesse Vincent's _Superpowers_ (obra/superpowers), the dominant community skills framework. Its bet, as Marc Nuri paraphrases it, is that what coding agents lack is not _capability_ but _discipline_ — and discipline can be distributed as plain text. Superpowers ships an entire engineering culture (brainstorm → spec → worktree → planning → subagent-driven execution → TDD red-green-refactor → two-stage review → merge) as a folder of SKILL.md files plus a session hook that tells the agent to read them first. No fine-tuned model, no SDK. And crucially, _the same folder runs across Claude Code, Codex, Cursor, Copilot CLI, Gemini CLI, and OpenCode without modification._ Skills became the first genuinely portable cross-harness artifact. That portability is the single most important structural fact about Claude Code's influence: it didn't just build an agent, it minted formats (Skills, CLAUDE.md, the plugin layout) that competitors now consume.

Recent direction: native messaging channels (Telegram/Discord/iMessage), the Claude Agent SDK (the harness extracted as a library, with SKILL.md as procedural memory), and — per mid-June 2026 coverage — "Dynamic Workflows" with subagent fan-out capped at a thousand. The throughline is unchanged: ship primitives, let the ecosystem compose them.

### Codex — one account, every surface

OpenAI's Codex is the clearest example of a _different_ harness philosophy: **vertical integration around a single account-and-model context, spread across every surface a developer touches.** "Codex" today is an umbrella — a Rust CLI (open source), an IDE extension, a cloud agent (chatgpt.com/codex) for delegated multi-hour parallel tasks, a GitHub bot, computer-use via screen reading, and a desktop app (macOS, then Windows in March 2026) that manages multiple agents in parallel. They all share one model lineage (the GPT-5.x-Codex family — GPT-5.5 as the agentic-first retrain, 5.4-mini for cheap subagents, a "spark" variant tuned for near-instant iteration) and one auth context, so a session you start in the CLI can be picked up in the app or the cloud.

What's special is the _coherence of the surface_. Where Claude Code is a primitive you compose and pi is a core you embed, Codex is a single product fabric where the question "where am I working" becomes irrelevant — terminal, editor, cloud, and GitHub are views onto the same agent. The native `app-server`/`exec-server` protocol that powers this is real enough that other harnesses (OpenClaw) integrate against it to get native thread resume and compaction. The stated ambition has widened from "writing code" to "general work agent." The obvious tension is lock-in: Codex is tightly coupled to OpenAI models, which is the price of the coherence.

### Gemini CLI → Antigravity CLI — open, generous, and just consolidated

Gemini CLI launched (early 2026) as Google's open-source (Apache-2.0) terminal agent with a recognizable shape: a ReAct loop, MCP-native, GEMINI.md context files, checkpointing, sandboxing, trusted folders, headless scripting, an enormous context window, and an unusually generous free tier — its differentiator was _openness and reach_ (inspect the code, verify the security, run it for free). Its philosophy is the Google-scale-public-good stance: an agent as open infrastructure.

The news, as of _June 18, 2026_ (literally the day before this was written), is that Google is folding Gemini CLI into **Antigravity CLI** — rebuilt in Go, with async background workflows, sharing architecture with the Antigravity 2.0 platform, and keeping Skills/Hooks/Subagents/Extensions (now "Antigravity plugins"). Paid and free tiers move to Antigravity. So the standalone Gemini CLI era is ending and the capability is being absorbed into Google's agent platform — see the Antigravity entry below.

### The open-source terminal harnesses — opinions, not products

This band is where philosophy is most concentrated, because each tool is essentially one person or team's strong claim about what matters:

- **Aider** is the elder. Its conviction is **git as the source of truth**: every change the agent makes is a real commit, so your entire interaction is auditable, reversible, and reviewable inside your normal git workflow. It also pioneered the _repo map_ — a tree-sitter-derived, ranked sketch of your codebase that gives the model structural awareness cheaply. The aesthetic, as one comparison put it, is "a disciplined patch tool": make a focused change, inspect the diff, commit. It bakes in audit and reversibility more deeply than anything else in the list.
- **OpenCode** (from SST) is the **provider-pluralist**: 75+ model providers behind one interface, a client/server architecture, a TUI "Mission Control" that renders diffs inline and toggles between Plan and Build agents with a keystroke, LSP integration, privacy-first. Its bet is that the harness should be a neutral, beautifully-engineered terminal surface and the model should be swappable.
- **Goose** (Block, ex-Square) was **co-designed with Anthropic around MCP from day one**, and it's deliberately _general-purpose_ — not coding-specific. Its sweet spot is DevOps-flavored glue: scripts, sysadmin, infra, research, file processing. The thesis is "one local agent for code _and_ the adjacent work."
- **Amp** (Sourcegraph) is the **radical-simplicity** play: famously few knobs, no model picker (the harness chooses the best model for the task), thread sharing as a first-class social primitive, and a "Deep mode" extended-reasoning research path for hard, ambiguous problems ("figure out why this CI flakes only on Mondays"). The philosophy is that the agent _is_ the product and your job is to use it, not tune it.
- **OpenHands** (formerly OpenDevin) is the **open self-hosted Devin** — a full agentic dev environment (SDK + CLI + local web GUI + hosted cloud) that browses, executes, and manages files end-to-end.
- **Cline** is the **multi-editor** pick (VS Code, JetBrains, Neovim, Emacs), model-agnostic, with strong MCP support.
- **SWE-agent** (Princeton) is **research infrastructure**, and it matters for an idea rather than a workflow: it introduced the _Agent-Computer Interface_ (ACI) — the insight that how you design the tools an agent sees (their affordances, their error messages) matters as much as the model. Its own docs now point people to **mini-swe-agent**, a ~100-line implementation, which is itself a philosophical statement: a huge fraction of agent capability needs almost no harness at all.

A recurring meta-observation across this band, nicely put by one comparison: these are _detached_ agents. They run in your terminal independent of your editor, so you pair them with whatever editor you like and never migrate when a better editor ships. That detachment — "keep your tool choice" — is the headline reason to prefer this band over the IDEs.

---

## Layer 4: Agent-first IDEs and editor agents

### Cursor — speed as a feature, agents as objects

Cursor (Anysphere) made two strategic bets with Cursor 2.0 (late October 2025) that define it. First, **vertical integration into its own model**: Composer, an in-house frontier coding model (MoE, RL-trained, with a "compaction-in-the-loop" technique that explicitly trains against the "forgot the constraint mid-refactor" failure), shipped through three generations in five months. The defining design value is _latency_ — roughly 4× faster than comparably-capable models, most turns under 30 seconds — on the theory that a fast enough loop changes the UX _qualitatively_: iteration feels like conversation rather than batch jobs. Second, an **agent-centric UI**: agents become first-class objects in a sidebar, manageable as processes, runnable up to eight in parallel, each with logs and diffs you inspect — a reframing from file-centric to agent-centric editing. The passionate-user pitch is that Composer is the most _responsive_ agent to actually work _with_, and that the agent-as-object model is the right information architecture for the coming era.

### Antigravity — the agent gets its own room, and Artifacts as the review surface

Google Antigravity (launched November 18, 2025 alongside Gemini 3; a VS Code fork; now a 2.0 ecosystem of standalone app + IDE + CLI + SDK) is the most fully-realized statement of the **agent-first** thesis: as Google puts it, agents shouldn't be chatbots in a sidebar; they should have their own dedicated space to work. The default surface is the **Manager View** — a mission-control console where you spawn and supervise many agents, each tracking its own task state — with a traditional Editor View available when you want to be hands-on.

Antigravity contributes what I think is one of the genuinely beautiful ideas in the whole field, aimed squarely at the hardest problem in delegation: _trust requires review, and reviewing raw tool-call logs is miserable._ Its answer is **Artifacts** — agents produce tangible, human-readable deliverables (implementation plans, task lists, screenshots, and browser walkthrough recordings) as the artifact you review, instead of scrolling a transcript. And the interaction loop on top is lovely: rather than restarting the conversation, you **comment on the artifact** — highlight a line in the implementation plan and write "use Zod instead of Yup," exactly like leaving feedback in a Google Doc. Paired with deep Chrome control (the agent starts your app, clicks through it, notices the misaligned button, fixes the CSS, screenshots the result), verification shifts from "trust a green test log" to "watch an automated QA pass." This is the cleanest articulation anywhere of _how a human should supervise an agent's work product_.

### Kiro, Windsurf, Copilot, Warp — the rest of the editor band

- **Kiro** (AWS) is the **spec-driven** IDE: it enforces structured specifications and _mandatory developer checkpoints before any code is written_. Its philosophy is a direct rebuttal to "vibe coding" — pay your review tax _upfront_ in spec approval rather than _downstream_ in PR triage. The tradeoff it makes explicit: where do you want to spend your attention?
- **Windsurf** (the agentic IDE with its Cascade agent) is now part of **Cognition** (Devin's maker) after a turbulent acquisition saga — so the autonomous-agent company and the IDE company are converging, which tells you something about where the puck is going.
- **GitHub Copilot** spans the boundary: per-keystroke autocomplete (the original) _and_ a coding-agent mode where you assign an issue and it opens a PR. It's the incumbent's "meet you where your code already lives (GitHub)" play.
- **Warp** has become a terminal-native "agentic development environment" that runs Claude Code / Codex / Antigravity inside one UI — i.e., the terminal itself as a multi-harness host.

The cross-cutting observation for this entire layer (Dave Patten's "they're all starting to look strangely similar under the hood") is the **convergence thesis**, which I'll develop later: different interfaces, different models, increasingly _the same architecture_.

---

## Layer 5: Parallel runners — one human, many agents

The defining constraint here is human attention, not model capability: once one agent can do real work, the bottleneck becomes _how does one person supervise five of them without drowning in terminal tabs and git branches?_ The shared answer is **git worktrees for isolation** — each agent gets its own branch and working copy, so they don't collide, and you review and merge from one place.

- **Conductor** (Melty Labs — who built the Melty editor first, then pivoted) essentially _pioneered the category_ of the Mac "agentic parallel runner." It runs parallel Claude Code / Codex / Cursor agents, each in an isolated worktree, with a single UI to watch status, review diffs, and merge; the app is free and you bring your own subscription. It's well-capitalized now (YC S24, a sizable Series A), which is a signal that "orchestration UX" is seen as a real product surface and not just a script.
- **Sculptor** (Imbue) presses on _safety_: parallel Claudes in containers (not just worktrees), so you can jump between isolated environments and test changes, with suggestions that catch issues as you go.
- **opcode** is a GUI/toolkit for Claude Code specifically — custom agents, session management, background runs.
- **Intent** (Augment Code) goes "further up" the stack: spec-driven decomposition, specialist agent personas, BYO-agent support, and a "Context Engine" doing semantic dependency analysis across very large codebases. It's the developer-in-the-loop orchestration answer.
- And note the incumbents built their own: the **Codex app** and **Antigravity's Manager** are first-party parallel runners, which is mild bad news for the third-party app category.

---

## Layer 6: Multi-agent orchestrators — the factory

### Gastown — Kubernetes for agents, gloriously feral

Gastown (Steve Yegge; "Gas Town") is the maximalist position, and the most fun. Yegge's thesis, which he evangelized for months before building it himself starting August 2025, is that **Claude Code is just a building block** and the future is _orchestration_ — "Kubernetes for agents," with multiple levels of agents supervising other agents. The execution is themed as a Mad-Max wasteland and the role names _are_ the architecture: a **Mayor** orchestrates and distributes work, **Polecats** execute tasks in parallel in isolated git worktrees, a **Witness** and **Deacon** patrol for stalled or unhealthy agents, a **Refinery** manages merges, all under a three-tier watchdog chain (a Go daemon heartbeating up to AI triage agents). It now has a cloud home via Kilo and a federated trust network — "the Wasteland" — for linking many Gas Towns together.

The single most-borrowed idea from Gastown is **beads** — a lightweight, structured, _git-backed issue ledger_ that serves as **external memory** for the agent swarm. Because models don't retain context across sessions or role-swaps, beads gives the team a shared, persistent place to track, reference, and update work, so continuity survives any individual prompt ending or agent restarting. It's the multi-agent analog of "the database is the source of truth," and it's the right shape for the problem.

It's also, by every honest account (Maggie Appleton's and paddo.dev's are the good ones), _feral_: entirely vibecoded, hastily designed, burning thousands of dollars a month in API costs, occasionally auto-merging failing tests, with supervisor agents reduced to "aggressive prompting and constant nudging" to keep workers from stalling. paddo's framing of "two kinds of multi-agent" is worth internalizing: there's the anthropomorphic kind that mimics a human org chart (Analyst → PM → Architect → Dev → QA, with all the phase-gate and role-confusion pathology that implies) versus Gastown's _operational_ roles (orchestrate / execute / monitor / merge). Gastown is a real glimpse of the autonomous-factory future and simultaneously a cautionary tale about its current cost and chaos. (See also **Claude-Flow**, an enterprise-flavored orchestration platform, and lighter "agent multiplexers" like **claude-squad** and **herdr** that just let you babysit several terminal agents at once.)

---

## Layer 7: Personal-assistant harnesses — beyond code

A whole ecosystem grew up around pi as an _embeddable SDK_, pointed not at coding but at the agent-as-companion.

### OpenClaw — the same loop, every channel you talk on

OpenClaw (an open-source project; the academic literature attributes it to "Steinberger and contributors") embeds pi's `AgentSession` directly via `createAgentSession()` from `@earendil-works/pi-agent-core` and wraps it in a **messaging gateway** that reaches you on 25+ channels — WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Teams, Matrix, Feishu, LINE, WeChat, and more — all from one process, with voice. Its design choice is _breadth of integration on top of someone else's runtime_: it doesn't reinvent the agent loop, it chooses pi for you and makes "one agent, one memory, every surface" real. Beyond that, it doubles as a **control plane for other harnesses** via the Agent Client Protocol — you can have OpenClaw spawn Claude Code or Codex sessions from a chat thread, with resilient session lifecycles that survive gateway restarts and dedicated isolated workspaces per agent. The tradeoff it names honestly: it's a _full assistant you adopt_, not a library you embed — if you want to wire an agent into something you already have, you drop down a layer to pi.

### Hermes — the agent that grows with you

Hermes Agent (Nous Research, MIT-licensed; explicitly distinct from their Hermes _LLM_ line) is the breakout of this ecosystem and stakes out the most ambitious philosophical claim: it's **self-improving**. It's the one agent built around a closed **learning loop** — it creates skills from experience, refines them during use, nudges itself to persist what it learned, searches its own past conversations, and builds a deepening model of _you_ across sessions. Nous's framing, and the reason it resonates, is a thesis about open models: _open-source models become genuinely useful if they have the right harness_ — the harness, not the weights, is the missing piece. It's aggressively model-agnostic (one of the most provider-agnostic harnesses around: Nous Portal, OpenRouter's 200+ models, Novita, NVIDIA NIM, GLM, Kimi, MiniMax, your own endpoint), runs anywhere from a $5 VPS to a GPU cluster to serverless (local / Docker / SSH / Singularity / Modal backends), uses SQLite + FTS5 for searchable session memory, and even pioneered a structurally novel auth path — using a Grok _consumer subscription_ as an agent backend via OAuth, the first time a frontier closed-weight provider let a consumer plan act as an agent backend. Arize's architectural review calls it one of the most complete open harnesses available: it treats sessions as infrastructure, separates _tool registration_ from _tool exposure_, and does lineage-based context compression. If pi is the minimal harness and OpenClaw is the maximal-reach harness, Hermes is the _learning_ harness.

---

## Layer 8: Autonomous / cloud SWE agents — delegate the whole task

This layer is the one you're most missing, and it's philosophically opposite to the harness band: instead of a tool you _drive_ turn-by-turn, it's an agent you _assign work to_ and walk away from.

- **Devin** (Cognition) is the archetype — billed since March 2024 as "the world's first AI software engineer." You hand it a bounded, well-specified task via Slack / Jira / Teams; it works autonomously in a cloud sandbox for multi-hour stretches and comes back with a PR; you can run many Devins at once. The philosophy is _delegation, not assistance_ — Devin is meant to function like a junior engineer you assign tickets to, and Cognition reports a large fraction of its _own_ codebase is Devin-authored. Its real-world envelope, by consistent reporting, is "clearly-scoped tasks with crisp acceptance criteria"; the single biggest predictor of success is the _quality of the task description_. (Cognition also now owns Windsurf, merging autonomy with an IDE.)
- **Jules** (Google) and the **GitHub Copilot coding agent** are the platform-native versions of the same delegate-to-the-cloud pattern (work in a cloud VM against a GitHub repo, open a PR).
- **Factory** ("droids") is the enterprise-flavored, agent-native SWE platform in this band.
- **OpenHands Cloud** is the open self-hostable counterpart.

The defining design axis for this whole layer — and the cleanest tension in the field — is **autonomy vs. oversight**, and where you pay your attention tax. Devin sits at the autonomous-delegation pole (review _downstream_, in PR triage). Kiro and Intent sit at the spec-driven, developer-in-the-loop pole (review _upstream_, in spec approval, with mandatory checkpoints). Neither is "right"; they're bets about which review surface scales for your team.

---

## Layer 9: Build-your-own frameworks and SDKs

This is a _different culture_ from the coding harnesses — it's for engineers assembling bespoke agent systems in code — and it has its own philosophical spread. The meta-story, well told by several 2026 retrospectives, is **"a story of humility":** the first generation (early LangChain, early AutoGen) bet that enough tools + context would let the model figure things out; in practice agents looped, failed silently, and were impossible to audit. The backlash produced a new consensus — _if it's important, it should be explicit_ — and the survivors reflect different answers to "explicit how?"

- **LangGraph** (LangChain) models the agent as a **graph**: nodes are model/tool/validation/human-review steps, edges are transitions, state is shared and checkpointed, and execution is durable with human-in-the-loop pauses. Its founding insight, as one writeup puts it, is that _a reliable agent is not a smarter prompt — it's a stateful software system_. It's the choice for production-grade, deterministic, long-running flows where you need to inspect and resume every step.
- **AutoGen** (Microsoft Research) bet on **conversation**: agents are conversational participants who talk, debate, and converge — not graph nodes or role-players. It evolved from a simple chat model through an event-driven actor architecture to a 1.0 GA (February 2026), but Microsoft has since shifted strategy to the broader **Microsoft Agent Framework**, merging AutoGen's concepts with Semantic Kernel; standalone AutoGen is now maintenance, and the community fork **AG2** carries the conversational torch.
- **CrewAI** bets on **roles**: you assemble a "crew" of role-defined agents with task delegation — the org-chart model — and it's the lowest-friction path from zero to a working team-of-agents prototype.
- **OpenAI Agents SDK** (the productionized descendant of Swarm) and the **Anthropic Claude Agent SDK** are the **minimal vendor SDKs** — tool use, handoffs, guardrails, tracing, memory, with as little abstraction as possible. The Claude Agent SDK is specifically tuned for autonomous coding (file edits, bash, SKILL.md procedural memory). For a single agent with a couple of tools, these are now often the _fastest_ path — the "skip the framework" position has become respectable.
- **Pydantic AI** is the **type-safe** entrant: it rejects bespoke DSLs in favor of standard Python validation and FastAPI-style ergonomics, model-agnostic, and has become the fastest-growing independent Python framework on the strength of "agents should feel like normal, typed Python."
- **Google ADK** is Google's platform-level framework, notable for operationalizing context pipelines as a first-class concern.
- And there's a quietly important sub-band: **durable-execution engines** (Temporal, DBOS, Inngest, Restate) reframing _the agent as a durable workflow_ — checkpoint every step, survive crashes, replay deterministically. This is the "agents are just long-running distributed systems, and we already know how to make those reliable" school.

---

## Layer 10: The interop layer — protocols

The connective tissue, now consolidating fast under Linux Foundation stewardship. The useful framing is "HTTP for the agent internet," and the field has settled on a **two-layer model**:

- **MCP** (Model Context Protocol, Anthropic, late 2024) **won the agent-to-tool layer** outright — adopted by Anthropic, OpenAI, Google, and Microsoft, now governed by the Linux Foundation's Agentic AI Foundation, with tens of thousands of community servers and SDK downloads in the tens of millions. The "USB-C for AI" analogy stuck because the spec is simple and solves a real N×M integration explosion. Every harness in this document speaks it.
- **A2A** (Agent-to-Agent, Google, donated to the Linux Foundation mid-2025) is the **agent-to-agent coordination** standard — agents discover each other via "Agent Cards," authenticate, and delegate, without exposing internals — with 50+ partners (AWS, Microsoft, Salesforce, SAP). MCP and A2A were designed to be complementary (Google and Anthropic coordinated), and the canonical pattern is "A2A for who-talks-to-whom, MCP for tool access underneath."
- **ACP** is a cautionary tale in naming: it refers to at least _three different things_ — Zed's **Agent Client Protocol** (how an editor drives an external coding agent; what OpenClaw uses to spawn Claude Code/Codex), IBM/AGNTCY's **Agent Communication Protocol** (a REST-native A2A alternative), and an **Agent Commerce Protocol** for payments. If someone says "ACP," ask which one.
- **AG-UI** (Agent-User Interaction, from CopilotKit) standardizes the _agent → frontend_ streaming surface, the piece the other two don't cover.
- **AGENTS.md** is the humble winner you should know about: a plain-markdown "README for agents" at the repo root, now in 60,000+ repositories and supported across Codex, Cursor, and others — endorsed even as a lightweight complement to formal Agent Cards. It's the convergence of all the per-tool context files (CLAUDE.md, GEMINI.md, …) toward one shared standard, and there's already academic work (Gloaguen et al., Feb 2026) empirically testing whether these files actually help. Payments get their own emerging stack (AP2, x402).

---

## Recurring concepts and genuinely beautiful ideas

These are the load-bearing ideas that recur across layers — the conceptual vocabulary of the field.

**Context engineering** is the organizing discipline, and it's the deepest one. Coined by Dex Horthy (HumanLayer) and quickly adopted into Anthropic's own guidance, it starts from the fact that _an LLM turn is a stateless function: context window in, next step out._ The contents of that window are the _only_ lever you have on output quality without touching the weights, so it's worth obsessing over. Thoughtworks' working definition (via Bharani Subramaniam) is the cleanest: "curating what the model sees so that you get a better result." Anthropic frames the goal as finding "the smallest set of high-signal tokens that maximize the likelihood of your desired outcome." This spawns the **context-window economy**: you have ~170–200K tokens, more usage correlates with _worse_ outcomes, and the whole craft is spending as few as possible. The canonical horror-story-turned-parable (from the 12-factor write-ups) is a workflow that burned 20 million tokens and failed repeatedly, then succeeded on 1,234 tokens with compressed memory pointers — _context engineering was the only change._ Every concept below is, in some sense, a context-engineering technique.

**The context-window economy's toolkit** is itself a set of recurring primitives: **compaction** (summarize old turns to reclaim space), **context editing / rule-based pruning** (drop stale tool output mid-run), **progressive disclosure** (Skills: load a one-line description, fetch the body only on demand), and **sub-agent isolation** (spin a fresh context for a sub-task so its noise never pollutes the parent — the most widely-adopted answer to "context rot"). `/context`-style introspection (see exactly what's eating your window) is now table stakes.

**Session-as-tree and time travel** — your `/tree` favorite. The idea that a session is a _branchable tree_ (pi's `/tree` and `/fork`, pi-context's lossless navigation, kimi-cli's "d-mail" that inspired it) rather than a linear log, so you can explore, keep, and backtrack with surgical precision. Adjacent but weaker cousins exist nearly everywhere as **checkpointing / rewind** (Gemini CLI's checkpoints, Codex's history search, "rewind and replay") — but those are coarse save-states, not _in-place fine-grained branching of the live context._ You're right to be surprised it hasn't spread; I'll come back to why in the gaps section, because I think it's the single clearest unmet need.

**Skills as portable discipline** — the Superpowers insight that what agents lack is discipline, not capability, and that discipline travels as plain markdown across every harness. This is also the field's main answer to _encoding team/org practice_ into agents.

**External memory ledgers** — Gastown's "beads," Hermes's searchable SQLite/FTS5 store, the general move toward "the durable store, not the context window, is the source of truth" for anything that must survive a session boundary or a role-swap.

**Artifacts as the review surface** — Antigravity's idea that the agent should hand you a _reviewable deliverable_ (plan, screenshots, walkthrough) and let you _comment on it like a doc_, rather than making you read tool-call logs. The cleanest answer anyone has to "delegation requires trust, and trust requires reviewable work."

**Plan-then-execute / spec-driven** — separating a planning phase (where write tools are _blocked at the system level_, à la Claude Code's plan mode) from execution, or pushing it all the way to mandatory written specs with checkpoints (Kiro). The unifying idea: make the agent _commit to an approach you've approved_ before it touches the codebase.

**Hooks** — deterministic code that fires on lifecycle events to _enforce_ what prompts can only _request_ (block a dangerous command, feed a type error back so the agent can't stop until it's resolved). Borrowed conceptually from git hooks.

**Git-worktree parallelism** — the now-standard substrate for running N agents without collision; true isolation without the cost of N clones.

**The 12-Factor Agents manifesto** (Horthy/HumanLayer, modeled on Heroku's 12-Factor App) is the field's clearest design creed: _own your prompts, own your control flow, own your context window, treat the agent as a stateless reducer (`input state → output state`), keep execution and business state unified._ It's deliberately a language-agnostic manifesto, not a framework — a reaction against "magic." Its most quotable claim is that most products calling themselves "AI agents" _aren't very agentic_: the reliable ones interleave deterministic code with a few well-placed LLM decision points. The durable summary, from an engineer Horthy quotes: even if models get 100× smarter, you'll still need context compression, deterministic control, and schema validation to ship.

**Harness engineering** (also HumanLayer) is the emerging name for the craft of building/tuning the harness itself — the realization that the harness is now a first-class engineering artifact you design, not a wrapper you bolt on.

**The convergence thesis** is the field-level observation: line up Claude Code, Codex, Gemini/Antigravity, Cursor, Devin, Windsurf, and they're "strangely similar under the hood" — an agent loop running tools over a codebase, fed by a human-readable config file (AGENTS.md/CLAUDE.md), with context management and sub-agents. Different surfaces, different models, _converging architecture._ The interesting corollary is that differentiation is migrating away from the loop (everyone has that) toward model quality, context-engineering sophistication, the review/verification surface, and ecosystem/portability.

---

## Design tensions

The field's live arguments, stated as axes rather than answers:

**Autonomy vs. control.** Devin's "assign it a ticket and leave" against Kiro/Intent's "stay in the loop with specs and checkpoints." Really a question of _where you spend your review attention_ — upstream on plans or downstream on PRs — and it doesn't have a universal answer; it depends on blast radius and how well your tasks can be specified.

**Minimal core vs. batteries-included.** pi (ship a tiny core, push everything to extensions) against Claude Code/Hermes (ship rich primitives) against products like Cursor/Antigravity (ship an entire opinionated experience). The minimal-core camp trades immediate productivity for ownership and longevity; the batteries camp trades lock-in for time-to-value.

**Framework vs. no-framework.** The whole "story of humility": magic frameworks (early LangChain/AutoGen) lost trust because failures were unauditable, and the pendulum swung to explicit state machines, typed I/O, vendor SDKs, and "just write the loop." LangGraph's bet is that the framework _can_ be explicit enough to keep; the SDK/12-factor bet is that you should own the control flow yourself.

**Model-coupled vs. model-agnostic.** Codex (tightly bound to GPT-5.x) and Cursor's Composer (own model) buy coherence and speed at the cost of lock-in; pi, OpenCode, Goose, Hermes (15–200+ providers) buy freedom and longevity at the cost of having to abstract over provider quirks. Hermes's whole thesis — open models are good enough _with the right harness_ — is a bet on the agnostic side.

**Single-agent vs. multi-agent.** Gastown's swarm against the pi/`/tree` "one agent, branch the context" view that you can get most of the benefit of subagents without the coordination cost, the burn rate, and the merge chaos. Multi-agent is seductive and genuinely useful for parallelism, but a recurring caution (paddo, Maggie Appleton) is that anthropomorphic agent org-charts import human-org pathologies, and that a lot of "multi-agent" is over-engineering where a disciplined single agent would win.

**Speed vs. depth.** Cursor's sub-30-second-turn obsession (fast loop changes the UX qualitatively) against Amp's "Deep mode" for slow, hard, ambiguous problems. Different tasks want different clocks, and few tools do both well.

**Local vs. cloud.** Conductor/pi/Aider (local-first, your code never leaves the machine) against Devin/Jules/Codex-cloud (delegated cloud execution that survives you closing the laptop). The cloud side buys async and durability; the local side buys privacy and control.

**Convergence vs. differentiation.** If everyone's harness is the same, what's left to compete on? The honest answer emerging in 2026: model quality, context-engineering craft, the _review/verification_ surface, and ecosystem/format ownership — not the loop.

**Trust and verification.** The unsolved hard one. Antigravity's Artifacts, git-commit-per-change (Aider), browser-based QA, and spec checkpoints (Kiro) are all partial answers to "how do I _know_ the agent did the right thing," and at N parallel agents the review surface becomes the bottleneck.

**Cost and burn.** Gastown's reported $100/hour and thousands-a-month is the loud version, but the quiet version is everywhere: parallel agents and long-horizon tasks burn quota fast, and _cost observability and governance_ lag badly behind capability.

**Security and supply chain.** You've already looked hard at this (your Shai-Hulud assessment). It's a first-class tension: every Skill, plugin, MCP server, and extension is _executable code you're inviting into a privileged loop_, the plugin marketplaces are an expanding attack surface, and prompt injection through tool output is a live exfiltration vector. The harness layer is exactly where the trust boundary lives, and the ecosystems are racing ahead of the governance — a point made repeatedly in the enterprise-framing coverage.

---

## Unmet needs (the interesting gaps)

**Fine-grained, in-place context surgery — everywhere.** This is your `/tree` instinct, and I think it's correct and underappreciated. Almost every harness treats the session as an _append-only log_ and offers, at best, coarse save-state checkpoints. pi treats it as a _tree with parent pointers_, which makes cheap branching, backtracking, and "prune this dead exploration out of my live context" fall out naturally. Nobody copied it, and I think the reason is architectural inertia, not lack of merit: branching has to be designed into the session substrate from the start, you can't bolt it onto an append-only log, and most teams optimized for the linear-chat mental model early and are now locked into it. Given that _context is the only lever_ (per context engineering), a first-class, ergonomic, in-place context editor — tree navigation, surgical removal of spent sub-threads, branch-and-merge of explorations — is arguably the highest-leverage missing feature in the whole field. pi-context gesturing at "context management as explicit tools" is the right direction; it should be everywhere.

**Portable _sessions_, not just portable skills.** Skills and AGENTS.md became cross-harness; _sessions_ did not. There's no standard for exporting a live agent session from Claude Code and resuming it in Codex or pi with full context and tool state. ACP (the Zed one) and OpenClaw's resumable handoffs are early steps, but a genuine "session interchange format" — the agent-loop analog of what MCP did for tools — doesn't exist yet.

**Verification and review that scales to N agents.** Artifacts and comment-on-the-plan are the best ideas so far, but reviewing the output of ten parallel agents is still a wall. The unmet need is a _review surface that scales sublinearly_ — semantic diffing, automatic risk-flagging, "show me only the decisions I'd disagree with" — rather than N transcripts to read.

**Cost observability and governance as a first-class layer.** Burn rate is currently discovered after the fact. There's no standard for budgets, per-task cost ceilings, or cross-harness spend attribution. For anyone running parallel or autonomous agents seriously, this is a glaring hole.

**Memory that persists _and generalizes_ without becoming noise.** Hermes's learning loop is the most ambitious attempt, and external ledgers (beads) handle task state, but durable _cross-session_ memory that gets more useful over time without bloating context or drifting into staleness is unsolved. The hard part isn't storage; it's _retrieval and relevance_ — knowing which of a thousand past facts belongs in _this_ window.

**Secure-by-default sandboxing and a real permission model.** Given the executable-extension attack surface, the default posture is still too trusting. Sculptor's containers and per-harness sandbox flags exist, but a portable, strong, _default-on_ isolation-and-capability model — with auditable permission manifests for what an agent and its plugins may touch — is missing, and the supply-chain incidents make it urgent.

**Standardized multi-agent coordination primitives.** Gastown reinvented orchestration, health-monitoring, and a merge strategy from scratch and vibecoded them. A2A standardizes _discovery and delegation_, but the _operational_ primitives — task queues, watchdogs, merge-conflict arbitration, back-pressure when an agent stalls — have no shared substrate. Everyone rebuilds the Mayor.

**Eval-driven development for agents.** The mature teams treat evals as the real moat, but it's still artisanal. There's no widely-adopted "test framework for agent behavior" with the ergonomics of, say, pytest — regression suites for "does my harness still do the right thing after I changed a Skill," variance analysis, CI integration. The benchmark world (SWE-bench, Terminal-Bench, and newer long-horizon suites like SWE-EVO) is academic; the _practitioner_ tooling lags.

**Interruptibility and mid-task steering.** Most autonomous agents are fire-and-forget or fully-supervised, with little in between. The ability to _steer_ a long-running agent mid-flight — "you're going down the wrong path, here's a correction" without restarting and without losing its accumulated context — is thin. (Gastown's solution, supervisor agents nudging workers, is a workaround, not a design.)

---

## A compact synthesis

If you want the field compressed to a few sentences: the organizing realization of 2026 is that **the harness is a first-class engineering artifact**, and the harness's whole job is **context engineering** — because the model is a stateless function and the context window is the only lever. Everyone's _loop_ has converged, so the live differentiation is in context-management craft (where pi's tree is quietly ahead of everyone), in the **review/verification surface** (where Antigravity's Artifacts are quietly ahead of everyone), in **portability and format ownership** (where Claude Code's Skills and the AGENTS.md/MCP standards won), and in the **autonomy-vs-oversight** bet each product places. The frameworks went through a humility cycle and came out favoring explicit state and durable execution. The protocols consolidated into "MCP for tools, A2A for agents, under one foundation." And the most interesting _unsolved_ problems — fine-grained context surgery for all, session portability, review-at-scale, cost governance, generalizing memory, and secure-by-default sandboxing — are exactly the seams where a tool-builder with your sensibilities (minimal, mechanistic, correctness-over-convenience) could do something that matters.

---

## Sources & further reading (primary where possible)

- **pi** — pi.dev; `github.com/badlogic/pi-mono`; explainx.ai "Pi minimal agent harness" guide; StackToHeap "Managing context windows with pi /tree"; `github.com/ttttmr/pi-context`.
- **Claude Code** — Anthropic docs; arXiv 2604.14228 (Claude Code design-space analysis); Marc Nuri "Superpowers"; `github.com/obra/superpowers`; HumanLayer "Skill Issue: Harness Engineering."
- **Codex** — `developers.openai.com/codex` (CLI, models, changelog); openai.com "Introducing the Codex app."
- **Gemini CLI / Antigravity** — `github.com/google-gemini/gemini-cli` (incl. the Antigravity CLI transition discussion #27274); Google Developers Blog "Build with Google Antigravity"; Google Codelabs "Getting started with Antigravity."
- **Cursor** — cursor.com/blog/2-0; InfoQ and CometAPI Composer coverage.
- **Open-source CLIs** — `github.com/bradAGI/awesome-cli-coding-agents`; Tembo and Pinggy CLI-tool guides; comparisons at mcp.directory and buildmvpfast.
- **Conductor** — conductor.build; Vercel/ChatGate/CodePick writeups.
- **Gastown** — Steve Yegge, "Welcome to Gas Town" (Medium); The New Stack; `github.com/gastownhall/gastown`; Maggie Appleton and paddo.dev analyses; kilo.ai/gastown.
- **OpenClaw / Hermes** — docs.openclaw.ai; `github.com/NousResearch/hermes-agent` + hermes-agent.nousresearch.com; Arize "How Hermes implements an open-source agent harness"; DataCamp Hermes tutorial.
- **Autonomous agents** — Cognition/Devin coverage; Augment Code "Kiro vs Devin," "Intent vs Devin."
- **Frameworks** — DEV/MortalApps/pecollective framework comparisons; LangChain and Microsoft Agent Framework docs.
- **Protocols** — Zylos Research and digitalapplied protocol surveys; MindStudio "Six agent protocols"; arXiv 2602.11988 (evaluating AGENTS.md).
- **Concepts** — HumanLayer "Advanced Context Engineering" and "12-Factor Agents" (`github.com/humanlayer/12-factor-agents`); Martin Fowler / Thoughtworks "Context Engineering for Coding Agents"; Anthropic's context-engineering guidance.
