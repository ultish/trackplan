# Env Studio

**Status:** working prototype (Phase 1: topology authoring)
**Related:** [docs/FIXTURE_STUDIO.md](../../docs/FIXTURE_STUDIO.md) (sibling tool — authors *test fixtures* against BUILD_SPEC; Env Studio authors a *real environment* to generate scenarios that test whether a SPEC covers them)

Env Studio is a small React + Vite + React Flow app for building a Trackplan-shaped
environment by hand: pick **Resource Types**, drop **Asset** instances on a canvas,
drag **Dataflow Connections** between their ports, and attach **Tasks** (with a fake
per-type **Inspector**) to check tasking-configuration and port-capacity rules live.
Export produces a self-contained JSON document meant to be fed to an LLM session (and
later, test cases) that checks whether a SPEC document covers the scenario.

This step does **not** implement Strategies / the strategy scheduler — that's step 2.
It only ever produces JSON; no engine logic runs here.

## Run it

```bash
npm install
npm run dev
```

## Vocabulary (same domain as BUILD_SPEC, renamed lens)

| Env Studio | BUILD_SPEC.md |
|---|---|
| ResourceType | StationType |
| Asset | Station |
| IOPortGroup / port `{name, index}` | Track / TrackDef |
| DataflowConnection | Link |
| Task + taskingConfiguration | Task + taskingConfiguration (same field) |
| Fake Inspector | Inspector SPI |

Env Studio does not aim for byte-identical DTO parity with BUILD_SPEC/Fixture Studio —
it's a different export whose consumer is an LLM scenario-coverage check, not the
Kotlin engine. The concepts map 1:1; the JSON shape is Env Studio's own.

## The 6 predefined Resource Types

| Resource Type | Ports | fanRule | tasking config sharing |
|---|---|---|---|
| Wave Switch 10x10 (Multicast) | 10x `wave` in, 10x `wave` out | `fan-out` | `multi` |
| Digital Switch 1x10 (Multiplex) | 1x `digital` in, 10x `digital` out | `fan-out` | `single` |
| Wave -> Digital Converter | 1x `wave` in, 1x `digital` out | `strict-one-to-one` | `single` |
| Wave 5x5 | 5x `wave` in, 5x `wave` out | `strict-one-to-one` | `multi` |
| Wave Source | 1x `wave` out only | `none` | `single` |
| Digital Sink | 1x `digital` in only | `none` | `single` |

Every type carries one tasking-config field, `key: string`, per the "key=hello" example
in the requirements — this keeps all 6 types directly comparable while still exercising
both `sharing` modes.

### Design decisions worth flagging

- **`fanRule` is a single enum** (`none` / `strict-one-to-one` / `fan-out` / `fan-in`)
  rather than separate "multicast" and "multiplex" flags, because mechanically both
  reduce to the same two questions: can one *input* serve many Tasks (fan-out), and can
  one *output* serve many Tasks (fan-in)? `fan-in` exists in the model for completeness
  even though none of the 6 predefined types use it.
- **The 1x10 "Digital Switch (Multiplex)"** only has one input port, so structurally it
  can only ever fan *out* (the domain calls this "multiplexing" the single input across
  many outputs) — there's no second input to fan traffic *into*. It's modeled as
  `fanRule: "fan-out"`, same mechanism as the 10x10 wave switch's multicast.
- **Tasking-config `sharing`** ("single" vs "multi" live configuration) is a second,
  independent axis from `fanRule` (port topology) — a switch can allow many concurrent
  Tasks port-wise while still requiring them to share one config value, or vice versa.

### Inspector rules, in prose (`inspectorRules`)

`fanRule` and `taskingConfig.sharing` are enough for code to enforce the rules, but an
LLM reading an exported `env.json` in isolation — without this source tree — has to
infer what e.g. `fanRule: "fan-out"` means for a *specific* type's port counts. So every
ResourceType also carries `inspectorRules: { portShape, taskingConfig }`: two plain-English
sentences saying exactly what the Fake Inspector allows/forbids for that type, e.g.

```json
"inspectorRules": {
  "portShape": "Multicast switch: any one of the 10 wave inputs may feed multiple wave outputs at once (one task per output, 1:1 through 1:10 from a single input). Each wave output can only ever be driven by one task at a time — two tasks cannot both claim the same output.",
  "taskingConfig": "Multiple concurrent 'key' values are allowed on this switch at once — each fan-out group can carry its own key, so tasks with different key values do not conflict with each other."
}
```

