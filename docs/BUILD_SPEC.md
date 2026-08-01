# Consist — Build Spec (v1)

**Project:** **Consist** (Kotlin package / service: `consist`).  
**Audience:** implementers / another LLM session.  
**Goal:** enough concrete decisions, schemas, algorithms, and tests to build a working core **without** inventing product policy.

**Read first for full picture / rationale / open questions:** [SPEC.md](./SPEC.md) (handoff).  
**Companion:** [booking-assembler-design.html](./booking-assembler-design.html) (interactive walkthroughs).  
**Vocabulary:** rail only — Class, Car, Setup, Inspector, Booking, Leg, Consist, Context, Yard, Track/port, Hop, Route, Cable, Assembler, Coupler, Oracle, Checkpoint.

---

## 0. How to use this doc

| Status tag | Meaning |
|------------|---------|
| **DECIDED v1** | Implement exactly this unless product overrides |
| **DEFAULT v1** | Recommended; safe to ship; note if you change it |
| **OPEN** | Needs product input; do not invent beyond listed options |

When something is **OPEN**, the **DEFAULT** is still specified so build can proceed.

---

## 1. Product thesis (non-negotiable)

1. A **Booking** is an ordered list of **Legs** `(Class, request/Setup fields)`.
2. Resolve **grows a Consist**: each successful leg binds a **Car** and extends a **Route** of hops through **Yards** (and other devices).
3. **Context** accumulates facts from (a) bound Cars and (b) **path visits** that publish facts (e.g. Yard stamps). Later **Inspectors** consume Context.
4. **Outer = Assembler** (which Cars, Context, checkpoints, sticky/fail). **Inner = Coupler** (bounded multi-sink path on **ports**).
5. Sub-optimal is OK. Deterministic + sticky preferred (re-Setup is expensive).
6. Failures explain at the **first pipeline stage** that emptied options; checkpoints scope later failures.
7. v1 is a **library/service core**, not a UI.  
8. **Production IO** is Kafka (world/demand in → plans/claims/setups out); **engine goldens do not require Kafka**. See SPEC §10.1.

---

## 2. Non-goals (v1)

**DECIDED v1 — do not build (in the engine slice):**

- Global optimal multi-Booking packing / MILP / CP-SAT as primary solver  
- Full UI  
- Parallel “assign all legs then join”  
- Device-level graph without ports  
- “Never visit same Yard twice” as a hard rule  
- Re-solving every poll when nothing hopeful changed  
- Perfect dependency-based cache invalidation (use hopeful-token set first)  
- **Kafka producers/consumers, topic schema registry wiring** (adapters after domain works; SPEC §10.1)  
- **Force-priority preemption** (kick lower Bookings) — design only in SPEC §12 Q16; v1 resolve uses free resources only

### 2.1 Booking priority (data only in v1)

```text
Booking {
  ...
  priority: int    // higher = more important; DEFAULT 0
}
```

| Resolve mode | v1 behavior |
|--------------|-------------|
| Normal | Only free resources; `CAPACITY_BLOCKED` if none |
| `forcePriority: true` | **Not implemented** — return clear error or ignore with warning until Q16 decided |

Do **not** silently overwrite another Booking’s claims in v1.

Full design strawman (eviction, cascade, audit): **SPEC.md §12 Q16**.

---

## 3. Canonical data model

### 3.1 Identifiers

**DECIDED v1:** opaque string ids (`car_…`, `yard_…`, `booking_…`). Stable sort = lexicographic id ascending unless sticky id overrides.

### 3.2 Entities

#### Class

```text
Class {
  id: string
  name: string
  allowed_setup_ids: string[]
  checkpoint: bool              // class-once after successful bind
  inspector_id: string          // registry key → Inspector implementation
  max_concurrent_bookings_per_car: int | null  // null = unlimited; DEFAULT 1 for endpoint-like classes
}
```

#### Setup

```text
Setup {
  id: string
  class_id: string
  name: string                  // e.g. "4N-cabinets"
  // optional static metadata for UI; fitness is Inspector’s job
}
```

