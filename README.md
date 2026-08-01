# Consist

Sticky, deterministic **booking assembly** on a rail fabric.

Users request ordered **Class** legs; Consist binds **Cars**, routes through **Yards** (port graph), accumulates **Context**, and prefers **sticky** reuse so re-Setup stays rare.

| Layer | Role |
|-------|------|
| **Assembler** | Legs, prefilter, Context, checkpoints, sticky / fail |
| **Coupler** | One multi-sink fabric search per Class→Class segment |

## Docs

Start here: **[docs/README.md](./docs/README.md)**

| Doc | Role |
|-----|------|
| [docs/SPEC.md](./docs/SPEC.md) | Full design handoff |
| [docs/BUILD_SPEC.md](./docs/BUILD_SPEC.md) | Implementer contracts + goldens G1–G12 |
| [docs/booking-assembler-design.html](./docs/booking-assembler-design.html) | Interactive walkthroughs (offline) |

```bash
open docs/SPEC.md
open docs/booking-assembler-design.html?scenario=simple
```

## Stack (target)

Kotlin (JVM) microservice. Domain goldens first; Kafka adapters later (SPEC §10.1).

## Name

**Consist** is the project. A **consist** is also the domain object (bound Cars + route).
