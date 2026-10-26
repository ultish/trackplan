# DAG resolve: fan-out and fan-in as one request

**Status:** Design proposal. Not part of BUILD_SPEC, not implemented. Written to be **adapted**: Part A is the algorithm and does not depend on how Trackplan works. Part B maps it onto Assembler/Coupler as the repo stands, and §9 lists every assumption that your real version may break.

**Audience:** You, another session, or a reviewer porting this onto a changed Trackplan.

**Reference implementation:** `solve()` in [`claude-review/dag-resolve-sketch.html`](../claude-review/dag-resolve-sketch.html). Its step list is the executable version of §5 and §6, and its four scenarios are the fixtures in §10. The page also explains the idea visually, one step at a time.

**Related:** [BUILD_SPEC.md](./BUILD_SPEC.md) §3.9d (multi-leg, checkpoint, alts), [RESOLVE_TRACE.md](./RESOLVE_TRACE.md) (trace events, §8 below), [COUPLER_OPTION_A_VS_B.md](./COUPLER_OPTION_A_VS_B.md).

| Status tag | Meaning here |
|------------|--------------|
| **PROPOSED** | This doc's recommendation. Nothing is DECIDED yet. |
| **OPEN** | Needs a product or engine decision. Do not invent one. |
| **ASSUMES** | The algorithm is only correct if this holds. Check it first (§9). |

---

## 1. Problem

Today a fan-out or fan-in takes several tasks that must stay in step:

```text
fan-out   task 1:  A  B  C  D  E
          task 2:  A  B  C  D  F        must re-use A, B, C, D from task 1

fan-in    task 1:  A  B  C  D
          task 2:  A′ B′ C  D           must land on the same C task 1 used
```

The rule "task 2 must re-use these assets" is enforced by making task 2 **follow** task 1. That makes the result depend on the order the tasks run in. Task 1 can also pick an asset (first-fit) that makes task 2 impossible, and nothing says why.

**Proposal:** express the whole request as one DAG, give every shared node **one** asset, and solve the DAG jointly. There is nothing to re-trace and no "task 1 first". A join becomes a constraint on one variable.

---

# Part A: The algorithm (engine-independent)

## 2. Model

| Term | Meaning | Trackplan name (network vocabulary) |
|------|---------|-------------------------------------|
| **Slot** | A node of the demand DAG. Takes exactly one asset. | A Step (ResourceType + TaskingConfiguration) that is a node of a DAG |
| **Domain** `D(s)` | Candidate assets for slot `s`. | Prefilter pool, Oracle++ filtered, inspector-passing |
| **Edge** `s→t` | The asset at `s` must feed the asset at `t`. | Consecutive Steps |
| **Compat** `R(s→t) ⊆ D(s)×D(t)` | Pairs `(x,y)` that may be adjacent. | "A valid Dataflow path from `x`'s OUT to `y`'s IN exists and inspects OK" |
| **Assignment** | One asset per slot. | AllocatedAssets |
| **Solution** | Assignment where every edge's pair is in `R`. | A resolved Strategy |

```text
DagRequest {
  slots: Slot[]                     // id, resourceTypeId, taskingConfiguration
  edges: (from: SlotId, to: SlotId)[]
}
Oracle {
  domain(slot): Asset[]                                  // ordered by ExpandKey
  compat(from: Slot, x: Asset, to: Slot, y: Asset): Boolean   // pure, memoised per (from,x,to,y)
}
Result = Solved(assignment: Map<SlotId, Asset>, stats)
       | Unsat(report: FailureReport)
```

**Passengers (tasks) are paths through the DAG.** The solver does not need them. It decides assets; the Tasks fall out of running the Inspectors along each source-to-sink path afterwards (§11, OPEN).

**Sharing is required (your call in discussion, not yet a BUILD_SPEC decision).** A slot has one asset no matter how many paths use it. "Cheaper if shared" is a different problem (§12).

## 3. Shape classification

Ignore edge direction. Let `N` be slots, `M` edges, `C` connected components.