#### Car

```text
Car {
  id: string
  class_id: string
  setup_id: string | null       // current armed Setup
  online: bool
  ports: Port[]                 // in/out tracks this Car exposes
  config: object                // live config blob; Inspector-defined schema per Class
  claims: int                   // how many active Bookings hold it (if multi allowed)
}
```

#### YardType (template)

```text
YardType {
  id: string
  kind: "direct" | "aggregator" | "expander" | "restricted" | "full"
  // Legal internal transitions: list of (in_track, out_track)
  // For direct: only (k,k) for each track k
  // For aggregator: (i, "Ag") for each i; Ag is out track id
  // For expander: ("Ag", j) for each j
  // For restricted/full: explicit pairs
  legal_pairs: { in: TrackId, out: TrackId }[]
  // Optional: facts published when a hop uses this yard (type-level defaults)
  publish_on_visit: FactPatch[]   // see Fact schema; often empty at type level
}
```

#### Yard (instance)

```text
Yard {
  id: string
  yard_type_id: string
  online: bool
  // optional instance override of legal_pairs
  legal_pairs_override: { in: TrackId, out: TrackId }[] | null
  setup_id: string | null       // if Yard can be reconfigured
  ports: Port[]                 // derived from tracks in maps
  // instance-level fact publishers (e.g. this yard grants y2_stamp)
  publish_on_hop: FactPatch[]   // applied when hop through this yard commits or when path visits (see §8)
}
```

#### Port

```text
Port {
  device_id: string             // Car id or Yard id
  device_kind: "car" | "yard"
  side: "in" | "out"
  track_id: string              // "1", "5", "Ag", …
}
```

#### Cable

```text
Cable {
  id: string
  from: { device_id, track_id } // out track
  to:   { device_id, track_id } // in track
  online: bool
}
```

#### Hop (route element)

```text
Hop {
  device_id: string
  device_kind: "car" | "yard"
  in_track: string
  out_track: string
  // hop_key = (device_id, in_track, out_track) unique on a path under anti-loop
}
```

#### Booking

```text
Booking {
  id: string
  legs: Leg[]
  priority: int                 // higher wins if force-preemption is ever enabled (SPEC Q16); ignored for placement in v1
  status: "pending" | "sat" | "unsat"
  consist: ConsistSlot[]        // bound Class Cars in leg order
  route: Hop[]                  // full path including Yards (may visit same Yard twice)
  context_final: Context        // facts at end of successful resolve
  snapshot: ResolveSnapshot | null
  failure: FailureReport | null
  created_at, updated_at
}

Leg {
  index: int                    // 0..n-1
  class_id: string
  setup_id: string | null       // requested Setup if applicable
  request: object               // Class-specific fields for Inspector
}

ConsistSlot {
  leg_index: int
  car_id: string
  setup_id: string | null
  facts_published: Context      // delta at bind
}
```

#### Reservation (live claims)

```text
Reservation {
  booking_id: string
  // exclusive resources held while Booking is SAT (or soft-hold during resolve txn)
  car_ids: string[]
  hop_keys: { device_id, in_track, out_track }[]
  cable_ids: string[]           // optional if cables are exclusive
}
```

#### ResolveSnapshot (sticky SAT)

```text
ResolveSnapshot {
  legs_hash: string
  consist: ConsistSlot[]
  route: Hop[]
  context: Context
  world_token: string           // see cache §10
}
```

### 3.3 Invariants

**DECIDED v1:**

1. Every Hop’s `(in_track→out_track)` is legal for that device (YardType map or Car pass-through).  
2. Consecutive hops are joined by a Cable (out of prev → in of next) **or** are sequential visits on the path with an explicit cable between devices.  
3. Route may contain the same `device_id` more than once if `hop_key` differs.  
4. No duplicate `hop_key` on a single Booking route (anti-loop).  
5. Checkpointed Class: at most one ConsistSlot for that `class_id` per Booking.  
6. Context is a flat string→JSON-primitive (or nested object) map; merges are shallow key overwrite unless Inspector defines namespaced keys (`class.fact`).

