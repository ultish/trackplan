# Trackplan — Entity diagrams

**Source of truth:** [BUILD_SPEC.md](./BUILD_SPEC.md) §1, §3 (especially §3.0–§3.10), §8.0.  
**Purpose:** class / relationship views of the **Station model** for humans and implementers.  
**Rule:** fields and edges match BUILD_SPEC only. Optional / **OPEN** items are labeled on the diagrams.

---

## Vocabulary bridge (old → new)

| Older / legacy wording | Canonical (Station model) |
|------------------------|---------------------------|
| Class / ResourceType | **StationType** |
| Car / Asset | **Station** |
| Yard | **transparent** StationType (no Yard entity) |
| Port | **Track** (`TrackId` + side in/out) |
| Cable | **Link** (OUT track → IN track) |
| config / claims | **Tasking** / **Task** |
| Consist (old project name) | **Trackplan** |
| consist display / plan path | **Route** (`Hop[]`) + **bindings** |

Also: **Assembler** (outer: legs, sticky, commit) · **Coupler** (inner: multi-sink path + **ExpandKey frontier** + inspect on the fabric).

---

## 1. Catalog vs instance

Catalog types define schemas, track shapes, and plugin ids. Instances hold values and live assignment truth.

```mermaid
classDiagram
  direction TB

  class StationType {
    +string id
    +string name
    +bool transparent
    +Schema setupSchema
    +Schema taskingSchema
    +Schema requestSchema
    +TrackId[] inputTracks
    +TrackId[] outputTracks
    +LegalPair[] legalPairs
    +string inspectorId
    +string? prefilterId
    +Heuristics heuristics
  }

  class Heuristics {
    +bool checkpoint
    +bool fillFirst
    +string? neighborRankId
  }

  class LegalPair {
    +TrackId in
    +TrackId out
  }

  class Station {
    +string id
    +string stationTypeId
    +bool online
    +object setup
    +Task[] tasking
    +object liveData
  }

  class Schema {
    <<JSON Schema or equivalent>>
  }

  StationType "1" --> "*" Station : stationTypeId
  StationType *-- Heuristics : heuristics
  StationType *-- LegalPair : legalPairs
  StationType --> Schema : setupSchema
  StationType --> Schema : taskingSchema
  StationType --> Schema : requestSchema
  StationType ..> Inspector : inspectorId registry
  StationType ..> Prefilter : prefilterId optional

  class Inspector {
    <<plugin>>
    inspect(...)
  }

  class Prefilter {
    <<plugin optional>>
    canUse(...)
  }

  note for StationType "transparent=true ⇒ omitted from Booking demand legs;\npath filler only (e.g. switch). No Yard entity."
  note for Station "setup = setupSchema values (humans).\ntasking = Task[] assignment truth.\nliveData = metrics, not setup/request."
  note for Heuristics "fillFirst default true (ExpandKey preferInUse).\nneighborRankId optional SmartNode (ExpandKey component 4).\nNo edgeCostId / summed preference ladder."
```

### How to read this

- **StationType** is catalog; **Station** is a deployed instance of that type.
- Schemas live on the type; **setup / tasking / liveData** values live on the station.
- `inspectorId` is required (code registry). `prefilterId` may be **null** (optional cheap screen).
- `transparent` stations are still real Stations on the fabric; they are only omitted from **demand** legs.
- Type track lists + **legalPairs** are capability; concurrent legality is **Inspector**, not only `legalPairs`.

---

## 2. Fabric topology

Physical graph: stations expose named IN/OUT tracks; **Links** wire an OUT to an IN.

