# Consist — Full Design Spec (handoff)

**Project:** **Consist** — sticky booking assembly on a rail fabric.  
**Purpose:** Single dense document so a **new LLM session or human implementer** can continue without replaying the design chat.  
**Scope:** Product model, algorithms, decisions, open questions, remaining work.  
**Not:** UI polish, marketing, or a substitute for interactive walkthroughs.

**Name note:** *Consist* is the product/repo; a **consist** is also the domain object (bound Cars + route). The outer engine is still called **Assembler**; the path engine **Coupler**.

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
> Walkthroughs in `booking-assembler-design.html` illustrate Coupler vs Assembler and prefilter vs accept.

**Stack preference:** Kotlin (JVM) microservices, same platform as the rest of the org.

---

## 1. Problem in one paragraph

Users request an end-to-end **Booking**: an ordered chain of **Class** roles (e.g. Refrigerated → Normal → Docking), each with constraints (Setup, seats, etc.). The system must pick concrete **Cars** (instances), route through a **fabric** of **Yards** (N:M junctions with numbered tracks and restricted internal maps), respect **capacity**, and accumulate **Context** (facts from bound Cars and from visiting certain Yards). Reconfiguration is expensive and disruptive, so results must be **deterministic** and **sticky** when the world has not hopefully changed. Failed resolves must be explainable without dumping the A* open set.

There may be thousands of Cars, many Yard types, multi-hop Yard paths (including loopbacks / re-entry on different tracks), and Context that is only available after traversing part of the fabric. Pure “shortest path on devices” is wrong; pure “pick all Cars then join” is wrong because Context depends on order and path.

---

## 2. Vocabulary (rail only)

Use these terms in code, APIs, and docs. Do **not** use legacy synonyms (asset, resource type, string, switch, modem, antenna) in new modules unless bridging an old system.

| Term | Meaning |
|------|---------|
| **Class** | Catalog role / type (many Cars implement one Class) |
| **Car** | Concrete instance of a Class |
| **Setup** | Named costly mode a Class/Car can be armed into |
| **Inspector** | Per-Class logic: `prefilter` + `accept` (+ publish facts) |
| **Booking** | End-to-end reservation: legs, consist, route, context, sticky/fail |
| **Leg** | One Class requirement on a Booking (request fields + optional Setup) |
| **Consist** | Ordered bound Cars so far (grows 1, 2, 3, …) |
| **Context** | Fact map accumulated from binds + path (Yard) visits |
| **Yard** | Junction with numbered IN/OUT tracks and legal in→out pairs |
| **Track / port** | `(device, in\|out, track_id)` |
| **Hop** | `in:device:out` — one visit through a device |
| **Route** | Ordered hop list for the Booking (Yards may repeat with different hop_keys) |
| **Cable** | External edge out-track → in-track |
| **Assembler** | Outer engine: legs, candidates, Context, Coupler calls, sticky/fail |
| **Coupler** | Inner engine: multi-sink path search on ports between two Class endpoints |
| **Oracle** | Optional precomputed reachability/distances on ports |
| **Checkpoint** | Class-once: after bind, other Cars of that Class not tried for this Booking |
| **prefilter** | Cheap Assembler-side screen (path-independent / already-known Context only) |
| **accept** | Full inspection at Coupler goal (path Context + track routing + deep rules) |

**Hop syntax:** `1:Y1:1` = enter Yard Y1 on IN1, leave on OUT1.  
`5:Y1:6` = different visit (re-entry). Same Yard device can appear twice on a route with different hop_keys.

---

## 3. Architecture (non-negotiable)

### 3.1 Two layers

```text
┌──────────────────────────────────────────────────────────┐
│ ASSEMBLER                                                │
│  for each Class leg:                                     │
│    prefilter + rank Cars → goals                         │
│    if first leg: bind Car (no Coupler)                   │
│    else: result = Coupler.couple(tail → goals, context)  │
│          // BLOCKED until Coupler returns once           │
│    bind / append hops / update Context / checkpoint      │
│  sticky SAT or UNSAT FailureReport                       │
└────────────────────────┬─────────────────────────────────┘
                         │ one call per Class→Class segment
                         ▼
┌──────────────────────────────────────────────────────────┐
│ COUPLER (multi-sink BFS/A* on port graph)                │
│  start = tail Car outs                                   │
│  goals = prefilter-passers of next Class                 │
│  expand cables + Yard legal in→out                       │
│  path may visit 0..many Yards of many types              │
│  on reach goal: accept() with path Context               │
│    fail → continue search (do NOT return to Assembler)   │
│    ok   → early return { car, hops[], context }          │
│  exhausted / budget → failure                            │
└──────────────────────────────────────────────────────────┘
```

