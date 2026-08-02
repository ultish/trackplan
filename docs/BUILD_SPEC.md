# Trackplan — Build Spec (v1)

**Project:** **Trackplan** (Kotlin package / service: `trackplan`).  
**Audience:** implementers / another LLM session.  
**Goal:** enough concrete decisions, schemas, algorithms, and tests to build a working core **without** inventing product policy.

**Read first for full picture / rationale / open questions:** [SPEC.md](./SPEC.md) (handoff).  
**Companion:** [booking-assembler-design.html](./booking-assembler-design.html) (interactive walkthroughs; vocabulary pass later).  
**Vocabulary:** StationType, Station, Track, Link, Setup, Tasking, Task, Request, Inspector, Booking, Leg, Route, Hop, Assembler, Coupler.  
**Bridge:** ResourceType→StationType · Asset→Station · Class/Car→StationType/Station · Yard→transparent StationType · Cable→Link · Port→Track · Consist (old project name)→Trackplan.

---

## 0. How to use this doc

| Status tag | Meaning |
|------------|---------|
| **DECIDED v1** | Implement exactly this unless product overrides |
| **DEFAULT v1** | Recommended; safe to ship; note if you change it |
| **OPEN** | Needs product input; do not invent beyond listed options |

When something is **OPEN**, the **DEFAULT** is still specified so build can proceed.

### Document authority (DECIDED)

| Source | Authority |
|--------|-----------|
| **§1–§4 + §3.7–§3.10** | **Canonical** — Station model, Prefilter/Inspector, first/last leg, sticky, commit |
| **§5+** | Must not contradict §1–§4; if they do, **§1–§4 win** (legacy Class/Car/Yard wording is a rename of the same concepts) |
| **SPEC.md** | Intent and open product questions; BUILD_SPEC §1–§4 wins on mechanism conflicts |

**Vocabulary map (use when reading older sections):** StationType←Class · Station←Car · transparent StationType←Yard · Link←Cable · Track←Port · Tasking/Task←config/claims · Route/bindings←consist display.

---

## 1. Product thesis (non-negotiable)

1. Under the covers this is **asset scheduling**; the domain cover is a network of **Stations** (**StationType**) connected by **Links** on **Tracks**.
2. A **Booking** demand is ordered **Legs**: non-transparent StationTypes only, each with a **request**. Transparent types (e.g. switches) are omitted from the demand string.
3. **Resolve** binds Stations for legs and a full **route** (hops), including transparent stations. After claim, the user may see `A → SW1 → B → …`.
4. Each Station has **setup** (semi-static) and **tasking** (list of **Tasks** — live / planned-live **source of truth**). Inspectors return updated tasking or fail.
5. **Context is per Task** (built as the path goes through the topology), not only a single booking-global map.
6. **Assembler** = outer (legs, candidates, checkpoints, sticky, incremental re-resolve). **Coupler** = inner (path between leg endpoints on the station graph).
7. Determinism: re-feed a world **snapshot** (setup + tasking + links); re-resolve changed/impacted Bookings only — do not empty-run every booking every time.
8. Sub-optimal OK. Sticky when nothing hopeful changed. Setup changes are rare / often human (see Setup vs Request).
9. Failures explain at the first stage that emptied options.
10. v1 = library/service core; **production is Kafka-triggered**. Domain goldens without Kafka. See §3.10 / SPEC §10.1.

---

## 2. Non-goals (v1)

**DECIDED v1 — do not build (in the engine slice):**

- Global optimal multi-Booking packing / MILP / CP-SAT as primary solver  
- Full UI  
- Parallel “assign all legs then join”  
- Device-level graph without tracks  
- “Never visit same Station twice” as a hard rule (re-entry on a new hop_key is allowed)  
- Re-solving every poll when nothing hopeful changed  
- Perfect dependency-based cache invalidation (use hopeful-token set first)  
- **Kafka producers/consumers, topic schema registry wiring** (adapters after domain works; SPEC §10.1)  
- **Force-priority preemption** (kick lower Bookings) — design only in SPEC §12 Q16; v1 resolve uses free resources only

### 2.1 Booking priority (data only in v1)

```text
Booking {
  ...
  priority: int    // 1 = highest (lower number = more important)
}
```

| Resolve mode | v1 behavior |
|--------------|-------------|
| Normal | Place in priority order (1 first); free capacity only within a time-slice view |
| `forcePriority: true` | **OPEN / not v1** — kick lower-priority bookings to free resources (SPEC Q16); distinct from “steal at a later event when both scheduled” |

**Note:** Mid-window **re-place** of a lower-priority booking after a higher-priority one **commits** in the same run is in-scope (Assembler queue). That is not the same as force-kick of an already-live exclusive hold without a full re-plan pass.

Do **not** silently overwrite another Booking’s claims in v1.

Full design strawman (eviction, cascade, audit): **SPEC.md §12 Q16**.

---

## 3. Canonical data model

### 3.0 Mental model

**Entity diagrams (Mermaid):** [ENTITY_DIAGRAMS.md](./ENTITY_DIAGRAMS.md).

```text
StationType  = catalog type (schemas, inspector, heuristics, transparent?)
Station      = instance (setup, tasking, liveData, tracks)
Track        = named IN or OUT endpoint on a StationType / use via Links
Link         = physical topology: StationA OUT track → StationB IN track
Task         = assignment on a Station: input, output, context, taskingConfiguration, bookingIds, time window
Tasking      = Task[] on a Station — live/planned-live assignment truth
Request      = user demand on a Booking leg
Route        = full hop path after resolve (user-visible plan string)
```

**DECIDED v1:** No Yard entity. Switches = **transparent** StationTypes. Product name = **Trackplan**. Domain plan string = **Route**.

### 3.1 Identifiers

**DECIDED v1:** opaque string ids (`st_…`, `sttype_…`, `booking_…`, `link_…`).  
Stable sort = lexicographic id ascending unless sticky id overrides.

### 3.2 Catalog: StationType

```text
StationType {
  id: string
  name: string

  // true ⇒ omitted from Booking demand string; path filler (e.g. switch).
  // Users do not author legs or requests for transparent types (v1 product).
  // Inspector API still accepts request (may be empty) so future product can opt in.
  transparent: bool

  // Schemas (JSON Schema or equivalent) — type defines shape; instances hold values
  setupSchema: Schema              // semi-static props (firmware, …) NOT booking-driven
  taskingSchema: Schema            // shape of Task / tasking list (inspector contract)
  requestSchema: Schema            // shape of Booking leg request; may be {} if unused

  // I/O shape for all stations of this type
  inputTracks: TrackId[]           // e.g. ["1","5"]
  outputTracks: TrackId[]          // e.g. ["1","2","6"]
  // Possible in→out pairs on one visit (type capability). Enforcement of *which*
  // concurrent uses are OK is Inspector-driven, not only this list.
  legalPairs: { in: TrackId, out: TrackId }[]

  inspectorId: string              // code registry → Inspector
  prefilterId: string | null       // optional cheap Prefilter (see §3.7)

  heuristics: {
    checkpoint: bool               // after bind this type, do not try other stations of type
  }
}
```

**Setup vs request (DECIDED):**

- Human / non-booking-dynamic → **setup**.  
- Booking may demand it → **request** only (never also setup).  
- Assembler **never** mutates setup (humans via UI/API).

**Topology vs inspector (DECIDED):**

- **Links** = physical graph Coupler may traverse.  
- **Inspector** decides whether a traversal/tasking is valid (multiplex, capacity, N:1 terminals, hubs, …).  
- StationType may expose N inputs / M outputs; legality of concurrent use is inspector rules, not a global “one link per out” hard law.

### 3.3 Instance: Station

```text
Station {
  id: string
  stationTypeId: string
  online: bool

  setup: object                    // setupSchema values
  tasking: Task[]                  // assignment truth (live + future windows)
  liveData: object                 // live metrics (e.g. crowdCapacity); not setup, not request
                                   // may make next inspect fail even if setup allows N tasks

  // Type defines all possible tracks; Links define which are wired in the world.
  // Engine uses type tracks ∩ links for traversal.
}
```

### 3.4 Track

```text
TrackId = string

TrackRef {
  stationId: string
  side: "in" | "out"
  trackId: TrackId
}
```

### 3.5 Link (topology)

