# Trackplan — Full Design Spec (handoff)

**Project:** **Trackplan** — sticky booking placement on Stations (asset scheduling under the covers).  
**Purpose:** Single dense document so a **new LLM session or human implementer** can continue without replaying the design chat.  
**Scope:** Product model, algorithms, decisions, open questions, remaining work.  
**Not:** UI polish, marketing, or a substitute for interactive walkthroughs.

**Canonical entities and latest engine decisions:** prefer **[BUILD_SPEC.md](./BUILD_SPEC.md) §1–§3** (StationType/Station/Tasking). Some later SPEC sections still use older Class/Car/Yard wording — treat BUILD_SPEC as authoritative where they conflict.

**Engines:** **Assembler** (outer), **Coupler** (inner path search).

| Doc | Role |
|-----|------|
| **This file (`SPEC.md`)** | Full picture, rationale, open questions, handoff checklist |
| [`BUILD_SPEC.md`](./BUILD_SPEC.md) | Implementable contracts: schemas, defaults, goldens G1–G12, Kotlin notes |
| [`booking-assembler-design.html`](./booking-assembler-design.html) | Interactive scenarios + diagrams (offline via `docs/vendor/`) |
| [`FIXTURE_STUDIO.md`](./FIXTURE_STUDIO.md) | Design for golden-authoring UI (not implemented) |
| [`README.md`](./README.md) | Index |

**Builder prompt (copy-paste):**

> Read `docs/SPEC.md` for full design intent, then implement `docs/BUILD_SPEC.md`.  
> Rail vocabulary only. Pass goldens G1–G12. No UI. Follow DECIDED/DEFAULT; ask only on OPEN items that block you.  
> Walkthroughs in `booking-assembler-design.html` illustrate Coupler vs Assembler and prefilter vs inspect.

**Stack preference:** Kotlin (JVM) microservices, same platform as the rest of the org.

---

## 1. Problem in one paragraph

Users request an end-to-end **Booking**: an ordered chain of **Class** roles (e.g. Refrigerated → Normal → Docking), each with constraints (Setup, seats, etc.). The system must pick concrete **Cars** (instances), route through a **fabric** of **Yards** (N:M junctions with numbered tracks and restricted internal maps), respect **capacity**, and accumulate **Context** (facts from bound Cars and from visiting certain Yards). Reconfiguration is expensive and disruptive, so results must be **deterministic** and **sticky** when the world has not hopefully changed. Failed resolves must be explainable without dumping the A* open set.

There may be thousands of Cars, many Yard types, multi-hop Yard paths (including loopbacks / re-entry on different tracks), and Context that is only available after traversing part of the fabric. Pure “shortest path on devices” is wrong; pure “pick all Cars then join” is wrong because Context depends on order and path.

---

## 2. Vocabulary

Use these terms in code, APIs, and docs. Asset scheduling under the covers; **Stations** are the domain cover.

| Term | Meaning |
|------|---------|
| **StationType** | Catalog type (schemas, inspector, heuristics, `transparent`) — *not* JVM `Class` |
| **Station** | Instance of a StationType (setup + tasking + tracks) |
| **transparent** | StationType omitted from Booking demand; path filler (e.g. switch) |
| **Track** | Named IN or OUT endpoint on a Station |
| **Link** | Topology: one station’s OUT track → another’s IN track |
| **Setup** | Semi-static station properties (schema on type, values on station); not booking-driven |
| **Tasking** | List of **Tasks** on a Station — live/planned-live source of truth |
| **Task** | One use of a station: input, output, **context**, taskingConfiguration |
| **Request** | User demand on a Booking leg (may be `{}` for transparent path work) |
| **Inspector** | Per-StationType: `(setup, tasking, request) → tasking \| fail` (same API all types) |
| **Booking** | Demand legs + plan (bindings, route, failure, sticky) |
| **Leg** | Non-transparent StationType + request |
| **Hop** | One visit: `in:station:out` (includes transparent stations) |
| **Route** | Full hop path after resolve (user-visible plan; may revisit station with new hop_key) |
| **Assembler** | Outer engine: legs, agenda, checkpoints, sticky, incremental resolve |
| **Coupler** | Inner engine: path between leg endpoints on the station graph |
| **Trackplan** | Project name (formerly Consist) |
| **liveData** | Live metrics on a Station (not setup, not request); can block inspect |
| **Prefilter** | Cheap screen: setup + request + liveData; no Task |
| **Binding** | Plan record: this Booking uses this Station (leg or path) |

