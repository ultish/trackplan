# Trackplan Fixture Studio

**Status:** design only — **not implemented**  
**Audience:** humans and agents who will build test tooling after (or alongside) the domain engine  
**Related:** [BUILD_SPEC.md](./BUILD_SPEC.md) (canonical model §1–§3, goldens G1–G12), [SPEC.md](./SPEC.md), [booking-assembler-design.html](./booking-assembler-design.html) (narrative walkthroughs)

**Canonical vocabulary:** StationType, Station, Track, Link, Setup, Tasking, Task, Request, Prefilter, Inspector, Booking, Leg, Route, Hop, Binding, Assembler, Coupler, Oracle++, agenda, multi-sink, transparent, liveData, edgeCost, NeighborRank.

**Bridge (old → new):** Class/Car → StationType/Station · Yard → transparent StationType · Cable → Link · Port → Track · Consist (old project name) → Trackplan · consist_car_ids → bindings / route station ids · `consist_fixture_version` → `trackplan_fixture_version`.

---

## 1. Problem

Real Trackplan worlds have:

- Many **StationTypes** (each with schemas, Prefilter / Inspector, heuristics, `transparent?`)
- Many **Stations**, **Tracks**, **Links**, legal in→out pairs (on type)
- **World state:** setup, **tasking** (Task[] — assignment source of truth), liveData; Station OPEN/CLOSED; Link.online
- **Bookings** as ordered non-transparent StationType legs with request fields, priority, timeWindow
- Optional multi-step stories (sticky re-resolve, hopeful release, planSegments)

Hand-authoring JSON fixtures for that is slow and error-prone. Walkthrough HTML teaches *behavior*, but is not a golden factory. Goldens drift from the “true” toy story when topology is only described in prose.

**Need:** a small web UI to **build topology + world state + bookings**, then **export deterministic fixtures** the engine tests can load.

---

## 2. Product name and non-goals

| Name | Role |
|------|------|
| **Trackplan Fixture Studio** | Author fixtures / goldens |
| **Trackplan** (engine) | Assembler + Coupler domain library/service |

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
| Combinatorial StationType × fabric × tasking | Point-and-click world; export JSON |
| Prefilter vs Inspector confusion | Show candidate stages: prefilter (setup/request/liveData) then inspect-on-arrival |
| Loopback / offline Links | Paint Link.online; document expected re-entry path |
| Sticky / negative cache (relevance-scoped) | Multi-step scripts on one fixture |
| G1–G12 + beyond | Grow suite without hand-editing hop lists |
| Onboarding | Same model as BUILD_SPEC; less “read 1000 lines of JSON” |

**ROI is high even if Phase A only exports JSON and never runs the engine.**

---

## 4. Core user flows

### 4.1 Topology / catalog

1. Add **StationTypes** (or pick from a registry of toy types: Refrigerated, Normal, Docking, Switch/transparent, …).  
2. Place **Stations** (instance of a StationType; setup blob; tracks come from type).  
3. Drag **out-track → in-track** to create a **Link** (`from` OUT → `to` IN).  
4. Toggle **Station online** (OPEN/CLOSED) and **Link.online**.  
5. **Multi-link allowed** (e.g. many upstream outs into one terminal in-track). Inspector rules decide concurrent legality — not a global “one link per out” hard law. Studio may **optionally warn** in toy mode if an out has multiple Links (see §8).

No separate Yard entity. Switches and similar junctions are **transparent StationTypes** with IN/OUT tracks and legal pairs.

### 4.2 World state (not only geometry)

Geometry alone cannot express capacity, sticky conflict, or mid-window re-place goldens. Author:

| Layer | What Studio edits |
|-------|-------------------|
| **setup** | Semi-static props per Station (firmware, max seats, …) — not booking-driven |
| **tasking** | `Task[]` on each Station — **live / planned-live source of truth** (other Bookings’ committed uses for CAPACITY / fill-first goldens) |
| **liveData** | Live metrics (e.g. crowdCapacity); may make inspect fail even when setup allows N tasks |
| **OPEN/CLOSED** | Station.online — CLOSED ⇒ Coupler must not use |
| **Link.online** | false ⇒ physical edge gone for search; users of that link re-schedule |