### 3.2 Wrong vs right interaction

| Wrong | Right |
|-------|--------|
| Coupler returns each failed short path to Assembler; Assembler starts a new A* | All tries (short N-04, N-12, then Y2…) happen **inside one** `couple()` |
| Assembler steps every Yard as a “leg” | Assembler only steps **Classes**; Yards are Coupler fabric |
| Full `accept` at Assembler drops cars for missing path stamps | `prefilter` only safe drops; stamps checked in `accept` at goal |
| Closed set = port only after failed accept at N-04 | State includes Context (or don’t close goals after accept-reject) so Y2 path can succeed later |

### 3.3 Long corridors / many Yard types

Booking legs `ClassA → ClassZ` with only Yards between ⇒ **one Coupler call**.  
Path may be `A-car → Y₁ → Y₂ → … → Y₁₂ → Z-car`.  
Twelve yard **types** = different `legal_pairs` / capacity / `publish_on_hop`, not twelve Assembler steps.

### 3.4 Why try short path to next Class before extra Yards?

**Search cost heuristic**, not domain knowledge of which Yard publishes stamps.

- Prefer fewer Yard hops / earlier approach to Class goal ports when costs are equal-ish.
- When stamp already in Context, short path wins quickly.
- When stamp missing, short arrivals fail `accept`, search **continues** and may discover Y2 via other edges.
- Inspector **never** names Y2; it only rejects missing Context keys.
- Algorithm discovers publishers by exploring the fabric with path Context in state.

**DEFAULT v1:** small positive cost per Yard hop (or per new Yard device on path). Not a hard ban on Yards before all Class attempts.

---

## 4. Inspector: prefilter vs accept

### 4.1 Rule

| Stage | When | Context | May reject only if… |
|-------|------|---------|---------------------|
| **prefilter** | Assembler, before Coupler | Prior legs only | No future path could fix it |
| **accept** | Coupler, at goal port | Prior + path-acquired | Full fitness for this arrival |

### 4.2 Concrete example (Normal, seats > 5)

**Request:** Class Normal, `min_seats: 6`.  
**Deep check:** Car must support internal routing e.g. track 1 → track 2 on the arrival path.

```text
prefilter(request, car, context):
  if car.max_seats < 6: reject("SEATS")   // path never adds seats
  if offline / cannot arm Setup: reject(...)
  return ok   // even if y2_stamp missing — path may supply it

accept(request, car, context, arrival):
  if car.max_seats < 6: reject("SEATS")
  if not car.can_route(arrival.in, arrival.out): reject("TRACK_ROUTE")
  if need stamp and missing from context: reject("CONTEXT")
  return ok
```

| Car | seats | prefilter | accept (examples) |
|-----|-------|-----------|-------------------|
| N-04 | 8 | pass → A* goal | may fail stamp on short path; may pass after Y2 |
| N-08 | 4 | **fail SEATS** — never a goal | never searched |
| N-12 | 12 | pass → A* goal | may fail TRACK_ROUTE on some arrivals |

### 4.3 What goes in which stage (checklist for new Classes)

**prefilter-safe:** max capability, offline, hard firmware/protocol “never”, Setup impossible, facts already required from **prior binds** and already known missing.  
**accept-only:** path stamps, arrival track pair, isolation vs path, anything that depends on **how** you got there.

---

## 5. Fabric model (ports, not devices)

### 5.1 Graph

- **Nodes:** ports `(device_id, side, track_id)` (or equivalent expand state).  
- **Edges:**  
  - **Cables:** out-track of A → in-track of B  
  - **Internal:** legal `(in→out)` on same Yard/Car per type map  
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
2. **Context:** short cable exists, but `accept` fails until a Yard hop publishes a fact (e.g. Y2 stamp).

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
**Do** bust on: release, topology expand, setup unlock, new Car online, policy loosen, legs edit.

### 6.4 Why

Reconfiguring assets disconnects live traffic and costs time. Sticky + deterministic search avoid thrashing.

---

## 7. Failure reporting

Fail at the **first pipeline stage** that emptied options; do not dump A* open set to users.

**Pipeline:**

```text
Catalog → prefilter → (Coupler: geometry / capacity / budget) → accept at goal
```

