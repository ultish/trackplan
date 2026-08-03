# Trackplan — Build Spec (v1)

**Project:** **Trackplan** (Kotlin package / service: `trackplan`).  
**Audience:** implementers / another LLM session.  
**Goal:** enough concrete decisions, schemas, algorithms, and tests to build a working core **without** inventing product policy.

**Read first for full picture / rationale / open questions:** [SPEC.md](./SPEC.md) (handoff).  
**Companion:** [booking-assembler-design.html](./booking-assembler-design.html) (interactive walkthroughs; vocabulary pass later).  
**Vocabulary (body text still mostly rail until bulk rename):** StationType, Station, TrackDef, Link, Setup, Tasking, Task, Request, Inspector, Booking, Leg, Route, Hop, Assembler, Coupler.  
**Product / package name:** still **Trackplan** / `trackplan` until decided otherwise.

### Network vocabulary (DECIDED — frozen; bulk body rename pending)

Apply this map on the next terminology pass. **Body of this doc may still use left-column names** until rewritten; new writing and code should prefer the right column.

| Current (rail / doc body) | Network name (target) | Notes |
|---------------------------|----------------------|--------|
| StationType | **ResourceType** | Catalog type + SPI |
| Station | **Asset** | Instance |
| TrackDef | **IoPort** | Type-owned in/out port kind |
| Link | **Dataflow** | Asset OUT IoPort → peer IN IoPort |
| Booking | **Strategy** | Demand + plan |
| Leg | **Step** | Ordered demand: ResourceType + TaskingConfiguration |
| Request | **TaskingConfiguration** | Same type on Strategy step and on Task (Strategy demand stored on Task) |
| Route | **Path** | Full ordered hop list after resolve |
| Hop | **Hop** | One asset visit: in/out IoPort (nulls OK entry/terminal) |
| Binding | **AllocatedAsset** | Strategy uses this Asset (leg or path) |
| Task | **Task** | Unchanged |
| Tasking | **Tasking** | `Task[]` — unchanged |
| transparent (flag) | **switch** | Switch ResourceTypes omitted from Strategy steps; fabric fillers |
| Assembler | **StrategyScheduler** | Outer: steps, time, sticky, commit |
| Coupler | **FabricRouter** | Inner: multi-sink path on Dataflows |
| Oracle++ / ExpandKey / PlanSegment | *(keep)* | Algorithm / time names |
| Yard / Cable / Class / Car / Port | *(retire)* | Legacy bridge only |

```text
Strategy {
  steps: Step[]                    // was legs; ResourceType + TaskingConfiguration
  path: Hop[] | null               // was route
  allocatedAssets: AllocatedAsset[]
  planSegments: PlanSegment[]
}
Step { index, resourceTypeId, taskingConfiguration }
Hop { assetId, inIoPort, outIoPort }   // was stationId, inTrack, outTrack
```

---

## 0. How to use this doc

| Status tag | Meaning |
|------------|---------|
| **DECIDED v1** | Implement exactly this unless product overrides |
| **DEFAULT v1** | Recommended; safe to ship; note if you change it — **only** when product/session explicitly chose it |
| **OPEN** | Needs product input; **do not invent** a mechanism, API, or “obvious” default |

**Rule for authors/agents:** if two sections conflict, or a behavior is not written, mark **OPEN** and **ask** — do **not** silently pick one side and relabel it DECIDED.

### Document authority (DECIDED)

| Source | Authority |
|--------|-----------|
| **§1–§4 + §3.7–§3.10** | **Canonical** — Station model, Prefilter/Inspector, first/last leg, sticky, commit |
| **§5+** | Must not contradict §1–§4; if they do, **§1–§4 win** (legacy Class/Car/Yard wording is a rename of the same concepts) |
| **SPEC.md** | Intent and open product questions; BUILD_SPEC §1–§4 wins on mechanism conflicts |

**Legacy bridge (older prose):** StationType←Class · Station←Car · switch ResourceType←Yard · Dataflow←Cable · IoPort←Port/TrackDef · Strategy←Booking · Step←Leg · Path←Route · AllocatedAsset←Binding · TaskingConfiguration←Request.  
**See network vocabulary table above** for the DECIDED target names.

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

## 2. Scope: what is in, out, and deferred

### 2.0 Sole deferred product feature (**not** building yet)

| Deferred | Meaning |
|----------|---------|
| **Force-priority preemption** (`forcePriority` / kick) | A higher-priority Booking **forcibly takes** resources already held by lower-priority Bookings (eviction cascade, audit). Strawman only: **SPEC.md §12 Q16**. |

Everything else that is **DECIDED** in this document is **in scope for v1** — not “optional,” not “P6 if needed,” not “maybe later.”  
Implementation **order** (phases P0–P5, domain goldens before Kafka adapters) is sequencing, not optionality.

### 2.1 Booking priority (**in v1**)

```text
Booking {
  ...
  priority: int    // 1 = highest (lower number = more important)
}
```

| Behavior | v1? |
|----------|-----|
| Place queue: priority 1 first, then FCFS **submitTime** | **Yes** |
| Free capacity only when placing (no free resource → fail / backtrack / CAPACITY) | **Yes** |
| Same-run **plan re-place**: higher-priority booking **SAT-commits** and takes a resource; lower-priority booking is **re-resolved in the same engine run** for affected slices | **Yes** (§3.9b) — scheduling repair, not force-kick |
| **`forcePriority: true`** — kick already-held lower-priority claims without a clean free-resource place | **No — sole deferred (Q16)** |

### 2.2 Non-goals (wrong approach — not “later phases”)

Do **not** build these as the engine design (they are incorrect or out of product shape, not deferred features):

- Global optimal multi-Booking packing / MILP / CP-SAT as primary solver (first-fit multi-sink + priority queue instead)  
- Parallel “assign all legs then join” (Context requires ordered legs)  
- Device-level graph without tracks  
- “Never visit same Station twice” as a hard rule (re-entry on a new hop_key is allowed)  
- Re-solving every poll when nothing hopeful changed (sticky / bust tables)  
- Soft multi-Booking **combine/share** on aggregator ports (**exclusive** is the product rule, not a v2 roadmap item)  
- Assembler peel / Option B Coupler (rejected; pivot doc only)  
- Full production ops UI as part of the engine library (Fixture Studio is separate tooling when built)

### 2.3 Sequencing (required, ordered — not optional)

| Order | Work |
|-------|------|
| 1 | Domain engine + goldens G1–G12 (P0–P5 below) |
| 2 | Kafka adapters / topics (same product; after domain is green — SPEC §10.1) |

Do **not** treat Kafka, Oracle++, backtrack, sticky, or FailureReport samples as optional extras.

---

## 3. Canonical data model

### 3.0 Mental model

**Entity diagrams (Mermaid):** [ENTITY_DIAGRAMS.md](./ENTITY_DIAGRAMS.md).

```text
StationType  = code catalog type (schemas, TrackDefs, canUse/inspect SPI, heuristics, transparent?)
Station      = instance (setup, tasking, liveData, inputs/outputs Links)
TrackDef     = StationType-owned track kind: { id, name, number } (e.g. up to 32 in + 32 out)
Link         = Station wiring: this station’s OUT TrackDef → peer’s IN TrackDef
Task         = assignment on a Station: input, output, context, taskingConfiguration, bookingIds
Tasking      = Task[] on a Station — live/planned-live assignment truth
Request      = user demand on a Booking leg
Route        = full hop path after resolve (user-visible plan string)
```

**DECIDED v1:** No Yard entity. Switches = **transparent** StationTypes. Product name = **Trackplan**. Domain plan string = **Route**.

### 3.1 Identifiers

**DECIDED v1:** opaque string ids (`st_…`, `sttype_…`, `booking_…`, `link_…`, track def uuids).  
Stable sort = lexicographic id ascending unless sticky id overrides.

### 3.2 Catalog: StationType

```text
// StationType is a *code* catalog entry (external JAR / module).
// One class per type implements the shared SPI (metadata + canUse + inspect).
// World projection stores Stations (with inputs/outputs Links) + Bookings — not dual plugin ids.

StationType {   // runtime object after load (in-memory catalog)
  id: string
  name: string

  // true ⇒ omitted from Booking demand string; path filler (e.g. switch).
  // Users do not author legs or requests for transparent types (v1 product).
  // inspect() still accepts request (may be empty) so future product can opt in.
  transparent: bool

  // Schemas (JSON Schema or equivalent) — type defines shape; instances hold values
  setupSchema: Schema              // semi-static props (firmware, …) NOT booking-driven
  taskingSchema: Schema            // shape of Task / tasking list (inspector contract)
  requestSchema: Schema            // shape of Booking leg request; may be {} if unused

  // Track kinds this type owns (StationType is catalog owner of TrackDefs).
  // Stations of this type connect to peers only via these defs (see Station.inputs/outputs).
  // Typical scale: up to ~32 inputs and ~32 outputs per type.
  inputTracks: TrackDef[]          // IN track kinds owned by this type
  outputTracks: TrackDef[]         // OUT track kinds owned by this type
  // Possible in→out pairs on one visit (type capability). Enforcement of *which*
  // concurrent uses are OK is inspect()-driven, not only this list.
  legalPairs: { in: TrackDefId, out: TrackDefId }[]   // TrackDef.id on this type

  // Behavior: methods on *this* class (common SPI). Not separate plugin objects.
  //   canUse(setup, request, liveData) → ok | reject   // optional; default pass-all
  //   inspect(setup, tasking, request, liveData) → Task[] | Failure  // required
  //   neighborRank(...) → Long   // optional; default 0 — ExpandKey component 4

  heuristics: {
    checkpoint: bool               // after bind this type, do not try other stations of type
    fillFirst: bool                // default true — ExpandKey preferInUse (§3.7b)
    // no edgeCostId / transparentCost / summed preference ladder
    // no neighborRankId — ranking is a method on the type when present
  }
}
```

**How types are supplied + loaded (DECIDED):**

Classpath alone is not enough: the engine must know **which class** implements each type. There is **one** load handle per type (the SPI class), not two plugin ids.

```text
// Thin load descriptor — boot config and/or catalog table (ops-owned).
// This is *not* "inspectorId + prefilterId"; it is the single FQCN of the StationType class.
StationTypeRef {
  id: string                 // stable key used by Station.stationTypeId and Booking legs
  className: string          // FQCN, e.g. "com.acme.trackplan.types.RefrigeratedStationType"
  // optional: jar / module hint for multi-classloader deploy (DEFAULT v1: app ClassLoader only)
}
```

| Step | What happens |
|------|----------------|
| 1. Ship | Each type is a class on the classpath (app module or external JAR) implementing the shared `StationType` SPI |
| 2. Declare | Ops/config lists `StationTypeRef { id, className }` (file, env, or thin catalog table) |
| 3. Load | For each ref: `Class.forName(className)` → no-arg (or engine-injected) construct → cast to SPI |
| 4. Bind | Assert `instance.id == ref.id` (or set id from ref if SPI returns constant). Fail boot on missing class / duplicate id |
| 5. Catalog | In-memory `Map<stationTypeId, StationType>` for the process lifetime |
| 6. Resolve | `Station.stationTypeId` / leg type → `catalog.get(id)` → call `canUse` / `inspect` on that instance |