```text
Link {
  id: string
  from: { stationId, trackId }     // OUT
  to:   { stationId, trackId }     // IN
  online: bool                     // false ⇒ link unusable; engine must not traverse
}
```

**DECIDED:**

- **Link.online = false** is a world/setup-like fact: that physical edge is gone for search.  
- Existing Tasking that depended on that link ⇒ those Bookings must be **re-scheduled** (find another path/link if possible).  
- Studio: drag out-track → in-track creates a Link.

Examples: many upstream outs may **Link** into one Terminal in-track (`B:1→T:1`, `C:1→T:1`); Hub types may have many inputs/outputs — inspector defines concurrent capacity.

### 3.6 Task, Tasking, Context

```text
Context = Record<string, JsonValue>

Task {
  input: TrackId | null            // null OK for entry/first-type start (no in used)
  output: TrackId | null           // null OK for terminal/last-type arrival (no out needed)
  context: Context                 // path/comms facts for THIS task; inspector writes/extends
  taskingConfiguration: object     // inspector bag (request material / provenance / …)
  bookingIds: string[]             // one Task may serve many bookings — inspector merges
  // NO timeWindow on Task — time is Assembler's job (see §3.9b)
}

// Station.tasking = Task[]   // committed (or time-slice projected) assignment
```

**DECIDED:**

- Users do not author tasking; Coupler appends **candidate Task(s)**; Inspector returns **full Task[]**.  
- Full list (not delta): store on station / pass to next segment without diff math.  
- One Task may list **many bookingIds** when inspector combines.  
- **liveData** + **setup** + **tasking** feed inspect/prefilter as applicable.  
- **Failed inspect:** do **not** write candidate into Station.tasking (tasking = what will/should be live).  
- **Working vs committed tasking:** during one Booking resolve, Coupler/Assembler may keep a **scratch/working** map of provisional Task[] per station; only on Booking SAT (or explicit commit) merge into world Station.tasking. On Booking fail, **discard scratch** (release preallocations for that attempt). See §3.9c.

### 3.7 Prefilter + Inspector

```text
// Cheap screen — NO Task (no in/out yet). NO path context.
Prefilter.canUse(
  setup: object,
  request: object | null,
  liveData: object | null
) → ok | reject(reason)
// Type-specific. DEFAULT: if request == null, apply no request-based filtering (pass unless setup/liveData hard-fail).
// Must NOT reject a station that could succeed once path Tasks build context.

// Full assign — one candidate Task appended per call
Inspector.inspect(
  setup: object,
  tasking: Task[],               // existing + exactly one candidate for this try
  request: object | null,
  liveData: object | null
) → Task[] | Failure             // FULL replacement list (working copy)
```

**DECIDED:**

- Prefilter: **setup, request, liveData** only — **no context**.  
- Transparent: **no prefilter** mid-path.  
- **One candidate Task per inspect** (Coupler appends exactly one).  
- Candidate **context** seeded by **copy of previous hop Task.context** (accumulation map); inspector may add keys for downstream.  
- **Request (B):** copied into candidate `taskingConfiguration` **and** passed as `inspect` arg.  
- `request == null` on prefilter: generally **no pre-filtering** (type may still hard-reject).

#### First leg / entry into A* (DECIDED)

Demand leg 1 = StationType T. **No transparent types before T.** First type is **entry-special**: Coupler **does not use input tracks** on these stations (even if the type defines some).

1. Assembler: OPEN stations of type T → **Prefilter**(setup, request, liveData) → candidate set C.  
2. Coupler: **virtual source S0** (not a real Station) with edges **S0 → each c ∈ C** (“pick this start station”).  
   - No Link into an in-track required.  
   - Cost S0→c uses edgeCost/neighborRank (fill-first, etc.) on c’s tasking.  
3. Goal: **inspect** accepts a **start Task** on some c (out-track chosen for the *next* segment if any).  
4. **`h`:** for this segment goals are the candidates themselves → `h(c)=0` at a goal; `h(S0)=0` (or min over candidates — equivalent for ranking). Later segments: `h(n)` = Oracle hop-count to nearest prefiltered goal of that leg’s type.

#### Last leg / terminal (DECIDED)

Last StationType is often a **terminal**: typically **no output track** needed.

- Success when path **arrives** at a prefiltered last station, e.g. physical hop into it `… → 1:C` (enter on in-track `1`).  
- Coupler/inspect does **not** require building a full `in:C:out` like `1:C:1` if there is no meaningful out.  
- Candidate Task for terminal: **input** set, **output** empty/null (or type-defined sentinel); inspect still validates tasking list.  
- If a last type *does* define outs, they are optional for “booking complete”; booking is done once last type is successfully tasked on arrival.

#### Oracle (DECIDED summary)

- Graph: **Stations + Tracks + Links** (no separate “side” concept beyond in vs out track lists on the type).  
- Physical reachability / hop `h`: topology only; **hop_key + H + V** anti-loop (loopback OK, infinite not).  
- Rebuild when Links add/remove/online or Station OPEN/CLOSED (and type track topology changes).  
- **Not** rebuilt on tasking. Build/rebuild before Assembler when topology dirty; read-only during run.

### 3.7b Coupler: dynamic edge costs + SmartNode (NeighborRank)

Coupler needs **both**:

1. **Edge costs** (A* `g` / path cost) that can depend on **dynamic** world state, and  
2. **SmartNode / NeighborRank** when expanding a Station: among legal next Stations (same type or peers), **sort deterministically** using **tasking** (and setup/liveData), not only static ids.

These are related but not the same knob.

#### Dynamic edge cost

```text
// Cost to traverse Link L into Station N using candidate Task t
// DECIDED: may read dynamic data — not a static weight on the Link alone
edgeCost(
  link: Link,
  fromStation: Station,
  toStation: Station,          // neighbor
  toSetup: object,
  toTasking: Task[],           // current tasking on toStation (SOURCE OF TRUTH)
  toLiveData: object | null,
  candidate: Task,             // proposed use of toStation (in/out/context/…)
  request: object | null,
  pathSoFar: Hop[]             // optional
) → non-negative Number
```

**DECIDED:**

- Costs are **dynamic** and **composable**: a sum (or ordered mix) of preference terms; new terms can be added later without changing Coupler structure.  
- Must be **pure + deterministic** given WorldSnapshot + candidate (no RNG, no map-iteration order).  
- Static baseline allowed (e.g. +1 per hop) **plus** dynamic terms.  
- **Hard illegality is not a huge cost** — illegal uses fail **Inspector**; cost only ranks *legal* preferences.  
- A* `f = g + h`: `g` sums `edgeCost` along the path; `h` may stay optimistic (ignore occupancy) — v1 ACCEPTABLE that A* is not optimal on the full dynamic metric.

**Known preference terms (v1 examples — extend over time):**

| Preference | Intent | Typical cost effect |
|------------|--------|---------------------|
| **Prefer non-transparent** | Progress demand legs / endpoints over lingering in pure path fillers | Higher cost entering **transparent** stations than non-transparent (or bonus for non-transparent) |
| **Prefer non-transparent** | Progress demand types | Transparent penalty — **default** e.g. +1; **StationType override** if that type is “more expensive” |
| **Prefer already-tasked (fill first)** | Pack load before empty peers | Empty-station penalty — **configurable per StationType** (default ON for all types) |
| **Baseline hop** | Every step costs something | +1 per Link |
| **Later terms** | OPEN | liveData headroom, merge-friendly tasking, … |

```text
edgeCost = hopBaseline
         + transparentPenalty(type)       // default 1 if transparent; override on StationType
         + emptyStationPenalty(tasking) // if type.heuristics.fillFirst (default true)
         + … future terms …
```

#### NeighborRank = SmartNode (name)

**NeighborRank** is the doc name for **SmartNode**: when expanding, order legal neighbors deterministically using **tasking** (etc.), not only `stationId`.

```text
neighborRank(neighbor.tasking, setup, liveData, candidate, request?) → Long  // higher = try sooner
// Default 0; type plugin can mirror fill-first / reuse scoring
```

**DECIDED:** NeighborRank applies **only when `edgeCost` is equal** (tie-break). It does not override a cheaper edge. Not every StationType has a SmartNode.

```text
sort: (edgeCost, -neighborRank_if_any, trackName/trackId, …stable leftovers)
// stationId is not part of edgeCost
```

