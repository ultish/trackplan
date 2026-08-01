# Consist Fixture Studio

**Status:** design only — **not implemented**  
**Audience:** humans and agents who will build test tooling after (or alongside) the domain engine  
**Related:** [BUILD_SPEC.md](./BUILD_SPEC.md) (entities, goldens G1–G12), [SPEC.md](./SPEC.md), [booking-assembler-design.html](./booking-assembler-design.html) (narrative walkthroughs)

---

## 1. Problem

Real Consist worlds have:

- Many **Classes** (each with its own prefilter / accept / facts)
- Many **Cars**, **Yards**, **ports**, **cables**, legal in→out maps
- **Occupancy** (closed edges, claims, busy hop_keys)
- **Bookings** as ordered Class legs with request fields
- Optional multi-step stories (sticky re-resolve, hopeful release)

Hand-authoring JSON fixtures for that is slow and error-prone. Walkthrough HTML teaches *behavior*, but is not a golden factory. Goldens drift from the “true” toy story when topology is only described in prose.

**Need:** a small web UI to **build topology + world state + bookings**, then **export deterministic fixtures** the engine tests can load.

---

## 2. Product name and non-goals

| Name | Role |
|------|------|
| **Consist Fixture Studio** (or **Consist Studio**) | Author fixtures / goldens |
| **Consist** (engine) | Assembler + Coupler domain library/service |

### This is not

- Production ops UI for live Bookings  
- A replacement for design walkthroughs (`booking-assembler-design.html`)  
- A requirement that Coupler runs in the browser on day one  
- A free-form drawing app that invents its own schema  

### This is

A **test asset factory**: construct `world` + `booking` (+ optional `expect`) using the **same rail vocabulary and shapes as BUILD_SPEC**, export files CI can assert on.

---

## 3. Why it is useful

| Pain | Studio helps by |
|------|-----------------|
| Combinatorial Class × fabric × occupancy | Point-and-click world; export JSON |
| Prefilter vs accept confusion | Show candidate stages before/after prefilter (static or via resolve) |
| Loopback / closed cables | Paint capacity; document expected re-entry path |
| Sticky / negative cache | Multi-step scripts on one fixture |
| G1–G12 + beyond | Grow suite without hand-editing hop lists |
| Onboarding | Same model as SPEC; less “read 1000 lines of JSON” |

**ROI is high even if Phase A only exports JSON and never runs the engine.**

---

## 4. Core user flows

### 4.1 Topology / catalog

1. Add **Classes** (or pick from a registry of toy Inspectors: Refrigerated, Normal, Docking, …).  
2. Place **Cars** (Class instance, config blob e.g. seats, ports).  
3. Place **Yards** (type, legal pairs, `publish_on_hop`).  
4. Draw **cables** out-track → in-track.  
5. Enforce studio rules that match engine policy for the toy (e.g. **no out-port multiplex** unless user opts into advanced mode).

### 4.2 World state (not only geometry)

- Online/offline devices  
- Closed / capacity-blocked cables or hop_keys  
- Existing claims / other Bookings’ reservations (for CAPACITY_BLOCKED goldens)  
- Armed Setups on Cars  

Geometry without occupancy cannot express G6, loopback-closed, sticky conflict, etc.

### 4.3 Booking as test case

1. Create **Booking**: ordered **legs** `(class_id, request)`.  
2. Optional metadata: id, priority (field only until force is designed).  
3. Optional **script** of actions: `resolve`, `resolve` again (sticky), `release`, mutate world, `resolve`.  

### 4.4 Expect (optional but recommended)

```text
Expect {
  status: SAT | UNSAT
  code?: FailureCode           // NO_CANDIDATES, CAPACITY_BLOCKED, BUDGET, …
  consist_car_ids?: string[]   // ordered binds
  route_hop_keys?: HopKey[]    // or hop strings "in:device:out"
  sticky_hit?: bool
  negative_cache_hit?: bool
  // loose match options: ignore hop order within segment, etc. — DEFAULT exact
}
```

Phase A may ship without expect (export world+booking only). Phase B+ should make expect easy so CI is one command.

### 4.5 Export / import

| Artifact | Contents |
|----------|----------|
| `world.json` | Classes, Setups, Cars, Yards, Cables, occupancy, policy overrides |
| `booking.json` | Legs + ids |
| `script.json` | Optional multi-step resolve/release |
| `expect.json` | Optional assertions |
| `fixture.manifest.json` | Name, description, tags (`loopback`, `prefilter`, `G6`), schema version |

**Round-trip required:** load export back into Studio without loss. That is the acceptance test for the Studio itself.

---