**Bridge:** ResourceType→StationType · Asset→Station · Class/Car→StationType/Station · Yard→transparent StationType · Cable→Link · Port→Track.

**Hop syntax:** `1:SW1:2` = enter station SW1 on IN1, leave on OUT2.  
Re-entry: same station twice only with a different hop_key `(stationId,in,out)`.

---

## 3. Architecture (non-negotiable)

### 3.1 Two layers

```text
┌──────────────────────────────────────────────────────────┐
│ ASSEMBLER                                                │
│  for each StationType leg (non-transparent):             │
│    prefilter → candidate Stations                        │
│    agenda = sort(oracleFilter(finishes))  // goal set    │
│    first leg: virtual S0 → Coupler (not Inspector-only)  │
│    else: Coupler from previous Task.out                  │
│    ONE multi-sink couple(goals=agenda) per segment try   │
│    remaining agenda → alts only if a *later* leg fails   │
│    checkpoint type only after *next* non-transparent OK  │
│    commit tasking only on whole-Booking SAT              │
│  sticky SAT or UNSAT FailureReport                       │
└────────────────────────┬─────────────────────────────────┘
                         │ one couple() per segment attempt
                         ▼
┌──────────────────────────────────────────────────────────┐
│ COUPLER (multi-sink BFS/A* on port / track graph)        │
│  start = tail outs (or virtual S0)                       │
│  goals = full agenda finishes (not one Station at a time)│
│  expand Links + legal in→out on stations                 │
│  path may visit 0..many transparent stations             │
│  on reach goal: Inspector.inspect(...) → Task[] | fail   │
│    fail → continue search (do NOT return to Assembler)   │
│    ok   → early return { station, hops[], tasking }      │
│  exhausted / budget → failure                            │
└──────────────────────────────────────────────────────────┘
```

**Agenda vs multi-sink — DECIDED Option A (multi-sink).** Assembler builds Oracle++-filtered goals; one `couple(goals=…)` per segment; inspect/path fails stay in Coupler. Option B (peel) is **not v1** — debate/pivot: [COUPLER_OPTION_A_VS_B.md](./COUPLER_OPTION_A_VS_B.md). Oracle++ also filters sinks by reachability to later non-transparent types and the **terminal** StationType (BUILD_SPEC §3.7).

### 3.2 Wrong vs right interaction

| Wrong | Right |
|-------|--------|
| Coupler returns each failed short path / inspect reject to Assembler; Assembler starts a **new** A* (one A* per Station / per agenda peel within the same segment) | All tries (short N-04, N-12, then via Y2…) happen **inside one** multi-sink `couple(goals=agenda)` |
| Assembler steps every transparent station as a “leg” | Assembler only steps **non-transparent StationTypes**; fabric is Coupler |
| Full `inspect` at Assembler drops stations for missing path stamps | `prefilter` only safe drops; stamps checked in `inspect` at goal |
| Closed set = port only after failed inspect at N-04 | State includes Context (or don’t close goals after inspect-reject) so Y2 path can succeed later |
| (Confusion) “agenda peel” means one Coupler call per target | Agenda builds **goals=** for multi-sink; Assembler re-calls Coupler only for **inter-leg backtrack** with remaining alts |

### 3.3 Long corridors / many transparent types

Booking legs `StationTypeA → StationTypeZ` with only transparent stations between ⇒ **one Coupler call**.  
Path may be `A-station → SW₁ → SW₂ → … → SW₁₂ → Z-station`.  
Twelve transparent **types** = different `legalPairs` / capacity / Inspector context writes, not twelve Assembler steps.

### 3.4 Why try short path to next non-transparent type before extra transparent hops?

**Search cost heuristic**, not domain knowledge of which switch writes stamps.

- Prefer fewer transparent hops / earlier approach to next-type goal ports when costs are equal-ish.
- When stamp already in Task.context, short path wins quickly.
- When stamp missing, short arrivals fail **inspect**, search **continues** and may discover Y2 via other edges.
- Inspector **never** names Y2; it only rejects missing context keys.
- Algorithm discovers stamp writers by exploring the fabric; **Inspectors** write keys into Task.context on visit (no `publish_on_hop` registry).

**DEFAULT v1:** small positive cost per transparent hop (or per new transparent station on path). Not a hard ban on transparent hops before all non-transparent attempts.

---

## 4. Inspector: prefilter vs inspect

### 4.1 Rule

| Stage | When | Context | May reject only if… |
|-------|------|---------|---------------------|
| **prefilter** | Assembler, before Coupler | No path context (setup + request + liveData only) | No future path could fix it |
| **inspect** | Coupler, at goal port **and** every transparent visit | Prior + path-acquired Task.context | Full fitness for this arrival / hop |

