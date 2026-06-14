# Prompt, tail, and entries-vs-events

`prompt --and-wait` may be solving the wrong problem for scripts. Waiting until a turn ends is useful, but a client often wants the activity produced after sending the prompt as the command's output.

Similarly, `tail --follow` feels like it may not be quite the right abstraction yet. We previously decided that events should be treated as wakeups and session entries should remain the source of truth: `tail --follow` listens for events, then re-drains `get_entries --since <cursor>`. That avoids reproducing pi's event-to-entry logic in pictl.

This may be too conservative. The logic to derive entries from the event stream may be simple enough to reproduce, and doing so might make both `tail --follow` and prompt sugar much more straightforward.

## Desired user-facing shape

The important scripting primitive may be closer to:

```bash
pictl prompt --target <target> "..." --and-tail
```

or perhaps keeping the existing sugar name but changing what it means:

```bash
pictl prompt --target <target> "..." --and-wait
```

The intended behavior would be:

1. send the prompt;
2. stream activity produced after the prompt;
3. stop when the requested stop condition is met;
4. emit enough cursor information for the caller to resume or continue.

Example candidate:

```bash
pictl prompt --target worker "Investigate the failing test" \
  --and-tail \
  --until no-activity:10 \
  --timeout 120
```

The key property: if you are the only one conversing with a given agent, you should be able to use a single `prompt --and-tail`-style command repeatedly and see the activity you would normally see when using pi interactively, without separately managing `tail` and cursors.

## Stream levels

There are at least three useful levels at which pictl might follow activity:

1. **Events** — most raw; direct socket broadcasts.
2. **Entries** — session entries, hopefully recoverable from the event stream.
3. **Messages** — user/assistant/tool-facing conversation messages, hopefully derivable from entries.

The default for `prompt --and-tail` probably should not be the rawest form. It may want to return mostly **messages**, plus the id of the final entry/message in the series so the caller has a cursor.

Open problem: pi messages do not currently include ids, so “message stream with cursor” may need either:

- message-shaped output annotated with the backing entry id;
- entry-shaped output by default;
- a final cursor record separate from message records;
- or a pi-side API change.

## Candidate flags

`prompt --and-tail` and `tail` should probably accept the same output-level controls:

```bash
pictl prompt --target <target> "..." --and-tail
pictl prompt --target <target> "..." --and-tail --entries
pictl prompt --target <target> "..." --and-tail --events
pictl prompt --target <target> "..." --and-tail --raw
pictl prompt --target <target> "..." --and-tail --until no-activity:10 --timeout 120 --entries

pictl tail --target <target>
pictl tail --target <target> --entries
pictl tail --target <target> --events
pictl tail --target <target> --raw
```

Names are not decided. `--raw` is especially overloaded because RPC passthrough uses it for raw wire responses; using the same flag for “raw events” may be confusing.
TDC: `--raw` is exactly correct here, not overloading. It means we're doing raw passthrough of the wire format.

## Tail as a filter-map over events

Current concern: `tail --follow` should perhaps be a filter-map over the event stream, but it currently uses events only as wakeups and then calls `get_entries`.

Possible direction:

- raw event stream is the base;
- entry stream is derived from events;
- message stream is derived from entries;
- `tail` and `prompt --and-tail` share the same filter-map pipeline and stop-condition machinery.

This would make `prompt --and-tail` exactly equivalent to “send prompt, then apply the tail filter-map and end condition from this point forward.”

## Entries to messages

Hypothesis: `get_messages` is computable from `get_entries` by following `parentId` from the current leaf and filter-mapping the resulting entries. A streaming “message tail” might apply the same filter-map to the entry stream without tracing backward from the leaf each time.

This needs source verification in pi.

## Bounding output

`tail` should probably accept an `-n` flag to bound the number of messages/entries/events returned:

```bash
pictl tail --target <target> -n 20
pictl tail --target <target> --entries -n 100
```

Questions:

- Does `-n` count messages, entries, or whatever output level is selected?
- Should it default to messages if the default output level is messages?
- How does `-n` combine with `--follow`?

## Open questions

- Should `--and-wait` be kept as pure completion waiting, or replaced/repurposed as output streaming?
- Is `--and-tail` the right name?
- What should the default output format be: messages, entries, or something hybrid? TDC: default should be messages; I told you that already.
- Can entries be reliably recovered from the event stream without duplicating fragile pi internals?
- Can messages be reliably derived from entries in the same way pi computes `get_messages`?
- Should this logic live in pictl, pi, or both? TDC: this logic obviously has to live in pictl, unless pi already exports the filtermap (which I doubt)
- What cursor should be emitted for message-level output if messages do not include ids? TDC: I explained this. The point is that the events/entries _do_ contain the ids, so when we filtermap to turn them into messages, we have to preserve the id of the last one. You clearly didn't understand this.
- How should compaction, tree navigation, forks, and session replacement appear in the default stream? TDC: as events/entries, there is no issue. However, in the message stream, we should somehow indicate these events (even though they are not messages) because they do change the message set.