---

## 4. Fact / Context schema

### 4.1 Context

```text
Context = Record<string, JsonValue>
```

**DEFAULT v1** namespacing:

- From Car bind: `{class_id}.{fact_name}` e.g. `refrigerated.cabinets = 4`  
- From Yard visit: `yard.{yard_id}.{fact}` or stable capability keys e.g. `clearance.y2_stamp = true`

### 4.2 FactPatch (publisher)

```text
FactPatch {
  key: string
  value: JsonValue
  // when applied:
  //  - on_car_bind: after Inspector accept + Coupler success + bind
  //  - on_yard_hop: when Coupler commits a hop through that Yard (path-acquired context)
}
```

### 4.3 Who publishes

| Source | When | DECIDED v1 |
|--------|------|------------|
| Inspector / Car | On successful bind of Car | Yes — `publish_facts(car, request, context) → FactPatch[]` |
| Yard instance | On hop through Yard in Coupler path | Yes if `publish_on_hop` non-empty |
| Setup catalog alone | Never (data only) | Inspector decides meaning of Setup |

**OPEN (DEFAULT v1):** Path-acquired facts apply when the hop is **accepted into the candidate path** during Coupler search (so mid-search Context can unlock goals), not only at final commit. Implement Coupler state as `(port, context_fingerprint)` or apply patches when expanding a yard hop edge.

### 4.4 Discovering path Context (why try Class N before Y2?)

Inspectors **must not** hard-code fabric devices (“go to Yard 2”). They only say accept/reject under Context (e.g. missing `y2_stamp`).

| Question | Answer |
|----------|--------|
| Why try short path to Class N first? | **Search heuristic**, not knowledge of Y2: prefer fewer Yard hops / earlier arrival at Class goal ports (lower edge cost toward goals). When stamp is already in Context, short path wins quickly. |
| Does Inspector tell us to use Y2? | **No.** It only fails without stamp. It has no idea Y2 exists. |
| How does the algorithm find Y2 then? | **Continued multi-sink search** with state `(port, context)`. Arriving at N without stamp = **not a successful goal** (do not bind). Keep expanding other edges; Y2’s `publish_on_hop` adds stamp; later arrival at N succeeds. |
| Is “prefer next Class over extra Yards” safe? | **Yes as a cost bias** if search is complete (or budgeted but still explores alternatives after goal-reject). **Unsafe** if first-fit means “first time we touch any N port, bind” without Inspector+path Context. |

**DECIDED v1:** Goal acceptance = reached candidate port **and** `inspector.accept(..., path_context) == ok`. Goal-reject ≠ search failure; only open-set exhaustion / budget is failure.

**DEFAULT cost bias:** small positive cost per Yard hop (or per extra Yard device on path) so simple corridors are tried first; not a hard “never enter Y2 before all N attempts.”

---

## 5. Inspector contract

### 5.1 Interface

**DECIDED v1:** two stages — cheap Assembler screen vs full check at Coupler goal.

```text
Inspector {
  class_id: string

  // --- Assembler (before Coupler) ---
  // Cheap, path-independent (or uses only Context already known).
  // MUST NOT reject a Car that could succeed after path-acquired facts.
  // Safe rejects: wrong Class, offline, can never do Setup, hard config mismatch,
  //                missing facts that only come from *earlier binds* (already in Context),
  //                not "missing stamp that a Yard might still publish on the way".
  prefilter(request, car, context)
    → { ok: true }
    | { ok: false, code: string, message: string }

  // Optional ranking among cars that passed prefilter
  rank_cost(request, car, context) → number   // DEFAULT: 0 if setup already matches, else 100

  // --- Coupler (on arrival at Car port, with path Context) ---
  // Real inspection: request + car live config + Context including path stamps.
  accept(request, car, context)
    → { ok: true }
    | { ok: false, code: string, message: string }

  publish_facts(request, car, context) → FactPatch[]   // after successful bind

  // Optional: keys still missing that path hops might supply (docs/ Coupler state)
  required_path_facts(request, context) → string[]
}
```

