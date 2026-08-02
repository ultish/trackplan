# Coupler control flow: Option A vs Option B

**Status:** Design record for pivot / revisit — **not** the implementer day-1 contract.  
**Current product choice:** **Option A (multi-sink + ExpandKey frontier)** — see [BUILD_SPEC.md](./BUILD_SPEC.md) §3.9d C2, §3.7b, §8.  
 
**Audience:** Future you, another session, or a reviewer who wants the full debate without replaying chat.

**Vocabulary:** StationType · Station · Track · Link · tail (bound out-track) · Prefilter · Inspector · Assembler · Coupler · Oracle++ · ExpandKey · frontier · agenda / goals · transparent.

---

## 1. Shared problem (both options)

**Given**

- **Tail:** a bound **out-track** on the previous Station (or virtual **S0** on the first leg). Binding always includes which out-track becomes the next start — not “Station only.”
- **Leg demand:** next **StationType T** + **request** (unless booking pins a specific Station).
- **Fabric:** Links + transparent stations between.

**Find**

- A path from the tail, and  
- A **concrete Station** of type T that Prefilter allowed and **Inspector** accepts for that arrival.

**Sink** = a concrete goal finish (Station + in-track, out as required) — **not** StationType itself.  
**StationType** = goal *class* used to build the candidate sink set.

Both options build a sorted list of candidate finishes (**agenda / goals**) after Prefilter + **Oracle++**. They differ in **who loops** when a goal fails inspect or is unreachable on some paths.

---

## 2. Option A — multi-sink + ExpandKey frontier (DECIDED v1)

```text
goals = sortByExpandKey(Oracle++ filter(prefilter pool of type T))
result = Coupler.couple(tail, goals=goals, …)   // ONE call per segment attempt
// Inside Coupler: one ExpandKey frontier; many sinks
//   pop = (g, ExpandKey…) — ExpandKey-dominated (not f=g+h preference ranking)
//   path fail / inspect fail at a goal → stay in frontier
//   first inspect-OK goal → return (first-fit)
// Assembler re-calls Coupler for next leg or inter-leg backtrack to last Checkpoint
// ExpandKey: preferInUse, preferNonTransparent, distToSegmentGoals, distToTerminal,
//            neighborRank, stationName, portName  (BUILD_SPEC §3.7b)
```

| | |
|--|--|
| Within-leg inspect/path retries | **Inside Coupler frontier** |
| Assembler role for this leg | Build goals, call once, apply result, keep unused goals as alts |
| Ranking | **ExpandKey** lex only — no summed edgeCost / no peel |
| Classic name | Multi-sink search with ExpandKey frontier |

### Pros

- Shared fabric from a fixed tail is explored **once** (no re-prime per Station).  
- Matches “segment = one search” mental model.  
- Path diversity to the **same** Station (short fail, long via transparent OK) stays in one frontier.  
- Aligns with performance note: not one A\* per Station (Option B peel).

### Cons

- Coupler core is harder to read (multi-goal frontier, continue-on-inspect-fail).  
- Careful closed-set rules so one bad arrival at N1 does not block another path to N1.  
- Slightly richer debug (log failed goal samples inside Coupler).

---

## 3. Option B — agenda peel

```text
goals = sort(Oracle++ filter(...))
while goals not empty:
  target = goals.pop()
  result = Coupler.tryTarget(tail, target, …)   // single-sink each time
  if result ok: break
// remaining goals = alts for later (if any)
```

| | |
|--|--|
| Within-leg station retries after null | **Assembler** peels next target |
| Coupler | Closer to textbook single-target A\* |
| Classic risk | Re-walk shared prefix from same tail for N1, then N2, then N3 |

### Pros

- Coupler function is easier to unit-test and step through per Station.  
- Assembler loop is obvious in a debugger (“now trying N2”).  
- Easy to pause/instrument per candidate.

### Cons

- Re-prime / re-expand from the same tail for each target (cost grows with fabric depth).  
- Control flow for “inspect fail” splits across Assembler + Coupler.  
- Easy to accidentally treat path retries as Assembler concerns (SPEC anti-pattern).  
- Assembler becomes thicker.

**Note:** Even under B, **path** retries to a *single* target should still stay inside one `tryTarget` (do not return to Assembler after every short path). Peel only changes **which Station** is the sole sink per call.

---

## 4. Concrete example (same for comparing A vs B)

Booking: **R → N → X** (X = terminal StationType).

```text
Tail bound: R1:1
Links from R1:1:
  R1:1 → 1:N1
  R1:1 → 1:N2
  R1:1 → 1:N3
Sort: ExpandKey lex (e.g. N1, N2, N3 when distances/ranks tie → name)
Oracle++ (see BUILD_SPEC): may drop sinks that cannot reach terminal X
  e.g. N1 cannot reach any X → drop N1 if Oracle++ enabled for terminal
Assume for a moment Oracle++ only filters “reach some N” (weak): goals = {N1,N2,N3}
```