```text
acyclic (forest)  ⇔  M = N − C
```

| Shape | Examples | Solver |
|-------|----------|--------|
| Forest | fan-out; fan-in from different starts; any mix of the two with no loop | §4: two passes, no search |
| Has a loop | one start splits, branches rejoin (diamond) | §5: pin one slot per loop, then §4 |

Fan-out and fan-in from separate starts are **trees**. Only a branch that **forks and rejoins** creates a loop. This is the key shape fact; do not treat "fan-in" as automatically hard.

## 4. Forest solve (no backtracking)

This is directional arc consistency on a tree-structured binary constraint problem (Freuder 1982).

1. **Orient.** Per component, root at the slot with most neighbours (ties: earliest declared). Orientation is for the algorithm only; it is unrelated to DAG direction.
2. **Prune, leaves → root.** For each non-leaf slot `v`, children `c₁…cₖ`:
   `D(v) ← { x ∈ D(v) : ∀ cᵢ ∃ y ∈ D(cᵢ) with (x,y) compatible }`
   If `D(v)` becomes empty → UNSAT, report `v`.
3. **Pick, root → leaves.** Root takes its first surviving candidate. Each child takes the first survivor compatible with its parent's pick.

**Guarantee.** After step 2 every survivor at a parent has support in every child, so step 3 always finds a pick. A root with a non-empty domain means a solution exists. No backtracking is ever needed on a forest.

**The join is the overlap.** For a slot with several children (a fan-in join, or a fan-out base), step 2 is exactly "take the intersection of what each child branch can reach". That replaces "task 2 must know which asset task 1 used".

## 5. Loop solve (pin one slot per loop)

A pure forest check is not complete once a loop exists: every pair can have support and the joint answer can still be empty.

1. **Local pass (optional).** Run arc consistency over all edges both ways. Cheap. It can prove UNSAT early, but a pass with no removals proves nothing.
2. **Choose a cutset** `K`: slots whose removal leaves a forest. For one loop, any slot on it works. **PROPOSED:** smallest `|D|`, ties earliest declared.
3. **For each value `v ∈ D(k)`, in domain order:**
   1. Pin `k = v`. Filter each neighbour's domain to partners of `v`.
   2. If any neighbour empties, record the failure and try the next value.
   3. Run §4 on the remaining forest.
   4. On success return. On failure record which slot emptied and restore all domains.
4. All values failed → UNSAT, with one failure record per pinned value.

**Cost.** At most `∏ |D(k)|` forest solves over the cutset `K`. Compat results are memoised across attempts, so retries are cheap. Backtracking is confined to the cutset: nothing outside it is ever retried.

**Several loops.** One pinned slot may not cut them all. Choose the smallest slot set whose removal leaves a forest (feedback vertex set; brute-force subsets are fine at demand-DAG sizes). Cost multiplies per extra pinned slot, so cap it (**OPEN**, §11).

## 6. Ordering and tie-breaks

| Choice | Proposed rule | Note |
|--------|---------------|------|
| Tree root | Highest degree, ties earliest declared | Join slot becomes the root, so overlaps are taken there |
| Pick among survivors | **ExpandKey order** (lowest g first), not pool order | The sketch page uses pool order only because it has no costs |
| Cutset slot | Smallest domain, ties earliest declared | **OPEN:** smarter heuristics later |
| Cutset value order | Domain (ExpandKey) order | |

Any survivor is a valid choice. Ordering only decides *which* valid answer you get.

## 7. Failure report

UNSAT is only useful if it says where. Because §4 empties a *specific slot*, the report is cheap:

```text
FailureReport {
  shape: FOREST | LOOP
  emptiedSlot: SlotId                    // forest: the slot; loop: the last attempt's slot
  perPin: { slot: SlotId, value: Asset, emptiedSlot: SlotId, viaBranches: Map<SlotId, Asset[]> }[]
}
```

