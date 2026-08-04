# Resolve tracing: schema and storage design

**Status:** Design proposal — not yet implemented, not part of BUILD_SPEC. Written up from a design discussion; treat like [COUPLER_OPTION_A_VS_B.md](./COUPLER_OPTION_A_VS_B.md) — a record for a future session or reviewer, not an implementer day-1 contract.

**Audience:** Future you, another session, or a reviewer deciding whether/how to build production resolve debugging.

**Relates to:** `W11` in [SPEC.md](./SPEC.md) ("Coupler explain log — Debug multi-switch tries — Structured 'goal reject' events — Not written — recommend for ops"). This doc is the concrete design for that gap.

---

## 1. Problem

When a Booking resolve fails, or backtracks, or just does something unexpected in production, there's currently no way to see *why* — which Stations Coupler tried, in what order, why one was preferred over another, where Assembler backtracked and why. `FailureReport` (BUILD_SPEC §9.3/§3.10) gives a capped sample of failed goal arrivals, which is enough for "something went wrong at leg N" but not enough to reconstruct the actual decision path for a step-through debugger.

An interactive step-through visualizer (topology diagram + Assembler/Coupler panels + frontier table) was prototyped in `claude-review/assembler-coupler-walkthrough.html` against a synthetic scenario. This doc is about feeding that same kind of UI with **real production resolves** instead.

---

## 2. Two approaches considered

### A. Replay — capture inputs, re-run the real engine later

Capture the booking + a world/topology snapshot at resolve time, and later re-run the *actual* Coupler/Assembler code in an instrumented "trace" mode against that snapshot to regenerate the full event stream on demand.

**Pro:** Zero risk of a hand-rolled visualizer drifting from the real algorithm (a bug hit while building the prototype: a reimplementation of the backtrack-retry rule diverged from what BUILD_SPEC actually specifies). Trace is only materialized when someone actually wants it.

**Con:** Requires reconstructing "the world as of time T," which — with production-scale topology/capacity — is genuinely hard unless the world model is itself built by folding an ordered, replayable event log (Kafka). Any state that isn't event-sourced (a live read from another service, no history) can't be reconstructed after the fact, full stop.

### B. Live bounded capture — the real engine emits its own trace as it runs (DECIDED direction)

The search already computes everything a trace needs (goal set G, the ExpandKey tuple per candidate, inspect verdicts) in order to make its decisions. Emitting those as structured events is not extra computation — it's not throwing away work already done. Because Oracle++/Coupler only ever touch the *reachable subgraph* from the tail (never the whole fabric), the resulting trace is bounded by search size, not by production's total object count — this is what makes "1000s of objects" a non-problem: the trace never contains more than the handful of Stations/Links this one resolve actually visited.

**Pro:** No reconstruction problem — the trace is captured at the moment it was true. Bounded size regardless of production scale. Reuses the same "self-contained fixture" shape the goldens (G1–G12, "pure... testable without Kafka") already use.

**Con:** Only exists for resolves that were instrumented at the time; can't retroactively trace an incident nobody flagged. (Mitigated by the retention policy in §3 — instrument every resolve cheaply, just don't *persist* all of them.)