```mermaid
classDiagram
  direction LR

  class Station {
    +string id
    +string stationTypeId
    +bool online
  }

  class StationType {
    +TrackId[] inputTracks
    +TrackId[] outputTracks
    +LegalPair[] legalPairs
  }

  class Link {
    +string id
    +From from
    +To to
    +bool online
  }

  class From {
    +string stationId
    +TrackId trackId
    <<OUT side>>
  }

  class To {
    +string stationId
    +TrackId trackId
    <<IN side>>
  }

  class TrackRef {
    +string stationId
    +string side
    +TrackId trackId
  }

  Station --> StationType : type defines tracks
  Link *-- From : from OUT
  Link *-- To : to IN
  From --> Station : stationId
  To --> Station : stationId
  TrackRef ..> Station : engine view of endpoint

  note for Link "from = OUT track on Station A\nto = IN track on Station B\nonline=false ⇒ Coupler must not traverse"
  note for Station "Engine traversal uses type tracks ∩ wired Links.\nMany outs may Link into one in (hub/terminal)."
```

**Traversal sketch (not a class diagram):**

```mermaid
flowchart LR
  A_out["Station A<br/>OUT track"] -->|Link| B_in["Station B<br/>IN track"]
  B_in --> B_visit["Visit B<br/>choose in→out pair"]
  B_visit --> B_out["Station B<br/>OUT track"]
  B_out -->|Link| C_in["Station C<br/>IN track"]
```

### How to read this

- A **Link** always runs **from OUT → to IN** (never the reverse as a single Link).
- Track identity is a string **TrackId** scoped by station + side; type lists all possible tracks.
- `Link.online = false` or `Station.online = false` (CLOSED) removes that edge/node from Coupler search.
- Topology (Links / online) feeds **Oracle++** (next type, non-transparent chain, terminal, hop `h`); tasking does **not** rebuild Oracle++.

---

## 3. Tasking

Each **Station** holds `tasking: Task[]` — live / planned-live assignment source of truth. Time is **not** on Task.

```mermaid
classDiagram
  direction TB

  class Station {
    +Task[] tasking
    +object setup
    +object liveData
  }

  class Task {
    +TrackId? input
    +TrackId? output
    +Context context
    +object taskingConfiguration
    +string[] bookingIds
  }

  class Context {
    <<Record string, JsonValue>>
  }

  class Booking {
    +string id
    +TimeWindow timeWindow
  }

  Station "1" *-- "*" Task : tasking
  Task *-- Context : context
  Task --> Booking : bookingIds many-to-many
  note for Task "NO timeWindow on Task — Assembler owns time (§3.9b).\ninput null OK for first-type start.\noutput null OK for terminal arrival.\nOne Task may serve many bookings (inspector merge)."
  note for Station "Failed inspect never writes candidate into tasking.\nWorking overlay during resolve; commit only on whole-Booking SAT."
```

### How to read this

- Users author **requests** on legs, not Tasks. Coupler proposes a candidate Task; **Inspector** returns a **full** `Task[]` (replacement list).
- **Context** is per-Task path facts, seeded from the previous hop and extended by the inspector.
- `request` material is copied into `taskingConfiguration` **and** passed to `inspect` (BUILD_SPEC option B).
- Cancel / remove SAT booking: drop `bookingId` from Tasks; drop Tasks whose `bookingIds` becomes empty.

---

## 4. Booking: demand vs plan

Demand is ordered non-transparent **Legs**. After resolve, the plan is **bindings**, **route** (`Hop[]`), and optional multi-slice **planSegments**.