### 4.2 Concrete example (Normal, seats > 5)

**Request:** StationType Normal, `min_seats: 6`.  
**Deep check:** Station must support internal routing e.g. track 1 → track 2 on the arrival path.

```text
// Prefilter — no Task, no path context
prefilter(setup, request, liveData):
  if station.max_seats < 6: reject("SEATS")   // path never adds seats
  if offline / cannot arm Setup: reject(...)
  return ok   // even if clearance.y2_stamp missing — path may supply it via Inspectors

// Inspect — BUILD_SPEC shape: setup, tasking+[candidate], request, liveData → Task[] | Failure
inspect(setup, tasking, request, liveData):
  // candidate Task carries input/output/context from Coupler path
  if setup.max_seats < 6: fail("SEATS")
  if not can_route(candidate.input, candidate.output): fail("TRACK_ROUTE")
  if need stamp and missing from candidate.context: fail("CONTEXT")
  return updated Task[]   // may extend Task.context for downstream
```

| Station | seats | prefilter | inspect (examples) |
|---------|-------|-----------|-------------------|
| N-04 | 8 | pass → multi-sink goal | may fail stamp on short path; may pass after Y2 |
| N-08 | 4 | **fail SEATS** — never a goal | never searched |
| N-12 | 12 | pass → multi-sink goal | may fail TRACK_ROUTE on some arrivals |

### 4.3 What goes in which stage (checklist for new StationTypes)

**prefilter-safe:** max capability, offline, hard firmware/protocol “never”, Setup impossible, facts already required from **prior binds** and already known missing.  
**inspect-only:** path stamps, arrival track pair, isolation vs path, anything that depends on **how** you got there.

---

## 5. Fabric model (ports, not devices)

### 5.1 Graph

- **Nodes:** ports `(device_id, side, track_id)` (or equivalent expand state).  
- **Edges:**  
  - **Cables:** out-track of A → in-track of B  
  - **Internal:** legal `(in→out)` on same Station per type `legalPairs`  
- **Hop key:** `(device_id, in_track, out_track)` — unique on a Booking route (anti-loop).  
- **Re-entry allowed:** same Yard twice if hop_key differs (`1:Y1:1` then later `5:Y1:6`).

### 5.2 Yard types (behavior families)

| Type | Internal rule sketch | Capacity DEFAULT v1 |
|------|----------------------|---------------------|
| direct | only `k→k` | exclusive hop_key |
| aggregator | many `i→Ag` | exclusive on `Ag` |
| expander | `Ag→` many j | exclusive on `Ag` and outs |
| restricted | sparse legal matrix | exclusive hop_key |
| full | dense N×N | exclusive hop_key |

**OPEN:** true multi-Booking share/combine on Ag (RF combine). **DEFAULT v1:** exclusive only.

### 5.3 Two reasons for multi-Yard / loopback

1. **Track map:** short internal pair illegal (e.g. cannot `1→6` on Y1).  
2. **Context:** short Link exists, but **inspect** fails until a transparent hop’s Inspector writes a fact into Task.context (e.g. Y2 stamp).

Both can apply on one Booking.

---

## 6. Determinism, sticky, negative cache

### 6.1 Determinism

- Stable sort of candidates (sticky id first, then rank_cost, then car id).  
- Stable edge expansion order when costs tie.  
- No random open-set order.  
- Prefer single-threaded resolve for reproducibility (or deterministic reduction).

### 6.2 Sticky SAT

Persist consist + full hop list + setups + world token.  
Re-resolve with same legs and valid world → **identical** assignment, no re-Setup, no search.

### 6.3 Negative UNSAT

Cache failure + reason under a **hopeful** token.  
**Do not** bust UNSAT only because someone else claimed more capacity (world tighter).  
**Do** bust on: release, topology expand, setup unlock, new Station online, policy loosen, legs edit.

### 6.4 Why

Reconfiguring assets disconnects live traffic and costs time. Sticky + deterministic search avoid thrashing.

---

## 7. Failure reporting

Fail at the **first pipeline stage** that emptied options; do not dump A* open set to users.

**Pipeline:**

```text
Catalog → prefilter → (Coupler: geometry / capacity / budget) → inspect at goal (and transparent visits)
```

**Codes (stable) — canonical names from BUILD_SPEC §9.3:**  
`NO_CANDIDATES`, `INSPECT_FAIL` (alias: `INSPECTOR_REJECT`), `ALL_BUSY`, `UNREACHABLE`, `CAPACITY` (alias: `CAPACITY_BLOCKED`), `BUDGET`, `CONTEXT_DEAD_END`, `POLICY`.