```text
// Boot sketch (Kotlin / JVM)
fun loadCatalog(refs: List<StationTypeRef>, cl: ClassLoader = Thread.currentThread().contextClassLoader): Map<String, StationType> {
  val map = linkedMapOf<String, StationType>()
  for (ref in refs) {
    val clazz = Class.forName(ref.className, true, cl)
    val type = clazz.getDeclaredConstructor().newInstance() as StationType
    require(type.id == ref.id) { "StationType ${ref.className} id=${type.id} != ref.id=${ref.id}" }
    require(ref.id !in map) { "duplicate stationTypeId ${ref.id}" }
    map[ref.id] = type
  }
  return map
}
```

**Rules:**

- **One class = one StationType** (metadata + `canUse` + `inspect` + optional `neighborRank`). Do **not** split into separate inspector/prefilter classes or store two plugin keys.  
- **`className` is the load key**; `id` is the domain key on Stations/Bookings. Both are required to line up at boot.  
- **Persist only** instance world data (`Station`, `Link`, `Booking`) plus, if needed, the thin `StationTypeRef` list for boot. **Do not** persist inspector/prefilter implementation blobs or dual plugin ids.  
- Metadata (schemas, tracks, heuristics flags) **lives on the class** (returned by the SPI). Overrides from config are **OPEN** if product later wants ops-tunable checkpoint without rebuild.  
- Changing type behavior = new jar + same or updated `className` + **restart** (cold catalog). Sticky “jar change” is not an in-process event.  
- **DEFAULT v1 discovery:** explicit `StationTypeRef` list (config). Optional extra: `ServiceLoader` / META-INF/services to *find* candidates, but production still needs a deterministic allow-list of which types are active (same as listing refs). DI frameworks may construct the instance after `Class.forName` if the type needs dependencies — still one class per type.

**Setup vs request (DECIDED):**

- Human / non-booking-dynamic → **setup**.  
- Booking may demand it → **request** only (never also setup).  
- Assembler **never** mutates setup (humans via UI/API).

**Topology vs inspector (DECIDED):**

- **Links** (on Stations) = physical graph Coupler may traverse.  
- **inspect()** decides whether a traversal/tasking is valid (multiplex, capacity, N:1 terminals, hubs, …).  
- StationType may expose N inputs / M outputs (TrackDefs); legality of concurrent use is inspect rules, not a global “one link per out” hard law.

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

  // World wiring for this instance (not on StationType).
  // Each Link is OUT → IN; this station is one endpoint.
  inputs:  Link[]                  // Links that land on an input TrackDef of this station
  outputs: Link[]                  // Links that leave from an output TrackDef of this station
}
```

**DECIDED:**

- **StationType owns** the track kinds (`TrackDef[]` on the type). Stations do not invent tracks.  
- **Station** only **uses** those owned defs to wire to other Stations (`inputs` / `outputs` Links).  
- A TrackDef with no Link on a given Station is unwired there — Coupler cannot enter/leave through it.  
- Engine builds the fabric graph from all Stations’ Links (see §3.5).

### 3.4 TrackDef (owned by StationType)

**Old model:** bare `TrackId = string` (e.g. `"1"`, `"5"`) with no structure.  
**Now:** StationType is the **owner** of its track kinds. Each IN/OUT is a **TrackDef** declared on the type (code / JAR).

```text
TrackDefId = string                // stable id (uuid) of this track kind on the owning StationType

// Example: { id: "<uuid>", name: "type1", number: 1 }
TrackDef {
  id: TrackDefId                   // identity — join key for Links, Tasks, hops, sticky
  name: string                     // track *kind* discriminator, e.g. "type1", "type2", "agg"
                                   // differentiates different types of tracks on this StationType
  number: int                      // index within the type/side, e.g. 1..32
}

// Engine endpoint when visiting a concrete station:
TrackRef {
  stationId: string
  side: "in" | "out"
  trackId: TrackDefId              // must be a TrackDef.id owned by that station’s StationType + side
}
```

**Rules (DECIDED):**

- **Owner = StationType.** TrackDefs are not free-floating and not defined on Station. Every Station of type T shares T’s TrackDef set.  
- **`id`** — stable join key (uuid in type code). Links / Tasks / hops / sticky reference **`TrackDef.id`**, never name or number alone.  
- **`name`** — track **kind** (e.g. `"type1"`, `"type2"`). **Also the inter-station connectivity key** (see §3.5): only same-name OUT→IN may Link. Not the join key for Tasks/hops (use `id`).  
- **`number`** — ordinal on that side (1..N). Unique per **(side)** within a type (no two IN TrackDefs share `number`; same for OUT).  
- Scale: types may declare up to ~32 IN and ~32 OUT TrackDefs (product limit, not engine hard law).  
- **legalPairs** reference `TrackDef.id` (in ∈ inputTracks, out ∈ outputTracks of the same type) — *internal* visit pairs on one station, not inter-station wiring.  
- **Stations connect** by Links that point at TrackDef.ids of the from/to stations’ types, subject to **name match**.

### 3.5 Link (topology — owned on Station)

A **Link** is one physical connection: **from** an OUT TrackDef on station A **to** an IN TrackDef on station B.

```text
Link {
  id: string                       // link_… stable id (same id on both endpoints if dual-listed)
  from: {
    stationId: string
    trackId: TrackDefId            // OUT TrackDef.id on from station’s type
  }
  to: {
    stationId: string
    trackId: TrackDefId            // IN TrackDef.id on to station’s type
  }
  online: bool                     // false ⇒ unusable; Coupler must not traverse
}
```

**Compatibility by track name (DECIDED):**

Not every StationType can wire to every other. **`TrackDef.name` is the compatibility key** between stations:

```text
// Legal Link only if:
type(A).outputTracks[from.trackId].name
  == type(B).inputTracks[to.trackId].name

// Examples:
//   A OUT { name: "type1", number: 1 }  →  B IN { name: "type1", number: 3 }   OK
//   A OUT { name: "type1", ... }        →  B IN { name: "type2", ... }         ILLEGAL
//   A has only type1 outs; B has only type2 ins  →  no legal Link between them
```

| Rule | Meaning |
|------|---------|
| **Same `name` required** | `type1` OUT may only connect to `type1` IN (any peer Station that owns a type1 input) |
| **Different StationTypes OK** | As long as both ends declare the **same track name** |
| **`number` free** | Peer may use a different number; only **name** must match |
| **`id` free** | Each type owns its own TrackDef ids; names align across types for fabric |

This is a **topology / Studio / load validation** rule, not an inspect() concern. Illegal Links must not enter the world; Coupler assumes all Links already satisfy name match.

**Where Links live (DECIDED):**

| View | Meaning |
|------|---------|
| `Station.outputs` | Links with `from.stationId == this.id` |
| `Station.inputs` | Links with `to.stationId == this.id` |

- Same physical edge appears in **from-station.outputs** and **to-station.inputs** (same `Link.id`).  
- **Persistence DEFAULT:** store each Link **once** (e.g. under the from-station’s outputs, or a link table); build the inverse `inputs` index at load. Dual-write both lists is OK if ids stay consistent.  
- **Not** on StationType — type only has TrackDefs + legalPairs.

**Other DECIDED:**

- **`Link.online = false`** = world fact: that edge is gone for search.  
- Tasking that depended on that link ⇒ re-schedule those Bookings.  
- Studio: drag OUT TrackDef on A → IN TrackDef on B creates a Link only if **names match**; reject otherwise.  
- Validation at write / load:  
  1. `from.trackId` ∈ type(A).outputTracks  
  2. `to.trackId` ∈ type(B).inputTracks  
  3. **`name(from) == name(to)`**  
- Examples: many upstream outs may Link into one Terminal in-track **if names match**; hub types use many TrackDefs — concurrent capacity is **inspect()**, not “one link per out” hard law.

### 3.6 Task, Tasking, Context

```text
Context = Record<string, JsonValue>

