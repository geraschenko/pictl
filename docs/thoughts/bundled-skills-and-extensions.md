# Bundled skills and extensions

The repo has [skills/](../../skills/) and [extensions/](../../extensions/) directories, but neither ships in the npm package — they're too early. Today a user who wants, say, the navigate-tree extension has to clone the repo and pass a path to `pictl spawn -- -e ...`.

Once they mature, it would be nice to have `pictl skill` and/or `pictl extension` subcommands that display what's bundled and install it. Something like:

```sh
pictl extension list
pictl extension show navigate-tree     # print the source / docs
pictl extension install navigate-tree  # or: pictl spawn --extension navigate-tree
pictl skill list
pictl skill install pictl ~/.pi/skills/
```

Open questions:

- "Install" for an extension could mean copying it somewhere, or just resolving a bundled name at spawn time (`pictl spawn -- -e navigate-tree` with a lookup into the package). The latter avoids staleness after upgrades.
- Skills are consumed by the agent, not by pi, so installation targets vary by harness; maybe `show`/path-printing is enough and the user's tooling does the copying.
- Whether spawned agents should get some extensions (e.g. navigate-tree) by default is undecided; see [skills/pictl/tree-navigation.md](../../skills/pictl/tree-navigation.md).