`viaBranches` is the overlap at the join: for each child, the parent candidates it can reach. An empty intersection of those sets is the human-readable cause ("branch B reaches {C1}, branch B′ reaches {C2}, no overlap").

---

# Part B: Onto Trackplan

## 8. Mapping to Assembler / Coupler

All **PROPOSED**. The point is to change as little as possible.

| Today | With DAG resolve |
|-------|------------------|
| Strategy.steps is an ordered list | Strategy has `steps` + `edges` (a Step may have several `after`); a linear list is the degenerate DAG |
| Coupler multi-sink `couple(tail, goals)` returns the **first** inspect-OK goal | Coupler (or a wrapper) supplies **candidate sets and compat tests**, not one bound pick |
| Assembler leg loop with alts and backtrack to last Checkpoint | Assembler runs the §3–§5 resolver. Backtrack target is the **cutset slot** |
| FailureReport names first emptying stage | Same idea; `emptiedSlot` and `viaBranches` (§7) |
| Sticky cache keyed on request | Key on **DAG shape + domains** (OPEN) |

**Where the Coupler sits.** `domain(slot)` is the Oracle++ filtered, ExpandKey-sorted goal list for that slot's ResourceType. `compat(x, y)` is a bounded path search from `x`'s OUT to `y`'s IN over online Dataflows, with Inspector accept. Both exist today in some form; the change is to expose them as queries and memoise them, not bind on first success.

**Checkpoint (OPEN, replaces BUILD_SPEC checkpoint timing for DAG requests).** In a linear request, a type is checkpointed once the *next* non-transparent step succeeds. Suggested DAG form: a slot may be checkpointed once **all** of its DAG neighbours are bound. Under the pin-and-solve loop, only the pinned slot is ever retried, so checkpointing is mostly implied; decide whether you still need explicit checkpoints.

**Trace events (feeds RESOLVE_TRACE).** The sketch's step kinds map to events one-to-one:

| Sketch step | Event | Payload |
|-------------|-------|---------|
| SETUP | `dag.start` | slots, edges, domains |
| SHAPE | `dag.shape` | `FOREST`/`LOOP`, cutset |
| PLAN | `dag.orient` | root, prune order |
| PRUNE | `dag.prune` | slot, removed assets + reason, `viaBranches` |
| FIX | `dag.pin` | slot, value |
| PICK | `dag.pick` | slot, asset |
| FAIL | `dag.dead_end` | emptied slot, `viaBranches` |
| DONE / UNSAT | `dag.done` / `dag.unsat` | assignment / FailureReport |

## 9. Assumptions to verify against your real Trackplan

This is the section to work through first. The algorithm is correct **only if these hold.**

| # | ASSUMES | If false | What to do |
|---|---------|----------|------------|
| 1 | **`compat(x,y)` is a pure function of the two assets** (plus the fixed world). | Then pruning over pairs is unsound. | See #2. |
| 2 | **Task.context does not change which assets are compatible.** Today the Inspector writes `Task.context` hop by hop, so what an asset accepts can depend on the route so far. | Pairwise constraints no longer capture it; a "compatible" pair may fail at inspect time. | (a) Make the domain value `(asset, contextDigest)` if context is finite and small. (b) Treat compat as an **optimistic pre-filter** and run the real Inspectors afterwards, falling back to generate-and-test: return to the pin loop and ban the failing pair. (c) Restrict DAG resolve to requests whose Inspectors are context-free. |
| 3 | **Two branches may use one asset at the same time.** "Shared slot, one asset" means the asset serves both tasks. | If an asset can hold only one task per interval, sharing a slot is impossible. | Define whether Tasking allows several Tasks per asset per interval, and how Inspectors see the second one. |
| 4 | **Branches do not compete for fabric capacity.** `compat` is checked per edge, independently. | Two edges can each have a path but share a switch port, so the pair of paths is impossible. | Add a **global capacity check** after assignment; on failure, feed the conflict back as a banned pair and re-solve. |
| 5 | **Time is outside the solve.** The resolver runs for one candidate time window. | If different slots need different windows, compat depends on both. | Keep the resolve inside `placeBookingOverTime` (per attempt); make `compat` time-aware. |
| 6 | **Domains are finite and enumerable** per slot. | Lazy infinite goal streams break pruning. | Cap with `max expansions`; treat truncation as `BUDGET`, not UNSAT. |
| 7 | **Required sharing.** A slot has one asset. | "Cheaper if shared" turns this into an optimisation (§12). | Different algorithm. |
| 8 | **Edges are binary.** Each constraint relates two slots. | A rule over three or more slots (e.g. "the join asset must differ from both branches' assets") needs a global constraint. | Treat as a post-check, or extend the model (OPEN). |
| 9 | **The demand is small.** Slots and domains are small enough for `d²` compat calls per edge. | Large `d` makes compat the bottleneck. | Memoise; prune domains with Oracle++ first. |