This is redundant with the enums for a reader who already knows this codebase, but it's
the field an LLM SPEC-coverage prompt should quote back when explaining what an
INVALID verdict on a given asset was supposed to mean. It's shown in the Palette and
Inspector panel too, and travels with the type in every export automatically (it's part
of the embedded `ResourceType`, not a separate lookup).

## Fake Inspector (`src/domain/inspector.ts`)

Given a ResourceType and the Task[] currently on an Asset, `FakeInspector.inspect()`
runs two checks and returns `{ valid, errors }`:

1. **Tasking config consistency** — every Task must supply all schema fields; if
   `sharing: "single"`, every Task's field values must match the first Task's (only one
   live configuration allowed).
2. **Port shape / fan legality** — ports referenced must exist and be in range; then,
   per `fanRule`, an input and/or output port may not be claimed by more than one Task
   (which one depends on `fanRule`: `strict-one-to-one` forbids both, `fan-out` forbids
   only output reuse, `fan-in` forbids only input reuse, `none` skips this check).

This runs live in the Inspector panel as you add/edit Tasks on a selected Asset — no
server, no engine.

## UI

- **Palette** (left) — click a predefined Resource Type to drop a new Asset on the canvas.
- **Canvas** (center, React Flow) — drag Assets to reposition; drag from an output-port
  handle to a same-named input-port handle on another Asset to create a Dataflow
  Connection (mismatched port names are rejected with a toast). Click an edge to remove it.
- **Inspector panel** (right) — select an Asset to rename it, add/edit/remove Tasks
  (input port, output port, tasking config fields), and see the live Fake Inspector
  verdict + error list.
- **Export JSON / Import** (top bar) — download the current environment as
  `env.json` (self-contained: embeds the full ResourceType defs used, not just ids),
  or reload a previously exported file.

## Export shape

```jsonc
{
  "env_studio_version": 1,
  "resourceTypes": [ /* full ResourceType defs used by any asset below */ ],
  "assets": [
    { "id": "...", "name": "...", "resourceTypeId": "...", "position": {"x":0,"y":0},
      "tasks": [{ "id": "...", "input": {"name":"wave","index":0}, "output": null,
                  "taskingConfiguration": { "key": "hello" } }] }
  ],
  "connections": [
    { "id": "...", "from": {"assetId":"...", "port":{"name":"wave","index":0}},
      "to": {"assetId":"...", "port":{"name":"wave","index":0}} }
  ]
}
```

`position` is layout only (à la Fixture Studio's `layout.json` convention) — a
scenario-coverage LLM prompt should ignore it and reason about `resourceTypes` /
`assets` / `connections` / `tasks`.

## Using the exported JSON

The export is the scenario. It is not consumed by any engine here — you hand it to an
LLM session alongside the SPEC under test and ask it to reason about coverage.

**1. Build the scenario in the UI.** Add the assets and connections that represent the
situation you want the SPEC to handle (a fan-out topology, a conflicting tasking config,
a switch at capacity, a signal with no sink, ...). Leaving invalid Tasks in place on
purpose — e.g. the port-conflict example above — is a valid way to author a "does the
SPEC say what should happen here?" scenario; the Fake Inspector's error list becomes
part of what you're asking the SPEC to account for.

**2. Export → `env.json`.**

**3. Paste both into an LLM session.** A minimal prompt shape:

```text
Here is a SPEC document: <paste or attach BUILD_SPEC.md / SPEC.md>

Here is an environment scenario, exported from Env Studio (env_studio_version: 1).
resourceTypes are fully embedded; assets reference them by resourceTypeId; tasks are the
live uses on each asset; connections are the dataflow wiring between asset ports.

<paste env.json>

Does the SPEC fully cover this scenario? For each asset / connection / task, tell me:
  - what the SPEC says should happen (cite the section)
  - any case the SPEC leaves ambiguous or unaddressed
  - if a task's Fake Inspector verdict was INVALID in Env Studio, does the SPEC define
    the failure behavior the Inspector should produce (error code, partial commit, etc.)?
```

**4. Iterate on the SPEC (or the scenario)** based on what comes back — gaps the LLM
finds are exactly the "scenarios the SPEC doesn't cover" this tool exists to surface.

**5. Later (test cases):** once step 2 (Strategies) exists, the same `env.json` shape
is meant to seed fixtures/goldens the way Fixture Studio's `world.json` does today —
not by this tool executing anything, just by being loadable, deterministic input.

## Not in this phase

- Custom/user-authored Resource Types (only the 6 predefined ones)
- Strategies, strategy steps, or the strategy scheduler (step 2)
- Any execution/resolve logic — this tool only ever produces JSON