**Checkpoints:** later failures scoped to locked Stations (“failed under R-17”). Not proof another Station would work until reopen.

**Explainability:** optional Coupler debug log of failed goal arrivals (short path tries) for operators — still not Assembler within-segment round-trips.

---

## 8. Performance (mechanism, not UI)

```text
time ≈ Σ_legs ( candidates_tried × cost(couple_search) )
```

Levers:

1. Sticky / negative cache  
2. prefilter shrinks goals  
3. Checkpoint closes Classes  
4. **One multi-sink search per segment** (not one A* per Station / target)  
5. Oracle optimistic reachability + A* heuristic  
6. Hard caps: H hops, V visits/yard, max expansions, wall clock  
7. hop_key anti-loop  
8. Integer port ids + CSR adjacency (Kotlin)  
9. Prefer fewer yards as **cost bias** only  

**Not v1:** parallel A* per neighbor of 5 edges (overhead); parallel all legs (Context breaks).

---

## 9. Toy topology (docs + goldens)

```text
R ──► Y1 ──┬── N-04 ──► D
           ├── N-08
           ├── N-12 only after re-entry (Y1 out6)
           └── Y2 ──┬── N-04 (out5)
                    └── Y1 in5 (out6 loopback) → Y1 5→6 → N-12
```

- No out-port multiplex; illegal Y1 `1→6` so N-12 needs loopback re-entry.  
- Y2 Inspector may write `clearance.y2_stamp` into Task.context on visit.  
- Interactive scenarios: simple, multiyard (Y2→N-04 free), **loopback** (useful re-entry + anti-spin guards / G1·G2), prefilter, nosol, sticky.  
- Offline assets: `docs/vendor/cytoscape.min.js`, `mermaid.min.js`.

---

## 10. Implementation language

**Preferred: Kotlin (JVM)** — matches other microservices; Inspector as interfaces; Coupler on int ports + CSR.  
Optimize representation and caches before considering Rust for the expand loop only.

**Performance detail (CSR, value classes, GC, closed-set, arenas, profiling):** see **`BUILD_SPEC.md` §18.2**. Summary: algorithm + sticky first; then **Int port ids**, **CSR adjacency**, **no String/HashMap in expand**, pack Context into bits/`Long`, avoid per-expansion `data class` nodes, single-thread Coupler, profile before micro-opts.

---

## 10.1 Deployment shape: Kafka microservice (not in v1 engine scope)

This service is a **Kotlin microservice** in an event-driven platform:

| Direction | Role |
|-----------|------|
| **In** | Kafka topics describing **world + demand** changes |
| **Core** | In-memory/DB projection of catalog/fabric/bookings + **resolve / re-schedule** when needed |
| **Out** | Kafka topics with **plans**: claims (Cars, hops/tracks) and **Setups** to apply on Cars used by Bookings |

**Out of scope for the first engine slice:** Kafka client wiring, topic schemas in production registries, exactly-once plumbing, consumer group ops. Those wrap the core once goldens pass.

### 10.1.1 Input classes (conceptual)

Consumers apply events into a **projected world state** (same entities as the data model):

| Input area | Examples of change |
|------------|-------------------|
| **Classes / catalog** | New Class, Setup allowed, Inspector policy flags |
| **Cars** | Online/offline, Setup armed, config blob, capacity |
| **Fabric** | Links add/remove, transparent maps, Station/Link online, Inspector context rules |
| **Bookings / demand** | New Booking, legs edited, cancel, priority |
| **External occupancy** (if any) | Claims held by other systems |

Events should be treatable as **upserts/deletes** into the projection (idempotent handlers).

### 10.1.2 When to run scheduling (resolve)

Do **not** re-resolve every message blindly. Classify each change:

| Change kind | Action |
|-------------|--------|
| **Hopeful** (can create capacity / new options) | Invalidate affected **UNSAT** caches; enqueue re-resolve for affected Bookings (or all pending if coarse) |
| **Tightening** (claims elsewhere, car offline used by others) | Invalidate **SAT** for Bookings using those resources; re-resolve those |
| **Legs / demand change** | Invalidate that Booking’s sticky + UNSAT; resolve |
| **No-op / unrelated** | Update projection only |
| **Topology map change** | Rebuild CSR/oracle; re-validate all SAT paths; re-resolve broken or all open Bookings per policy |

**DEFAULT v1 policy (coarse is OK):**