**Codes (stable):**  
`NO_CANDIDATES`, `INSPECTOR_REJECT` / accept samples, `ALL_BUSY`, `UNREACHABLE`, `CAPACITY_BLOCKED`, `BUDGET`, `CONTEXT_DEAD_END`, `POLICY`.

**Checkpoints:** later failures scoped to locked Cars (“failed under R-17”). Not proof another Car would work until reopen.

**Explainability:** optional Coupler debug log of failed goal arrivals (short path tries) for operators — still not Assembler round-trips.

---

## 8. Performance (mechanism, not UI)

```text
time ≈ Σ_legs ( candidates_tried × cost(couple_search) )
```

Levers:

1. Sticky / negative cache  
2. prefilter shrinks goals  
3. Checkpoint closes Classes  
4. **One multi-sink search per segment** (not one A* per Car)  
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
- Y2 `publish_on_hop: clearance.y2_stamp`.  
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
| **Fabric** | Cables add/remove, Yard maps, Yard online, publish_on_hop |
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
| **Setups** | Which Setup each used Car (and Yard if applicable) should arm |
| **Route / hop list** (optional) | Full plan for audit/ops |
| **UNSAT / failure** (optional topic or same topic with status) | Why a Booking cannot be placed |

Consumers of those topics: device controllers, UI, inventory — **not** this service’s Coupler.

### 10.1.4 Suggested topic roles (names illustrative)