```mermaid
classDiagram
  direction TB

  class Booking {
    +string id
    +int priority
    +string status
    +TimeWindow timeWindow
    +Leg[] legs
    +Binding[] bindings
    +Hop[] route
    +PlanSegment[] planSegments
    +FailureReport? failure
    +ResolveSnapshot? snapshot
    +Instant submitTime
  }

  class TimeWindow {
    +Instant start
    +Instant end
  }

  class Leg {
    +int index
    +string stationTypeId
    +object request
  }

  class Binding {
    +string stationId
    +int? legIndex
    +string role
  }

  class Hop {
    +string stationId
    +TrackId inTrack
    +TrackId outTrack
  }

  class PlanSegment {
    +Instant start
    +Instant end
    +Hop[] route
    +Binding[] bindings
  }

  class FailureReport {
    +string code
    +int? legIndex
    +string message
    +string? stationId
    +Hop[]? pathTaken
  }

  class StationType {
    +bool transparent
  }

  class Station {
    +string id
  }

  Booking *-- TimeWindow : timeWindow only place time lives
  Booking *-- Leg : demand
  Booking *-- Binding : plan uses stations
  Booking *-- Hop : route full path
  Booking *-- PlanSegment : may be greater than 1 mid-window re-place
  Booking *-- FailureReport : on unsat
  Leg --> StationType : stationTypeId transparent false
  Binding --> Station : stationId
  Hop --> Station : stationId
  PlanSegment *-- Hop : route
  PlanSegment *-- Binding : bindings

  note for Leg "Demand string = non-transparent types only.\nUsers do not author transparent legs (v1)."
  note for Binding "legIndex null if transparent / not a demand leg.\nrole path = transparent or intermediate."
  note for Hop "hop_key = stationId, inTrack, outTrack.\nAnti-loop: no repeat hop_key; max H / V."
  note for PlanSegment "Assembler may re-place mid-window under contention;\nnot because inspectors know time."
  note for Booking "status: pending | sat | unsat.\npriority 1 = highest.\nFCFS = submitTime DECIDED §3.10 not createTime.\nrole on Binding: leg | path.\nsnapshot optional."
```

**Demand vs plan (conceptual):**

```mermaid
flowchart LR
  subgraph demand ["Demand (user)"]
    L1["Leg A + request"] --> L2["Leg B + request"] --> L3["Leg C + request"]
  end
  subgraph plan ["Plan (engine)"]
    R["Route hops\nA → SW1 → B → … → C"]
    Bind["Bindings\nleg + path stations"]
    Seg["PlanSegments\nover time slices"]
  end
  demand -->|resolve| plan
```

### How to read this

- **Legs** = what the user asks for (types + requests). Transparent types never appear as demand legs.
- **Route** = full hop path including transparent stations (user-visible plan string after claim).
- **Bindings** mark every Station on the plan (`leg` vs `path`).
- **timeWindow** is the only time on the Booking demand; **planSegments** hold time-sliced plan pieces after resolve.
- **submitTime** orders FCFS after priority; create-then-submit is allowed.

---

## 5. Engine plugins (Prefilter, Inspector, NeighborRank / ExpandKey)

Plugins attach by id on **StationType**. Prefilter is optional; Inspector is required. Coupler ranking uses **ExpandKey** lexicographic order (BUILD_SPEC §3.7b); **NeighborRank** is ExpandKey component 4 (SmartNode).

```mermaid
classDiagram
  direction TB

  class StationType {
    +string inspectorId
    +string? prefilterId
    +Heuristics heuristics
  }

  class Heuristics {
    +bool checkpoint
    +bool fillFirst
    +string? neighborRankId
  }

  class Prefilter {
    <<optional plugin>>
    +canUse setup request liveData
  }

  class Inspector {
    <<required plugin>>
    +inspect setup tasking request liveData
  }

  class NeighborRank {
    <<SmartNode optional>>
    +neighborRank Long higher sooner
  }

  StationType --> Prefilter : prefilterId
  StationType --> Inspector : inspectorId
  StationType *-- Heuristics
  Heuristics ..> NeighborRank : neighborRankId

  note for Prefilter "NO Task, NO path context.\nCheap screen only.\nTransparent: no prefilter mid-path.\nrequest null ⇒ generally no request-based filter."
  note for Inspector "One candidate Task appended per call.\nReturns FULL Task[] replacement.\nHard illegality lives here, not ExpandKey."
  note for NeighborRank "ExpandKey component 4 (after in-use, non-trans, distToG, distToTerminal).\nHigher rank = try sooner. Default 0."
  note for Heuristics "ExpandKey lex only — no edgeCostId / summed ladder.\nfillFirst → preferInUse; transparent via preferNonTransparent."
```

**Call shape (inputs only):**

| Plugin | Reads | Does not read |
|--------|--------|----------------|
| Prefilter | setup, request, liveData | Task, context, path |
| Inspector | setup, tasking+candidate, request, liveData | Assembler time windows |
| ExpandKey | fill-first, non-trans, distToG, distToTerminal, NeighborRank, names | Hard fail (use Inspector) |
| NeighborRank | neighbor tasking/setup/liveData, candidate | ExpandKey component 4 only |