1. Apply event to projection + bump `topology_rev` / `occupancy_rev` / `setup_rev` / `catalog_rev` / `hopeful_rev` as appropriate (same idea as sticky/negative cache).  
2. Compute **affected Booking set** (or “all non-terminal Bookings” if cheap).  
3. For each: sticky revalidate if possible; else `resolve()`.  
4. Emit outputs only when plan **changes** (or on explicit force).

**OPEN:** fine-grained “which Bookings touch cable X” index vs re-resolve all open Bookings. Start coarse if Booking count is modest.

### 10.1.3 Outputs (plans)

After a successful (or updated) resolve, publish **intentions** other services execute:

| Output | Meaning |
|--------|---------|
| **Claims** | Which Cars, hop_keys / tracks / cables this Booking holds |
| **Setups** | Which Setup each used Station (including transparent) should arm |
| **Route / hop list** (optional) | Full plan for audit/ops |
| **UNSAT / failure** (optional topic or same topic with status) | Why a Booking cannot be placed |

Consumers of those topics: device controllers, UI, inventory — **not** this service’s Coupler.

### 10.1.4 Suggested topic roles (names illustrative)

```text
in:  catalog.classes / catalog.cars / fabric.cables / fabric.yards
in:  bookings.commands  (create/update/cancel)
in:  occupancy.events   (optional external claims)

out: bookings.plans     (status sat|unsat, consist, route summary)
out: claims.commands    (claim/release Station + hop resources)
out: setups.commands    (arm Setup on Station)
```

Exact names/schemas = platform standard (Avro/Protobuf/JSON). **Not implemented in engine v1.**

### 10.1.5 Module boundary

```text
kafka/          // adapters only — map events → domain commands
  inbound handlers → update projection + schedule policy
  outbound mappers ← Plan / Claim / Setup domain events

domain/         // BUILD_SPEC core — no Kafka types
  assembler, coupler, inspectors, fabric, reserve, cache
```

Domain must stay **testable without Kafka** (goldens G1–G12 pure).

---

## 11. What else to document / implement (fleshed out)

This expands the design-doc “What else to document” list into **actionable work packages**. Each has: purpose, minimum content, status.

| # | Work package | Purpose | Minimum content | Status |
|---|--------------|---------|-----------------|--------|
| W1 | **Canonical data model** | Shared types | Entities in BUILD_SPEC §3; invariants (route may re-enter station with new hop_key) | **Done in BUILD_SPEC** |
| W2 | **Resolve API** | Service boundary | PUT booking, POST resolve/release, FailureReport, force, sticky flags | **Done in BUILD_SPEC §9** — choose HTTP vs library only |
| W3 | **Policy registry** | Tunables without code change | H, V, expansions, wall_ms, first_fit, checkpoint overrides | **Done defaults §7** — confirm numbers |
| W4 | **Inspector SPI + guide** | New StationTypes without engine rewrite | prefilter/inspect; seats vs TRACK_ROUTE example; context keys via Inspector | **Done SPI BUILD_SPEC §5** — **need production StationType schemas** |
| W5 | **Yard type catalog** | Fabric rules | direct/agg/expand/restricted/full + capacity | **Done exclusive v1** — OPEN combine |
| W6 | **Fact / Context schema** | Inter-leg + path facts | Namespacing, FactPatch, who publishes when | **Done §4** — **enumerate real stamps/Yards** |
| W7 | **Concurrency & claims** | Multi-Booking safety | Txn, lock order, hard claim on SAT | **Done §11** |
| W8 | **Golden tests G1–G12** | Prevent regressions | Toy topology + behaviors listed in BUILD_SPEC | **Specified** — implement with code |
| W9 | **Observability** | Ops | sticky_hit, expansions p99, fail codes | **Specified §12** |
| W10 | **Non-goals / threats / phases** | Scope control | P0–P6, edge cases | **Done §2,14,15** |
| W11 | **Coupler explain log** | Debug multi-switch tries | Structured “goal reject” events (path summary, inspect code) | **Not written** — recommend for ops |
| W12 | **Cost model details** | Yard-bias, re-Setup penalty | Numeric weights, piggyback ranking formula | **Partial** — defaults only |
| W13 | **Oracle++ design** | Scale | Reach next type, between non-transparent types, to terminal; hop `h`; topology rebuild | **DECIDED intent** BUILD_SPEC §3.7 — index shape engineering |
| W14 | **Real Class catalog** | Production | Each Class: request JSON schema, prefilter rules, accept rules, facts, path facts, checkpoint | **OPEN — product** |
| W15 | **Migration bridge** | Legacy names | Optional map only; rail terms in new code | **Optional** |
| W16 | **Kotlin service skeleton** | Ship | packages: catalog, inspectors, fabric, coupler, assembler, reserve, cache, api, fixtures | **Not started** |
| W17 | **Kafka adapters** | Production IO | Topic list, event→projection, reschedule policy, plan/claim/setup publishers; domain free of Kafka types | **Specified §10.1 — implement after engine goldens** |
| W18 | **Reschedule impact index** | Scale | Optional index Booking↔cable/car for fine-grained re-resolve | **OPEN — start coarse** |
| W19 | **Priority + force preemption** | Ops override when free search fails | Priority model, force flag, eviction set, cascade limits, Kafka order (release victims → claim winner), audit | **OPEN — SPEC Q16; not v1** |