```text
in:  catalog.classes / catalog.cars / fabric.cables / fabric.yards
in:  bookings.commands  (create/update/cancel)
in:  occupancy.events   (optional external claims)

out: bookings.plans     (status sat|unsat, consist, route summary)
out: claims.commands    (claim/release Car + hop resources)
out: setups.commands    (arm Setup on Car/Yard)
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
| W1 | **Canonical data model** | Shared types | Entities in BUILD_SPEC §3; invariants (route may repeat Yard; hop_key unique) | **Done in BUILD_SPEC** — confirm extras (only Car+Yard?) |
| W2 | **Resolve API** | Service boundary | PUT booking, POST resolve/release, FailureReport, force, sticky flags | **Done in BUILD_SPEC §9** — choose HTTP vs library only |
| W3 | **Policy registry** | Tunables without code change | H, V, expansions, wall_ms, first_fit, checkpoint overrides | **Done defaults §7** — confirm numbers |
| W4 | **Inspector SPI + guide** | New Classes without engine rewrite | prefilter/accept/publish/required_path_facts; seats vs TRACK_ROUTE example | **Done SPI §5** — **need production Class schemas** |
| W5 | **Yard type catalog** | Fabric rules | direct/agg/expand/restricted/full + capacity | **Done exclusive v1** — OPEN combine |
| W6 | **Fact / Context schema** | Inter-leg + path facts | Namespacing, FactPatch, who publishes when | **Done §4** — **enumerate real stamps/Yards** |
| W7 | **Concurrency & claims** | Multi-Booking safety | Txn, lock order, hard claim on SAT | **Done §11** |
| W8 | **Golden tests G1–G12** | Prevent regressions | Toy topology + behaviors listed in BUILD_SPEC | **Specified** — implement with code |
| W9 | **Observability** | Ops | sticky_hit, expansions p99, fail codes | **Specified §12** |
| W10 | **Non-goals / threats / phases** | Scope control | P0–P6, edge cases | **Done §2,14,15** |
| W11 | **Coupler explain log** | Debug multi-Yard tries | Structured “goal reject” events (path summary, accept code) | **Not written** — recommend for ops |
| W12 | **Cost model details** | Yard-bias, re-Setup penalty | Numeric weights, piggyback ranking formula | **Partial** — defaults only |
| W13 | **Oracle design** | Scale | What is precomputed, invalidation on topology change | **Partial** — optional phase |
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
- **Impact:** reservation model, CAPACITY_BLOCKED rates.

### Q2. Backtrack when checkpoint blocks later leg?

- **Options:** 0 (fail + report); reopen last Class; full backtrack.  
- **DEFAULT v1:** 0.  
- **Discuss if:** success rate too low with first-fit + checkpoint.  
- **Impact:** complexity, reconfig cost if reopen forces re-Setup.

### Q3. First-fit vs best of K goals / paths?

- **Options:** first acceptable; continue to price top-K; global optimize.  
- **DEFAULT v1:** first-fit multi-sink.  
- **Discuss if:** path quality / load balance matters more than latency.  
- **Impact:** Coupler runtime.

### Q4. First Class leg: bind without fabric?

- **Options:** bind only; always attach via headend Yard; virtual source.  
- **DEFAULT v1:** bind only if no tail.  
- **Discuss if:** production always has a fixed headend.  
- **Impact:** first Coupler call index.

### Q5. Path Context in Coupler state

- **Options:** `(port, context)` always; waypoints from `required_path_facts`; pseudo-legs.  
- **DEFAULT v1:** context in Coupler state + publish_on_hop on expand.  
- **Discuss if:** state explosion too large — then waypoints.  
- **Impact:** correctness of multi-Yard stamp discovery.

### Q6. Which Yards publish which facts?

- **Options:** empty default; instance lists; type-level templates.  
- **DEFAULT v1:** instance `publish_on_hop`.  
- **Discuss:** production catalog.  
- **Impact:** which paths can unlock accept().

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

- **DEFAULT:** optional samples (path summary + accept code), capped.  
- **Discuss:** PII/ops needs.  
- **Impact:** explainability of multi-Yard discovery.

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

**Need (product):** Bookings can carry a **priority**. Normal resolve only uses **free** resources. If Coupler exhausts with CAPACITY_BLOCKED, the user may request **force priority**: use this Booking’s priority to **displace lower-priority Bookings** holding desired resources, then claim them.

**This needs more design before coding.** Below is a strawman, not DECIDED.

#### Modes

| Mode | Behavior |
|------|----------|
| **Normal** (default) | Only free Cars/hops/tracks. Exhaust → `CAPACITY_BLOCKED` (or busy). No kicks. |
| **Force priority** | Explicit user/API flag on resolve. May treat resources held by **strictly lower** priority Bookings as preemptable; build a plan that includes **evictions** + new claims. |

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
| Vocabulary | Rail: Class, Car, Yard, Booking, … |
| Architecture | Assembler outer + Coupler inner |
| Coupler unit of work | One segment between two Classes; early success or exhaust |
| Failed path tries | Inside Coupler only |
| Path graph | Ports + hop_key, not device-only |
| Re-entry | Allowed on different hop_keys |
| Quality | Sub-optimal OK (first-fit, class-once) |
| Determinism + sticky | Required (reconfig cost) |
| UNSAT cache | Hopeful invalidation, not every claim |
| Inspector split | prefilter (Assembler) + accept (Coupler goal) |
| Seats example | prefilter seats; accept track route + stamps |
| Path context discovery | Goal-reject + continue; don’t hardcode Yard names in Inspector |
| Prefer short path to Class | Cost bias, not hard rule |
| Stack | Kotlin preferred |
| IO shape | Kafka in (world/demand) → resolve when needed → Kafka out (claims, setups, plans) |
| Kafka in v1 engine | **Not required** — pure domain + goldens first; adapters later |
| Booking priority / force kick | **OPEN (Q16)** — field may exist; force preemption not in v1 engine; needs eviction design |
| Docs | SPEC (this) + BUILD_SPEC + interactive HTML offline |

---

## 14. Suggested next session agenda

1. Confirm/override **§12 OPEN** defaults (especially Q1, Q2, Q4, Q8, Q9).  
2. Draft **W14** production Class table (even incomplete).  
3. Implement **P0–P2** per BUILD_SPEC (Coupler → Assembler+prefilter → path Context).  
4. Port goldens G1–G12 on toy topology.  
5. Only then Kafka adapters (**W17**): projection, reschedule policy, plan/claim/setup publishers.  
6. Real topology import + policy numbers from profiling.

---

## 15. Anti-patterns (do not implement)

1. Device-level Dijkstra without tracks.  
2. Assembler round-trip per failed path.  
3. Full accept at Assembler that drops cars for missing path-only facts.  
4. Closed-set by port alone after accept-reject (blocks later stamped arrival).  
5. “Never visit Yard twice.”  
6. Parallel assign all Classes then stitch.  
7. Re-resolve all UNSAT on every process start without hopeful check.  
8. Putting legacy names (asset, string, switch) in new Kotlin packages.

---

## 16. File map

```text
docs/
  SPEC.md                         ← this handoff (full picture)
  BUILD_SPEC.md                   ← implementer contracts + goldens
  README.md                       ← index
  booking-assembler-design.html   ← interactive (prefilter/accept, multi-yard, …)
  FIXTURE_STUDIO.md               ← topology + booking golden UI (design only)
  vendor/                         ← cytoscape + mermaid (offline)
```


---

*End of Consist SPEC. When in doubt: Assembler owns Booking/Class state; Coupler owns one fabric segment; prefilter is cheap and path-blind; accept is thorough and path-aware; sticky beats re-search when the world has not hopefully improved.*