**Decision: build B.** Fall back to A only if the topology/capacity model turns out to be reconstructable from an ordered event log anyway (likely, since Kafka already drives topology/occupancy changes per SPEC.md's topic list) and someone specifically wants interactive counterfactual re-runs ("what if node X had been online"), which B alone can't give you.

---

## 3. When to persist

Computing the trace is ~free (see above). Persisting it at booking QPS over time is not. Gate persistence on outcome, not on cost of computation:

| Trigger | Action |
|---|---|
| Every resolve | Always write the cheap summary row (§4.1) |
| `FailureReport` would have content (UNSAT, or ≥1 backtrack) | Persist the full event stream |
| Expansion count / Coupler-call count exceeds a perf-outlier budget | Persist the full event stream |
| Ops flags a booking / customer / StationType ahead of time | Force full trace on next resolve regardless of outcome |
| Everything else (clean first-fit SAT) | Summary row only, no event stream |

This is tail-based sampling applied to a domain-specific trace instead of a generic span tree: always compute, retain based on the tail outcome.

---

## 4. Schema

### 4.1 Envelope — one row per resolve attempt, always written

```kotlin
data class ResolveEnvelope(
    val resolveId: String,
    val bookingId: String,
    val ts: Instant,
    val worldSnapshotRef: String,       // topology/capacity version id, for cross-reference only
    val legs: List<String>,             // ordered StationType flavors
    val outcome: Outcome,               // SAT | UNSAT
    val finalBindings: Map<String, String>, // flavor -> stationId
    val expansions: Int,
    val couplerCalls: Int,
    val backtrackCount: Int,
    val legsFailed: List<String>,
    val hasFullTrace: Boolean,          // whether the event stream (4.2) was persisted
    val touchedSubgraphRef: String?,    // pointer to 4.3, null if hasFullTrace = false
)
enum class Outcome { SAT, UNSAT }
```

This row is cheap and always written — it's what you query/filter/alert on ("show me every UNSAT for StationType C this week") without ever touching a full trace blob.

### 4.2 Event stream — one blob per resolve, only when retained (§3)

Same vocabulary as the prototype's step kinds, now as typed deltas rather than prose. Store deltas, not full state snapshots per step — the viewer reconstructs Assembler/Coupler state by folding these in order once on load, then steps through the in-memory reconstruction. (The prototype clones full state on every step because that's the cheap way to support scrubbing in a browser with no backend over ~40 steps; it's the wrong call for a stored trace.)

```kotlin
sealed class TraceEvent { abstract val callId: Int? }

data class LegStart(val legIdx: Int, val flavor: String, val tail: String) : TraceEvent() { override val callId = null }

data class CouplerCallStart(
    override val callId: Int, val flavor: String, val tail: String,
    val goalSet: List<String>,   // node ids
    val forced: Boolean,         // true if this call restricts G to remaining alts (a backtrack retry)
) : TraceEvent()

data class NodeReached(override val callId: Int, val node: String, val g: Int, val via: String) : TraceEvent()

data class NodeExpanded(override val callId: Int, val node: String, val g: Int) : TraceEvent() // transparent node popped + walked

data class NodeInspected(
    override val callId: Int, val node: String, val g: Int, val result: InspectResult, val code: String?,
    val expandKey: ExpandKey,
    val runnersUp: List<ExpandKeyCandidate>, // top ~3 competing candidates at this pop — never the full frontier
) : TraceEvent()
enum class InspectResult { PASS, FAIL }

data class LegSuccess(val legIdx: Int, val flavor: String, val winner: String, val unusedAlts: List<String>) : TraceEvent() { override val callId = null }
data class LegFail(val legIdx: Int, val flavor: String, val goalSet: List<String>, val failedSamples: List<String>) : TraceEvent() { override val callId = null }
data class Checkpoint(val flavor: String, val station: String) : TraceEvent() { override val callId = null }
data class Backtrack(val fromFlavor: String, val toFlavor: String, val alts: List<String>, val undone: String) : TraceEvent() { override val callId = null }
data class ResolveDone(val outcome: Outcome, val bindings: Map<String, String>) : TraceEvent() { override val callId = null }

data class ExpandKey(
    val preferInUse: Int, val preferNonTransparent: Int,
    val distToSegmentGoals: Int?, val distToTerminal: Int?,
    val neighborRank: Int, val name: String,
)
data class ExpandKeyCandidate(val node: String, val g: Int, val expandKey: ExpandKey)
```

### 4.3 Touched subgraph — what the viewer needs to draw the diagram, no external lookups

As the search runs, every node/edge it actually visits gets collected into a small local graph — this is what makes a stored trace self-contained and viewable without reaching back into production topology state:

```kotlin
data class TouchedSubgraph(
    val nodes: Map<String, TouchedNode>,
    val edges: List<TouchedEdge>,
)
data class TouchedNode(val flavor: String?, val transparent: Boolean, val label: String)
data class TouchedEdge(val from: String, val to: String, val port: String?)
```

Bounded by search size (same reason the event stream is bounded), not by production's total object count.

---

## 5. Storage

- **Envelope rows (§4.1):** wherever booking metadata already lives — needs to be queryable (outcome, flavor, time range), doesn't need to hold the heavy payload.
- **Trace blobs (§4.2 + §4.3, combined into one document per resolve):** object storage (S3/GCS) keyed by `touchedSubgraphRef`/`resolveId` is the simplest default. A Kafka topic keyed by `bookingId` fits naturally instead if the rest of the world model is already event-sourced through Kafka and the trace should live alongside it.
- **Schema version:** tag every blob with a version field. Add fields defensively; never repurpose an existing field's meaning, since old blobs will outlive schema changes.

---

## 6. Viewer

The prototype (`claude-review/assembler-coupler-walkthrough.html`) already renders exactly this shape — topology diagram, Assembler panel (legs/checkpoints/alts), Coupler panel (tail/goal-set/frontier table), event log with scrubbing. Pointing it at real data means: replace the hardcoded `SCENARIOS` array with "fetch envelope + trace blob by `resolveId`," fold the `TraceEvent` list into per-step state snapshots on load (§4.2's storage-vs-render distinction), and render `TouchedSubgraph` in place of the hardcoded `NODES`/`EDGES`. The step-kind vocabulary (`leg_start`, `call_start`, `expand`, `inspect-pass`/`inspect-fail`, `leg_success`, `leg_fail`, `checkpoint`, `backtrack`, `booking_sat`/`dead_end`) maps directly onto the `TraceEvent` subtypes above.

---

## 7. Open questions

- What's actual booking QPS, to size the envelope-row storage cost and pick a reasonable perf-outlier expansion-count threshold for §3?
- Is the topology/capacity model already fully event-sourced through Kafka (per SPEC.md's topic list), which would make replay (Approach A) viable as a *second* capability for interactive counterfactual re-runs, on top of B?
- Where do envelope rows naturally live given existing booking metadata storage — same store, or a dedicated trace index?

---

## 8. Cross-links

| Doc | Role |
|---|---|
| [SPEC.md](./SPEC.md) §W11 | The gap this doc fills ("Coupler explain log... Not written") |
| [BUILD_SPEC.md](./BUILD_SPEC.md) §9.3/§3.10 | `FailureReport` — the existing capped-sample mechanism this extends |
| [BUILD_SPEC.md](./BUILD_SPEC.md) §3.7b | ExpandKey component definitions, mirrored in §4.2's `ExpandKey` type |
| `claude-review/assembler-coupler-walkthrough.html` | Prototype viewer this schema is designed to feed |