---

## 12. Open questions (flesh-out)

Each item: decision needed, options, recommendation, impact if wrong.

### Q1. Aggregator / expander capacity: exclusive vs share?

- **Options:** exclusive hop/Ag; soft share with physics rules; scheduled mutex.  
- **DEFAULT v1:** exclusive.  
- **Discuss if:** real fabric allows multi-Booking combine on Ag.  
- **Impact:** reservation model, `CAPACITY` rates.

### Q2. Backtrack when a later leg fails? — **RESOLVED**

- **Was:** DEFAULT depth 0 (fail + report only).  
- **DECIDED (BUILD_SPEC §3.9d C2b, P1 required):** inter-leg backtrack **up to the last Checkpoint**; never reopen a checkpointed StationType. Alts retained until checkpoint (C2c).  
- **Required** in v1 / P1 Assembler (not optional).  
- **Impact:** Assembler alt stack + restore working overlay; budgets/heuristics still critical.

### Q3. First-fit vs best of K goals / paths?

- **Options:** first acceptable; continue to price top-K; global optimize.  
- **DEFAULT v1:** first-fit multi-sink.  
- **Discuss if:** path quality / load balance matters more than latency.  
- **Impact:** Coupler runtime.

### Q4. First Class leg: bind without fabric? — **RESOLVED / SUPERSEDED**

- **Was (stale):** bind only if no tail (Inspector-only first leg).  
- **DECIDED (see §3.1, BUILD_SPEC §3.7 / §8.1b):** first leg always goes through **virtual S0 → multi-sink Coupler** — **not** Inspector-only bind without fabric. First StationType inputs are unused; Coupler picks a start Station via S0 edges + inspect.  
- **Do not implement** the old “bind only if no tail” default.

### Q5. Path Context in Coupler state

- **Options:** `(port, context)` always; waypoints from `required_path_facts`; pseudo-legs.  
- **DEFAULT v1 / DECIDED in BUILD_SPEC:** context in Coupler state as `(port, context)`; keys written only by **Inspector** on visit.  
- **Discuss if:** state explosion too large — then waypoints.  
- **Impact:** correctness of multi-switch stamp discovery.

### Q6. Who writes path facts into Task.context? — **RESOLVED**

- **Was:** separate `publish_on_hop` lists on yards/instances.  
- **DECIDED (BUILD_SPEC §4.2):** **Inspector is the only writer** of Task.context keys (optional per type; not every inspect writes). No `publish_on_hop` registry.  
- **Impact:** transparent visit = candidate Task + inspect; stamps appear when that Inspector writes them.

### Q7. UNSAT invalidation granularity

- **Options:** hopeful_rev counter; dependency sets per failure.  
- **DEFAULT v1:** hopeful_rev.  
- **Discuss if:** high claim rate causes either too many retries or too few.  
- **Impact:** CPU vs freshness.

### Q8. Production Class list and request schemas

- **Options:** (product)  
- **DEFAULT:** toy R/N/D only for tests.  
- **Discuss:** must complete before production Inspectors.  
- **Impact:** all of product.

### Q9. Numeric policy (H, V, expansions, wall_ms, yard hop cost)

- **DEFAULT:** H=16, V=3, exp=50k, wall=500ms, small yard hop cost.  
- **Discuss:** after profiling on real topology size.  
- **Impact:** BUDGET vs success rate.

### Q10. Soft hold during resolve vs hard claim only on SAT

- **DEFAULT v1:** txn locks during resolve; hard claim on SAT.  
- **Discuss:** multi-tenant contention.  
- **Impact:** races, UX of concurrent Booking.

### Q11. Should Coupler expose debug “failed arrivals” in FailureReport?