## 5. Schema contract (source of truth)

**DECIDED (design):** Studio export **must** map 1:1 to BUILD_SPEC §3 entities (and §7 Policy where needed).  

- Do **not** invent parallel “UI-only” ids without a stable export mapping.  
- Prefer the same field names as BUILD_SPEC so Kotlin tests deserialize once.  
- Schema version field on every fixture: `consist_fixture_version: 1`.  

Walkthrough HTML may remain a **narrative** view; Studio fixtures are the **machine** view. When they diverge, **fixtures + BUILD_SPEC win** for tests.

---

## 6. UI → schema → Kotlin tests (important)

Studio does **not** need to spit out Kotlin source files for each scenario. Prefer:

```text
  Fixture Studio (browser)
           │  export
           ▼
  fixtures/G6_capacity/          ← pure data (JSON)
    world.json
    booking.json
    expect.json
    manifest.json
           │  load at test time
           ▼
  Kotlin test runner (JUnit)
    kotlinx.serialization (or Jackson) → domain types
    resolve(world, booking) → assertEquals(expect, actual)
```

### 6.1 What the UI generates

| Output | Role |
|--------|------|
| **JSON fixtures** | The golden corpus (checked into git) |
| **JSON Schema** (optional, once) | Validates Studio export + Kotlin can codegen types if desired |
| **Not** (DEFAULT) | Per-test `.kt` files generated by the UI |

Hand-written Kotlin stays thin: **one generic test** (or a few) that parameterize over `fixtures/**`.

### 6.2 Kotlin side (DEFAULT v1 pattern)

**Shared model** (single source for deserialize + engine):

```kotlin
// engine or consist-fixtures module
@Serializable
data class WorldFixture(
  val consist_fixture_version: Int = 1,
  val classes: List<ClassDef>,
  val cars: List<Car>,
  val yards: List<Yard>,
  val cables: List<Cable>,
  val occupancy: Occupancy = Occupancy(),
  // …
)

@Serializable
data class BookingFixture(…)

@Serializable
data class ExpectFixture(
  val status: Status,
  val code: FailureCode? = null,
  val consist_car_ids: List<String>? = null,
  val route_hops: List<String>? = null,  // "1:Y1:2", …
  val sticky_hit: Boolean? = null,
)
```

**Loader + runner:**

```kotlin
class GoldenFixtureTest {
  @ParameterizedTest
  @MethodSource("allFixtures")
  fun golden(dir: Path) {
    val world = loadWorld(dir / "world.json")
    val booking = loadBooking(dir / "booking.json")
    val expect = loadExpect(dir / "expect.json")
    val result = Assembler.resolve(world.toDomain(), booking.toDomain())
    assertMatches(expect, result)
  }

  companion object {
    @JvmStatic fun allFixtures(): List<Path> =
      Paths.get("fixtures").listDirs() // or classpath resources
  }
}
```

Adding a Studio-exported folder under `fixtures/` **automatically** becomes a test. No Kotlin edit per scenario.

### 6.3 Where schema lives

| Option | Pros | Cons |
|--------|------|------|
| **A. Kotlin `@Serializable` types first** | One model for engine + tests; Studio copies field names from BUILD_SPEC / OpenAPI dump | Studio needs a published schema doc |
| **B. JSON Schema first** | Studio validates on export; `jsonschema2kotlin` or hand types | Two places to keep in sync if engine drifts |
| **C. Both** — BUILD_SPEC is human SSOT; Kotlin types implement it; JSON Schema generated from Kotlin in CI | Best for longer term | Slightly more pipeline |

**DEFAULT:** **A** for early Consist — implement domain/fixture DTOs in Kotlin once; document fields in BUILD_SPEC; Studio exports JSON that matches those names. Add JSON Schema in CI when Studio is built (validate fixtures in PR).

### 6.4 What *not* to do (usually)

| Approach | Why avoid as default |
|----------|----------------------|
| UI emits `G6Test.kt` with hardcoded asserts | Merge noise, hard to review, regenerating overwrites hand tweaks |
| UI emits SQL inserts | Wrong layer for unit goldens |
| Duplicate “UI model” vs “engine model” | Drift; double deserialize |

**Optional later:** codegen a *type-safe* `Fixtures.kt` index (`object G6 { val path = … }`) for IDE navigation — still loads JSON, does not embed the world graph in source.

### 6.5 Multi-step scripts (sticky, release)

```text
script.json
  steps: [
    { "op": "resolve", "booking": "B1", "expect_ref": "expect_1.json" },
    { "op": "resolve", "booking": "B1", "expect_ref": "expect_sticky.json" },
    { "op": "release", "booking": "blocker" },
    { "op": "resolve", "booking": "B1", "expect_ref": "expect_after_release.json" }
  ]
```