| Mechanism | Effect |
|-----------|--------|
| **edgeCost** | Primary sort / A* `g` |
| **neighborRank (SmartNode)** | Only if type defines one **and** edgeCost equal |
| **track name** | Last-resort deterministic tie-break |

#### A* heuristic `h` (hop count to goal)

`f = g + h`. **`g`** = sum of dynamic edgeCosts so far. **`h`** = estimate of remaining cost to goal.

**DECIDED DEFAULT v1:**

- **`h` = BFS hop count** on the **online Link** graph from current station to the **nearest goal** for this Coupler segment (goal = stations of the target StationType for this leg / multi-sink set). Each Link counts as 1. **Ignores** tasking, fill-first, transparent penalties.  
- “Optimistic” = does not add dynamic penalties into `h` (so `h` underestimates true dynamic remaining cost). Smarts stay in **`g` (edgeCost)** + **NeighborRank** ties.

**Precompute (Oracle) — yes, optional but recommended:**

```text
// Rebuild when topology changes (Links add/remove, Link.online, station online)
// Do NOT rebuild on every tasking/liveData change
oracle.minHops[fromStationId][toStationId] = BFS distance on online Links

// Multi-sink goals G for this couple():
h(n) = min over g in G of oracle.minHops[n][g]

// Virtual source S0 → candidates C:
h(S0) = min over c in C of h(c)   // or min (1 + h(c)) if S0 edges count as one hop
```

Per Coupler call without Oracle: one multi-source BFS **backward from all goals** once, then O(1) `h(n)` lookups — same idea, amortized per call.

#### Registration

```text
StationType.heuristics {
  checkpoint: bool
  fillFirst: bool                 // default true — prefer already-tasked
  transparentCost: Number | null  // null ⇒ use global default (e.g. 1) if transparent
  edgeCostId / neighborRankId     // optional plugins
}
```

### 3.8 Booking (demand + plan)

```text
Booking {
  id: string
  priority: int
  status: "pending" | "sat" | "unsat"
  timeWindow: { start: Instant, end: Instant }   // only place time lives (start/end Instants; no RRULE)

  // DEMAND — non-transparent types only
  legs: Leg[]

  // PLAN
  bindings: Binding[]            // every Station used (leg + path)
  route: Hop[]                   // full path; user-visible after engine
  failure: FailureReport | null
  snapshot: ResolveSnapshot | null
}

Leg {
  index: int
  stationTypeId: string          // transparent == false
  request: object
}

// Binding = "this Booking uses this Station" (on the plan)
Binding {
  stationId: string
  legIndex: int | null           // null if transparent / not a demand leg
  role: "leg" | "path"           // path = transparent or intermediate
}

Hop {
  stationId: string
  inTrack: TrackId
  outTrack: TrackId
  // hop_key = (stationId, inTrack, outTrack)
}
```

| View | Name | Content |
|------|------|---------|
| User demand | legs | A → B → C + requests |
| After engine | **route** | A → SW1 → B → … (display / plan path) |

### 3.9 When the engine runs (incremental)

**DECIDED:**

| Trigger | What re-resolves |
|---------|------------------|
| One Booking created/changed | **That Booking only** (commit its Tasks on SAT) |
| Exception | All still-**unsat** bookings also tried each wake (sticky accelerates) |
| Link.online = false / setup breaks routes | Bookings whose route used that resource re-schedule |
| Queue in one run | **Priority 1 first**, then **FCFS by submitTime** (not createTime); each SAT commits before next |

Do **not** re-run every SAT booking from empty every time.

### 3.9b Time (Assembler-owned, Inspectors time-dumb)

**DECIDED:**

- Booking has **`timeWindow: { start, end }`** (Instant range only — no RRULE).  
- **Tasks have no time fields.** Inspectors are **time-dumb**.  
- **Horizon** = **engine config** (e.g. next 8 hours from run “now”).  
- **Event times** = every unique booking **`start` / `end`** inside the horizon.  
  Example: B1 9–10, B2 10–11, B3 10:30–11 → **9:00, 10:00, 10:30, 11:00**.  
- **“Now”** is not a separate schedule event. If `now` lies inside a booking window, that booking is **already in force** from its **start** (which may be in the past). Output/plan still uses **start/end**, not “began at now.”  
- **Events** (domain): plan pieces keyed by time; **Tasks** hang under an **Event** parent for a given instant/slice.  
- **Idempotent per event:** if event T was already computed for a booking and **no relevant change** (booking, station setup, links, …), **do not** recompute that (booking, T).  
- **Multi-segment plan (A):** one Booking may have **several plan segments** over sub-intervals (e.g. 9–10:30 route X, 10:30–11 route Y) when contention/priority forces a change — not because inspect knows time.  
- **Priority steal:** if higher-priority booking **successfully commits** and takes a station at T, lower-priority booking is **re-placed in the same engine run** (for affected slices). No steal on failed higher-priority attempt.  
- **Priority:** **1 = highest** (lower number wins). **Ties: first-come first-served** (earlier submit/accepted time wins; then stable id if timestamps equal).  
- **liveData:** next run only; no auto re-queue.  
- Projected tasking at T: tasks from bookings whose window covers T and whose **plan segment** places them on that station for that sub-interval.  
- Skip work when nothing to do at T (no dirty bookings for that event). Event set is start/end points; an event always corresponds to some booking boundary, but “active set needing compute” may be empty after filtering.

```text
PlanSegment {
  start: Instant
  end: Instant
  route: Hop[]
  bindings: Binding[]
}

Booking {
  timeWindow: { start, end }      // demand validity
  priority: int                   // 1 = highest
  planSegments: PlanSegment[]     // after resolve; may be >1 if mid-window re-place
  ...
}

Event {                           // Assembler time index
  at: Instant
  // tasks active in the open interval starting at `at` (until next event)
}
```

### 3.9c Working state, commit, batch queue (memory & performance)

**DECIDED: whole-Booking commit only; queue commits between bookings.**

```text
CommittedWorld (durable “world view” — setup, tasking, liveData, links, bookings)

// One engine run may process many bookings (priority order):
for booking in queue:
  WorkingState = empty path-local overlay on CommittedWorld
  place ALL legs (Coupler + inspect) using WorkingState only
  if SAT:  commit WorkingState → CommittedWorld; next booking sees new tasking
  if FAIL: discard WorkingState; world unchanged
```

**Path-local provisional — which stations?**

Current attempt has an explicit **path** of hops (including **transparent** stations):

```text
overlay keys = stationIds on this path/branch that already got a successful inspect
read(S) = overlay[S] ?: committedWorld.tasking[S]
```

You never preload every switch in the plant. You only overlay stations **you have walked and accepted** on this branch (SW1, SW2, … appear when the path goes through them). New neighbor N: usually read **committed** tasking until N is accepted, then N joins the overlay. Re-entry uses overlay (sees this booking’s earlier Task). Separate A* branches ⇒ separate COW overlays.

**Not** “hold 10 bookings uncommitted.” After booking 1 SAT → commit → booking 2 sees world.

| Event | Effect |
|-------|--------|
| Inspect OK on a branch | Overlay path stations only |
| Branch dies | Drop branch overlay |
| **Whole Booking SAT** | Merge overlay → world |
| **Fail any leg** | Discard entire booking overlay |
| Link.online=false | Re-queue routes using that link |
| Setup change on S | Re-queue users of S (+ unsats each wake) |
| liveData | No auto re-queue |

**Audit:** cache keys + FailureReport. **Perf:** path-local COW; sticky SAT + unsat.

### 3.9d Multi-leg tail, outs, lookahead, alternatives, checkpoint

**Mental model (DECIDED):**

1. Toward B: try hops like `1:B:1`, `2:B:2`.  
2. Inspect accepts **`1:B:1`** ⇒ working Task, **tail = B out 1**.  
3. Next segment: from **B:1** via Links (transparent OK) to type C.

#### C1 — Physical reachability uses same loop rules

“Does B out X reach some C?” is **bounded** path existence on online Links, **not** naive infinite BFS:

| Rule | Same as Coupler |
|------|-----------------|
| No repeat **hop_key** `(stationId,in,out)` | Useful re-entry OK; spin blocked |
| **max_hops H** | Cap length |
| **max_visits_per_station V** | Cap re-visits |
| Online Links only | |

Loopbacks allowed; infinite loops not. Rebuild when topology changes, not tasking.

#### C2 — Agenda: next target to try (inspect when peeled)