## 10. Reference fixtures

Four scenarios from the sketch. Use them as goldens (suggested ids `DG1`–`DG4`, to avoid colliding with G1–G12). Domain order is the pool order shown; compat pairs are listed per edge (symmetric).

### DG1 Fan-out (forest)

```text
slots   A{A1,A2} B{B1,B2} C{C1,C2} D{D1,D2} E{E1,E2} F{F1}
edges   A→B  B→C  C→D  D→E  D→F
compat  A-B: A1B1 A2B2        B-C: B1C1 B2C2      C-D: C1D1 C2D2
        D-E: D1E1 D2E2        D-F: D2F1
```

| Expect | |
|---|---|
| Shape | FOREST, root D |
| Prune | D drops D1 (no F partner); B, C keep both |
| Assignment | A=A2 B=B2 C=C2 D=D2 E=E2 F=F1 |
| Backtracks | 0 |

Variant: take `D2` offline → UNSAT, `emptiedSlot = D`.

### DG2 Fan-in from different starts (forest)

```text
slots   A{A1,A2} B{B1,B2} A′{A3,A4} B′{B3,B4} C{C1,C2} D{D1}
edges   A→B  B→C  A′→B′  B′→C  C→D
compat  A-B: A1B1 A2B2       B-C: B1C1 B2C2
        A′-B′: A3B3 A4B4     B′-C: B3C2 B4C2        C-D: C1D1 C2D1
```

| Expect | |
|---|---|
| Shape | FOREST, root C (neighbours B, B′, D) |
| Overlap at C | via B `{C1,C2}`, via B′ `{C2}`, via D `{C1,C2}` → `{C2}`; C1 dropped |
| Assignment | A=A2 B=B2 A′=A3 B′=B3 C=C2 D=D1 (A and A′ are the two starts) |
| Backtracks | 0 |

### DG3 Split and rejoin (loop, SAT after one retry)

```text
slots   A{A1,A2} B{B1,B2} B′{B3,B4} C{C1,C2} D{D1}
edges   A→B  A→B′  B→C  B′→C  C→D
compat  A-B: A1B1 A2B2       A-B′: A1B3 A2B4
        B-C: B1C1 B2C2       B′-C: B3C2 B4C1 B4C2   C-D: C1D1 C2D1
```

| Expect | |
|---|---|
| Shape | LOOP (5 slots, 5 edges), cutset A (domain size 2, earliest declared) |
| Local pass | removes nothing |
| Pin A1 | B={B1}, B′={B3}; C needs `{C1}∩{C2}` = ∅ → dead end at C |
| Pin A2 | B={B2}, B′={B4}; C needs `{C2}∩{C1,C2}` = `{C2}` |
| Assignment | A=A2 B=B2 B′=B4 C=C2 D=D1 |
| Backtracks | 1, over A only |

### DG4 Split and rejoin (loop, UNSAT)

Same as DG3 but `B′-C: B3C2 B4C1` (no `B4C2`).