### How to read this

- Assembler runs **Prefilter** to build the multi-sink goal pool; Coupler **inspects** at goals (and every transparent visit) **inside one multi-sink frontier** — not “when a target is peeled.”
- Ranking: **ExpandKey** lex order (§3.7b) — not summed edgeCost / not `f=g+h`.
- Frontier pop is ExpandKey-dominated (`(g, ExpandKey…)`); Oracle++ distances live **inside** ExpandKey (components 2–3), not as a competing frontier `h` / `f=g+h`.
- New ExpandKey columns only by product decision (order changes paths).

---

## 6. Runtime world + sticky

**CommittedWorld** is durable truth. One booking attempt uses a path-local **WorkingState** overlay. **StickyRecord** caches SAT/UNSAT under relevance-scoped epochs.

```mermaid
classDiagram
  direction TB

  class CommittedWorld {
    <<durable world view>>
    +stations setup tasking liveData
    +links
    +bookings
  }

  class WorkingState {
    <<path-local overlay COW>>
    +Map stationId Task[] overlay
  }

  class Station {
    +Task[] tasking
  }

  class Booking {
    +string id
    +status
  }

  class StickyRecord {
    +string bookingId
    +demandHash
    +Map relevantSetupEpochs
    +Map relevantTopoEpochs
    +result satOrUnsat
  }

  class StickySAT {
    +planSegments
    +bindings
    +route
  }

  class StickyUNSAT {
    +FailureReport failureReport
  }

  class Event {
    <<Assembler time index>>
    +Instant at
  }

  CommittedWorld "1" *-- "*" Station
  CommittedWorld "1" *-- "*" Booking
  WorkingState --> CommittedWorld : overlay on
  WorkingState ..> Station : read overlay or committed
  StickyRecord --> Booking : bookingId
  StickyRecord *-- StickySAT : result SAT
  StickyRecord *-- StickyUNSAT : result UNSAT
  Event ..> Booking : start/end instants in horizon

  note for WorkingState "overlay keys = stations on this path/branch with successful inspect.\nread S = overlay S else committed tasking S.\nSAT → merge to world; FAIL → discard entire overlay."
  note for StickyRecord "Not a second schedule format — stores/points at engine result.\nEpochs only for RELEVANT stations/types/links — not whole plant."
  note for StickySAT "SAT relevance ⊆ types/stations/links on plan."
  note for StickyUNSAT "UNSAT relevance ⊆ demand StationTypes + optional failure samples;\nbust on hope only (open link, free tasking, …)."
```

**Commit lifecycle:**

```mermaid
flowchart TB
  Q["Queue: priority 1 first,\nthen submitTime FCFS"] --> W["WorkingState = empty overlay\non CommittedWorld"]
  W --> Place["Place ALL legs\nCoupler + inspect"]
  Place -->|SAT| Commit["Commit overlay → CommittedWorld\nnext booking sees new tasking"]
  Place -->|FAIL| Discard["Discard WorkingState\nworld unchanged"]
  Commit --> Sticky["Save StickyRecord SAT"]
  Discard --> StickyU["Save StickyRecord UNSAT"]
```

### How to read this

- Never hold many bookings uncommitted: **whole-Booking commit only**, then the next booking in the queue.
- Overlay is **path-local** (stations actually walked and accepted), not every switch in the plant.
- Sticky hit ⇒ skip Coupler and return cached plan / FailureReport when demand hash + **relevant** epochs still match.
- **liveData** does not auto re-queue; Inspector jar changes imply cold restart (no sticky bust story in v1).

---

## 7. Assembler ↔ Coupler collaboration

Outer Assembler owns legs, prefilter, **Oracle++** goal construction, checkpoints, sticky, and commit. Inner Coupler owns **multi-sink ExpandKey frontier** + inspect at goal (**DECIDED Option A** — BUILD_SPEC §3.9d C2 / §3.7b). Pivot history: [COUPLER_OPTION_A_VS_B.md](./COUPLER_OPTION_A_VS_B.md).