### Happy path (N1 inspect OK)

| | Option A | Option B |
|--|----------|----------|
| Calls | One `couple(goals={N1,N2,N3})` | One `tryTarget(N1)` success |
| N2, N3 inspected? | No | No |
| Remainder | Unused goals kept as alts (if policy keeps alts) | Remainder of agenda |

### N1 inspect FAIL, N2 OK

| | Option A | Option B |
|--|----------|----------|
| Behavior | Same ExpandKey frontier continues → reach N2 → inspect OK | Return to Assembler → `tryTarget(N2)` |
| Efficiency | Shared expansions from R1:1 | Second search from R1:1 |

### N1 inspect OK, but N1 cannot reach X

Neither A nor B fixes this **inside** the N-leg search alone. Need:

- **Oracle++** “this N sink can still reach terminal X (and/or next non-transparent types)”, and/or  
- **Inter-leg backtrack** (to last Checkpoint): undo N1 if N not checkpointed, retry alts {N2,N3}.

---

## 5. Oracle++ (related; both options benefit)

Weak Oracle: “from tail, can I reach **some** Station of type T?”  
**Oracle++ (DECIDED direction):** topology insight for the **whole remaining booking**, not only the next type:

1. Between **non-transparent** StationTypes on the demand string (leg i → leg i+1 → …).  
2. From a candidate Station (or finish) of an intermediate type to the **terminal** StationType (last leg).  
3. From the current tail (or S0) through those filters when building **goals** for a segment.

This shrinks multi-sink goal sets (and peel agendas) so first-fit is less likely to bind a dead-end Station for the rest of the chain.  
Details: [BUILD_SPEC.md](./BUILD_SPEC.md) §3.7 Oracle++.

Oracle++ is **topology-only** (same loop rules as Coupler: hop_key, H, V, online Links/Stations). It does **not** replace Inspector (tasking, request, context stamps).

---

## 6. Why v1 chose A

Recorded lean (product session):

1. Production graphs are deep fabric + many candidates — re-priming per Station hurts.  
2. Inspect/path failures at goals are normal; they should not round-trip Assembler every time.  
3. Assembler stays “legs + world + sticky”; Coupler stays “from this tail, ExpandKey frontier over multi-sink goals.”  
4. Happy path identical to B; difference is failure packing and cost.  
5. Readability of Coupler is manageable with helpers + goldens; system-level story is clearer with one search per segment.

**Pivot triggers** (when to reconsider B or a hybrid):

- Coupler frontier bugs dominate delivery cost and goldens are unstable.  
- Goal sets are always size 1 in production (booking always pins Station).  
- Profiling shows multi-sink overhead worse than peel on real topologies (unexpected).  
- Team strongly prefers single-target A\* for onboarding and accepts Assembler loop cost.

**Hybrid (not v1):** multi-sink for path retries but Assembler batches goals in waves — only if profiling demands; document here if adopted.

---

## 7. Mapping to code (if pivoting)

| Concern | Option A | Option B |
|---------|----------|----------|
| Public API | `couple(tail, goals: Set<Finish>)` + ExpandKey frontier | `tryTarget(tail, finish)` + Assembler peel loop |
| Ranking | ExpandKey lex only (no summed edgeCost / f=g+h) | Single-sink A\* per peel (pivot shape) |
| Goldens | G: N1 inspect fail → same resolve binds N2 without two segment metrics spikes | G: two couple invocations |
| Metrics | `expansions` per segment | Sum expansions across peels; count peels |
| FailureReport samples | Failed goal arrivals inside one call | Per-tryTarget samples |

Implementers on **current** mainline: implement **A** only. Keep this file when changing BUILD_SPEC §8 so the discarded shape is not lost.

---

## 8. Cross-links

| Doc | Role |
|-----|------|
| [BUILD_SPEC.md](./BUILD_SPEC.md) §3.7 Oracle++ | Reachability queries |
| [BUILD_SPEC.md](./BUILD_SPEC.md) §3.9d C2–C2d | DECIDED A + backtrack/alts/transparent inspect |
| [BUILD_SPEC.md](./BUILD_SPEC.md) §8 | Implement multi-sink |
| [SPEC.md](./SPEC.md) §3 | Architecture narrative |
| [ENTITY_DIAGRAMS.md](./ENTITY_DIAGRAMS.md) §7 | Sequence (A) |

---

*If you pivot to B: update BUILD_SPEC §3.9d C2 + §8 first, leave this doc’s §6 with a dated “pivoted to B on …” note, and do not delete the A description.*