Kotlin runner interprets `script.json` if present; otherwise single resolve + one expect.

### 6.6 Layout vs golden data

- `layout.json` (x,y for Studio) — **not** required by Kotlin tests.  
- Goldens assert **ids, hops, status, codes**, not pixel positions.

### 6.7 CI picture

```text
PR:
  1. validate fixtures/*.json against schema (optional)
  2. ./gradlew test   # parameterized goldens
Studio is not in CI — only its exports are.
```

---

## 7. Phased delivery

| Phase | Deliverable | Engine required? | Exit criteria |
|-------|-------------|------------------|---------------|
| **A — Author & export** | Topology + occupancy + booking editors; download JSON | No | Round-trip load; export matches BUILD_SPEC shapes; can recreate current toy world |
| **B — Expect + library** | expect.json UI; seed G1–G12 as loadable fixtures | No (manual expect) | Each golden has a fixture folder under e.g. `fixtures/` |
| **C — Highlight declared path** | Paint expect hops on fabric (static) | No | Review loopback/multiyard without running code |
| **D — Live resolve** | “Run” calls local Consist API or in-process/WASM | Yes | Diff actual vs expect; red/green |
| **E — Generators** | Constrained random worlds / bookings | Optional | Fuzz corpus from same schema |

**Recommendation:** implement **A** as soon as entity types stabilize enough for toy Classes; do **not** block A on Coupler completeness. **D** after P0–P2 engine slices.

Kotlin golden runner (load JSON → resolve → assert) can ship with the engine **before** Studio exists: hand-write a few fixture folders, then let Studio author the rest.

---

## 8. UX principles

1. **Rail vocabulary only** — Class, Car, Yard, Cable, Hop, Booking, Leg, Consist, prefilter, accept.  
2. **Port-first** — show IN/OUT tracks; hops are `in:device:out`.  
3. **One cable per out** (DEFAULT in Studio for toy mode) — matches current design; advanced multiplex is opt-in later.  
4. **Separate geometry from occupancy** — “delete cable” ≠ “close cable for this test.”  
5. **Scenarios are fixtures**, not slides — multi-step script object, not PowerPoint.  
6. **Offline-friendly** for local use; no CDN hard dependency for core authoring (same spirit as design docs).  
7. **Determinism** — export sorted ids; no random node positions in golden files (layout may be separate `layout.json` if needed).

---

## 9. Relationship to existing artifacts

| Artifact | Role vs Studio |
|----------|----------------|
| `booking-assembler-design.html` | Teaching / product narrative; keep |
| Goldens G1–G12 (BUILD_SPEC §13) | Target consumers of Studio exports |
| SPEC / BUILD_SPEC | Schema and behavior contracts |
| Kafka (SPEC §10.1) | Later: Studio might simulate “projected world” snapshots; not Phase A |

Suggested repo layout (when built):

```text
consist/
  docs/                 # SPEC, BUILD_SPEC, this doc, design HTML
  fixtures/             # exported goldens (G1…, custom)
  studio/               # Fixture Studio web app (Phase A+)
  engine/               # Kotlin domain (later)
```

---

## 10. UI stack (interactive Studio)

Studio must feel like a real editor: **drag nodes**, **click to select**, **connect ports**, **forms for text/numbers**, not a static diagram.

### 10.1 Recommended DEFAULT