- **DEFAULT / DECIDED:** optional capped samples (path summary + inspect code).  
- **Discuss:** PII/ops needs.  
- **Impact:** explainability of multi-switch discovery.

### Q12. Language / deploy

- **DEFAULT:** Kotlin microservice.  
- **Discuss:** only if platform constraint.  
- **Impact:** team velocity.

### Q13. Kafka topic contracts & ordering

- **Options:** platform-standard schemas; single multiplex topic vs many.  
- **DEFAULT:** separate conceptual streams (catalog/fabric/bookings in; plans/claims/setups out); exact names TBD with platform.  
- **Discuss:** ordering guarantees (per Booking key?), compaction on catalog.  
- **Impact:** dual-write races, sticky validity.

### Q14. Reschedule scope on each event

- **Options:** all open Bookings; only Bookings touching changed resources; debounce window.  
- **DEFAULT v1:** coarse (open Bookings + optimistic sticky revalidate); debounce optional.  
- **Discuss:** when Booking count / event rate grows.  
- **Impact:** CPU vs plan freshness.

### Q15. Who applies Setups/claims — this service or downstream?

- **DEFAULT:** this service **publishes commands**; actuators apply and may emit occupancy confirmations.  
- **Discuss:** if actuators are slow, need provisional vs confirmed claims.  
- **Impact:** CAPACITY_BLOCKED races, two-phase claim.

### Q16. Booking priority and forced preemption (“force priority”)

**Need (product):** Bookings can carry a **priority** (**1 = highest**).  

**Already DECIDED in BUILD_SPEC (not full force-kick):**

| Mechanism | In v1? |
|-----------|--------|
| Place queue: priority 1 first, then FCFS **submitTime** | **Yes** |
| **Priority steal / plan re-place:** higher-priority booking **SAT-commits** at time event T and takes a station; lower-priority booking is **re-placed in the same engine run** for affected slices (multi planSegments) | **Yes** (§3.9b) — scheduling repair, logged as normal re-resolve |
| **Force priority** API flag: treat lower-priority holders as preemptable even without a clean place-first pass; eviction cascade/audit | **Sole deferred** — strawman below; **do not implement** until designed |

**This force-kick mode is the only product feature we are not building yet.** Needs more design before coding. Strawman only:

#### Modes

| Mode | Behavior |
|------|----------|
| **Normal + ordered place** (v1) | Priority queue + free capacity in time-sliced tasking views. Steal = re-place lower plan after higher commits. |
| **Force priority** (OPEN) | Explicit user/API flag. May treat resources held by **strictly lower** priority as preemptable; build plan with **evictions** + new claims. |

#### What “kick” means (options)

1. **Soft:** mark victim Bookings `displaced` / re-queue resolve; release claims; then place the high-priority Booking.  
2. **Hard atomic:** one transaction: release victims’ overlapping resources, claim for winner, emit claims/setups for winner + cancel/replan victims.  
3. **Two-phase:** propose eviction set → human/ops confirm → commit (safer for live RF).

#### Strawman algorithm (for discussion)

```text
resolve(booking, forcePriority=false):
  result = couple/assemble using only free resources
  if result.ok or not forcePriority: return result

  // force path
  result2 = couple/assemble where occupancy of bookings with priority < this
            is treated as free (or soft-blocked with cost)
  if result2.fail: return still blocked (even after preemption)
  victims = bookings owning resources in result2.route/consist
  return {
    status: SAT_WITH_PREEMPTION,
    plan: result2,
    evict: victims,           // must re-resolve or go UNSAT
    warnings: [...]
  }
```

**Important:** Coupler should not silently steal. Preemption is an **Assembler/policy** concern: either (a) occupancy filter ignores lower-priority claims when `forcePriority`, or (b) search returns a path plus required victim set for a separate commit step.

#### Open sub-questions (must answer before implement)

| # | Question | Notes |
|---|----------|--------|
| P1 | Total order on priority? Ties? | Numeric rank vs tiers; stable tie-break (booking id) |
| P2 | Who can set force flag? | Auth / ops only? |
| P3 | Partial preemption? | Kick only overlapping hops vs whole victim Booking |
| P4 | Cascade | Victim re-resolve may force-kick someone else? Depth limit? |
| P5 | Sticky of victims | Force-invalidate sticky; emit release + optional auto re-plan |
| P6 | Setup cost of victims | Kicking causes reconfig downtime — surface in UX |
| P7 | Same priority | Never kick equal/higher (DEFAULT recommendation) |
| P8 | Audit | Always log who kicked whom and why |
| P9 | Interaction with checkpoints | Winner’s plan after free search failed — full re-search with expanded free set |
| P10 | Kafka outputs | Additional events: `booking.evicted`, claim releases, then winner claims/setups order |