**DECIDED:**

```text
agenda = sort( oracleFilter( candidate finishes e.g. 1:B1:1, 2:B1:2, 1:B2:1, … ) )
// targets only — not full multi-hop paths
// sort: edgeCost, then NeighborRank if cost equal & type has one, then track name

while agenda not empty:
  target = agenda.pop()              // next available task to try
  pathTaken = Coupler.find path to target   // store hops for debug / FailureReport / cache
  if path fail: continue
  inspect when peeled (one candidate Task); if fail: continue
  // remaining agenda kept as alts if later leg fails
  if no next leg: segment OK
  else if Coupler(target.out → next type) OK: continue booking
  else restore working overlay; peel next from agenda
fail leg
```

| Rule | Decision |
|------|----------|
| Agenda = Oracle-filtered, sorted **targets** | **Yes** |
| Peel top → Coupler | **Yes** |
| Inspect **when peeled** (not eager-all) | **Yes** (option A) |
| Store **pathTaken** to each target | **Yes** (track/debug / report / sticky keys) |
| Full fabric paths precomputed into agenda? | **No** |
| Who owns agenda? | **Assembler** |

#### Checkpoint timing (DECIDED)

Checkpoint = do not try **other stations of this StationType** on this Booking.

- **Too early:** checkpoint type B as soon as `1:B:1` accepts → cannot switch to another B station if C fails. (Retrying **same** B with `2:B:2` is still OK under checkpoint.)  
- **DEFAULT:** checkpoint type B only **after the next non-transparent leg (C) has a successful working Task** (or B is last leg and booking is SAT).  
- If search backtracks **through** C and abandons B, **clear** B’s type checkpoint.  
- Whole Booking SAT freezes via commit.

So: **yes** — earliest safe checkpoint for B is after the **next** non-transparent station succeeds (last leg: at full booking SAT).

### 3.10 Sticky cache (SAT + unsat)

#### Sticky record vs engine output

| | **StickyRecord** (cache) | **Plan / ScheduledEvents** (engine output) |
|--|--------------------------|-----------------------------------------------|
| Job | “Already answered this demand under a still-valid **relevant** world?” | What was scheduled: route, planSegments, tasking |
| SAT hit | Skip Coupler; **return cached plan** | That cached plan *is* the schedule |
| UNSAT hit | Skip Coupler; return FailureReport | No schedule |

Sticky is **not** a second schedule format. It **stores or points at** the engine result so a hit reuses it.

#### Relevance-scoped invalidation (DECIDED)

Plant changes are global, but **sticky validity is per booking**.

- If StationType **X** (or only X’s stations/links) changes and this booking **never uses X** (not in legs; not on SAT route; not needed for unsat hope) → **do not** bust that booking’s sticky.  
- SAT relevance ⊆ types/stations/links on its **plan**.  
- UNSAT relevance ⊆ **demand StationTypes** (+ optional failure samples); hope only on those.

#### StickyRecord shape

```text
StickyRecord {
  bookingId
  demandHash     // legs + requests + timeWindow + priority + submitTime
  // epochs only for RELEVANT stations/types/links — not whole plant
  relevantSetupEpochs: Map<Id, long>
  relevantTopoEpochs:  Map<Id, long>
  result:
    SAT  { planSegments, bindings, route, … }   // engine output
    UNSAT { failureReport }
}
```

#### Unsat bust (hope only, scoped)

| Change | Bust **this** unsat? |
|--------|----------------------|
| This booking’s demand / submitTime | **Yes** |
| Setup on a **relevant** station/type | **Yes** |
| Link **opened**/added or station **OPENED** useful to **relevant** types | **Yes** |
| Tasking **freed** on **relevant** types | **Yes** |
| Link closed / station CLOSED | **No** |
| Tasking added | **No** |
| Unrelated type X | **No** |
| liveData | **No** auto |
| Inspector jar | **N/A** (StationType/jar; restart = cold) |

#### FCFS = **submit** time (DECIDED)

Booking may be **created** then later **submitted** to the engine. Ordering uses **submitTime** (when handed to Trackplan), not createTime. Priority **1** first, then earlier submitTime, then booking id.

#### FailureReport (v1 minimum)

```text
FailureReport {
  code: "NO_CANDIDATES" | "INSPECT_FAIL" | "UNREACHABLE" | "BUDGET"
      | "CAPACITY" | string
  legIndex: int | null
  message: string
  stationId: string | null
  pathTaken: Hop[] | null
}
```

#### Engine trigger (Kafka)

**DECIDED:** Kafka events update the world projection and wake Assembler (affected bookings + sticky unsat checks). Core is the same without Kafka in tests.

#### Remove / cancel a SAT booking (DECIDED)

1. Remove `bookingId` from all Tasks that list it.  
2. **Drop** any Task whose `bookingIds` becomes empty (sole owner).  
3. **Re-run Assembler** (affected unsats + any policy that re-packs fill-first — DEFAULT: run engine wake with this release as a hopeful event so unsats may succeed).  
Does **not** require full invent of surgical re-inspect of every peer booking in v1 beyond (1)–(3) + engine wake.

#### Station OPEN/CLOSED (DECIDED)

Same usability idea as `Link.online`: CLOSED ⇒ Coupler must not use it. **CLOSED/OPEN** triggers re-queue like setup/topology (OPEN = hope; CLOSED = re-route users of that station).

### 3.11 Invariants

**DECIDED v1:**

1. Concurrent task validity is **Inspector**; Coupler walks **online Links** only.  
2. Re-entry: different hop_key only (anti-loop).  
3. Legs only `transparent == false`.  
4. Prefilter: setup + request + liveData; no Task; no context.  
5. Failed inspect never commits to Station.tasking.  
6. **Only whole-Booking SAT** commits overlay; fail on any leg discards all provisional tasking for that booking.  
7. Setup only changed by humans.  
8. Time only on Booking; Assembler time-slices by event instants in horizon; inspectors time-dumb.  
9. NeighborRank only when edgeCost equal; `h` = hop-count Oracle to segment goals.  
10. Request on candidate Task: copied into taskingConfiguration **and** passed to inspect (option B).  
11. Physical reachability Oracle uses same hop_key / H / V loop rules as Coupler.  
12. Checkpoint a type only after next non-transparent leg succeeds (or last leg at SAT); clear if backtrack abandons that leg.

---

## 4. Context on Tasks (path facts)

### 4.1 Context

```text
Context = Record<string, JsonValue>   // on each Task
```

**DEFAULT v1** namespacing examples:

- From non-transparent bind: `{stationTypeId}.{fact}` e.g. `refrigerated.cabinets = 4`  
- From path: capability keys e.g. `clearance.y2_stamp = true` (written into Task.context as Coupler advances)

### 4.2 How context grows

**DECIDED:** **Inspector** is the writer of durable path communication:

1. Coupler appends a **candidate Task** (in/out known from topology; context seeded from **previous Task.context** on the path, or `{}` at start).  
2. Inspector runs on full `Task[]` (existing + candidate).  
3. On accept, inspector places request material into **taskingConfiguration** and puts **downstream facts into Task.context** so later stations can read them.  

**Canonical “current context” for the booking path (DECIDED):**  
There is **no separate booking-global Context store**.  
`currentContext` in Assembler/Coupler pseudocode means **a copy of the latest accepted Task.context on the working path** (or `{}` before any Task).  
`ResolveResult.context` (if exposed) = that same value at finish (last Task on route), not a second shadow map.

### 4.3 Discovering path context (why try endpoint B before transparent SW?)

Inspectors **must not** hard-code fabric stations (“go to SW-2”). They accept/reject from **setup + tasking + request + Task.context** (e.g. missing stamp in context).

| Question | Answer |
|----------|--------|
| Why try short path to endpoint B first? | **Search heuristic**: prefer fewer hops / earlier arrival at goal stations. When required facts are already in Task.context, short path wins quickly. |
| Does Inspector tell us to use a switch? | **No.** It only fails without needed context. It does not name transparent stations. |
| How does the algorithm find SW then? | **Continued multi-sink search**. Arriving at B with bad Task.context = not a successful goal; keep expanding; path through transparent stations builds context on Tasks; later arrival at B may succeed. |
| Prefer next leg station over extra transparent hops? | **Cost bias only**, if search still explores after goal-reject. **Unsafe** if first touch of B binds without inspect. |