| Expect | |
|---|---|
| Local pass | removes nothing (every asset has a partner on every edge) |
| Pin A1 | C needs `{C1}∩{C2}` = ∅ |
| Pin A2 | C needs `{C2}∩{C1}` = ∅ |
| Result | UNSAT, `emptiedSlot = C`, one `perPin` record per value of A |

Also useful: take assets offline one at a time and assert the outcome in the sketch's playground (it re-solves live). Each result there is a free regression case.

## 11. Open questions

| # | Question |
|---|----------|
| O1 | **Tasks at a join.** Today an Inspector sees one Task and the context built along one path. At a fan-in, two paths arrive. Does the join Inspector see both contexts, a merged context, or are two Tasks created? |
| O2 | **Who owns the DAG shape?** A `Strategy` with `after` edges, or a new type? How do existing linear Strategies migrate (a chain is the degenerate DAG)? |
| O3 | **Checkpoint semantics** for DAG requests (§8). |
| O4 | **Pin-set cap** when several loops exist: maximum product of the pinned slots' domain sizes before returning `BUDGET`. |
| O5 | **Context-dependent compat** (assumption 2): which mitigation (a), (b) or (c)? This is the biggest correctness risk. |
| O6 | **Sticky cache key** for DAG requests, and whether UNSAT sticky entries carry `viaBranches`. |
| O7 | **Capacity feedback loop** (assumption 4): ban a pair vs. ban a path. |
| O8 | **Sharing when an asset is single-tenant** (assumption 3). |

## 12. Non-goals

- **Cost-optimal sharing** ("a shared edge costs once"). That is Steiner-tree search, a different problem. The solver here finds *a* valid assignment, then orders by ExpandKey.
- **Preferred, not required, sharing.** Out of scope; required sharing is what makes this a pure constraint problem.
- **Time as a variable.** See assumption 5.
- **Changing Coupler's internal ExpandKey frontier.** It stays; only its output is consumed differently.

## 13. Pseudocode

```text
solve(req, oracle):
  dom   = { s: oracle.domain(s) for s in req.slots }
  shape = classify(req)                              // §3
  if shape.isForest:                                  // §4
    return solveForest(req.slots, dom, oracle)
  if localPassEmpties(req, dom, oracle): return Unsat(...)
  K = chooseCutset(req, dom)                          // §5
  fails = []
  for combo in product(K.map { dom[it] }):
    d2 = copy(dom); pin(d2, K, combo)
    if filterNeighbours(d2, K, combo, oracle).anyEmpty: fails += ...; continue
    r = solveForest(req.slots - K, d2, oracle)
    if r is Solved: return Solved(combo ∪ r.assignment)
    fails += r.report
  return Unsat(perPin = fails)

solveForest(slots, dom, oracle):
  for tree in orient(slots):                          // root = highest degree
    for v in postOrder(tree):                         // leaves first
      if tree.children(v).isEmpty: continue
      dom[v] = dom[v].filter { x -> tree.children(v).all { c -> dom[c].any { y -> oracle.compat(v, x, c, y) } } }
      if dom[v].isEmpty: return Unsat(emptied = v, via = overlaps(v))
    pick[tree.root] = dom[tree.root].first()
    for v in preOrder(tree) minus root:
      pick[v] = dom[v].first { y -> oracle.compat(parent(v), pick[parent(v)], v, y) }   // never fails
  return Solved(pick)
```

---

## 14. Adaptation checklist

Work through these in order when porting to your real Trackplan:

1. **Confirm assumptions 1, 2 and 4 in §9.** If context (2) or capacity (4) changes what is compatible, decide the mitigation before building anything.
2. **Define `domain` and `compat`** as pure, memoised queries on your real Coupler/Oracle. Everything else in this doc depends only on them.
3. **Decide the demand schema** (O2): how a Strategy expresses a DAG and how existing linear Strategies map onto it.
4. **Decide join semantics** (O1, O3).
5. **Wire the §10 fixtures** as goldens against a stub oracle first (pure data, no fabric). Only then connect the real Coupler.
6. **Emit the §8 trace events** from the start so failures are explainable in production.