Task {
  input: TrackDefId | null         // null OK for entry/first-type start (no in used)
  output: TrackDefId | null        // null OK for terminal/last-type arrival (no out needed)
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

#### First leg / entry into Coupler (DECIDED)

Demand leg 1 = StationType T. **No transparent types before T.** First type is **entry-special**: Coupler **does not use input tracks** on these stations (even if the type defines some).

1. Assembler: OPEN stations of type T → **Prefilter**(setup, request, liveData) → candidate set C.  
2. Coupler: **virtual source S0** (not a real Station) with edges **S0 → each c ∈ C** (“pick this start station”).  
   - No Link into an in-track required.  
   - Order S0→c by **ExpandKey** (§3.7b; fill-first / distToG / names on candidates).  
3. Goal: **inspect** accepts a **start Task** on some c (out-track chosen for the *next* segment if any).  
4. Ranking: **ExpandKey** on S0→candidates and on fabric expands (§3.7b). Frontier pop is ExpandKey-dominated (not a separate `f=g+h` preference).

#### Last leg / terminal (DECIDED)

Last StationType is often a **terminal**: typically **no output track** needed.

- Success when path **arrives** at a prefiltered last station, e.g. physical hop into it `… → 1:C` (enter on in-track `1`).  
- Coupler/inspect does **not** require building a full `in:C:out` like `1:C:1` if there is no meaningful out.  
- Candidate Task for terminal: **input** set, **output** empty/null (or type-defined sentinel); inspect still validates tasking list.  
- If a last type *does* define outs, they are optional for “booking complete”; booking is done once last type is successfully tasked on arrival.

#### Oracle++ (DECIDED — topology insight beyond “next type only”)

**Name:** **Oracle++** (supersedes the weaker “Oracle = only hop-count to next type” story).  
**Graph:** Stations + Tracks + Links (in vs out from type track lists). Topology only — **not** tasking, request, or Inspector.

**Loop rules (same as Coupler):** hop_key uniqueness on a path, max hops **H**, max visits per station **V**, online Links + OPEN Stations only. Loopback OK; infinite spin not.

**Rebuild when:** Links add/remove/online, Station OPEN/CLOSED, type track / legalPairs topology changes.  
**Not rebuilt on:** tasking, liveData, booking request changes.  
Build/rebuild before Assembler when topology dirty; **read-only** during a resolve run.

##### Queries Oracle++ must support (DECIDED)

Booking demand legs = ordered **non-transparent** StationTypes `T0, T1, …, Tk` with **Tk = terminal** (last leg).

| Query | Meaning | Used for |
|-------|---------|----------|
| **Reach type** | From a start (S0, or tail out-track / port), does **any** Station of type **T** remain reachable? | Empty pool / UNREACHABLE early out |
| **Candidate sinks for next type** | From current tail, which Stations (finishes) of type **T_next** are reachable? | Build Coupler multi-sink **goals** |
| **Non-transparent chain** | From a Station (or finish) of type **T_i**, can I reach **some** Station of type **T_j** (j > i), via fabric + transparent only? | Drop sinks that are dead for **later demand legs** |
| **To terminal** | From a Station/port, can I reach **some** Station of terminal type **Tk**? | Filter dead-end sinks |
| **Distance to terminal** | Optimistic **hop length** from port/Station → nearest terminal-type Station | ExpandKey component — prefer shorter; **not** boolean alone |
| **Distance to segment goals** | Optimistic hop length from port/Station → nearest Station in **this couple’s multi-sink goal set** `G` | ExpandKey component — prefer shorter (local leg progress) |
| **Segment-goal distance** | Same as ExpandKey component 2 | Preference only via ExpandKey — no competing `f=g+h` |

**DECIDED:** Oracle++ stores **numeric distances** (to terminal **and** to current multi-sink set `G`), not only can/cannot reach. Unreachable = ∞ / filtered out of goals.

**DECIDED product intent:** when building goals for leg i, filter candidates with Oracle++ so a sink is kept only if it is reachable from the **current tail** **and** (for i < k) it can still reach the **terminal** type Tk (and DEFAULT: intermediate non-transparent types T_{i+1}…T_{k-1}).

```text
// Goal construction for leg i (Assembler) — DECIDED shape
pool = Prefilter(OPEN stations of type T_i)
goals = [ s in pool
          | Oracle++.reachable(tail → s)
          | (i == k || Oracle++.canReachTerminal(s, Tk))
          | (DEFAULT: Oracle++.canReachTypes(s, T_{i+1}..T_{k-1})) ]
goals = sortByExpandKey(goals)  // lexicographic ExpandKey — §3.7b
// then Coupler.couple(tail, goals)  // multi-sink Option A
```

**Not Oracle++:** whether Inspector will accept (request, tasking, context stamps).

**Implementation:** precompute reachability **and** distances to terminal (and segment goals) on topology change; read-only during resolve.

**Legacy name:** older text saying “Oracle” means **Oracle++**.

### 3.7b Neighbor expand order — **lexicographic ExpandKey (DECIDED)**

**Do not** sum preference terms into one number for expand order.  
`(1,1,2,0)` and `(0,1,3,0)` both sum to 4, but **first differing component wins**.

When Coupler expands legal children (or Assembler sorts multi-sink goals), build an **ExpandKey** and compare **lexicographically**. After all components, ties are already broken by name fields.

```text
// DECIDED component order (index 0 is most significant)
ExpandKey = (
  preferInUse,           // 0: 1 if neighbor already in use (tasking), else 0 — PREFER HIGHER
  preferNonTransparent,  // 1: 1 if NOT transparent, else 0 — PREFER HIGHER
  distToSegmentGoals,    // 2: Oracle++ hops to nearest Station in this couple’s multi-sink set G — PREFER LOWER
  distToTerminal,        // 3: Oracle++ hops to nearest terminal Tk — PREFER LOWER
  neighborRank,          // 4: SmartNode if type defines one, else 0 — PREFER HIGHER
  stationName,           // 5: lexicographic — PREFER LOWER
  portName               // 6: track id on hop — PREFER LOWER
)
```

| # | Component | Prefer | Source |
|---|-----------|--------|--------|
| 0 | **In use** | Higher (fill-first) | Neighbor has tasking / “already used”; type may disable fill-first → always 0 |
| 1 | **Non-transparent** | Higher | `!stationType.transparent` — prefer demand types over pure path fillers |
| 2 | **Distance to this leg’s multi-sink goals** | Lower | **Oracle++** min hops from neighbor → any station in **current couple goal set `G`**. If neighbor ∈ `G`, distance = **0**. If unreachable to all of `G`, ∞. |
| 3 | **Distance to terminal** | Lower | **Oracle++** numeric length to nearest terminal Station (booking last type Tk) |
| 4 | **NeighborRank (SmartNode)** | Higher | Optional method on StationType; default 0 |
| 5 | **Station name/id** | Lower | Stable id |
| 6 | **Port/track name** | Lower | TrackDef.name + number, or TrackDefId string if needed for stability |

**Why both distances:**  
- **Segment goals (2):** local progress for *this* `couple()` (e.g. prefer N-04 over N-08 when both non-transparent — N-04 is a goal / closer to an N goal).  
- **Terminal (3):** longer-horizon topology (prefer sinks that leave a shorter path to Docking/X).  
Compared **lexicographically**: segment distance wins ties before terminal distance.

**DECIDED:**

- **Tuple order**, not sum.  
- **Pure + deterministic** given WorldSnapshot + candidate + current goal set `G`.  
- Hard illegality is not a key — **Inspector** rejects; expand only ranks legal edges.  
- **Prefilter** is earlier (Assembler); not an ExpandKey component.  
- `G` is fixed for the duration of one `couple()` call (Assembler-built multi-sink goals).  
- New columns only by product decision (order changes paths).

#### Relation to A* `g` / `h`

| Idea | Role |
|------|------|
| **ExpandKey** | **Primary** order for which neighbor / agenda goal to try next |
| **`g`** | **DEFAULT:** +1 per Link hop (search accounting / hygiene only) |
| **distToSegmentGoals** | ExpandKey component 2 only — not a competing frontier `h` score |

**Frontier pop:** ExpandKey-dominated — e.g. `(g, ExpandKey…)`. Do not invent a second summed preference cost or `f=g+h` ranking.

#### NeighborRank = SmartNode

```text
// Optional method on StationType (same JAR as canUse/inspect). Default 0 if unimplemented.
stationType.neighborRank(neighbor.tasking, setup, liveData, candidate, request?) → Long
// higher = try sooner among peers already tied on components 0–3
```

#### Oracle++ distances used by ExpandKey

```text
// Rebuild topology distances when Links/online change — not on every tasking change
oracle.minHops[from][to] = BFS on online Links

// Multi-sink goals G for this couple() — ExpandKey component 2:
distToSegmentGoals(n) = min over g in G of oracle.minHops[n][g]
// n ∈ G ⇒ 0

// Terminal Tk — ExpandKey component 3:
distToTerminal(n) = min hops to any Station of type Tk
```

Per Coupler call without a full all-pairs Oracle: one multi-source BFS **backward from all goals** once, then O(1) distToSegmentGoals lookups — same idea, amortized per call.

#### Heuristics (config on type; not plugin ids)

```text
StationType.heuristics {
  checkpoint: bool
  fillFirst: bool                 // default true — ExpandKey preferInUse
  // NeighborRank = optional method on the type — not a string id field
}
```

### 3.8 Booking (demand + plan)

```text
Booking {
  id: string
  priority: int                  // 1 = highest
  status: "pending" | "sat" | "unsat"
  submitTime: Instant            // when handed to engine (FCFS); NOT createTime
  // only place time lives on the booking (no RRULE). Half-open [start, end) — see §3.9b.
  timeWindow: { start: Instant, end: Instant }

  // DEMAND — non-transparent types only
  legs: Leg[]

  // PLAN — schedule SSOT is planSegments (§3.9b). route/bindings are denormalized display.
  planSegments: PlanSegment[]    // empty if pending/unsat or nothing in horizon
  bindings: Binding[] | null     // convenience; DEFAULT: copy of single segment, else null if multi
  route: Hop[] | null            // convenience display path; same DEFAULT as bindings
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
  inTrack: TrackDefId | null     // null OK for first-leg S0 entry (no physical in)
  outTrack: TrackDefId | null    // null OK for terminal arrival (no out)
  // hop_key = (stationId, inTrack, outTrack) — TrackDef.ids; nulls are part of the key
}

// One constant-path piece over a half-open time interval. Materialized at SAT.
PlanSegment {
  start: Instant
  end: Instant                   // half-open [start, end)
  route: Hop[]
  bindings: Binding[]
  // DECIDED: store Tasks written at path SAT so projectTasking never re-runs Inspector
  stationTasks: Map<stationId, Task>   // stations on this segment’s path (leg + transparent)
}
```

| View | Name | Content |
|------|------|---------|
| User demand | legs | A → B → C + requests |
| Schedule SSOT | **planSegments** | Path + Tasks per time sub-interval |
| Display (optional) | route / bindings | Denormalized; prefer single-segment copy |

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

**DECIDED v1 — full machine (not intent-only).** Path search stays in §8 (`placeBookingPath`). Time ownership is the outer Assembler loops below.

#### Interval & config

| Rule | Status |
|------|--------|
| All time ranges are **half-open** `[start, end)` | **DECIDED** — `timeWindow`, `PlanSegment`, open event slices |
| Instant `end` is **exclusive**; the next open interval may start at that instant | **DECIDED** — no double occupancy at boundaries |
| `timeWindow` only (no RRULE) | **DECIDED** |
| **Tasks have no time fields** | **DECIDED** — Inspectors are time-dumb |
| **Horizon** = `Policy.assembler.horizon` from run **`now`** | **DEFAULT:** `8 hours` |
| **`submitTime`** on Booking for FCFS | **DECIDED** — see §3.8 |
| Priority **1 = highest**; ties → earlier `submitTime`, then `booking.id` | **DECIDED** |
| **`now` is not an event cut** | **DECIDED** — if `now ∈ [start,end)`, booking is already in force from `start` (may be past) |
| **liveData** | next run only; no auto re-queue |

#### Schedule SSOT vs Station.tasking

| Store | Role |
|-------|------|
| **`Booking.planSegments`** | **SSOT** for what this booking occupies over time (route, bindings, **materialized `stationTasks`**) |
| **`Station.tasking`** | **Not** an independent multi-time ledger. During resolve, Coupler/inspect see a **projection** at one slice (`projectTasking`). Live/ops “armed now” = projection at `now` for downstream claims/UI |
| **`PlanSegment.stationTasks`** | Written at path SAT for that slice — **full `Task` objects** so later projection **never re-runs Inspector** |

#### What gets scheduled (horizon clip)

```text
placeSpan(booking, now, horizonEnd) =
  booking.timeWindow ∩ [now, horizonEnd)     // half-open ∩ half-open
```

| Case | Behavior |
|------|----------|
| `placeSpan` empty | **SAT** with `planSegments = []` (nothing to do in horizon; not a failure) |
| `timeWindow` extends past `horizonEnd` | Schedule **only** the intersection; remainder waits for later runs as `now` advances |
| Window entirely in the past (`end ≤ now`) | Same as empty span — no new segments |

#### Event cuts & open slices

Event instants are **booking window boundaries**, not an open-ended clock tick:

```text
// Example windows (drawn closed for readability; stored half-open):
// B1 [9,10), B2 [10,11), B3 [10:30,11)  → cuts 9:00, 10:00, 10:30, 11:00
// Open slices with constant foreign occupancy membership:
// [9,10), [10,10:30), [10:30,11)
```

For one booking being placed over `span = placeSpan(...)`:

```text
cuts = sorted unique instants {
  span.start, span.end,
  every other booking’s timeWindow.start / timeWindow.end
    that lies in (span.start, span.end)   // strictly inside — endpoints already in set
}
// Open slices: I_i = [cuts[i], cuts[i+1]) for i = 0 .. len(cuts)-2
// Skip degenerate zero-length (should not occur if instants unique)
```

Foreign bookings that never intersect `span` do not add cuts. Skip work when the wake set has no booking whose span needs recompute (sticky still applies).

#### Projected tasking (what Inspector sees)

```text
function projectTasking(world, at: Instant, excludeBookingId: string?) → Map<stationId, Task[]>
  // For each booking b ≠ exclude with status sat (or already committed this run):
  //   for each PlanSegment S of b where S.start ≤ at < S.end:
  //     for (stationId, task) in S.stationTasks:
  //       append task into result[stationId]  (merge order: stable by booking.id then segment.start)
  // Stations with no covering segment → empty Task[] (or omit)
```

- **Coupler/inspect** for a slice use `projectTasking(..., at = I.start, exclude = this booking)` as the **committed peer tasking** baseline, then the usual path-local WorkingState overlay for *this* attempt.  
- Multiple tasks on one station in a projection = concurrent peer bookings in that slice (Inspector enforces exclusive / capacity).  
- **Do not** call Inspector to rebuild peer tasks from route alone.

#### Outer engine loop (serial + time)

```text
function engineRun(committed, now, wakeSet, policy):
  horizonEnd = now + policy.assembler.horizon
  candidates = wakeSet
    ∪ all status=unsat bookings that intersect [now, horizonEnd)
    ∪ (policy: always retry pending in horizon)
  queue = sort(candidates, priority asc, submitTime asc, id asc)

  for booking in queue:                          // one at a time — §11
    result = placeBookingOverTime(booking, committed, now, horizonEnd, policy)
    if result is SAT:
      commitBooking(booking, result.planSegments)  // replace prior segments for this booking
      denormalizeDisplay(booking)                  // route/bindings convenience
      stickySAT.save(booking, result)
      // Same-run re-place (priority steal without force-kick):
      victims = lower-priority bookings whose existing planSegments
                share any stationId with result.planSegments (time-overlap required)
      for v in sort(victims, priority, submitTime, id):
        bust sticky(v); re-run placeBookingOverTime(v, …) in this same run
        // v may become UNSAT — allowed; capacity went to higher booking
    else:
      discard working; clear planSegments; status=unsat; stickyUNSAT.save(...)
```

#### placeBookingOverTime (per booking)

```text
function placeBookingOverTime(booking, world, now, horizonEnd, policy):
  if stickySAT.hit(booking) && !force: return cached SAT
  if stickyUNSAT.hit(booking) && !force: return cached UNSAT

  span = placeSpan(booking, now, horizonEnd)
  if span empty: return SAT(planSegments=[])

  slices = openSlices(span, otherBookingWindowCuts)
  workingSegments = []

  for I in slices:                                 // in time order
    projected = projectTasking(world, I.start, exclude=booking.id)
    // DEFAULT v1: always re-path every dirty booking’s full span (no partial-slice sticky)
    path = placeBookingPath(booking, projected, policy)   // §8 — multi-leg Coupler
    if path is FAIL:
      // DECIDED: any slice fail → whole booking UNSAT; discard all workingSegments
      return UNSAT(path.failure)   // legIndex/code from first failing slice

    workingSegments += PlanSegment(
      start = I.start, end = I.end,
      route = path.route, bindings = path.bindings,
      stationTasks = path.acceptedTasksByStation   // from inspect-OK Tasks on the path
    )

  return SAT(planSegments = mergeAdjacentIdentical(workingSegments))

// merge: adjacent segments with identical route + bindings + stationTasks (by value)
//        → one PlanSegment spanning [first.start, last.end)
```

| Rule | Status |
|------|--------|
| Any required slice **FAIL** → whole booking **UNSAT** | **DECIDED** — no partial commit |
| Commit only after **all** slices of `placeSpan` succeed | **DECIDED** — aligns with whole-booking commit (§3.9c) |
| Multi-segment when paths differ across slices | **DECIDED** — contention/priority, not Inspector “knowing” time |
| Adjacent identical paths **merge** | **DECIDED** |
| Same-run re-place after higher SAT | **DECIDED** — victim = lower priority + **stationId** overlap on time-overlapping segments (v1; hop_key-level optional later) |
| No steal on failed higher attempt | **DECIDED** |
| Idempotent skip | Sticky SAT/UNSAT at **booking** grain (**DEFAULT v1**); not per-slice cache |

#### Event (index only)

```text
Event {
  at: Instant
  // Conceptual: open interval [at, nextAt) has constant set of covering planSegments.
  // Not a durable entity store — Assembler derives cuts from booking windows.
}
```

#### Goldens vs time

G1–G12 may use a **single open slice** (one booking, trivial cuts) so path behavior is tested without multi-booking contention. Time/re-place behavior is still **required v1** (not optional phase); add dedicated fixtures when implementing §3.9b fully.

### 3.9c Working state, commit, batch queue (memory & performance)

**DECIDED: whole-Booking commit only; queue commits between bookings.**  
Time layer (§3.9b): “whole booking” = **all open slices** of `placeSpan` succeed, then commit **`planSegments`** (with `stationTasks`). Path layer may succeed on early slices but those stay working until the last slice OK.

```text
CommittedWorld (durable “world view” — setup, liveData, links, bookings with planSegments)
// Station.tasking for ops/live = projectTasking(world, now); not a second multi-time ledger

// One engine run (see §3.9b engineRun):
for booking in queue:   // priority then submitTime
  for each open slice I in placeSpan:   // WorkingState path-local on projectTasking(I)
    placeBookingPath using WorkingState only
  if all slices SAT: commit planSegments → CommittedWorld; next booking projects new peers
  if any slice FAIL: discard all working segments; world unchanged
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

#### C2 — Multi-sink Coupler — **DECIDED Option A**

**Product choice:** **Option A — multi-sink.**  
**Pivot / debate record:** [COUPLER_OPTION_A_VS_B.md](./COUPLER_OPTION_A_VS_B.md) (Option B retained only for future pivot).

| Rule | Status |
|------|--------|
| Within-segment: one `couple(tail, goals=agenda)` | **DECIDED A** |
| Goals = many concrete Station finishes of next type (not StationType as a node) | **DECIDED** |
| Path fail / inspect fail at a goal → **continue inside Coupler** | **DECIDED** |
| First inspect-OK goal → return (first-fit) | **DECIDED** |
| Agenda = Oracle++-filtered, sorted **targets** (finishes e.g. `1:N1`, not full multi-hop paths) | **DECIDED** |
| Sort / expand order: **ExpandKey** lexicographic (§3.7b) | **DECIDED** |
| Full fabric paths precomputed into agenda? | **No** (**DECIDED**) |
| Store pathTaken for debug / FailureReport / sticky | **DECIDED** |
| Inspect = `Inspector.inspect` → `Task[] \| Failure` | **DECIDED** |
| First leg = virtual S0 + multi-sink Coupler | **DECIDED** |
| Tail for next segment = bound **out-track** (not Station alone) | **DECIDED** |
| Assembler re-calls Coupler per goal after inspect fail in same segment? | **No** |
| Option B (Assembler peel + `tryTarget`) | **Not v1** — pivot doc only |

```text
// DECIDED segment attempt
agenda = sortByExpandKey(Oracle++ filter(Prefilter pool))   // goals for type T_i; terminal-aware
result = Coupler.couple(tail, goals=agenda, working, inspector, request, caps)
// inspect/path fails stay in ExpandKey frontier; first OK wins
// unused goals → alts until type is checkpointed (C2c)
```

#### C2b — Inter-leg backtrack — **DECIDED**

On failure of a later segment, Assembler **may backtrack** and retry prior choices, but **only as far back as the last Checkpoint** (not past a checkpointed StationType).

```text
// Conceptual
fail at leg j
→ restore working overlay to state at last Checkpoint boundary
→ resume with remaining alts for the first non-checkpointed leg on the stack
→ never reopen StationTypes that are already checkpointed
```

| Rule | Status |
|------|--------|
| Backtrack allowed | **Yes** |
| Backtrack floor | **Last Checkpoint** (cannot undo a checkpointed type’s Station choice to try sibling Stations of that type) |
| Past last Checkpoint | **No** — those binds are frozen for this booking resolve |
| Cost risk | Large alt × fabric search space — **heuristics + Oracle++ + budgets required** (not optional nice-to-haves) |

**Product note:** This can be a large graph and slow before UNSAT. Mitigations (implement; tune with goldens/profiling):

- Oracle++ terminal/chain filters (fewer dead-end first-fits)  
- ExpandKey (fill-first, non-transparent, dist-to-G, dist-to-terminal, NeighborRank, names)  
- Coupler caps: H, V, max expansions, wall clock → `BUDGET`  
- Checkpoint as soon as **allowed** (after next non-transparent OK) to **shrink** future backtrack depth  
- FailureReport should still explain first emptying stage, not dump full frontier  

Exact numeric caps remain policy (**OPEN** numbers only — not the backtrack rule).

#### C2c — Alts vs checkpoint — **DECIDED**

| Phase | Alts (other goals of type T not chosen) |
|-------|----------------------------------------|
| After multi-sink binds T (e.g. N1) but **before** next non-transparent leg succeeds | Alts for T **retained** for backtrack if the **next** leg fails (N not yet checkpointed) |
| After next non-transparent succeeds (e.g. path uses N1 then X2 inspect OK) → **checkpoint T** | Alts for T **discarded or ignored** — never try other Stations of type T on this booking |
| Same Station, other finishes (e.g. `2:N1:2`) while T not checkpointed | Allowed under checkpoint rules only as prior docs: checkpoint blocks **other stations of type**, not necessarily other outs of the **same** station until product tightens — **DEFAULT:** checkpoint = other **Stations** of type T |

**Why not checkpoint on first inspect of N1 alone:** next leg can still fail; then we need other N sinks (or other paths). Matches “checkpoint only after next non-transparent OK.”

#### C2d — Transparent mid-path Inspector — **DECIDED**

**Every visit** (each completed in→out hop on a transparent Station): Coupler builds a candidate Task and runs **Inspector** (same API as goals). May update working tasking and **Task.context** for downstream. Not topology-only skip.

| Rule | Status |
|------|--------|
| Transparent hop always inspects before the path may leave that station | **DECIDED** |
| `request` on transparent mid-path inspect | **`null`** (DEFAULT v1) — demand request is only for the **goal** StationType of this `couple()` |
| Inspect **OK** | Apply returned `Task[]` to path-local working overlay; flow **accepted Task.context** into search state; continue expand from the hop’s **out** port |
| Inspect **FAIL** | **Prune this branch only** (do not push children); continue frontier — not segment UNSAT until frontier exhausted |
| Non-transparent **goal** inspect FAIL | Same: prune that goal attempt; continue frontier (C2) |
| Full algorithm | **§8.2** (canonical implementer text) |

#### Checkpoint timing (DECIDED) — aligned with C2b/C2c

Checkpoint = do not try **other Stations of this StationType** on this Booking.

- **Too early:** checkpoint type N as soon as N1 inspect OK → cannot switch to N2 if X fails.  
- **DECIDED:** checkpoint type N only **after the next non-transparent leg has a successful working Task** (or N is last leg and booking is SAT).  
- If backtrack **clears** past a failed next leg without having checkpointed N, N’s alts remain usable until checkpoint.  
- Once checkpointed, alts for that type are gone (C2c).  
- Whole Booking SAT freezes via commit.

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
  // SAT relevance ⊆ stations/types/links on any planSegment (union of segments)
  result:
    SAT  { planSegments /* SSOT */, bindings?, route?, … }
    UNSAT { failureReport }
}
```

#### SAT bust (plan-relevant, scoped) — **DECIDED**

SAT sticky is valid only while **this booking’s plan** still matches the world. Relevance ⊆ stations/links/types **on the SAT plan** (route + bindings), plus the booking demand itself.

| Change | Bust **this** SAT? |
|--------|---------------------|
| This booking’s **requests** / legs / demandHash | **Yes** |
| This booking’s **start/stop** (timeWindow) | **Yes** |
| **Setup** on a Station **used by this booking’s plan** | **Yes** |
| Station **CLOSED** (or online→false) on a Station **used by plan** | **Yes** |
| Link **CLOSED** / offline on a Link **used by plan** | **Yes** |
| This booking **deleted** / cancelled | **Yes** (drop sticky + release tasking) |
| This booking **unsubmitted** (withdrawn from engine queue) | **Yes** (drop sticky; treat as no longer scheduled) |
| Unrelated station/link/type not on plan | **No** |
| Tasking changes on unused stations | **No** (unless they invalidate via other rules) |
| liveData | **No** auto (same as unsat) |
| Another booking claims elsewhere | **No** by itself (this plan’s resources unchanged) |

After SAT bust: re-resolve this booking (and any policy wake of others). Do **not** return sticky plan.

#### Unsat bust (hope only, scoped) — **DECIDED** (confirmed)

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

**Overlap note:** SAT and UNSAT use **different** bust tables (plan-relevant vs hopeful). Same world event can bust one booking’s SAT and another’s UNSAT without busting everything.

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
8. Time only on Booking (`timeWindow`, half-open); schedule SSOT = **`planSegments`** with materialized `stationTasks`; Assembler places `placeSpan = timeWindow ∩ [now, now+horizon)`; inspectors time-dumb (§3.9b).  
9. ExpandKey lexicographic order (§3.7b); NeighborRank is component 4 (not a separate edgeCost ladder).  
10. Request on candidate Task: copied into taskingConfiguration **and** passed to inspect (option B).  
11. Physical reachability Oracle uses same hop_key / H / V loop rules as Coupler.  
12. Checkpoint a type only after next non-transparent leg succeeds (or last leg at SAT); clear if backtrack abandons that leg.  
13. Any open slice FAIL → whole booking UNSAT (no partial planSegments commit). Sticky is booking-grain (DEFAULT v1).  
14. Coupler: multi-sink first-fit; **C2d** inspect every transparent hop (`request=null`); goal inspect uses leg request; fabric = transparent only + goals in G; closed set `(locus, contextFingerprint)`; hop_key nulls matter (§8.2).

---

## 4. Context on Tasks (path facts)

### 4.1 Context

```text
Context = Record<string, JsonValue>   // on each Task
```

**DEFAULT v1** namespacing examples:

- From non-transparent bind: `{stationTypeId}.{fact}` e.g. `refrigerated.cabinets = 4`  
- From path: capability keys e.g. `clearance.y2_stamp = true` — **written only by Inspector** when Coupler visits and inspect runs (not a separate publish_on_hop catalog). Not every Inspector writes keys.

### 4.2 How context grows

**DECIDED:** **Inspector** is the writer of durable path communication:

1. Coupler appends a **candidate Task** (in/out known from topology; context seeded from **previous Task.context** on the path, or `{}` at start).  
2. Inspector runs on full `Task[]` (existing + candidate).  
3. On **inspect OK**, inspector places request material into **taskingConfiguration** and **may** put downstream facts into **Task.context** (optional per type). That map is copied into the next candidate along the path.  

**DECIDED:** There is **no** separate `publish_on_hop` registry for “who publishes facts.” **Inspector is the only writer** of Task.context keys. Coupler search state carries **`(OutPort locus, context)`** (context = flowing copy of last accepted Task.context) so alternate paths can differ. Closed-set fingerprint of `context` is defined in **§8.2.1**.

**Canonical “current context” for the booking path (DECIDED):**  
There is **no separate booking-global Context store**.  
`currentContext` in Assembler/Coupler pseudocode means **a copy of the latest accepted Task.context on the working path** (or `{}` before any Task).  
`ResolveResult.context` (if exposed) = that same value at finish (last Task on route), not a second shadow map.

### 4.3 Discovering path context (why try endpoint B before transparent SW?)

Inspectors **must not** hard-code fabric stations (“go to SW-2”). They accept/reject from **setup + tasking + request + Task.context** (e.g. missing stamp in context).

| Question | Answer |
|----------|--------|
| Why try short path to endpoint B first? | **ExpandKey**: prefer non-transparent + lower `distToSegmentGoals` / `distToTerminal` (lexicographic). When required facts are already in Task.context, short corridor often wins first-fit. |
| Does Inspector tell us to use a switch? | **No.** It only fails without needed context. It does not name transparent stations. |
| How does the algorithm find SW then? | **Continued multi-sink search**. Arriving at B with bad Task.context = not a successful goal; keep expanding; path through transparent stations builds context on Tasks; later arrival at B may succeed. |
| Prefer next leg station over extra transparent hops? | **ExpandKey** `preferNonTransparent` + `distToSegmentGoals` (lexicographic) — not a summed hop/edgeCost ladder. **Unsafe** if first touch of B binds without inspect. |

**DECIDED v1:** Goal success = reached candidate station with a Task that **inspect** accepts (new tasking returned). Goal-reject ≠ search failure; only **frontier** exhaustion / budget is failure.

**Ranking:** **ExpandKey** frontier only (§3.7b / §8.2). No separate `f=g+h` preference; no summed edgeCost.

---

## 5. Prefilter + Inspector contract (**canonical = §3.7**)

**DECIDED:** Behavior lives **on the StationType class** (external JAR / module), via a shared SPI. Load path is **`StationTypeRef { id, className }` → Class.forName** (§3.2) — **not** dual `inspectorId` / `prefilterId` plugin keys.

```text
// One SPI class per type (metadata + behavior). Boot builds stationTypeId → instance.

StationType.canUse(setup, request, liveData) → ok | reject(code, message)   // Prefilter SPI
// No Task, no path context. Must not reject path-only successes.
// Optional: default pass-all if type does not need a cheap screen.

StationType.inspect(setup, tasking, request, liveData) → Task[] | Failure   // required
// tasking includes exactly one Coupler-appended candidate Task.
// Returns FULL Task[] for that station (working copy). Context lives on Tasks.

// Optional ranking for Assembler goal list / Coupler ties (§3.7b):
// ExpandKey ranking — NOT a separate rank_cost API or summed edgeCost.
// StationType.neighborRank(...) = ExpandKey component 4; default 0 if unimplemented.
```

| Stage | When | Inputs | Use |
|-------|------|--------|-----|
| **canUse** (prefilter) | Assembler before agenda/Coupler | setup, request, liveData | Shrink candidate stations |
| **inspect** | Coupler at multi-sink goal (and every transparent visit) | setup, tasking(+candidate), request, liveData | Accept/reject + new Task[] |

**Wrong:** full inspect at Assembler dropping stations for missing path stamps.  
**Right:** canUse only irreversible/static checks; path facts checked in **inspect** when candidate Task carries context.

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
type = catalog.stationType(stationTypeId)   // Class.forName-loaded SPI instance (§3.2)
for station in pool(stationTypeId) if OPEN and not checkpoint-closed:
  if type.canUse(station.setup, leg.request, station.liveData).ok:
    candidates.append(station)
// candidates → Oracle++ filter → ExpandKey-sorted agenda → Coupler.couple / type.inspect at goal
```

### 5.3 Per-StationType guide

1. Implement one SPI class; register `StationTypeRef { id, className }` for boot load  
2. setupSchema / taskingSchema / requestSchema + tracks / legalPairs / transparent  
3. canUse reject codes (if any)  
4. inspect rules + Failure codes  
5. What goes into Task.context for downstream  
6. heuristics.checkpoint / fillFirst (ExpandKey §3.7b)  
7. Unit tests  


**v1 walkthrough StationTypes (goldens / walkthroughs):**

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
**DECIDED:** exclusive only — product rule. Soft multi-booking combine/share on Ag is **out of scope** (not a deferred “v2 feature”).

---

## 7. Policy registry

Config object (file or DB), not hard-coded:

```text
Policy {
  coupler: {
    // DECIDED defaults (reference); all fields configurable per engine/resolve
    max_hops: 16                  // H
    max_visits_per_station: 3     // V
    max_expansions: 50_000
    max_wall_ms: 500
    forbid_repeat_hop_key: true
    forbid_immediate_link_backtrack: true  // DEFAULT
    search: "bfs" | "astar"       // DEFAULT "astar" — accounting only; preference = ExpandKey (§3.7b), not f=g+h
    // ExpandKey ranking — preferInUse, nonTrans, distToG, distToTerminal, NeighborRank, names
    use_expand_key: true          // DECIDED required for v1 product preference
    use_neighbor_rank: true
  }
  assembler: {
    mode: "first_fit"             // DECIDED v1
    horizon: Duration             // DEFAULT 8 hours — placeSpan = timeWindow ∩ [now, now+horizon)
    // DECIDED C2b: inter-leg backtrack floor = last Checkpoint (not a numeric depth of 0)
    inter_leg_backtrack: "to_last_checkpoint"   // DECIDED v1 — not "off" / not backtrack_depth: 0
    sticky_prefer: true
    use_neighbor_rank_for_goals: true  // ExpandKey component 4 on agenda stations
  }
  cache: {
    sticky_sat: true
    negative_unsat: true
    // hopeful events bust UNSAT; tighter claims do not
  }
  station_type_overrides: {
    [stationTypeId]: { checkpoint: bool }  // per-type checkpoint enable; reopen is C2b not a separate flag
  }
}
```

### Policy decisions (aligned with §3.9d)

| Question | v1 | Notes |
|----------|-----|--------|
| Agg/exp shared vs exclusive | **Exclusive (DECIDED)** | Combine/share out of scope |
| Search quality | **First-fit multi-sink (DECIDED)** | Best-of-K / beam not the v1 algorithm (not a deferred deliverable) |
| Inter-leg backtrack | **to last Checkpoint (DECIDED C2b)** | **Required.** Never reopen past a checkpointed StationType. |
| Leg 1 entry | **Virtual S0 → Coupler** | **§3.7** — not Inspector-only bind |
| UNSAT invalidation | Relevance-scoped hope (§3.10) | Not global token nuke |
| Path Context | **Per Task.context**; `(port, context)` in search | §4.2 |
| Transparent facts | Inspector writes Task.context | No `publish_on_hop` registry |
| Horizon | **DEFAULT 8h** (`Policy.assembler.horizon`) | placeSpan clip — §3.9b |
| Time intervals | **Half-open `[start,end)`** | PlanSegment + timeWindow |
| Slice fail | Whole booking UNSAT | No partial commit |

---

## 8. Algorithms (implement exactly — Station model; **§3.7 / §3.9d C2 win** if conflict)

**Coupler shape:** **Option A multi-sink** (DECIDED). Pivot debate: [COUPLER_OPTION_A_VS_B.md](./COUPLER_OPTION_A_VS_B.md).

**Two Assembler layers (DECIDED — do not collapse):**

| Layer | Function | Owns |
|-------|----------|------|
| **Time** | `engineRun` / `placeBookingOverTime` | Horizon, event cuts, `projectTasking`, planSegments, same-run re-place — **§3.9b** |
| **Path** | `placeBookingPath` | Multi-leg prefilter, Oracle++ goals, Coupler, checkpoint/backtrack — **this section** |

API `resolve` / engine wake → **time layer** → path layer once per open slice (with projected peer tasking).

### 8.0 Assembler ↔ Coupler contract (path layer)

| | **Assembler (path)** | **Coupler (multi-sink + ExpandKey frontier)** |
|--|---------------|----------------------------------|
| **Job** | Legs, prefilter, Oracle++ goal set, alts, checkpoints; called **once per time slice** with projected world | One multi-sink search from **tail out-track** or **S0**; **ExpandKey frontier**; inspect at goal (+ transparent per C2d) |
| **Calls** | One `couple()` per leg segment; **inter-leg backtrack to last Checkpoint (C2b)** | Path + inspect fails stay in the **same frontier** |
| **Success** | Working overlay + route + `stationTasks`; returned to time layer (commit only after **all** slices SAT) | Path + inspect-OK `Task[]` on first-fit goal |
| **Failure** | Slice FAIL → time layer marks whole booking UNSAT | Exhaust frontier / budget → null |
| **Transparent** | Not demand legs | Middle of Link graph |
| **Does not** | Own horizon/events (time layer); one A\* per Station within a leg | Own multi-booking queue / sticky / planSegments |

```text
// placeBookingPath — one projected world, one full multi-leg bind
working = empty overlay on projectedPeerTasking   // not raw Station.tasking bag
tail = null   // first leg → virtual S0
prevContext = {}
for legIndex, leg in booking.legs:  // non-transparent only
  isLastLeg = (legIndex == last)
  candidates = Prefilter(pool of leg.stationTypeId)
  agenda = sort(Oracle++.filterForLeg(tail, candidates, remainingTypes incl. terminal))
  result = Coupler.couple(tail, goals=agenda, working, booking, leg, caps, prevContext)
  // couple: S0 if tail==null; C2d transparent inspect; goal inspect; see §8.2
  if fail:
    // C2b DECIDED: backtrack to last Checkpoint using remaining alts (C2c); else FAIL slice
    if canBacktrackToLastCheckpoint(altStack): restore; continue
    discard working; return FAIL
  apply result; keep unused goals as alts until type checkpointed (C2c)
  tail = result.tailOut            // OutPort | null
  prevContext = result.context     // last accepted Task.context on this segment
  // checkpoint previous type per §3.9d after next non-transparent OK
return OK { route, bindings, stationTasks: accepted Tasks by station on path }
// Time layer merges into PlanSegment; commits only after all slices OK (§3.9b)
```


**Wrong (void):** first leg Inspector-only; Assembler peel/`tryTarget` per goal within a segment (Option B); `backtrack_depth: 0` as v1 product (contradicts C2b); treating §8 path sketch as the whole engine (skips time).

### 8.1 placeBookingPath (path layer) — sketch

```text
// Called by placeBookingOverTime once per open slice I, with:
//   peerTasking = projectTasking(world, I.start, exclude=booking.id)
function placeBookingPath(booking, peerTasking, policy, opts={force:false}):
  // Sticky is booking-grain in the time layer (§3.9b); path layer assumes caller decided to search

  working = WorkingState(peerTasking)   // path-local overlay; reads peer then overlay
  route = []; bindings = []; stationTasks = {}
  tail = null; closedTypes = {}; prevContext = {}
  altStack = []   // C2b/C2c: remaining goals per non-checkpointed leg

  for legIndex, leg in enumerate(booking.legs):
    type = catalog.stationType(leg.stationTypeId)   // JAR-loaded StationType (canUse + inspect)
    pool = OPEN stations of type not in closedTypes
    candidates = [s for s in pool if type.canUse(s.setup, leg.request, s.liveData).ok]
    if candidates empty: return fail(NO_CANDIDATES, legIndex)

    agenda = Oracle++.goalsForLeg(tail, candidates, booking.legs[legIndex..], terminal=last)
    // sort: ExpandKey (§3.7b / §8.1c); G = station ids
    if agenda empty: return fail(UNREACHABLE, legIndex)

    result = Coupler.couple(tail, goals=agenda, working, booking, leg, caps, prevContext)
    // §8.2: S0 entry if tail==null; C2d transparent inspect; goal first-fit
    if result is null:
      if canBacktrackToLastCheckpoint(altStack): restore working/route/tail/prevContext; continue
      discard working; return fail(..., legIndex)

    apply result.pathTaken + result.taskingByStation to working
    route += result.pathTaken; bindings += …
    merge result.stationTasks into stationTasks
    tail = result.tailOut              // OutPort | null
    prevContext = result.context
    if legIndex > 0: closedTypes.add(booking.legs[legIndex-1].stationTypeId)  // after next OK

  return OK { route, bindings, stationTasks }
  // Caller (time layer) builds PlanSegment and commits after all slices succeed
```

### 8.1b Legacy first-leg bind — void (DECIDED)

```text
// REMOVED: if tail is null: bind via inspect only without Coupler
// REMOVED: while agenda: Coupler.tryTarget(...)   // Option B — not v1
```

### 8.1c Expand / agenda sort (DECIDED — lexicographic ExpandKey)

```text
// §3.7b — do NOT sum components
compare ExpandKey:
  0 preferInUse             // higher first (fill-first)
  1 preferNonTransparent    // higher first
  2 distToSegmentGoals      // lower first (Oracle++ to this couple’s multi-sink set G)
  3 distToTerminal          // lower first (Oracle++ to booking terminal Tk)
  4 neighborRank            // higher first (SmartNode; default 0)
  5 stationName             // lower first (lexicographic)
  6 portName                // lower first (lexicographic)
// sticky preferred station may be forced first when sticky_prefer (policy override)
```

### 8.2 Coupler (multi-sink + C2d — **DECIDED** implementer machine)

**Contract:** `couple(tail, goals, …)` always multi-sink.  
`goals` **G** = Assembler agenda: **set of concrete Station ids** (Oracle++ + prefilter + ExpandKey sort for push order).  
**Ranking:** ExpandKey only (§3.7b) — no `f=g+h` preference ladder.  
**Inspect fails / dead branches** stay inside one frontier until success, exhaustion, or budget.

#### 8.2.0 Graph vocabulary (ports & hops)

```text
// Physical wire: Link connects OUT track on A → IN track on B
OutPort = (stationId, trackId)     // side = out
InPort  = (stationId, trackId)     // side = in

// One Coupler hop on a real station (recorded on pathTaken):
Hop { stationId, inTrack: TrackDefId|null, outTrack: TrackDefId|null }
hop_key = (stationId, inTrack, outTrack)   // nulls are part of equality

// Search sits at an OutPort AFTER a successful inspect (ready to take Links),
// or at synthetic S0 (no station), or is attempting a goal ENTRY (first leg).
```

| Concept | DECIDED meaning |
|---------|-----------------|
| **Goal set G** | Stations (ids). **Not** precomputed full paths. |
| **Goal success** | Some station `s ∈ G` has an **inspect-OK** Task for this segment’s `request` (leg request). First such success wins (first-fit). |
| **Finish / arrival** | For non-S0: path **arrives** on an **InPort** of `s` via an online Link (or S0 entry with `inTrack=null`). Coupler then tries **legal out(s)** (or `out=null` if terminal arrival). |
| **Agenda “1:N1” examples** | Pedagogical finish labels; implementer may rank by in-track name via ExpandKey `portName`, but **membership in G is station-level**. Any legal in-track of `s ∈ G` may attempt goal inspect. |
| **Fabric between legs** | Only **transparent** stations may be traversed as intermediate hops. **Non-transparent ∉ G:** do **not** expand into them. **Non-transparent ∈ G:** goal attempts only (no “pass through” without accepting as this segment’s bind). |

#### 8.2.1 Search node & closed set

```text
SearchNode {
  locus:
    | S0                         // virtual source (first leg only)
    | OutPort                    // after inspect-OK; expand via Links
  g: int                         // hop count (S0→first station counts as 1 when that hop is accepted)
  context: Context               // copy of last accepted Task.context (or {} at start)
  pathTaken: Hop[]
  hopKeysOnPath: Set<hop_key>    // path-local anti-loop
  visitsOnPath: Map<stationId, int>
  lastLinkId: LinkId | null      // for forbid_immediate_link_backtrack
  // branch-local working tasking overlay COW (stations inspect-OK on this path)
}

// Closed-set key (DECIDED): do not re-expand the same locus+context
closedKey = (locusKey, contextFingerprint)
// locusKey: "S0" | "out:" + stationId + ":" + trackId
// contextFingerprint DEFAULT v1: stable hash of canonical JSON
//   (sort object keys; UTF-8; hash) of Context map — correctness first.
//   Perf: known stamp schemas may pack to Long bitset (§18.2) if fingerprint-equivalent.
```

| Closed-set rule | DECIDED |
|-----------------|---------|
| When marked closed | When a node is **popped** and its expansions from that locus are generated (or goal attempts from that arrival are finished) |
| Same closedKey again | **Skip** (do not re-push / do not re-expand) |
| Better `g` later | **DEFAULT v1:** first closed wins (simple). Optional later: reopen if strictly smaller `g` — not required for goldens |

#### 8.2.2 Caps & edge legality (path-local)

Before any hop is accepted onto a path:

| Check | Rule |
|-------|------|
| `Link.online` / station OPEN | Must be usable |
| `forbid_repeat_hop_key` | `hop_key ∉ hopKeysOnPath` when policy true (DEFAULT true) |
| `max_hops H` | After accepting hop, `pathTaken.length ≤ H` |
| `max_visits_per_station V` | `visitsOnPath[station] < V` before another hop on that station |
| `forbid_immediate_link_backtrack` | If policy true (DEFAULT): after arriving via Link `L` (A→B), the **next** Link must not be a **reverse** of `L` (same two endpoints swapped: B→A on the reciprocal ports). Only **immediate** next hop; later return via other paths OK |
| `legalPairs` | Candidate `(in,out)` must be in type’s legalPairs **or** entry special (`in=null`) / terminal special (`out=null`) as below |
| Exclusive CAPACITY | **Inspector** is authority on concurrent Tasks (projected peers + working). Coupler **may** cheap-skip obviously blocked exclusive resources if a claim index exists (see claims § when filled); must not accept without inspect when rules need Task fields |

#### 8.2.3 Candidate Task construction

```text
// Seed always:
candidate.context = copy(node.context)     // previous accepted Task.context or {}
candidate.bookingIds = [thisBookingId]     // inspector may merge more on return
// request material: copy into taskingConfiguration AND pass as inspect arg (option B)
//   — for goal: leg.request; for transparent mid-path: request arg = null

// Entry (first leg, S0 → station s ∈ G):
Task { input: null, output: outOrNull, … }

// Terminal arrival (last leg of booking, type needs no out):
Task { input: inTrack, output: null, … }

// Normal transparent or intermediate goal (needs out for next leg / continue fabric):
Task { input: inTrack, output: outTrack, … }  // (in,out) ∈ legalPairs
```

**Which outs to try** at a station after arrival on `inTrack` (or entry with `in=null`):

1. If **goal** `s ∈ G` and this `couple` is the **last leg** of the booking: try **`output=null` first** (terminal success), then optional outs if product still wants them (DEFAULT: null sufficient for success; do not require out).  
2. If **goal** and **more legs follow**: try each `out` with `(in,out) ∈ legalPairs` (entry: each `out ∈ outputTracks` with type allowing null-in). Order by ExpandKey components on `(station, out)` (portName, etc.).  
3. If **transparent**: try each legal `(in,out)`; order by ExpandKey.  
4. First inspect-OK for a **goal** returns from `couple` (first-fit). Transparent OK only extends the path.

#### 8.2.4 Inspect call sites (C2d + goal)

| Site | When | `request` | On OK | On FAIL |
|------|------|-----------|-------|---------|
| **Goal** | Attempt bind for `s ∈ G` | **leg request** | Return success from `couple` | Prune attempt; continue frontier |
| **Transparent** | Every accepted fabric hop | **`null`** | Overlay tasking; set `node.context` from that Task; sit at OutPort | Prune branch |
| Non-transparent ∉ G | — | — | **Never expand** | — |

Inspector is always `type.inspect(setup, working.tasking(station)+[candidate], request, liveData) → Task[] | Failure`.  
Working tasking read = branch overlay ∪ projected peers (from time layer).

#### 8.2.5 Algorithm

```text
function couple(tail, goals G, workingBase, booking, leg, caps, prevContext):
  // tail = null ⇒ first leg (S0). Else tail = OutPort from previous leg’s accepted Task.output
  // workingBase = projected peer tasking + prior legs’ overlays for this booking path
  frontier = priority queue   // pop: smaller g first, then worse-to-better ExpandKey? 
                              // DECIDED: pop min g; ties broken by ExpandKey of the *edge that created the node*
                              // (store expandKeyOnPush with each node). PreferInUse etc. already on key.
  closed = empty set
  expansions = 0
  context0 = copy(prevContext) or {}

  if tail == null:
    // --- S0: no physical Link; try each goal station as ENTRY ---
    for s in G ordered by ExpandKey(s as candidate, G):
      for out in entryOutChoices(s, isLastLeg):   // outs and/or null — §8.2.3
        push GoalAttemptEntry(s, out, g=0, context0, path=[], …)
  else:
    push Locus(OutPort=tail, g=0, context0, path=[], lastLink=null, …)

  while frontier not empty:
    n = pop_best(frontier)
    expansions++
    if expansions > max_expansions or wall exceeded: return null, BUDGET

    ck = closedKey(n.locus or n.entryKey, n.context)
    if ck in closed: continue
    closed.add(ck)

    // ===== A) Goal ENTRY attempts (from S0 only) =====
    if n is GoalAttemptEntry(s, out):
      hop = Hop(s, inTrack=null, outTrack=out)
      if !pathAllows(n, hop): continue
      cand = makeCandidate(null, out, n.context, leg.request)
      outcome = inspect(s, working(n), cand, leg.request)
      if outcome is Task[]:
        return success(path=n.path+[hop], tasking=outcome, stationTasks merge, tailOut=out)
      else:
        // optional: record inspector_samples; do NOT push children
        continue

    // ===== B) Expand from OutPort via Links =====
    assert n.locus is OutPort (stationA, outTrackA)
    edges = online Links from (stationA, outTrackA) ordered by ExpandKey(neighbor, G)
    for link in edges:
      if forbid_immediate_link_backtrack && isReverse(link, n.lastLinkId): continue
      B = link.to.stationId
      inB = link.to.trackId
      if station B is CLOSED: continue

      typeB = typeOf(B)

      // Non-transparent not in G: skip (not fabric)
      if !typeB.transparent && B ∉ G: continue

      // --- B transparent: mid-path C2d — try each legal out, inspect each ---
      if typeB.transparent:
        for outB in legalOuts(typeB, inB) ordered by ExpandKey:
          hop = Hop(B, inB, outB)
          if !pathAllows(n, hop): continue
          cand = makeCandidate(inB, outB, n.context, request=null)
          outcome = inspect(B, working(n), cand, request=null)
          if outcome is Failure: continue   // try other outs / edges
          // OK: new branch node at OutPort(B,outB)
          child = n.extend(
            path+hop, g=n.g+1, context=taskContext(outcome, cand),
            overlay apply outcome, hopKeys+hop_key, visits[B]++, lastLink=link.id,
            locus=OutPort(B,outB))
          push frontier(child, expandKey for this hop)
        continue

      // --- B ∈ G (goal station): try terminal null and/or legal outs — first OK wins couple ---
      if B ∈ G:
        for outB in goalOutChoices(typeB, inB, isLastLeg) ordered by ExpandKey:
          hop = Hop(B, inB, outB)
          if !pathAllows(n, hop): continue
          cand = makeCandidate(inB, outB, n.context, leg.request)
          outcome = inspect(B, working(n), cand, leg.request)
          if outcome is Task[]:
            return success(path=n.path+[hop], tasking=outcome, …, tailOut=outB)
          // else try next outB / next link
        continue

  return null, UNREACHABLE   // or CAPACITY if all goal attempts failed only on capacity samples
```

```text
function pathAllows(n, hop) -> bool:
  hk = hop_key(hop)
  if forbid_repeat_hop_key && hk in n.hopKeysOnPath: return false
  // DECIDED: after accepting hop, pathTaken.length must be ≤ max_hops (H)
  if n.pathTaken.length + 1 > max_hops: return false
  if visitsOnPath[hop.stationId] + 1 > max_visits_per_station: return false
  return true
```


**S0 path recording (DECIDED):** successful first-leg entry appends `Hop{stationId: s, inTrack: null, outTrack}` to `pathTaken`. There is **no** Hop for S0 itself. G12 expects start hop(s) on the real start station.

**`g` accounting (DECIDED):** each accepted Hop (including S0 entry) increments `g` by 1. ExpandKey distances stay Oracle++ topology hops — separate from `g`.

#### 8.2.6 Return value

```text
CoupleSuccess {
  pathTaken: Hop[]              // includes transparent hops + goal hop; S0 not a hop
  goalStationId: string
  goalTask: Task                // the accepted candidate as finalized in returned Task[]
  taskingByStation: Map<stationId, Task[]>  // full inspect lists applied on this path (working)
  stationTasks: Map<stationId, Task>        // this booking’s Task per station for PlanSegment
  tailOut: OutPort | null       // goal Task.output; null if terminal
  context: Context              // last accepted Task.context
}

CoupleFail { code: BUDGET | UNREACHABLE | …, samples? }
```

#### 8.2.7 Terms

| Term | Role |
|------|------|
| **Frontier** | Pending partial paths |
| **Closed set** | `(locus, contextFingerprint)` — avoid re-expand |
| **ExpandKey** | **Only** preference for push/pop tie-break |
| **`g`** | Accepted hop count — hygiene / budget narrative |
| **C2d** | Transparent inspect every hop before leaving |
| **Oracle++ distToG** | Inside ExpandKey only |

**Do not implement:** summed edgeCost; `f=g+h` overriding ExpandKey; Assembler peel / one search per goal Station; skipping transparent inspect; expanding non-transparent non-goals as fabric.

### 8.3 Bound out-track / tail — **DECIDED**

A successful goal inspect produces a **Task** with concrete **input** and **output** tracks (output may be null on terminal arrival).

| Fact | Status |
|------|--------|
| Next Coupler segment **tail** = that Task’s **output** as `OutPort` | **DECIDED** |
| If `output` is null (terminal) | No further `couple()` for this booking path |
| Binding includes station **and** the Task’s in/out | **DECIDED** |
| No post-inspect re-pick of a different out | **DECIDED** — out was chosen when the candidate was formed and inspect passed |
| Transparent outs on the path | Chosen during C2d expand; fixed on the branch that reached the goal |

Which out is proposed is Coupler expansion order (ExpandKey + legalPairs) + inspect. Engine does **not** re-rank outs after success.

---

## 9. Resolve API contract

### 9.1 Operations

| Op | Input | Output |
|----|--------|--------|
| `PUT /bookings/{id}` | `{ legs: Leg[] }` | Booking created/updated (clears snapshot if legs_hash changes) |
| `POST /bookings/{id}/resolve` | `{ force?: bool, forcePriority?: bool }` | `ResolveResult` — `force` bypasses sticky/UNSAT cache; `forcePriority` **reserved / sole deferred** (SPEC Q16 — do not implement yet) |
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

**Canonical contract:** **§3.10** (relevance-scoped sticky SAT + UNSAT bust tables).  
This section is the short implementer summary — **not** a second global-token-only contract.

### 10.1 World epochs (plant-level I/O may still bump tokens)

Coarse plant revisions may exist for Kafka/wake fan-out:

```text
topology_rev      // Links, online maps, devices online
setup_rev         // station setup changes
catalog_rev       // stations/types added-removed
policy_rev
occupancy_rev     // any reserve/release
// optional coarse hopeful_rev for wake I/O only — NOT the sticky validity contract
```

**Sticky validity is per booking** via `StickyRecord.relevantSetupEpochs` / `relevantTopoEpochs` (§3.10) — not “whole plant `hopeful_rev` unchanged.”

### 10.2 SAT validity (plan-relevant, scoped)

Snapshot valid if:

- demandHash / legs unchanged  
- plan resources still held by this booking (hard-claim)  
- **relevant** topology/setup/policy epochs for **stations/links/types on the SAT plan** still match  

**DECIDED v1:** on SAT, **hard-claim** reservations until release.  
Unrelated plant changes **do not** bust this booking’s SAT (§3.10 SAT bust table).

### 10.3 UNSAT validity (hope only, scoped)

Cached UNSAT reusable while **this booking’s demand** is unchanged and **no hopeful change** on **relevant** types/stations/links (§3.10 unsat bust table).

**Do not** bust UNSAT solely because occupancy increased from **new claims** elsewhere.

**Do** bust on: demand edit; setup on relevant types; Link opened / station OPENED useful to relevant types; tasking freed on relevant types; policy loosen.

---

## 11. Concurrency & claims

**DECIDED v1 — serial engine (no parallel booking resolves):**

1. **One engine run at a time.** Kafka (or other) triggers that need scheduling are **queued**; runs do not overlap.  
2. **World is static for the duration of a run’s read of CommittedWorld** at start of each booking step; after each booking **SAT**, commit updates CommittedWorld so the **next** booking in the same run sees new tasking.  
3. **Within a run:** bookings processed **one at a time**, ordered by priority then submitTime (FCFS). Not parallel.  
4. **Within a booking:** WorkingState overlay only; **commit on full-booking SAT**, discard on fail — no need for cross-booking locks because nothing else runs concurrently.  
5. **Force-kick preemption** (`forcePriority`) is the **sole deferred** product feature (SPEC Q16). **In scope:** priority-ordered place + same-run **plan re-place** when a higher-priority booking **SAT-commits** and takes a resource at a time event (§3.9b).  
6. Persistence: engine run may still sit in a DB txn / process-level mutex so a second process cannot run a second engine against the same plant — **serialization of runs**, not per-hop locks between parallel resolves.

**Not the product design:** concurrent multi-threaded `placeBooking` on the same world without a global engine queue (use serial runs — §11).

---

## 12. Observability

**Metrics (counters/histograms):**

- `resolve_sat`, `resolve_unsat`, `sticky_hit`, `negative_cache_hit`  
- `coupler_expansions` (p50/p99)  
- `resolve_ms`  
- `fail_code{code=}`  
- `candidates_in` / `candidates_after_inspector` per leg  

**Trace (debug):** one resolve id; log leg start, candidate counts, coupler result, fail stage.

**FailureReport samples (DECIDED):** support **capped** `inspector_samples` / failed goal arrivals (stationId, code, short path summary). Not the full frontier. May be empty on a given result if none collected; the capability is in scope.

---

## 13. Golden acceptance tests

Implement as automated tests (reference topology fixture).

| ID | Name | Expect |
|----|------|--------|
| G1 | Restricted re-entry | Path includes two Y1 hops with different hop_keys (e.g. `1:Y1:2` then `5:Y1:6`); reaches N station (see walkthrough `loopback`) |
| G2 | No oscillation | With Y1↔Y2 cables present, search cannot spin forever: `forbid_repeat_hop_key` + `max_visits_per_station` / `max_hops` / expansions → finite `BUDGET` or UNSAT (never hang) |
| G3 | Inspector context | cabinets=4 filters Normal; wrong stations rejected |
| G4 | Checkpoint | After R bind, other R stations never tried |
| G5 | Context path stamp | Short path to N-04 fails inspect (missing stamp in Task.context); path via Y2 writes stamp then N-04 succeeds |
| G6 | Capacity blocked | Reserve blocking hop; `CAPACITY` (+ blocker id; alias CAPACITY_BLOCKED) |
| G7 | Sticky SAT | resolve×2 identical route/consist; second sticky_hit |
| G8 | Negative UNSAT | fail; resolve again no hopeful change → negative_cache_hit, expansions=0 |
| G9 | Hopeful release | after release blocker, resolve may SAT |
| G10 | Determinism | shuffle station iteration order in fixture → still same bind order via sort by id |
| G11 | Duplicate yard in consist | route lists same yard_id twice when re-entered |
| G12 | First leg via S0 | leg0 binds station via virtual S0 + Coupler; route has start hop(s) |

### Reference topology (goldens / walkthroughs)

- Stations (non-transparent): R-17, R-22, N-04, N-08, N-12, D-02, D-11  
- Transparent switches: Y1/Y2 = Switch StationTypes; R-*/N-*/D-* = demand StationTypes  
- Y1 restricted legalPairs (`1→1`, `1→2`, `1→3`, `5→6`; **not** `1→6`); Y2 (`1→5`, `1→6`); Y2 inspect may write `clearance.y2_stamp` into Task.context  
- Links: Y1:1→N-04, Y1:2→Y2:1, Y1:3→N-08, Y1:6→N-12, Y2:5→N-04, Y2:6→Y1:5, N-04→D-02, N-12→D-11  
- **G5:** stamp gate is on **Normal (N-04)**, not Docking — short Y1→N-04 fails inspect; via Y2 stamp then N-04 OK  
- loopback: if Y2→N-04 closed → re-entry → N-12  
- See walkthroughs `?scenario=multiyard` and `?scenario=loopback`  

---

## 14. Phased delivery

**All phases below are required sequencing toward v1 DoD** — not a menu of optional features.  
**Only deferred product feature:** force-priority preemption (§2.0 / Q16).

| Phase | Deliverable | Exit criteria |
|-------|-------------|---------------|
| **P0** | Port graph + transparent maps + Coupler only (fixed tail → fixed station) | G1, G2 |
| **P1** | Assembler multi-leg + Prefilter/Inspector + first-fit + **checkpoint timing** + **alts (C2c)** + **inter-leg backtrack to last Checkpoint (C2b)** | G3, G4, G10, G12; multi-leg fail retries prior non-checkpointed alts |
| **P2** | Path-acquired Context via **Inspector-written Task.context** (transparent + goal inspect) | G5, G11 |
| **P3** | Reservations + `CAPACITY` | G6 |
| **P4** | Sticky SAT + negative UNSAT (bust tables §3.10) | G7, G8, G9 |
| **P5** | Oracle++ (incl. terminal/chain) + A* + metrics (budgets configurable) | p99 under budget on reference×N; G1–G12 green with full stack |
| **P6** | Kafka adapters (in/out plans, claims, setups) | SPEC §10.1; after domain goldens |

---

## 15. Threats & edge cases

| Case | Behavior DECIDED v1 |
|------|---------------------|
| Empty pool for StationType | `NO_CANDIDATES` |
| All stations busy | `ALL_BUSY` if inspect would pass else NO_CANDIDATES |
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

On reference topology: resolve &lt; 50ms.  
On ~5k cars / ~500 yards: sticky &lt; 5ms; cold resolve aim &lt; 500ms with caps; never unbounded.

---

## 18. Open items that still need a human (summary)

### 18.0 Coupler / Oracle++ status

| ID | Status |
|----|--------|
| **C2** multi-sink Option A | **DECIDED** — §3.9d C2; pivot [COUPLER_OPTION_A_VS_B.md](./COUPLER_OPTION_A_VS_B.md) |
| **Oracle++** chain + terminal reachability | **DECIDED** — §3.7 |
| **C2b** Inter-leg backtrack to last Checkpoint | **DECIDED** — §3.9d C2b; **P1** |
| **C2c** Alts until checkpoint; then discard | **DECIDED** — §3.9d C2c |
| **C2d** Transparent inspect every visit | **DECIDED** — §3.9d C2d |
| **8.3** Tail = accepted Task.output | **DECIDED** |

**Rule:** unclear → **OPEN** + ask. Do not mark DECIDED by agent inference.

Other items (confirm before production):

1. **Combine/share** on aggregator ports — **DECIDED exclusive v1**.  
2. **Numeric budgets** — **DECIDED:** defaults H=16, V=3, exp=50_000, wall_ms=500 (reference); **all configurable** per engine/resolve.  
3. **First leg** uses S0 + Coupler (**DECIDED**; old “bind only” void).  
4. **Exact Fact key conventions** for production StationTypes.  
5. **Concurrency** — **DECIDED:** serial engine runs + one booking at a time; commit on SAT (§11).  
6. **Language/runtime** — **DECIDED: Kotlin (JVM)**; package `trackplan` (see §18.1).

### 18.1 Implementation language

| Option | When it wins | When it loses |
|--------|----------------|---------------|
| **Kotlin (JVM)** | Same as other microservices; shared auth/observability/DB; team fluency; Inspector plugins as classes; Coroutines for async API | Micro-optimizing hottest A* inner loop in a systems language |
| **Rust / C++** | Extreme coupler p99 at huge mesh scale | Split stack, FFI, slower product iteration, two deploy cultures |
| **Go** | Simple deploy, fine graph search | You already standardized on Kotlin services |
| **Python** | Prototyping only | Cold-path resolve latency + typing discipline for this engine |

**DECIDED: Kotlin (JVM)** for this service (v1+).

Reasons: algorithm fit (int graph search), platform fit, Inspectors as interfaces, correctness/sticky first, escape hatch to native Coupler only if profiler demands it.

Service shape: normal microservice with REST/gRPC per §9. Tests: JUnit 5 + reference topology G1–G12.  
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

Naive: each frontier entry = new `Node(port, g, parent, contextMap)`.

Better patterns:

1. **Object pool / slab** of search nodes reused across resolves (thread-local or per-resolve arena).  
2. **Parent as `Int` index** into a slab, not a pointer to another heap node.  
3. **Path reconstruction** only on success (walk parent indices once).  
4. **Context:**  
   - If sparse keys: small fixed schema → pack into `Long` / `Int` bitset (e.g. bit per known stamp).  
   - If maps required: **persistent/shared structure** or copy-on-write only when a hop publishes — not a new `HashMap` every edge.  
   - Closed-set key = `(portId, contextFingerprint)` — fingerprint must be cheap (`Long` xor of stamps).  
5. **Closed set:** `LongOpenHashMap` / Eclipse Collections / fastutil **primitive** maps, or two-level: `BooleanArray` if context is empty, else open-addressed long set. Avoid `HashSet<Pair<Int, Map<…>>>`.  
6. **Frontier:** priority by `(g, ExpandKey…)` — binary heap of **ints** (node indices) + parallel `g[]` / ExpandKey arrays; or specialized int-heap. **Not** a separate `f[]` preference ladder. Java `PriorityQueue` of objects works for v1 but allocates.

**DEFAULT v1 pragmatic:**  
- Port = `Int`  
- Closed = `LongSet` of packed `(port, contextBits)` or just `port` if context empty for that topology  
- Frontier = `PriorityQueue` ordered ExpandKey-dominated **or** int-heap  
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
- **C2 warmup:** first resolves may be slower; warm with golden fixtures on deploy if p99 SLAs are tight.  
- Escape analysis helps stack-allocate short-lived objects — still better not to create them.  
- Avoid megamorphic call sites in expand (`edgeKind` as sealed hierarchy with many impls); prefer data-driven CSR + `when (kind)` on a byte.

#### 18.2.8 Algorithm > micro-opts (priority order)

1. Sticky SAT + negative UNSAT (skip search)  
2. prefilter shrinks goals  
3. Multi-sink one search (not per-Station / per-target A*)  
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
catalog/     StationType SPI; StationTypeRef; boot Class.forName load (id → instance)
             Station, Link, Track
stationtypes/  (or external jars) one class per type: metadata + canUse/inspect
fabric/      port graph build, Oracle++
coupler/     multi-sink search
assembler/   resolve loop (incl. C2b backtrack)
reserve/     reservations / exclusive capacity
cache/       sticky SAT + negative UNSAT
api/         debug/admin facade if needed
fixtures/    reference topology + golden tests
kafka/       inbound projection + outbound claims/setups/plans (after domain goldens)
```

---

## 20. Definition of done (v1 core)

- [ ] All **DECIDED** behaviors implemented  
- [ ] Golden tests G1–G12 green  
- [ ] Resolve API returns SAT/UNSAT with FailureReport  
- [ ] Sticky + negative cache behavior matches §10  
- [ ] Route includes transparent stations; re-entry allowed; hop_key anti-loop  
- [ ] Context from **Inspector-written Task.context** (flowing path; no publish_on_hop registry)  
- [ ] No force-priority preemption required (sole deferred — §2.0)  
- [ ] Kafka adapters may follow domain DoD (sequencing P6), but domain checklist above is complete without them  

When this checklist is green, the design docs + this spec are sufficient for another session to extend StationTypes/Inspectors without redesigning the engine. **Do not** treat DECIDED engine features as optional.