**DECIDED v1:** Goal success = reached candidate station with a Task that **inspect** accepts (new tasking returned). Goal-reject ≠ search failure; only open-set exhaustion / budget is failure.

**DEFAULT cost bias:** small positive cost per hop (or per transparent station) so simple corridors are tried first.

---

## 5. Prefilter + Inspector contract (**canonical = §3.7**)

**DECIDED:** One registration model, two plugins per StationType (or one jar exposing both):

```text
// StationType.prefilterId →
Prefilter.canUse(setup, request, liveData) → ok | reject(code, message)
// No Task, no path context. Must not reject path-only successes.

// StationType.inspectorId →
Inspector.inspect(setup, tasking, request, liveData) → Task[] | Failure
// tasking includes exactly one Coupler-appended candidate Task.
// Returns FULL Task[] for that station (working copy). Context lives on Tasks.

// Optional ranking for Assembler goal list / Coupler ties (§3.7b):
// Use NeighborRank / edgeCost plugins — NOT a separate rank_cost API.
// DEFAULT: neighborRank = 0; sort by edgeCost then track name.
```

| Stage | When | Inputs | Use |
|-------|------|--------|-----|
| **Prefilter** | Assembler before agenda/Coupler | setup, request, liveData | Shrink candidate stations |
| **inspect** | Coupler when peeled target | setup, tasking(+candidate), request, liveData | Accept/reject + new tasking |

**Wrong:** full inspect at Assembler dropping stations for missing path stamps.  
**Right:** prefilter only irreversible/static checks; path facts checked in **inspect** when candidate Task carries context.

#### Example: StationType Normal — seats vs path

**Leg request:** `min_seats: 6`. Inspect also checks arrival routing + path context stamps.

```text
Prefilter.canUse(setup, request={ min_seats: 6 }, liveData):
  if station CLOSED/offline: reject OFFLINE
  if setup.max_seats < 6: reject SEATS   // safe: path won't add seats
  return ok

Inspector.inspect(setup, tasking, request, liveData):
  // tasking includes candidate Task with input/output/context
  if setup.max_seats < request.min_seats: fail SEATS
  if not legalPairs(candidate.input → candidate.output): fail TRACK_ROUTE
  if candidate.context missing required stamp: fail CONTEXT
  return new full Task[]  // or fail CAPACITY / multiplex / …
```

| Station | max_seats | prefilter | inspect |
|---------|-----------|-----------|---------|
| N-04 | 8 | pass → agenda | may need stamp via SW path |
| N-08 | 4 | fail SEATS | never searched |
| N-12 | 12 | pass → agenda | may fail TRACK_ROUTE |

### 5.2 Assembler usage

```text
for station in pool(stationTypeId) if OPEN and not checkpoint-closed:
  if Prefilter.canUse(station.setup, leg.request, station.liveData).ok:
    candidates.append(station)
// candidates → Oracle filter → agenda → Coupler.couple / inspect when peeled
```

### 5.3 Per-StationType guide

1. setupSchema / taskingSchema / requestSchema  
2. Prefilter reject codes  
3. inspect rules + Failure codes  
4. What goes into Task.context for downstream  
5. heuristics.checkpoint / fillFirst / transparentCost  
6. Unit tests  

**v1 toy StationTypes (goldens / walkthroughs):**

| StationType | transparent | request highlights | prefilter | inspect path facts |
|-------------|-------------|-------------------|-----------|-------------------|
| Refrigerated | no | setup/band style fields | static capability | bind; publish e.g. cabinets into Task.context |
| Normal | no | min_seats, … | seats etc. | track route + **clearance.y2_stamp** (or equiv.) in Task.context |
| Switch (Y1/Y2) | **yes** | usually null | n/a mid-path | tasking in/out; Y2 may write stamp into Task.context |
| Docking / Terminal | no | connector, … | static | often terminal (out null); **not** the Y2 stamp gate |

---

## 6. Yard type catalog (capacity semantics)

| kind | legal_pairs | Capacity **DEFAULT v1** |
|------|-------------|-------------------------|
| **direct** | only `(k→k)` | Each hop_key exclusive per Booking; one Booking per hop_key |
| **aggregator** | `(i→Ag)` for many i | **Exclusive** on out `Ag` (mutex). One active hop using Ag at a time globally |
| **expander** | `(Ag→j)` for many j | **Exclusive** on in `Ag`; each out `j` exclusive |
| **restricted** | sparse list | Each hop_key exclusive |
| **full** | all (i,j) | Each hop_key exclusive |

**OPEN:** shared/combine medium (true RF combine).  
**DEFAULT v1:** exclusive only — simpler reservations. Document combine as v2.

---

## 7. Policy registry

Config object (file or DB), not hard-coded:

```text
Policy {
  coupler: {
    max_hops: 16                  // H
    max_visits_per_station: 3     // V
    max_expansions: 50_000
    max_wall_ms: 500
    forbid_repeat_hop_key: true
    forbid_immediate_link_backtrack: true  // DEFAULT
    search: "bfs" | "astar"       // DEFAULT "astar"
    // Dynamic costs + SmartNode: see §3.7b (edgeCost / neighborRank use tasking+liveData)
    use_dynamic_edge_costs: true
    use_neighbor_rank: true
  }
  assembler: {
    mode: "first_fit"             // DECIDED v1
    backtrack_depth: 0            // DEFAULT v1: no backtrack; fail at leg
    sticky_prefer: true
    use_neighbor_rank_for_goals: true  // rank leg candidate stations with same SmartNode inputs
  }
  cache: {
    sticky_sat: true
    negative_unsat: true
    // hopeful events bust UNSAT; tighter claims do not
  }
  class_overrides: {
    [class_id]: { checkpoint: bool, backtrack_reopen: bool }
  }
}
```

### Open questions → DEFAULT v1

| Question | DEFAULT v1 | Notes |
|----------|------------|--------|
| Agg/exp shared vs exclusive | **Exclusive** | Combine later |
| Backtrack on checkpoint fail | **0** (fail; report checkpoint) | Set `backtrack_depth: 1` later to reopen last checkpoint |
| First-fit vs price all goals | **First-fit multi-sink** (stop at first goal in rank order) | Beam later |
| Leg 1 entry | **Virtual S0 → Coupler** into prefiltered first StationType (inputs unused) | **§3.7** — not Inspector-only bind |
| UNSAT invalidation | Relevance-scoped hope (§3.10) | Not global token nuke |
| Path Context | **Per Task.context**; flowing var = last accepted Task.context | §4.2 |
| Transparent facts | Inspector writes Task.context (e.g. stamp) | No Yard entity |

---

## 8. Algorithms (implement exactly — Station model; **§3.7 wins** if conflict)

### 8.0 Assembler ↔ Coupler contract

| | **Assembler** | **Coupler (A\*/BFS)** |
|--|---------------|------------------------|
| **Job** | Legs, prefilter, agenda/alts, checkpoints, sticky, whole-booking commit | Path from tail or **virtual S0** to peeled target; inspect when peeled |
| **Calls** | One segment **per leg including first** (S0 for first StationType) | Internal expansions; try/fail paths stay inside segment |
| **Success** | Working overlay + route; commit only on full Booking SAT | Path + inspect-OK Task[] on goal |
| **Failure** | UNSAT; discard overlay | Exhaust agenda / budget |
| **Transparent** | Not demand legs | Middle of Link graph |
| **Does not** | Expand every track | Own multi-booking queue / sticky |

```text
working = empty overlay on CommittedWorld
tail = null   // first leg uses virtual S0
for leg in booking.legs:  // non-transparent StationTypes only
  candidates = Prefilter pool
  agenda = sort(oracleFilter(finishes toward candidates))  // first: S0→candidates
  peel agenda until Coupler path + inspect OK or fail
  if fail: discard working; return UNSAT
  // checkpoint *previous* type only after this leg succeeded (§3.9d)
if all legs OK: commit working; return SAT
```

**Wrong:** first leg = Inspector-only bind with **no** Coupler.  
**Right:** first leg = **S0 + Coupler** (§3.7).  
**Wrong:** Assembler starts a new A* after each short-path inspect fail.  
**Right:** fails stay inside segment / agenda peel.

### 8.1 Resolve (Assembler) — sketch

