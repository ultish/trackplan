# Consist — docs index

**Consist** is the project name: sticky, deterministic booking assembly on a rail fabric  
(Class · Car · Yard · Booking · Inspector · Assembler · Coupler).

The domain object **consist** (bound Cars + route) is intentional — the system *grows a consist*.

## For a new session / other LLM (start here)

| Order | Doc | Role |
|-------|-----|------|
| **1** | **[SPEC.md](./SPEC.md)** | **Full handoff:** problem, architecture, Assembler↔Coupler contract, prefilter vs accept, multi-Yard discovery, sticky/cache, decision log, open questions, work packages |
| **2** | **[BUILD_SPEC.md](./BUILD_SPEC.md)** | Implementable contracts: schemas, algorithms, API, policy defaults, goldens G1–G12, Kotlin notes, phases |
| **3** | **[booking-assembler-design.html](./booking-assembler-design.html)** | Interactive scenarios + track-level fabric (offline) |
| — | **[FIXTURE_STUDIO.md](./FIXTURE_STUDIO.md)** | **Design only:** web UI to build topology + bookings → golden fixtures (not implemented) |

### Copy-paste builder prompt

```text
Project: Consist. Read docs/SPEC.md for full design intent, then implement docs/BUILD_SPEC.md.
Rail vocabulary only. Pass goldens G1–G12. No UI.
Follow DECIDED/DEFAULT; ask only on OPEN items that block you.
Use docs/booking-assembler-design.html walkthroughs if Assembler/Coupler or prefilter/accept is unclear.
Preferred stack: Kotlin (JVM). Repo and package root: consist.
Kafka in/out is production shape (SPEC §10.1) — implement adapters after domain goldens; not required for G1–G12.
```

### Confirm-with-human before production

See **SPEC.md §12** (open questions) and **§11** (work packages W14 Class catalog, W17 Kafka, **W19 priority/force preemption**, policy numbers, combine vs exclusive). Defaults exist so coding can start.

**Priority:** Bookings may carry `priority`; normal resolve only uses free resources (`CAPACITY_BLOCKED` if none). **Force priority** (kick lower Bookings) is **OPEN** — strawman in SPEC Q16, not v1.

### Production IO (documented, not engine v1)

- **In (Kafka):** changes to Classes, Cars, connections/fabric, Bookings, …  
- **Decide:** whether change requires reschedule (hopeful / broken sticky / demand change).  
- **Out (Kafka):** claims + Setups for Cars used by Bookings (and plan status).  
Details: **SPEC.md §10.1**, **BUILD_SPEC §18.3**.

## Assembler vs Coupler (one sentence each)

- **Assembler** — ordered Class legs, **prefilter** candidates, Context, checkpoints, sticky; calls Coupler **once per segment**.
- **Coupler** — one successful path between two Class Cars (any Yards in between), or exhaust/fail. Failed path tries stay **inside** Coupler; full **accept()** at goal.

## Toy topology (walkthroughs)

```text
R ──► Y1 ──┬── N-04 ──► D-02
           ├── N-08
           ├── N-12 (only via re-entry out6) ──► D-11
           └── Y2 ──┬── N-04 (out5)
                    └── Y1 in5 (out6 loopback)
```

No out-port multiplex. Illegal Y1 `1→6` forces N-12 via Y2 loopback + `5→6`.

| # | Scenario | Link |
|---|----------|------|
| 1 | Simple (prefilter seats, accept at N) | [simple](./booking-assembler-design.html?scenario=simple) |
| 2 | Multi-Yard + path Context (Y2→N-04 free) | [multiyard](./booking-assembler-design.html?scenario=multiyard) |
| 3 | Loopback + anti-spin (re-entry OK; infinite Y1↔Y2 killed) | [loopback](./booking-assembler-design.html?scenario=loopback) |
| 4 | Prefilter rejection | [prefilter](./booking-assembler-design.html?scenario=prefilter) |
| 5 | No solution (capacity) | [nosol](./booking-assembler-design.html?scenario=nosol) |
| 6 | Sticky & cache | [sticky](./booking-assembler-design.html?scenario=sticky) |

`N-04` = **Car** of Class **Normal** (not a Yard).

## Offline

Libs under [`docs/vendor/`](./vendor/) — **no CDN** (`cytoscape.min.js`, `mermaid.min.js`).

## Vocabulary

Class · Car · Setup · Inspector · **prefilter** · **accept** · Booking · Leg · Consist · Context · Yard · Hop · Assembler · Coupler · Checkpoint

## Local open

```bash
open docs/SPEC.md
open docs/BUILD_SPEC.md
open docs/booking-assembler-design.html?scenario=simple
```
