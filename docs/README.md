# Trackplan — docs index

**Trackplan** places **Bookings** on **Stations** (typed by **StationType**), connected by **Links** on **Tracks**, with **setup / tasking / request**, Inspectors, Assembler + Coupler.

## Start here

| Order | Doc | Role |
|-------|-----|------|
| **1** | **[BUILD_SPEC.md](./BUILD_SPEC.md)** | **Canonical** model + engine decisions (keep current) |
| **1b** | **[ENTITY_DIAGRAMS.md](./ENTITY_DIAGRAMS.md)** | Mermaid class / relationship diagrams for the Station model |
| **2** | **[SPEC.md](./SPEC.md)** | Broader handoff; some sections still older Class/Car wording |
| **3** | **[booking-assembler-design.html](./booking-assembler-design.html)** | Interactive walkthroughs (rename pass later) |
| — | **[COUPLER_OPTION_A_VS_B.md](./COUPLER_OPTION_A_VS_B.md)** | Multi-sink (A) vs peel (B) — **A is v1**; keep for pivot |
| — | **[FIXTURE_STUDIO.md](./FIXTURE_STUDIO.md)** | Golden authoring UI design |

### Builder prompt

```text
Project: Trackplan. Read docs/BUILD_SPEC.md (StationType/Station/Tasking) as source of truth.
Coupler = Option A multi-sink; Oracle++ filters goals (incl. to terminal). See COUPLER_OPTION_A_VS_B.md for pivot only.
Implement goldens G1–G12 adapted to Station model. No UI required for engine v1.
Follow DECIDED/DEFAULT; ask only on OPEN items that block you (C2b/c/d, multi-out).
Kotlin package: trackplan. Kafka after domain goldens.
```

### Vocabulary (short)

StationType · Station · Track · Link · Setup · Tasking · Task · Request · Prefilter · Inspector · Booking · Leg · Route · Assembler · Coupler · transparent · Oracle++ · agenda · multi-sink

### Local open

```bash
open docs/BUILD_SPEC.md
open docs/booking-assembler-design.html?scenario=simple
```