```text
function placeBooking(booking, world, opts={force:false}):
  if !opts.force and stickySAT.hit(booking, world): return cached SAT
  if !opts.force and stickyUNSAT.hit(booking, world): return cached UNSAT

  working = WorkingState(world)
  route = []; bindings = []; tail = null; closedTypes = {}

  for legIndex, leg in enumerate(booking.legs):
    prefilter = registry.prefilter(leg.stationTypeId)
    inspector = registry.inspector(leg.stationTypeId)
    pool = OPEN stations of type not in closedTypes
    candidates = [s for s in pool if prefilter.canUse(s.setup, leg.request, s.liveData).ok]
    if candidates empty: return fail(NO_CANDIDATES, legIndex)

    agenda = buildAgenda(tail, candidates, nextLegGoals, oracle)  // sort: edgeCost, rank, track
    // first leg: tail=null ⇒ virtual S0; first type inputs unused

    segmentOk = false
    while agenda not empty:
      target = agenda.pop()
      path = Coupler.tryTarget(tail, target, working, inspector, leg.request)
      if path is null: continue
      apply path to working; route += path; bindings += …
      tail = out track of accepted Task on goal (null if terminal last leg)
      segmentOk = true
      // remaining agenda kept for backtrack if later leg fails
      break
    if not segmentOk:
      // backtrack prior alts or:
      discard working; return fail(..., legIndex)
    if legIndex > 0: closedTypes.add(booking.legs[legIndex-1].stationTypeId)

  commit working → world
  stickySAT.save(...)
  return SAT
```

### 8.1b Legacy pseudocode removed

> The old loop “if tail is null: bind via Inspector only; else couple” is **void**. Use §8.1 above.

```text
// REMOVED (do not implement):
//   if tail is null: car = first candidate inspector.accept(...); bind without Coupler
// Use virtual S0 + couple/agenda for first leg instead.
```

### 8.1c Sort keys (no separate rank_cost API)

```text
// Agenda / neighbor sort — §3.7b only:
edgeCost ascending
then neighborRank descending if type defines SmartNode and edgeCost equal
then track name
// sticky preferred station may be forced first as policy override when sticky_prefer
```

### 8.2 Coupler (multi-sink; implement with §3.7 / §3.7b)

```text
state = {
  port: Port,                 // current position (device, side, track) — simplify: arrive at device in_track ready to leave
  context: Context,
  g: int,                     // cost
  hops: Hop[],
  visit_count: Map<yard_id, int>,
  used_hop_keys: Set,
  used_cables: Set
}

// Representation DEFAULT v1:
// Nodes in search graph = (device_id, track_id, side) after arriving on an in track,
// or free to choose legal out.

function couple(tail_port, candidate_cars, context0, inspector, leg, caps):
  starts = expand_outs(tail_port)  // car out tracks
  goals = all in-ports of candidate_cars

  open = priority queue  // bfs: g; astar: g+h(port)
  push all starts with context0
  expansions = 0

  while open not empty:
    s = pop
    expansions++
    if expansions > max_expansions or wall exceeded: return null, BUDGET

    // Goal check: if s.port is in-port of a candidate car
    if is_goal(s.port):
      car = owner(s.port)
      // apply any pending; context already includes path facts
      if inspector.accept(leg.request, car, s.context).ok:
        return s.hops + hop_into_car, car, s.context
      else:
        continue  // wrong car or still missing facts

    for edge in legal_edges(s):  // cable out→in OR internal in→out on same device
      if hop_key repeated: skip
      if cable backtrack forbidden: skip
      if yard visit_count exceeds V: skip
      if hops length >= H: skip
      if resource reserved by other booking: skip  // CAPACITY

      ctx2 = s.context
      if edge is yard internal hop or enters yard:
        ctx2 = apply(publish_on_hop for that yard)

      // occupancy check on hop_key / cable
      push neighbor state

  return null, UNREACHABLE or CAPACITY_BLOCKED
    // CAPACITY if any goal was expanded to but only busy edges remained
    // UNREACHABLE if oracle said no or never near goals
```

**Oracle (optional):** precompute hop distances **ignoring** tasking/liveData for admissible-style `h` (optimistic). Dynamic penalties live in **`edgeCost` (§3.7b)** on `g`, not necessarily in `h`.

**Expand order:** legal neighbors sorted by **`neighborRank` (SmartNode, sees tasking)** then **`edgeCost`** then stable ids (§3.7b).

### 8.3 choose_tail_port

**DEFAULT v1:** lowest track_id among Car **out** ports that are online; sticky previous out track if still free.

---

## 9. Resolve API contract

### 9.1 Operations

| Op | Input | Output |
|----|--------|--------|
| `PUT /bookings/{id}` | `{ legs: Leg[] }` | Booking created/updated (clears snapshot if legs_hash changes) |
| `POST /bookings/{id}/resolve` | `{ force?: bool, forcePriority?: bool }` | `ResolveResult` — `force` bypasses sticky/UNSAT cache; `forcePriority` reserved (SPEC Q16), **not implemented v1** |
| `POST /bookings/{id}/release` | — | releases reservations; status pending; may keep last failure |
| `GET /bookings/{id}` | — | Booking + snapshot/failure |

### 9.2 ResolveResult

```text
{
  status: "sat" | "unsat",
  sticky_hit?: boolean,
  negative_cache_hit?: boolean,
  bindings?: Binding[],
  route?: Hop[],
  planSegments?: PlanSegment[],
  // Optional convenience: last Task.context on route (NOT a separate global store — see §4.2)
  context?: Context,
  failure?: FailureReport,
  metrics?: { expansions, ms, candidates_per_leg: number[] }
}
```

### 9.3 FailureReport (**align with §3.10**)

```text
{
  // Canonical codes (aliases in parentheses for older prose):
  code: "NO_CANDIDATES" | "INSPECT_FAIL" /* aka INSPECTOR_REJECT */
      | "UNREACHABLE" | "BUDGET" | "CAPACITY" /* aka CAPACITY_BLOCKED */
      | "ALL_BUSY" | "CONTEXT_DEAD_END" | "POLICY" | string,
  legIndex: int | null,          // preferred name (failed_leg synonym)
  message: string,               // summary synonym
  stationId: string | null,
  pathTaken: Hop[] | null,
  // Optional richer fields (DEFAULT empty):
  checkpoints?: { leg, stationTypeId, stationId }[],
  counts?: object,
  blockers?: { bookingId?, hop?, stationId?, detail? }[],
  suggestions?: string[],
  inspector_samples?: { stationId, code, message }[]
}
```

### 9.4 Idempotency

**DECIDED v1:**  
`resolve` without `force`, same legs_hash + valid snapshot → identical SAT.  
`resolve` without `force`, valid UNSAT cache → identical UNSAT.  
`force: true` bypasses both caches.

### 9.5 Timeouts

Return `BUDGET` / wall clock exceed; do not hang. **DEFAULT** `max_wall_ms: 500` per resolve (configurable).

---

## 10. Cache: sticky SAT & negative UNSAT

### 10.1 World revisions

```text
topology_rev      // cables, yard maps, devices online
setup_rev         // car/yard setup changes
catalog_rev       // cars/classes added-removed
policy_rev
occupancy_rev     // any reserve/release (for SAT validity)
hopeful_rev       // only: release, topology expand, setup enable, catalog add, policy loosen
```

### 10.2 SAT validity

Snapshot valid if:

- legs_hash unchanged  
- all reserved hop_keys/cars still held by this booking **or** still free if soft snapshot  
- topology_rev, setup_rev for used devices, policy_rev match snapshot token  

**DECIDED v1:** on SAT, **hard-claim** reservations until release.

### 10.3 UNSAT validity (hopeful)

Cached UNSAT reusable while `hopeful_rev` and `legs_hash` and `policy_rev` (if tighter) unchanged.

**Do not** bust UNSAT solely because `occupancy_rev` increased from **new claims**.

**Do** bust on release, new cable/pair, car online, setup change that could enable, policy loosen, legs edit.

---

## 11. Concurrency & claims

**DECIDED v1:**

1. Resolve runs in a **DB transaction** (or single-threaded in-memory lock per process for embedded).  
2. Order of locking: sort resource ids; claim cars then hops to avoid deadlock.  
3. If conflict mid-resolve → abort, return retryable error or `CAPACITY_BLOCKED`.  
4. Two concurrent resolves: serializable isolation; one wins claims.  
5. **No force-kick preemption in v1** (SPEC Q16). **Allowed:** priority-ordered place + same-run **plan re-place** of lower-priority bookings when a higher-priority booking **SAT-commits** and takes a resource at a time event (§3.9b “priority steal”).