| Stage | When | Context available | Use |
|-------|------|-------------------|-----|
| **prefilter** | Assembler, before `couple()` | Prior legs only (no path stamps yet) | Drop cars that **cannot** work; shrink multi-sink goals |
| **accept** | Coupler, at goal port | Prior + **path-acquired** facts | Real gate to bind |

**Wrong:** call full `accept` at Assembler and drop N-12 because stamp missing — stamp might arrive via Y2.  
**Right:** `prefilter` only uses irreversible/static checks; stamp checked in `accept` at goal (or prefilter if stamp already in Context from an *earlier* leg).

#### Example: Class Normal — seats vs track routing

**Leg request:** Class Normal, must support **more than 5 seats**.  
Full inspection also cares whether the Car can actually **run the arrival path** (e.g. enter on track 1, leave toward next segment on track 2).

```text
// Assembler — cheap, no fabric
prefilter(request={ min_seats: 6 }, car, context):
  if car.offline: return reject("OFFLINE")
  if car.max_seats < request.min_seats:   // e.g. N-08 has only 4 seats
    return reject("SEATS")                 // safe: no path will add seats
  if car cannot ever arm Setup for this request:
    return reject("SETUP")
  return ok   // keep as Coupler goal even if path stamps / track routing unknown

// Coupler — on arrival at this Car with concrete path
accept(request, car, context, arrival):  // arrival = in_track used, planned out, path hops
  // still enforce seats (belt and suspenders)
  if car.max_seats < request.min_seats: return reject("SEATS")
  // thorough: can this Car internal routing support the path we took / need next?
  if not car.can_route(in_track=arrival.in, out_track=arrival.desired_out):
    return reject("TRACK_ROUTE")           // e.g. cannot run track 1 → track 2
  if missing path Context keys (stamps): return reject("CONTEXT")
  // … other deep checks (band, firmware mode, isolation, …)
  return ok
```

| Car | max_seats | prefilter | Later in Coupler |
|-----|-----------|-----------|------------------|
| N-04 | 8 | **pass** → A* goal | `accept`: check 1→2 routing, stamps, … |
| N-08 | 4 | **fail SEATS** — never a goal | never searched |
| N-12 | 12 | **pass** → A* goal | may fail `TRACK_ROUTE` if path enters a track it can’t bridge |

Assembler never asks “can I run track 1→2?” — that depends on **which cable/hop** Coupler used to arrive. Prefilter only asks “is this Car even capable of >5 seats?”

### 5.2 Assembler usage

```text
for car in pool(class_id) if online and not checkpoint-closed:
  r = inspector.prefilter(leg.request, car, context)   // cheap mini-inspector
  if r.ok: candidates.append(car)
// candidates become Coupler multi-sink goals
// full accept() runs inside Coupler when a path reaches the car
```

If `required_path_facts` are missing from Assembler Context, **still keep** the car as a goal if `prefilter` passed — Coupler may acquire facts en route.

### 5.3 Per-Class guide (how to add a Class)

Document for each Class (template):

1. `request` JSON schema  
2. `accept` rules (table of reject codes)  
3. `publish_facts` keys  
4. `required_path_facts` if any  
5. Checkpoint default  
6. Unit tests: accept/reject fixtures  

**v1 toy classes for golden tests** (implement these three):