**Tasking is the assignment truth** — not free-form “claims” alone. When seeding blockers for goldens, Studio should write Tasks (with `bookingIds`, input/output tracks, context, taskingConfiguration) that match what a prior SAT commit would have written.

### 4.3 Booking as test case

1. Create **Booking**: ordered **legs** of **non-transparent** StationTypes only, each with `request`.  
2. Metadata: `id`, **priority** (1 = highest), **submitTime** (FCFS within priority), **timeWindow** `{ start, end }`.  
3. Optional **script** of actions: `resolve`, `resolve` again (sticky), `release`, mutate world (tasking / Link.online / station online), `resolve`.  

Expect plan fields after resolve: **route** (full hops, including transparent stations), **bindings**, **planSegments** (may be >1 under mid-window re-place) — **not** legacy `consist_car_ids`.

### 4.4 Expect (optional but recommended)

```text
Expect {
  status: SAT | UNSAT
  code?: FailureCode           // NO_CANDIDATES, CAPACITY, BUDGET, UNREACHABLE, INSPECT_FAIL, …
  bindings?: Binding[]         // stationId + legIndex? + role leg|path
  route?: Hop[]                // or hop strings "in:stationId:out"
  planSegments?: PlanSegment[] // multi-slice plans when needed
  sticky_hit?: bool
  negative_cache_hit?: bool
  // loose match options: ignore hop order within segment, etc. — DEFAULT exact
}
```

```text
Hop { stationId, inTrack, outTrack }   // hop_key = (stationId, inTrack, outTrack)
Binding { stationId, legIndex: int | null, role: "leg" | "path" }
PlanSegment { start, end, route: Hop[], bindings: Binding[] }
```

Phase A may ship without expect (export world+booking only). Phase B+ should make expect easy so CI is one command.

### 4.5 Export / import

| Artifact | Contents |
|----------|----------|
| `world.json` | stationTypes, stations (setup, tasking, liveData, online), links, policy overrides |
| `booking.json` | legs + ids + priority + submitTime + timeWindow |
| `script.json` | Optional multi-step resolve/release |
| `expect.json` | Optional assertions (route, bindings, planSegments, sticky flags) |
| `fixture.manifest.json` | Name, description, tags (`loopback`, `prefilter`, `G6`), schema version |

**Round-trip required:** load export back into Studio without loss. That is the acceptance test for the Studio itself.

---

## 5. Schema contract (source of truth)

**DECIDED (design):** Studio export **must** map 1:1 to BUILD_SPEC §3 entities (and §7 Policy where needed).  

- Do **not** invent parallel “UI-only” ids without a stable export mapping.  
- Prefer the same field names as BUILD_SPEC so Kotlin tests deserialize once.  
- Schema version field on every fixture: **`trackplan_fixture_version: 1`**.  

Walkthrough HTML may remain a **narrative** view; Studio fixtures are the **machine** view. When they diverge, **fixtures + BUILD_SPEC win** for tests.

### 5.1 Vocabulary bridge (export names)

| Do not export (legacy) | Export (canonical) |
|------------------------|--------------------|
| classes / Class | stationTypes / StationType |
| cars / Car | stations / Station |
| yards / Yard | stations of transparent StationType |
| cables / Cable | links / Link |
| ports | tracks (TrackId on type + TrackRef in Links) |
| consist_car_ids | bindings + route station ids |
| consist_fixture_version | trackplan_fixture_version |
| claims (only) | tasking: Task[] (+ optional liveData) |
| prefilter/accept as sole API | Prefilter.canUse + Inspector.inspect (§3.7) |

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
    Assembler.resolve(world, booking) → assertEquals(expect, actual)