---

## 12. Observability

**Metrics (counters/histograms):**

- `resolve_sat`, `resolve_unsat`, `sticky_hit`, `negative_cache_hit`  
- `coupler_expansions` (p50/p99)  
- `resolve_ms`  
- `fail_code{code=}`  
- `candidates_in` / `candidates_after_inspector` per leg  

**Trace (debug):** one resolve id; log leg start, candidate counts, coupler result, fail stage.

---

## 13. Golden acceptance tests

Implement as automated tests (toy topology fixture).

| ID | Name | Expect |
|----|------|--------|
| G1 | Restricted re-entry | Path includes two Y1 hops with different hop_keys (e.g. `1:Y1:2` then `5:Y1:6`); reaches N car (see walkthrough `loopback`) |
| G2 | No oscillation | With Y1↔Y2 cables present, search cannot spin forever: `forbid_repeat_hop_key` + `max_visits_per_yard` / `max_hops` / expansions → finite `BUDGET` or UNSAT (never hang) |
| G3 | Inspector context | cabinets=4 filters Normal; wrong cars rejected |
| G4 | Checkpoint | After R bind, other R cars never tried |
| G5 | Context path stamp | Short path to N-04 fails inspect (missing stamp in Task.context); path via Y2 writes stamp then N-04 succeeds |
| G6 | Capacity blocked | Reserve blocking hop; CAPACITY_BLOCKED + blocker id |
| G7 | Sticky SAT | resolve×2 identical route/consist; second sticky_hit |
| G8 | Negative UNSAT | fail; resolve again no hopeful change → negative_cache_hit, expansions=0 |
| G9 | Hopeful release | after release blocker, resolve may SAT |
| G10 | Determinism | shuffle car iteration order in fixture → still same bind order via sort by id |
| G11 | Duplicate yard in consist | route lists same yard_id twice when re-entered |
| G12 | First leg no fabric | leg0 binds car, route empty or car-only hop |

### Toy topology (minimal)

- Cars: R-17, R-22, N-04, N-08, N-12, D-02, D-11  
- Stations: Y1/Y2 = **transparent** Switch StationTypes; N-*/R-*/D-* = non-transparent  
- Y1 restricted legalPairs (`1→1`, `1→2`, `1→3`, `5→6`; **not** `1→6`); Y2 (`1→5`, `1→6`); Y2 inspect may write `clearance.y2_stamp` into Task.context  
- Links: Y1:1→N-04, Y1:2→Y2:1, Y1:3→N-08, Y1:6→N-12, Y2:5→N-04, Y2:6→Y1:5, N-04→D-02, N-12→D-11  
- **G5:** stamp gate is on **Normal (N-04)**, not Docking — short Y1→N-04 fails inspect; via Y2 stamp then N-04 OK  
- loopback: if Y2→N-04 closed → re-entry → N-12  
- See walkthroughs `?scenario=multiyard` and `?scenario=loopback`  

---

## 14. Phased delivery

| Phase | Deliverable | Exit criteria |
|-------|-------------|---------------|
| **P0** | Port graph + Yard maps + Coupler only (fixed tail → fixed car) | G1, G2 |
| **P1** | Assembler multi-leg + Inspector + checkpoint + first-fit | G3, G4, G10, G12 |
| **P2** | Path-acquired Context + yard publish_on_hop | G5, G11 |
| **P3** | Reservations + CAPACITY_BLOCKED | G6 |
| **P4** | Sticky SAT + negative UNSAT | G7, G8, G9 |
| **P5** | Oracle distances + A* + metrics | p99 under budget on toy×N |
| **P6** | Optional backtrack_depth=1, beam | only if G-fail rate needs it |

---

## 15. Threats & edge cases

| Case | Behavior DECIDED v1 |
|------|---------------------|
| Empty pool for Class | `NO_CANDIDATES` |
| All cars busy | `ALL_BUSY` if accept would pass else NO_CANDIDATES |
| Disconnected fabric | `UNREACHABLE` |
| Checkpoint dead-end | `CONTEXT_DEAD_END` / NO_CANDIDATES; list checkpoints |
| force retry loop | allowed; metrics only; no auto force |
| Policy H too small | `BUDGET` or `UNREACHABLE`; suggestion raise H |
| Legs edited | invalidate snapshot + unsat cache |
| Yard offline mid-route sticky | snapshot invalid → full resolve |

---

## 16. Migration / glossary bridge (optional)

Only if integrating legacy systems. Keep rail terms in code. Optional map:

| Legacy | Rail |
|--------|------|
| Resource type | Class |
| Asset | Car |
| String | Booking |
| Switch | Yard |

Do **not** use legacy names in new modules.

---

## 17. Reference resolve complexity (v1 target)

On toy topology: resolve &lt; 50ms.  
On ~5k cars / ~500 yards: sticky &lt; 5ms; cold resolve aim &lt; 500ms with caps; never unbounded.

---

## 18. Open items that still need a human (summary)

These have **DEFAULTS** above so build can start; confirm before production:

1. **Combine/share** on aggregator ports (v1 exclusive).  
2. **Backtrack depth** (v1 zero).  
3. **Whether first leg ever needs fabric** (v1 no).  
4. **Exact Fact key conventions** for production Classes.  
5. **Hard vs soft claims** during planning (v1 hard on SAT only; resolve txn holds locks until commit/abort).  
6. **Language/runtime** — **DEFAULT / preferred: Kotlin (JVM)** if that matches the rest of the platform (see §18.1).

### 18.1 Implementation language

| Option | When it wins | When it loses |
|--------|----------------|---------------|
| **Kotlin (JVM)** | Same as other microservices; shared auth/observability/DB; team fluency; Inspector plugins as classes; Coroutines for async API | Micro-optimizing hottest A* inner loop in a systems language |
| **Rust / C++** | Extreme coupler p99 at huge mesh scale | Split stack, FFI, slower product iteration, two deploy cultures |
| **Go** | Simple deploy, fine graph search | You already standardized on Kotlin services |
| **Python** | Prototyping only | Cold-path resolve latency + typing discipline for this engine |

**Recommendation: stick with Kotlin** for v1–v2 of this service.

Reasons: algorithm fit (int graph search), platform fit, Inspectors as interfaces, correctness/sticky first, escape hatch to native Coupler only if profiler demands it.

Service shape: normal microservice with REST/gRPC per §9. Tests: JUnit 5 + toy topology G1–G12.  
`resolve` = **synchronous** domain call inside a DB/txn boundary; suspend only at the HTTP edge if the rest of the platform does.

### 18.2 Kotlin / JVM performance (Coupler hot path)

Performance will be dominated by **algorithm + data layout**, not by “Kotlin vs Java.” Still, the expand loop can allocate heavily if written naively. Goals: **low allocation per expansion**, **predictable GC**, **cache-friendly adjacency**, **cheap closed-set checks**.

#### 18.2.1 Identity model (biggest win)

| Layer | Representation |
|-------|----------------|
| API / DB | String ids (`car_…`, `yard_…`) |
| Coupler / fabric | Dense **`Int` port ids** `0 .. P-1` |

- Build a `PortIndex` once when topology loads: `stringKey → Int`, reverse array for debug.  
- **Never** hash `String` in the expand loop.  
- Hop key: pack into a `Long` when possible, e.g.  
  `(deviceId.toLong() shl 32) or (inTrack.toLong() shl 16) or outTrack`  
  or two ints + open addressing — avoid `data class HopKey` as HashMap keys on the hot path if profiles show pressure.

#### 18.2.2 Graph storage (CSR)

```text
// Compressed sparse row adjacency (read-only after topology build)
offsets: IntArray   // size P+1
targets: IntArray   // neighbor port ids
// optional parallel arrays:
edgeKind: ByteArray // cable vs internal
edgeMeta: IntArray  // cable id / yard id for occupancy checks
```

- Rebuild CSR on topology change only.  
- Occupancy: `BooleanArray` / `LongArray` bitset indexed by edge id or hop_key id — not `MutableSet<String>`.  
- Prefer **structure of arrays** over array of heap objects for neighbors.

#### 18.2.3 Kotlin features to use carefully