```mermaid
sequenceDiagram
  participant Sticky as Sticky cache
  participant Asm as Assembler
  participant Pref as Prefilter
  participant Oracle as Oracle++
  participant Cpl as Coupler
  participant Insp as Inspector
  participant World as CommittedWorld

  Asm->>Sticky: SAT/UNSAT hit for booking+world?
  alt sticky hit
    Sticky-->>Asm: cached plan or FailureReport
  else miss
    Asm->>Asm: WorkingState = empty overlay on World
    loop each demand leg non-transparent
      Asm->>Pref: canUse setup, request, liveData
      Pref-->>Asm: candidate pool C
      Asm->>Oracle: filter sinks (next type + chain + terminal)
      Asm->>Asm: agenda = sortByExpandKey(goals)
      Asm->>Cpl: couple tail or S0, goals=agenda, working, request
      loop multi-sink ExpandKey frontier until first-fit or exhaust
        Cpl->>Cpl: expand Links + legalPairs ordered by ExpandKey
        Cpl->>Insp: inspect setup, tasking+candidate, request, liveData
        alt inspect OK
          Insp-->>Cpl: full Task[]
          Cpl-->>Asm: path + Task[] + target; stop this segment
          Note over Asm: remaining agenda → alts for later-leg fail only
          Note over Asm: checkpoint previous type only after this leg succeeds
        else inspect fail
          Insp-->>Cpl: Failure
          Note over Cpl: continue same frontier — do NOT return to Assembler
        end
      end
      alt couple returned null
        Asm->>Asm: optional inter-leg backtrack with prior alts else discard; UNSAT
      end
    end
    alt all legs OK
      Asm->>World: commit WorkingState
      Asm->>Sticky: save SAT planSegments, route, bindings
    else fail
      Asm->>Sticky: save UNSAT FailureReport
    end
  end
```

**Responsibility split:**

```mermaid
flowchart LR
  subgraph Assembler
    A1[Legs + queue priority]
    A2[Prefilter pool]
    A3[Agenda goals + inter-leg alts]
    A4[Checkpoint types]
    A5[Sticky + whole-booking commit]
    A6[Time events / planSegments]
  end
  subgraph Coupler
    C1[Virtual S0 first leg]
    C2[Multi-sink path on Links]
    C3[ExpandKey frontier]
    C4[Inspect at goal in frontier]
    C5[Candidate Task in/out/context]
  end
  Assembler -->|"one multi-sink couple() per segment attempt"| Coupler
  Coupler -->|"path + inspect-OK Task[] (first-fit)"| Assembler
```

### How to read this

- **First leg** still uses Coupler: virtual source **S0 → candidates** (no Link into entry stations; inputs unused on first type).
- **Last / terminal** leg: success on arrival (input set, output often null); outs optional once last type is tasked.
- Assembler does **not** expand every track; Coupler does **not** own multi-booking queue or sticky.
- Wrong (DECIDED void): first leg = Inspector-only bind with no Coupler; Option B peel as v1 contract.
- **DECIDED:** multi-sink `couple(goals=…)` (Option A). Oracle++ drops sinks that cannot reach terminal / later non-transparent types.

---

## Cross-reference map

| Diagram | BUILD_SPEC |
|---------|------------|
| 1 Catalog vs instance | §3.0, §3.2, §3.3 |
| 2 Fabric topology | §3.4, §3.5, Oracle in §3.7 |
| 3 Tasking | §3.6, §4 context growth |
| 4 Booking demand vs plan | §3.8, §3.9b PlanSegment |
| 5 Engine plugins | §3.7, §3.7b |
| 6 Runtime + sticky | §3.9c, §3.10 |
| 7 Assembler ↔ Coupler | §8.0, §8.1, §3.9d |

For product thesis and non-goals, see [BUILD_SPEC.md](./BUILD_SPEC.md) §1–§2. For interactive walkthroughs, see [booking-assembler-design.html](./booking-assembler-design.html).
