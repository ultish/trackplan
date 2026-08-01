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

## 6. Phased delivery

| Phase | Deliverable | Engine required? | Exit criteria |
|-------|-------------|------------------|---------------|
| **A — Author & export** | Topology + occupancy + booking editors; download JSON | No | Round-trip load; export matches BUILD_SPEC shapes; can recreate current toy world |
| **B — Expect + library** | expect.json UI; seed G1–G12 as loadable fixtures | No (manual expect) | Each golden has a fixture folder under e.g. `fixtures/` |
| **C — Highlight declared path** | Paint expect hops on fabric (static) | No | Review loopback/multiyard without running code |
| **D — Live resolve** | “Run” calls local Consist API or in-process/WASM | Yes | Diff actual vs expect; red/green |
| **E — Generators** | Constrained random worlds / bookings | Optional | Fuzz corpus from same schema |

**Recommendation:** implement **A** as soon as entity types stabilize enough for toy Classes; do **not** block A on Coupler completeness. **D** after P0–P2 engine slices.

---

## 7. UX principles

1. **Rail vocabulary only** — Class, Car, Yard, Cable, Hop, Booking, Leg, Consist, prefilter, accept.  
2. **Port-first** — show IN/OUT tracks; hops are `in:device:out`.  
3. **One cable per out** (DEFAULT in Studio for toy mode) — matches current design; advanced multiplex is opt-in later.  
4. **Separate geometry from occupancy** — “delete cable” ≠ “close cable for this test.”  
5. **Scenarios are fixtures**, not slides — multi-step script object, not PowerPoint.  
6. **Offline-friendly** for local use; no CDN hard dependency for core authoring (same spirit as design docs).  
7. **Determinism** — export sorted ids; no random node positions in golden files (layout may be separate `layout.json` if needed).

---

## 8. Relationship to existing artifacts

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

## 9. Tech notes (non-binding)

| Concern | Guidance |
|---------|----------|
| Graph UI | Prefer **simple SVG/Canvas** or light graph lib; **GoJS** only if building a long-lived editor with budget for license (see design discussion). Do not block Phase A on GoJS. |
| Port fabric | Same teaching model as design HTML (ports + legal pairs); reuse ideas, not necessarily the same file. |
| Hosting | Local `vite`/`static` app is enough; no production deploy required. |
| Engine bridge (Phase D) | HTTP to local Consist service, or shared fixture runner CLI: `consist-test fixtures/G1`. |

---

## 10. Success metrics

- Time to add a new golden (world + booking + expect) **&lt; 30 minutes** for someone who knows the domain.  
- Zero hand-edited hop lists for new tests once path is painted/accepted.  
- Round-trip: export → reload → byte-identical canonical JSON (sorted).  
- At least the **current toy topology** loadable as a starter template.  
- CI runs `fixtures/**` against the engine without Studio in the pipeline (export is pure data).

---

## 11. Open questions

| # | Question | DEFAULT until decided |
|---|----------|------------------------|
| Q1 | Store layout (x,y) in fixture or separate file? | Separate `layout.json` so goldens ignore pixels |
| Q2 | Multi-booking worlds in one fixture? | Yes for capacity tests; one “primary” booking under test |
| Q3 | Inspector plugins in Studio? | Toy registry only (hard-coded Class forms) until W14 catalog |
| Q4 | Browser resolve vs CLI only for Phase D? | CLI first (simpler CI); browser optional |
| Q5 | Who can edit production-like Class schemas? | Product; Studio only hosts forms driven by schema registry |

---

## 12. Work package sketch (for planning)

| ID | Package | Depends |
|----|---------|---------|
| **FS0** | Fixture JSON schema + Kotlin (or JSON Schema) types shared with tests | BUILD_SPEC §3 |
| **FS1** | Phase A Studio: edit + export + import | FS0 |
| **FS2** | Seed fixtures for G1–G12 (+ multiyard / loopback stories) | FS1 |
| **FS3** | Phase C static expect paint | FS1 |
| **FS4** | Phase D resolve runner + diff | Engine P0+ |
| **FS5** | Phase E generators | FS0, domain invariants |

Engine goldens G1–G12 remain **required** for the domain. Studio accelerates **creating and maintaining** them; it does not replace implementing Coupler/Assembler.

---

## 13. Decision log

| Decision | Choice |
|----------|--------|
| Build a fixture UI? | **Yes** — high value for test authoring |
| Scope | Fixture / golden author, **not** production Consist UI |
| Phase A without engine? | **Yes** — export JSON first |
| Schema source of truth | **BUILD_SPEC** entities |
| Walkthrough HTML | Keep for teaching; fixtures for machine tests |

---

*End of Fixture Studio design. Implement only when ready; until then, hand fixtures and design walkthroughs remain valid.*