```

### 6.1 What the UI generates

| Output | Role |
|--------|------|
| **JSON fixtures** | The golden corpus (checked into git) |
| **JSON Schema** (optional, once) | Validates Studio export + Kotlin can codegen types if desired |
| **Not** (DEFAULT) | Per-test `.kt` files generated by the UI |

Hand-written Kotlin stays thin: **one generic test** (or a few) that parameterize over `fixtures/**`.

### 6.2 Kotlin side (DEFAULT v1 pattern)

**Shared model** (single source for deserialize + engine; shapes from BUILD_SPEC §3):

```kotlin
// trackplan-fixtures or engine module
@Serializable
data class WorldFixture(
  val trackplan_fixture_version: Int = 1,
  val stationTypes: List<StationTypeDto>,
  val stations: List<StationDto>,
  val links: List<LinkDto>,
  val policy: PolicyDto? = null,
)

@Serializable
data class StationTypeDto(
  val id: String,
  val name: String,
  val transparent: Boolean = false,
  val setupSchema: JsonElement? = null,
  val taskingSchema: JsonElement? = null,
  val requestSchema: JsonElement? = null,
  val inputTracks: List<String>,
  val outputTracks: List<String>,
  val legalPairs: List<LegalPairDto>,
  val inspectorId: String,
  val prefilterId: String? = null,
  val heuristics: HeuristicsDto = HeuristicsDto(),
)

@Serializable
data class StationDto(
  val id: String,
  val stationTypeId: String,
  val online: Boolean = true,       // OPEN when true; CLOSED when false
  val setup: JsonObject = JsonObject(emptyMap()),
  val tasking: List<TaskDto> = emptyList(),
  val liveData: JsonObject = JsonObject(emptyMap()),
)

@Serializable
data class LinkDto(
  val id: String,
  val from: TrackEndpointDto,       // OUT: stationId + trackId
  val to: TrackEndpointDto,         // IN:  stationId + trackId
  val online: Boolean = true,
)

@Serializable
data class TaskDto(
  val input: String? = null,        // TrackId; null OK for entry / first-type start
  val output: String? = null,       // TrackId; null OK for terminal / last-type arrival
  val context: JsonObject = JsonObject(emptyMap()),
  val taskingConfiguration: JsonObject = JsonObject(emptyMap()),
  val bookingIds: List<String> = emptyList(),
  // NO timeWindow on Task — time is Assembler-owned (Booking.timeWindow / planSegments)
)

@Serializable
data class BookingFixture(
  val trackplan_fixture_version: Int = 1,
  val id: String,
  val priority: Int = 1,            // 1 = highest
  val submitTime: String,           // Instant ISO-8601; FCFS within priority
  val timeWindow: TimeWindowDto,
  val legs: List<LegDto>,
  val status: String? = null,       // pending | sat | unsat — optional in demand fixture
)

@Serializable
data class LegDto(
  val index: Int,
  val stationTypeId: String,        // must be non-transparent
  val request: JsonObject,
)

@Serializable
data class ExpectFixture(
  val status: Status,               // SAT | UNSAT
  val code: String? = null,         // FailureReport.code
  val bindings: List<BindingDto>? = null,
  val route: List<HopDto>? = null,  // or route_hops: List<String> "1:st_Y1:2"
  val planSegments: List<PlanSegmentDto>? = null,
  val sticky_hit: Boolean? = null,
  val negative_cache_hit: Boolean? = null,
)

@Serializable
data class HopDto(
  val stationId: String,
  val inTrack: String,
  val outTrack: String,
)

@Serializable
data class BindingDto(
  val stationId: String,
  val legIndex: Int? = null,
  val role: String,                 // "leg" | "path"
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

**DEFAULT:** **A** for early Trackplan — implement domain/fixture DTOs in Kotlin once; document fields in BUILD_SPEC; Studio exports JSON that matches those names. Add JSON Schema in CI when Studio is built (validate fixtures in PR).

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

**Sticky relevance (BUILD_SPEC §3.10):** invalidation is per booking — only changes to types/stations/links on that booking’s plan (SAT) or demand StationTypes (UNSAT hope) bust sticky. Studio scripts that mutate *unrelated* stations should still expect sticky hits when testing relevance-scoped cache.

### 6.6 Layout vs golden data

- `layout.json` (x,y for Studio) — **not** required by Kotlin tests.  
- Goldens assert **ids, hops, status, codes, bindings, planSegments**, not pixel positions.

### 6.7 CI picture

```text
PR:
  1. validate fixtures/*.json against schema (optional)
  2. ./gradlew test   # parameterized goldens
Studio is not in CI — only its exports are.
```

### 6.8 Example world.json sketch

```json
{
  "trackplan_fixture_version": 1,
  "stationTypes": [
    {
      "id": "sttype_refrigerated",
      "name": "Refrigerated",
      "transparent": false,
      "inputTracks": ["1"],
      "outputTracks": ["1"],
      "legalPairs": [{ "in": "1", "out": "1" }],
      "inspectorId": "refrigerated",
      "prefilterId": "refrigerated",
      "heuristics": { "checkpoint": true, "fillFirst": true }
    },
    {
      "id": "sttype_switch",
      "name": "Switch",
      "transparent": true,
      "inputTracks": ["1", "5"],
      "outputTracks": ["1", "2", "3", "6"],
      "legalPairs": [
        { "in": "1", "out": "1" },
        { "in": "1", "out": "2" },
        { "in": "1", "out": "3" },
        { "in": "5", "out": "6" }
      ],
      "inspectorId": "switch",
      "prefilterId": null,
      "heuristics": { "checkpoint": false, "fillFirst": true }
    }
  ],
  "stations": [
    {
      "id": "R-17",
      "stationTypeId": "sttype_refrigerated",
      "online": true,
      "setup": { "band": "4N", "maxCabinets": 4 },
      "tasking": [],
      "liveData": {}
    },
    {
      "id": "Y1",
      "stationTypeId": "sttype_switch",
      "online": true,
      "setup": {},
      "tasking": [],
      "liveData": {}
    }
  ],
  "links": [
    {
      "id": "link_y1_n04",
      "from": { "stationId": "Y1", "trackId": "1" },
      "to": { "stationId": "N-04", "trackId": "1" },
      "online": true
    }
  ]
}
```

### 6.9 Example booking.json + expect.json sketch

```json
{
  "trackplan_fixture_version": 1,
  "id": "booking_g3",
  "priority": 1,
  "submitTime": "2026-01-01T09:00:00Z",
  "timeWindow": { "start": "2026-01-01T09:00:00Z", "end": "2026-01-01T10:00:00Z" },
  "legs": [
    { "index": 0, "stationTypeId": "sttype_refrigerated", "request": { "setup": "4N" } },
    { "index": 1, "stationTypeId": "sttype_normal", "request": { "setup": "2-seats" } },
    { "index": 2, "stationTypeId": "sttype_docking", "request": { "setup": "1-connector" } }
  ]
}
```

```json
{
  "status": "SAT",
  "bindings": [
    { "stationId": "R-17", "legIndex": 0, "role": "leg" },
    { "stationId": "Y1", "legIndex": null, "role": "path" },
    { "stationId": "N-04", "legIndex": 1, "role": "leg" }
  ],
  "route": [
    { "stationId": "R-17", "inTrack": "", "outTrack": "1" },
    { "stationId": "Y1", "inTrack": "1", "outTrack": "1" },
    { "stationId": "N-04", "inTrack": "1", "outTrack": "1" }
  ],
  "sticky_hit": false
}
```

(Exact hop encoding for first-leg entry / last-leg terminal may use empty or null tracks per BUILD_SPEC §3.7 first/last special cases — keep fixture runner aligned with engine Hop DTOs.)

---

## 7. Phased delivery

| Phase | Deliverable | Engine required? | Exit criteria |
|-------|-------------|------------------|---------------|
| **A — Author & export** | Topology + world state (setup/tasking/liveData) + booking editors; download JSON | No | Round-trip load; export matches BUILD_SPEC shapes; can recreate current toy world |
| **B — Expect + library** | expect.json UI; seed G1–G12 as loadable fixtures | No (manual expect) | Each golden has a fixture folder under e.g. `fixtures/` |
| **C — Highlight declared path** | Paint expect route hops on fabric (static) | No | Review loopback / multi-switch paths without running code |
| **D — Live resolve** | “Run” calls local Trackplan API or in-process/WASM | Yes | Diff actual vs expect; red/green |
| **E — Generators** | Constrained random worlds / bookings | Optional | Fuzz corpus from same schema |

**Recommendation:** implement **A** as soon as entity types stabilize enough for toy StationTypes; do **not** block A on Coupler completeness. **D** after P0–P2 engine slices.

Kotlin golden runner (load JSON → resolve → assert) can ship with the engine **before** Studio exists: hand-write a few fixture folders, then let Studio author the rest.

---

## 8. UX principles

1. **Rail vocabulary only** — StationType, Station, Track, Link, Hop, Booking, Leg, Route, Binding, Task, Tasking, Request, Prefilter, Inspector, Assembler, Coupler, Oracle, agenda, transparent, liveData.  
2. **Track-first** — show IN/OUT tracks; hops are `in:stationId:out`; Links are out→in.  
3. **Drag-to-link** — create Links by dragging from an **out** track on a Station to an **in** track on another; reposition Stations by dragging nodes.  
4. **Multi-link allowed** — BUILD_SPEC: many Links may share the same out or in; concurrent legality is **Inspector**-driven. Studio **DEFAULT toy mode:** optional **warn** (not hard-block) when an out already has a Link; advanced mode silent. Do **not** treat “one Link per out” as mandatory engine policy.  
5. **Separate geometry from usability** — “delete Link” ≠ “set Link.online = false”; “delete Station” ≠ “Station CLOSED”.  
6. **Tasking over free-form claims** — seed capacity goldens with Task[] on stations.  
7. **Scenarios are fixtures**, not slides — multi-step script object, not PowerPoint.  
8. **Offline-friendly** for local use; no CDN hard dependency for core authoring (same spirit as design docs).  
9. **Determinism** — export sorted ids; no random node positions in golden files (layout may be separate `layout.json` if needed).

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
trackplan/
  docs/                 # SPEC, BUILD_SPEC, this doc, design HTML
  fixtures/             # exported goldens (G1…, custom)
  studio/               # Fixture Studio web app (Phase A+)
  engine/               # Kotlin domain (later)
```

---

## 10. UI stack (interactive Studio)

Studio must feel like a real editor: **drag nodes**, **click to select**, **connect tracks**, **forms for text/numbers**, not a static diagram.

### 10.1 Recommended DEFAULT

| Layer | Choice | Why |
|-------|--------|-----|
| App shell | **React + Vite + TypeScript** | Fast local dev, huge ecosystem for forms/DnD |
| Topology canvas | **[React Flow](https://reactflow.dev/)** (`@xyflow/react`) | Built for node editors: drag, select, connect, custom nodes, minimap, undo-friendly patterns; **MIT**, no commercial license |
| Forms / panels | **React** controlled inputs (+ optional **shadcn/ui** or plain CSS) | StationType request fields, setup/tasking/liveData, booking legs |
| State | **Zustand** or React context | World + selection + dirty flag for export |
| Track fabric detail | Custom node interiors in React Flow **or** side-panel SVG | Tracks as connection handles on Station nodes |

**Why React Flow over Cytoscape for Studio:** Cytoscape is strong for *analysis / highlight*; React Flow is strong for *authoring* (the interaction model Studio needs). Keep Cytoscape only in the design walkthrough HTML if you want; Studio can be a separate app.

### 10.2 Interaction map (what the lib must support)

| User action | Implementation sketch |
|-------------|------------------------|
| Drag Station on canvas | React Flow node drag; persist `layout.json` x,y |
| **Drag to link** Station ↔ Station | Primary way to create **Links**: pointer down on an **out** track/handle → drag → drop on an **in** track/handle → new Link |
| Click Station | Selection → right panel (setup, tasking, liveData, online, type) |
| Click track | Highlight legal mates; optional “connect mode” if not dragging |
| Connect Link (rules) | Edge only **out → in**; multi-link allowed (inspector validates at resolve); optional toy warn if out already linked |
| Delete / offline edge | Delete = remove Link; “offline” = `Link.online = false` (not geometry) |
| OPEN/CLOSED Station | Toggle `Station.online` |
| Palette → canvas | Drag “add Station” (pick StationType) onto canvas |
| Add booking leg | List UI + non-transparent StationType dropdown + request form |
| Export | Button → download JSON fixtures |

**Drag-to-link detail (DEFAULT UX):**

1. User hovers an **OUT** track on a Station → handle highlights.  
2. Drag starts a temporary connection line (React Flow `onConnectStart` / connection line).  
3. Drop on a valid **IN** track of another Station → Link created; invalid targets (same station without self-loop product rule, in→in) show reject cursor / toast.  
4. Optional: drag from palette (“add Station”) onto canvas to place nodes, then link with track-to-track drag as above.

This is first-class authoring — not “edit JSON edges by hand.”

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
| Track-level truth | Handles = track ids; edges store `from: {stationId, trackId}` / `to: {stationId, trackId}` matching BUILD_SPEC Link |
| Accessibility | Keyboard select + panel forms for fields that must be precise (ids, setup, request) |
| Hosting | Local Vite app; no production deploy required |
| Engine bridge (Phase D) | HTTP to local Trackplan service, or CLI `trackplan-test fixtures/G1` |
| Offline | Prefer npm-bundled deps (same spirit as design docs vendor/) |

### 10.5 What Studio surfaces about engine concepts (optional panels)

Studio does not implement Coupler, but editors can document/export fixtures that exercise:

| Concept | Fixture relevance |
|---------|-------------------|
| **Prefilter** | setup / request / liveData on candidates; no Task/context |
| **Inspector** | tasking Task[] must be valid after SAT; seed blockers as Tasks |
| **Oracle** | online Link graph + Station OPEN/CLOSED; rebuild on topology change only |
| **agenda** | multi-finish targets (e.g. `1:B1:1`, `2:B1:2`) — expect route reflects peeled path |
| **edgeCost / NeighborRank** | fill-first / transparent cost — seed uneven tasking across peers for ranking goldens |
| **First / last station** | first leg: no in required; last leg: out optional (terminal) |
| **planSegments** | multi-booking timeWindow contention + priority in one fixture world |
| **whole-booking commit** | script: SAT B1 then resolve B2 sees B1’s committed tasking |

---

## 11. Success metrics

- Time to add a new golden (world + booking + expect) **&lt; 30 minutes** for someone who knows the domain.  
- Zero hand-edited hop lists for new tests once path is painted/accepted.  
- Round-trip: export → reload → byte-identical canonical JSON (sorted).  
- At least the **current toy topology** loadable as a starter template (stations + transparent switches + links).  
- CI runs `fixtures/**` against the engine without Studio in the pipeline (export is pure data).

---

## 12. Open questions

| # | Question | DEFAULT until decided |
|---|----------|------------------------|
| Q1 | Store layout (x,y) in fixture or separate file? | Separate `layout.json` so goldens ignore pixels |
| Q2 | Multi-booking worlds in one fixture? | Yes for capacity / priority / planSegments tests; one “primary” booking under test (others seed tasking) |
| Q3 | Inspector / Prefilter plugins in Studio? | Toy registry only (hard-coded StationType forms) until full catalog |
| Q4 | Browser resolve vs CLI only for Phase D? | CLI first (simpler CI); browser optional |
| Q5 | Who can edit production-like StationType schemas? | Product; Studio only hosts forms driven by schema registry |
| Q6 | Generate Kotlin source from Studio? | **No** — JSON + one parameterized test runner |
| Q7 | Schema SSOT: Kotlin types vs JSON Schema? | Kotlin DTOs first; JSON Schema optional in CI |
| Q8 | Toy-mode multi-link warning? | **Warn**, do not hard-block (BUILD_SPEC allows multi-link) |
| Q9 | How to author planSegments expects for multi-slice SAT? | Phase B: optional array; single route/bindings when one segment |
| Q10 | Seeding tasking UI vs raw JSON? | Phase A: structured Task form (tracks, bookingIds, context); advanced raw JSON OK |

Items **not** open for Studio (DECIDED in BUILD_SPEC — do not re-litigate here): multi-link legality (inspector); priority 1=highest + FCFS submitTime; sticky relevance-scoped; whole-booking commit; no Yard entity; transparent types omitted from demand legs.

---

## 13. Work package sketch (for planning)

| ID | Package | Depends |
|----|---------|---------|
| **FS0** | Kotlin fixture DTOs (`@Serializable`) + `loadFixture(dir)` + `assertMatches` | BUILD_SPEC §3 |
| **FS0b** | Optional JSON Schema export from DTOs / hand schema for Studio validation | FS0 |
| **FS1** | Phase A Studio: edit + export + import JSON | FS0 field names stable |
| **FS2** | Seed fixtures for G1–G12 (+ multi-switch / loopback stories) | FS0 (hand JSON OK before Studio) |
| **FS3** | Phase C static expect paint (route hops) | FS1 |
| **FS4** | Phase D resolve runner + diff | Engine P0+ |
| **FS5** | Phase E generators | FS0, domain invariants |

Engine goldens G1–G12 remain **required** for the domain. Studio accelerates **creating and maintaining** them; it does not replace implementing Coupler/Assembler.

---

## 14. Decision log

| Decision | Choice |
|----------|--------|
| Build a fixture UI? | **Yes** — high value for test authoring |
| Scope | Fixture / golden author, **not** production Trackplan UI |
| Phase A without engine? | **Yes** — export JSON first |
| Schema source of truth | **BUILD_SPEC** entities (§3) |
| Walkthrough HTML | Keep for teaching; fixtures for machine tests |
| Studio → Kotlin bridge | **JSON fixtures + parameterized JUnit loader** (not generated `.kt` per case) |
| Kotlin model | Shared `@Serializable` DTOs aligned with BUILD_SPEC |
| Studio UI stack | **React + Vite + React Flow (`@xyflow/react`)** + form panels; MIT |
| Linking devices | **Drag out-track → in-track** creates **Link** |
| Multi-link | **Allowed** (inspector validates); Studio optional toy warn |
| Topology entities | StationTypes + Stations + Links — **no Yard / Cable / Port names** in export |
| World truth | **setup + tasking + liveData**; tasking = assignment SSOT |
| Booking demand | Non-transparent legs + request; priority + submitTime + timeWindow |
| Expect plan | route / bindings / planSegments — not consist_car_ids |
| Fixture version field | **`trackplan_fixture_version`** |
| Repo root name | **`trackplan/`** (not `consist/`) |

---

## 15. Mental model cheat sheet (for Studio authors)

```text
StationType  = catalog (schemas, inspector, prefilter?, transparent?, tracks, legalPairs)
Station      = instance (setup, tasking: Task[], liveData, online)
Track        = named IN or OUT on type; wired by Links in the world
Link         = OUT track → IN track; online flag
Task         = one use of a station (in/out, context, taskingConfiguration, bookingIds)
Tasking      = Task[] — what is / will be live (source of truth)
Request      = user demand on a Booking leg
Booking      = legs (non-transparent types only) + priority + submitTime + timeWindow
             → plan: bindings, route (full hops), planSegments[]
Prefilter    = cheap canUse(setup, request, liveData) — no Task, no context
Inspector    = inspect(setup, tasking+candidate, request, liveData) → full Task[] | fail
Assembler    = outer: legs, prefilter candidates, agenda, checkpoints, sticky, commit
Coupler      = inner: path on Stations+Tracks+Links; edgeCost + NeighborRank; Oracle h
Oracle       = hop-count on online Links; rebuild on topology / OPEN-CLOSED, not tasking
```

---

*End of Fixture Studio design. Implement only when ready; until then, hand fixtures and design walkthroughs remain valid. When vocabulary conflicts with older notes, **BUILD_SPEC wins**.*
