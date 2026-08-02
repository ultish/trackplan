# Trackplan

Sticky, deterministic **booking placement** on a network of **Stations** (asset scheduling under the covers).

Users request ordered **StationType** legs with **requests**; Trackplan binds **Stations**, builds a **Route** (including transparent path stations), updates **tasking**, and uses **sticky** caches so re-resolve stays cheap.

| Layer | Role |
|-------|------|
| **Assembler** | Legs, prefilter, time slices, agenda/alts, commit, sticky |
| **Coupler** | Path search on Links (A*), inspect candidates, dynamic edge costs |

## Docs

Start: **[docs/README.md](./docs/README.md)**

| Doc | Role |
|-----|------|
| [docs/SPEC.md](./docs/SPEC.md) | Design handoff (partially legacy wording) |
| [docs/BUILD_SPEC.md](./docs/BUILD_SPEC.md) | **Canonical** entities + engine decisions (Station model) |
| [docs/booking-assembler-design.html](./docs/booking-assembler-design.html) | Interactive walkthroughs (vocabulary pass later) |
| [docs/FIXTURE_STUDIO.md](./docs/FIXTURE_STUDIO.md) | Fixture Studio design (React Flow, JSON → Kotlin goldens) |
| [docs/COUPLER_OPTION_A_VS_B.md](./docs/COUPLER_OPTION_A_VS_B.md) | Multi-sink vs peel debate (v1 = multi-sink A) |

```bash
open docs/BUILD_SPEC.md
open docs/booking-assembler-design.html?scenario=simple
```

## Stack (target)

Kotlin (JVM). Package root: `trackplan`. Domain goldens first; Kafka later.

## Name

**Trackplan** is the project (formerly Consist). Domain plan path = **Route**, not “consist.”