| Class | request | accept highlights | publish | path facts |
|-------|---------|-------------------|---------|------------|
| Refrigerated | `{ setup: "4N", band?: string }` | prefilter: can do 4N/band; accept: same | `refrigerated.cabinets=4` | none |
| Normal | `{ setup: "2-seats" }` | prefilter: can do 2-seats + prior `cabinets` if required; **not** path stamps; accept: + any path facts | `normal.seats=2` | optional stamp in multi-yard toy |
| Docking | `{ setup: "1-connector" }` | prefilter: can dock; accept: `clearance.y2_stamp` if required by topology | `docking.connector=1` | `clearance.y2_stamp` |

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
    max_visits_per_yard: 3        // V
    max_expansions: 50_000
    max_wall_ms: 500
    forbid_repeat_hop_key: true
    forbid_immediate_cable_backtrack: true  // DEFAULT
    search: "bfs" | "astar"       // DEFAULT "astar" if oracle distances exist else "bfs"
  }
  assembler: {
    mode: "first_fit"             // DECIDED v1
    backtrack_depth: 0            // DEFAULT v1: no backtrack; fail at leg
    sticky_prefer: true
    piggyback_setup_bonus: true   // rank cars already on requested setup first
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
| Leg 1 entry | **Virtual source** connected to all free in-ports of candidate Cars of leg 0 **or** bind first Car with empty route if no prior tail | DECIDED: if no tail, pick ranked Car via Inspector only; route starts empty; first Coupler is leg 0→1 |
| UNSAT invalidation | **Hopeful token set** (not full global fingerprint for claims) | See §10 |
| Path Context model | **Coupler state includes Context**; yard `publish_on_hop` patches on expand | Waypoints optional optimization |
| Which Yards publish | **Instance `publish_on_hop` list**; empty by default | Toy Y2 publishes stamp |

---

## 8. Algorithms (implement exactly)

### 8.0 Assembler ↔ Coupler contract (read this first)

| | **Assembler** | **Coupler (A\*/BFS)** |
|--|---------------|------------------------|
| **Job** | Run the Booking: ordered Class legs, grow consist, Context, checkpoints, sticky/fail | Find **one successful fabric path** from current tail to **some** next-Class candidate Car |
| **Calls** | Once per Class→Class **segment** (after first Car is bound) | Internal expansions only — **not** one return per failed path try |
| **Success** | Bind returned Car, append **full** hop list, update Context | Early return: `{ car, hops[], context }` when goal port + Inspector OK |
| **Failure** | Booking UNSAT at this leg | Exhaust open set / budget → fail code (no path acceptable) |
| **Yards** | Does not navigate Yards | Yards are middle nodes on the port graph (0..many types/hops between two Classes) |
| **Does not** | Expand every track | Decide leg order, checkpoints, sticky snapshot |

```text
// Control flow (not per-path Assembler round trips)
for leg in legs:
  if first leg: bind Car via Inspector only
  else:
    result = Coupler.couple(tail → candidate Cars of this Class)
    // Coupler may try short path, fail Inspector, try other paths, visit Y2, …
    // Assembler is blocked until Coupler returns ONCE
    if result.fail: return UNSAT
    bind result.car; route += result.hops; context = result.context; tail = result.car
```

**Wrong mental model:** Coupler returns `R→Y1→N4` to Assembler, Inspector fails, Assembler starts a **new** A\* for `R→Y2→N4`.  
**Right mental model:** That entire try/fail/continue sequence is **inside one** `couple()` call.

**Long Yard chains:** Booking legs `ClassA → ClassZ` with only Yards between ⇒ still **one** Coupler call; path may be `A → Y₁ → … → Y₁₂ → Z`. Twelve yard *types* are edge rules, not twelve Assembler steps.

### 8.1 Resolve (Assembler)

```text
function resolve(booking_id, opts={force:false}):
  booking = load(booking_id)
  policy = load_policy()

  if !opts.force and booking.snapshot and snapshot_valid(booking.snapshot):
    return SAT from snapshot

  if !opts.force and booking.failure and unsat_still_valid(booking.failure):
    return UNSAT from cache

  context = {}
  route = []
  consist = []
  closed_classes = {}
  tail = null  // Port | null

  for leg in booking.legs:
    inspector = registry(leg.class_id)
    pool = cars where class_id and online and (class not in closed_classes)
    candidates = []
    for car in pool:
      // If required path facts missing, still allow as geometric goals only if
      // Coupler can acquire facts en route; accept() rechecked at goal with path context.
      candidates.append(car)

    // Soft filter: cars that can never accept even with all path facts → drop
    candidates = [c for c in candidates if maybe_accept(inspector, leg, c, context)]

    candidates.sort by (
      sticky car first if matches last snapshot,
      inspector.rank_cost,
      car.id ascending
    )

    if candidates empty after pure Inspector with current context
       and required_path_facts already satisfied or none:
      return fail(NO_CANDIDATES | CONTEXT_DEAD_END, leg, consist, context)

    if tail is null:
      // first leg: bind without fabric (DEFAULT)
      car = first candidate that inspector.accept(leg.request, car, context).ok
      if none: return fail(NO_CANDIDATES, …)
      bind(car); publish facts; checkpoint; consist.append; tail = choose_tail_port(car)
      continue

    path, car, context_after = Coupler.couple(
      tail, candidates, context, inspector, leg, policy.coupler
    )
    if path is null:
      return fail(code from coupler, leg, consist, context)

    // reserve hops+car in txn
    route.append_all(path)
    consist.append(car)
    context = context_after
    merge inspector.publish_facts(...)
    if class.checkpoint: closed_classes.add(class_id)
    tail = choose_tail_port(car)

  commit reservations
  snapshot = { legs_hash, consist, route, context, world_token }
  return SAT
```

`maybe_accept`: **DEFAULT** — run `accept` with context; if fail only due to missing keys in `required_path_facts`, keep candidate; if fail for other reasons, drop.

### 8.2 Coupler (multi-sink, context-aware)

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

**Oracle (optional v1 phase 2):** precompute hop distances ignoring occupancy and context; use as `h`. Optimistic reachability may ignore context (false positives OK).

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
  consist?: ConsistSlot[],
  route?: Hop[],
  context?: Context,
  failure?: FailureReport,
  metrics?: { expansions, ms, candidates_per_leg: number[] }
}
```

### 9.3 FailureReport

```text
{
  failed_leg: int,
  code: "NO_CANDIDATES" | "INSPECTOR_REJECT" | "ALL_BUSY" | "UNREACHABLE"
       | "CAPACITY_BLOCKED" | "BUDGET" | "CONTEXT_DEAD_END" | "POLICY",
  summary: string,
  checkpoints: { leg, class_id, car_id }[],
  counts: object,
  blockers: { booking_id?, hop?, yard_id?, detail? }[],
  suggestions: string[],
  hopeful_token: string,     // for negative cache
  inspector_samples?: { car_id, code, message }[]
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
5. No preemption in v1.

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
| G5 | Context yard loop | Short Y1→D fails Inspector; path via Y2 stamp then D succeeds |
| G6 | Capacity blocked | Reserve blocking hop; CAPACITY_BLOCKED + blocker id |
| G7 | Sticky SAT | resolve×2 identical route/consist; second sticky_hit |
| G8 | Negative UNSAT | fail; resolve again no hopeful change → negative_cache_hit, expansions=0 |
| G9 | Hopeful release | after release blocker, resolve may SAT |
| G10 | Determinism | shuffle car iteration order in fixture → still same bind order via sort by id |
| G11 | Duplicate yard in consist | route lists same yard_id twice when re-entered |
| G12 | First leg no fabric | leg0 binds car, route empty or car-only hop |

### Toy topology (minimal)

- Cars: R-17, R-22, N-04, N-08, N-12, D-02, D-11  
- Yards: Y1 restricted (`1→1`, `1→2`, `1→3`, `5→6` legal; **not** `1→6`), Y2 (`1→5`, `1→6`; `publish_on_hop: clearance.y2_stamp`)  
- Cables (no out multiplex): Y1:1→N-04, Y1:2→Y2:1, Y1:3→N-08, Y1:6→N-12, Y2:5→N-04, Y2:6→Y1:5, N-04→D-02, N-12→D-11  
- G5 / loopback: short Y1→N fails stamp; if Y2→N-04 free → bind N-04; if closed → loopback re-entry → N-12  
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