| Feature | Hot path Coupler | Assembler / API |
|---------|------------------|-----------------|
| **`inline value class` PortId(val v: Int)** | Yes — zero-cost wrapper, type safety | Yes |
| **`data class` state nodes** | **Avoid** allocating per expansion | Fine for results |
| **`copy()` on data classes** | Avoid in loop | Fine |
| **Sequences / `map`/`filter` chains** | **Avoid** on expand (allocates iterators) | Fine for candidate prep |
| **lambdas capturing** | Avoid per-edge if they allocate | Fine |
| **`for (i in 0 until n)` + arrays** | Prefer | — |
| **`when` / sealed interfaces** | Fine for Inspectors (virtual call once per goal) | Prefer for SPI |
| **Coroutines** | **Not inside expand**; one resolve = blocking CPU work | Edge adapters |
| **`lazy` / delegates** | Not in hot state | Config ok |
| **`==` on data classes** | Structural — fine for cold code; hot closed-set use **int identity** | — |
| **Reference equality `===`** | Use only when you intentionally intern objects | Rarely needed if using Int ids |

**Value classes:** great for `PortId`, `EdgeId` at API of Coupler.  
**Do not** put boxed `PortId?` in arrays (boxing). Use raw `IntArray` internally; wrap at boundaries.

#### 18.2.4 Search state without GC thrash

Naive: each open-set entry = new `Node(port, g, parent, contextMap)`.

Better patterns:

1. **Object pool / slab** of search nodes reused across resolves (thread-local or per-resolve arena).  
2. **Parent as `Int` index** into a slab, not a pointer to another heap node.  
3. **Path reconstruction** only on success (walk parent indices once).  
4. **Context:**  
   - If sparse keys: small fixed schema → pack into `Long` / `Int` bitset (e.g. bit per known stamp).  
   - If maps required: **persistent/shared structure** or copy-on-write only when a hop publishes — not a new `HashMap` every edge.  
   - Closed set key = `(portId, contextFingerprint)` — fingerprint must be cheap (`Long` xor of stamps).  
5. **Closed set:** `LongOpenHashMap` / Eclipse Collections / fastutil **primitive** maps, or two-level: `BooleanArray` if context is empty, else open-addressed long set. Avoid `HashSet<Pair<Int, Map<…>>>`.  
6. **Open set:** binary heap of **ints** (node indices) + parallel `g[]`/`f[]` arrays; or specialized int-heap. Java `PriorityQueue` of objects works for v1 but allocates.

**DEFAULT v1 pragmatic:**  
- Port = `Int`  
- Closed = `LongSet` of packed `(port, contextBits)` or just `port` if context empty for that topology  
- Open = `PriorityQueue` of a **recycled** node type **or** int-heap  
- Profile before writing a custom allocator

#### 18.2.5 Memory & GC

| Do | Don’t |
|----|--------|
| Reuse Coupler buffers per thread (`ThreadLocal` arena cleared each resolve) | Allocate neighbor lists every expand |
| Topology immutable + shared read-only CSR | Mutate graph under concurrent resolves without copy-on-write |
| Sticky path: store `IntArray` of port ids / hop keys | Store full object graphs in snapshot |
| Bound expansions (already required) | Unbounded search that fills heap |
| `-XX:+UseG1GC` or ZGC for low-latency services (ops standard) | Rely on GC to clean millions of tiny nodes per request |

**Resolve allocation budget (aspirational):** sticky hit ≈ zero Coupler alloc; cold resolve p99 allocations dominated by result objects + DB, not by O(expansions) node objects.

#### 18.2.6 Concurrency

- **One resolve = single-threaded Coupler** (simplest + deterministic).  
- Parallelism across **different Bookings** (thread pool), not inside expand.  
- Shared topology: immutable after publish; occupancy: use txn / striped locks / versioned bitsets — don’t contend per edge with fine locks in the expand loop.  
- `prefilter` may use parallel streams only if candidate lists are huge **and** Inspectors are pure — usually not worth it at hundreds of cars.

#### 18.2.7 JVM / runtime knobs (ops, not code)

- Prefer **GraalVM native** only if cold-start matters; graph search often fine on HotSpot after warmup.  
- **C2 warmup:** first resolves may be slower; warm with toy goldens on deploy if p99 SLAs are tight.  
- Escape analysis helps stack-allocate short-lived objects — still better not to create them.  
- Avoid megamorphic call sites in expand (`edgeKind` as sealed hierarchy with many impls); prefer data-driven CSR + `when (kind)` on a byte.

#### 18.2.8 Algorithm > micro-opts (priority order)

1. Sticky SAT + negative UNSAT (skip search)  
2. prefilter shrinks goals  
3. Multi-sink one search (not per-Car A*)  
4. Hard H / V / expansion / wall caps  
5. hop_key anti-loop  
6. Oracle distances for A*  
7. Yard-hop cost bias (prefer short Class corridors)  
8. Then: int CSR, primitive closed set, node pooling  

#### 18.2.9 Profiling checklist

Before rewriting in Rust:

- JMH microbench: expand 100k neighbors on CSR vs object graph  
- Async-profiler / JFR: % time in alloc, HashMap, Inspector, GC  
- Count: allocations per resolve, expansions p99, sticky hit rate  
- If Inspector dominates: cache prefilter results per `(carId, contextFingerprint)` for the resolve  
- If GC dominates: node pool + primitive closed set  
- If topology walk dominates: better oracle / tighter H  

#### 18.2.10 Sketch (shape, not production code)

```kotlin
@JvmInline value class PortId(val v: Int)

class PortGraph(
  val portCount: Int,
  val offsets: IntArray,      // CSR
  val neighbors: IntArray,
  // hopKey id or edge id for occupancy
) {
  inline fun forEachNeighbor(p: PortId, action: (PortId, edgeIdx: Int) -> Unit) {
    val i = p.v
    var e = offsets[i]
    val end = offsets[i + 1]
    while (e < end) {
      action(PortId(neighbors[e]), e)
      e++
    }
  }
}

// Per-resolve arena (thread-local)
class CouplerArena(maxNodes: Int) {
  val parent = IntArray(maxNodes) { -1 }
  val gScore = IntArray(maxNodes) { Int.MAX_VALUE }
  val portOf = IntArray(maxNodes)
  val ctxOf = LongArray(maxNodes)   // packed path context
  var size = 0
  fun clear() { size = 0 /* optionally fill gScore only as used */ }
}
```

Inspectors stay **objects** (polymorphic per Class) — called rarely (goals), not per edge.

### 18.3 Kafka microservice boundary (implement later)

**Not required for G1–G12.** Production shape:

```text
Kafka IN  →  projection + “does this require reschedule?”  →  domain resolve
domain plan  →  Kafka OUT (claims, setups, booking status)
```

| In (examples) | Out (examples) |
|---------------|----------------|
| Class/Car/Setup/catalog changes | **Claims** on Cars + hop/track resources |
| Cable / Yard / map changes | **Setups** to arm on Cars (and Yards if any) |
| Booking create/update/cancel | Booking plan (sat/unsat, consist, route summary) |

**Reschedule:** use same rev/hopeful rules as sticky & negative cache (SPEC §10.1). Prefer sticky revalidate before full resolve. Emit outputs only when plan changes.

**Package rule:** `kafka/` adapters only; **zero** Kafka types inside `coupler` / `assembler` / `inspectors`.

---

## 19. Minimal module map (suggested)

```text
// Kotlin packages (example)
catalog/     Class, Setup, Car, Yard, Cable, YardType
inspectors/  per-Class Inspector implementations + registry
fabric/      port graph build, oracle
coupler/     multi-sink search
assembler/   resolve loop
reserve/     reservations + txn
cache/       sticky + negative
api/         optional HTTP facade for debug / admin
fixtures/    toy topology + golden tests
kafka/       // later: inbound projection + outbound claims/setups/plans
```

---

## 20. Definition of done (v1 core)

- [ ] All **DECIDED** behaviors implemented  
- [ ] Golden tests G1–G12 green  
- [ ] Resolve API returns SAT/UNSAT with FailureReport  
- [ ] Sticky + negative cache behavior matches §10  
- [ ] Route includes Yards; re-entry allowed; hop_key anti-loop  
- [ ] Context from Car bind + Yard publish_on_hop  
- [ ] No UI required  

When this checklist is green, the design docs + this spec are sufficient for another session to extend Classes/Inspectors without redesigning the engine.