| Layer | Choice | Why |
|-------|--------|-----|
| App shell | **React + Vite + TypeScript** | Fast local dev, huge ecosystem for forms/DnD |
| Topology canvas | **[React Flow](https://reactflow.dev/)** (`@xyflow/react`) | Built for node editors: drag, select, connect, custom nodes, minimap, undo-friendly patterns; **MIT**, no commercial license |
| Forms / panels | **React** controlled inputs (+ optional **shadcn/ui** or plain CSS) | Class request fields, occupancy toggles, booking legs |
| State | **Zustand** or React context | World + selection + dirty flag for export |
| Port fabric detail | Custom node interiors in React Flow **or** side-panel SVG | Ports as connection handles on nodes |

**Why React Flow over Cytoscape for Studio:** Cytoscape is strong for *analysis / highlight*; React Flow is strong for *authoring* (the interaction model Studio needs). Keep Cytoscape only in the design walkthrough HTML if you want; Studio can be a separate app.

### 10.2 Interaction map (what the lib must support)

| User action | Implementation sketch |
|-------------|------------------------|
| Drag Car / Yard | React Flow node drag; persist `layout.json` x,y |
| Click device | Selection → right panel (config, seats, legal pairs) |
| Connect cable | Edge create from **out handle** → **in handle** (1:1 out rule in editor) |
| Delete / close edge | Delete = remove cable; “closed” = occupancy flag (not geometry) |
| Add booking leg | List UI + Class dropdown + request form |
| Export | Button → download JSON fixtures |

### 10.3 Alternatives (if not React)

| Stack | When |
|-------|------|
| **Vue + Vue Flow** | Team prefers Vue; same interaction model as React Flow |
| **Svelte Flow** | Prefer Svelte |
| **Konva / Fabric.js** | Full freeform canvas; you reimplement node/edge UX yourself — slower |
| **JointJS (Rappid free tier / community)** | Classic diagramming; heavier API, license check for advanced |
| **Plain SVG + pointer events** | Only for a tiny prototype; not DEFAULT for full Studio |

**Avoid for Studio:** libraries aimed only at static viz or analytics graphs without first-class connect/drag handles.

### 10.4 Other notes

| Concern | Guidance |
|---------|----------|
| Port-level truth | Handles = track ids; edges store `from: {device, track}` / `to: {device, track}` matching BUILD_SPEC Cable |
| Accessibility | Keyboard select + panel forms for fields that must be precise (ids, seats) |
| Hosting | Local Vite app; no production deploy required |
| Engine bridge (Phase D) | HTTP to local Consist service, or CLI `consist-test fixtures/G1` |
| Offline | Prefer npm-bundled deps (same spirit as design docs vendor/) |

---

## 11. Success metrics

- Time to add a new golden (world + booking + expect) **&lt; 30 minutes** for someone who knows the domain.  
- Zero hand-edited hop lists for new tests once path is painted/accepted.  
- Round-trip: export → reload → byte-identical canonical JSON (sorted).  
- At least the **current toy topology** loadable as a starter template.  
- CI runs `fixtures/**` against the engine without Studio in the pipeline (export is pure data).

---

## 12. Open questions

| # | Question | DEFAULT until decided |
|---|----------|------------------------|
| Q1 | Store layout (x,y) in fixture or separate file? | Separate `layout.json` so goldens ignore pixels |
| Q2 | Multi-booking worlds in one fixture? | Yes for capacity tests; one “primary” booking under test |
| Q3 | Inspector plugins in Studio? | Toy registry only (hard-coded Class forms) until W14 catalog |
| Q4 | Browser resolve vs CLI only for Phase D? | CLI first (simpler CI); browser optional |
| Q5 | Who can edit production-like Class schemas? | Product; Studio only hosts forms driven by schema registry |
| Q6 | Generate Kotlin source from Studio? | **No** — JSON + one parameterized test runner |
| Q7 | Schema SSOT: Kotlin types vs JSON Schema? | Kotlin DTOs first; JSON Schema optional in CI |

---

## 13. Work package sketch (for planning)

| ID | Package | Depends |
|----|---------|---------|
| **FS0** | Kotlin fixture DTOs (`@Serializable`) + `loadFixture(dir)` + `assertMatches` | BUILD_SPEC §3 |
| **FS0b** | Optional JSON Schema export from DTOs / hand schema for Studio validation | FS0 |
| **FS1** | Phase A Studio: edit + export + import JSON | FS0 field names stable |
| **FS2** | Seed fixtures for G1–G12 (+ multiyard / loopback stories) | FS0 (hand JSON OK before Studio) |
| **FS3** | Phase C static expect paint | FS1 |
| **FS4** | Phase D resolve runner + diff | Engine P0+ |
| **FS5** | Phase E generators | FS0, domain invariants |

Engine goldens G1–G12 remain **required** for the domain. Studio accelerates **creating and maintaining** them; it does not replace implementing Coupler/Assembler.

---

## 14. Decision log

| Decision | Choice |
|----------|--------|
| Build a fixture UI? | **Yes** — high value for test authoring |
| Scope | Fixture / golden author, **not** production Consist UI |
| Phase A without engine? | **Yes** — export JSON first |
| Schema source of truth | **BUILD_SPEC** entities |
| Walkthrough HTML | Keep for teaching; fixtures for machine tests |
| Studio → Kotlin bridge | **JSON fixtures + parameterized JUnit loader** (not generated `.kt` per case) |
| Kotlin model | Shared `@Serializable` DTOs aligned with BUILD_SPEC |
| Studio UI stack | **React + Vite + React Flow (`@xyflow/react`)** + form panels; MIT |

---

*End of Fixture Studio design. Implement only when ready; until then, hand fixtures and design walkthroughs remain valid.*