#### Recommendations until decided

- **DEFAULT v1 engine:** priority field stored on Booking; **ignored** for placement except logging. Force flag **rejected** or no-op with clear “not implemented.”  
- **Do not** mix force into first Coupler search without an eviction plan in the result.  
- Prefer **explicit result type** `SAT_WITH_PREEMPTION` + victim list over silent claim overwrite.  
- Prefer **no cascade** or cascade depth 1 for first cut.

#### Relation to failure codes

| Situation | Code / status |
|-----------|----------------|
| No free path, force=false | `CAPACITY_BLOCKED` |
| No path even after treating lower priority as free | `CAPACITY_BLOCKED` or `PREEMPTION_INSUFFICIENT` |
| Path only with kicks, force=true | `SAT_WITH_PREEMPTION` + `evict[]` |

---

## 13. Decision log (from design sessions)

| Decision | Choice |
|----------|--------|
| Vocabulary | StationType, Station, Track, Link, Booking, Route (rail cover) |
| Architecture | Assembler outer + Coupler inner |
| Coupler unit of work | **Option A multi-sink** — one `couple(goals)` per segment; pivot doc if revisit B |
| Failed path / inspect tries | Inside Coupler only (same open set); inter-leg backtrack to last Checkpoint (C2b/c) |
| First leg | Virtual S0 → multi-sink Coupler (not Inspector-only) |
| Oracle++ | Topology reachability next type + non-transparent chain + terminal |
| Path graph | Ports + hop_key, not device-only |
| Re-entry | Allowed on different hop_keys |
| Quality | Sub-optimal OK (first-fit, class-once) |
| Determinism + sticky | Required (reconfig cost) |
| UNSAT cache | Hopeful invalidation, not every claim |
| Inspector split | prefilter (Assembler) + inspect (Coupler goal) |
| Seats example | prefilter seats; inspect track route + stamps |
| Path context discovery | Goal-reject + continue; don’t hardcode Yard names in Inspector |
| Prefer short path to Class | Cost bias, not hard rule |
| Stack | Kotlin preferred |
| IO shape | Kafka in (world/demand) → resolve when needed → Kafka out (claims, setups, plans) |
| Kafka in v1 engine | **Not required** — pure domain + goldens first; adapters later |
| Booking priority place + same-run re-place | **In v1** |
| Force-kick preemption (`forcePriority`) | **Sole deferred** — SPEC Q16; not building yet |
| Docs | SPEC (this) + BUILD_SPEC + interactive HTML offline |

---

## 14. Suggested next session agenda

1. Confirm/override **§12 OPEN** defaults (especially Q1, Q2, Q8, Q9; **Q4 resolved** — virtual S0).  
2. Draft **W14** production Class table (even incomplete).  
3. Implement **P0–P2** per BUILD_SPEC (Coupler → Assembler+prefilter → path Context).  
4. Port goldens G1–G12 on toy topology.  
5. Only then Kafka adapters (**W17**): projection, reschedule policy, plan/claim/setup publishers.  
6. Real topology import + policy numbers from profiling.

---

## 15. Anti-patterns (do not implement)

1. Device-level Dijkstra without tracks.  
2. Assembler round-trip per failed path.  
3. Full inspect at Assembler that drops stations for missing path-only facts.  
4. Closed-set by port alone after inspect-reject (blocks later stamped arrival).  
5. “Never visit transparent station twice.” (re-entry on new hop_key is allowed)  
6. Parallel assign all Classes then stitch.  
7. Re-resolve all UNSAT on every process start without hopeful check.  
8. Putting legacy names (asset, string, switch) in new Kotlin packages.

---

## 16. File map

```text
docs/
  SPEC.md                         ← this handoff (full picture)
  BUILD_SPEC.md                   ← implementer contracts + goldens
  COUPLER_OPTION_A_VS_B.md        ← multi-sink vs peel (v1 = A; pivot record)
  README.md                       ← index
  booking-assembler-design.html   ← interactive (prefilter/inspect, multi-yard, …)
  FIXTURE_STUDIO.md               ← topology + booking golden UI (design only)
  vendor/                         ← cytoscape + mermaid (offline)
```


---

*End of Trackplan SPEC. When in doubt: Assembler owns Booking/StationType state; Coupler owns one fabric segment; prefilter is cheap and path-blind; inspect is thorough and path-aware; sticky beats re-search when the world has not hopefully improved.*
