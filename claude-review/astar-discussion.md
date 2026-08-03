# A* Discussion

## User

i have a A* system at work, and for every node it discovers, it keeps it in the log. eg start at A, see childs B, C, so the log has A->B, A->C, then if we explore B we see it's childs D, E. so the log shows
- B -> D
- B -> E
- A -> C
what its doing is tracking unopened nodes, so that it can backtrack to find an alternatvive path.

however, is this normal for A*, does A* usually start again from a previous node?

## Assistant

This is a conceptual algorithms question, not a codebase task — answering directly.

What you're describing is normal A* behavior, but the terminology is worth untangling:

- **A* doesn't "restart" or "backtrack" from a previous node** in the sense of re-running the search. Instead, it maintains an **open set** (aka frontier/priority queue) of all discovered-but-not-yet-expanded nodes, ordered by `f(n) = g(n) + h(n)`.
- Every time you expand a node, you generate its children and push them onto the open set. That's exactly what your log is capturing: `A -> B`, `A -> C` (children of A pushed), then `B -> D`, `B -> E` (children of B pushed).
- "Backtracking to find an alternative path" happens naturally because at each step, A* doesn't necessarily expand the most recently discovered node — it expands whichever node in the open set currently has the lowest `f` value. So after expanding B into D and E, if `A -> C` still has a lower `f(C)` than `f(D)` and `f(E)`, A* will expand C next, even though it was discovered earlier. To an observer this looks like "jumping back" to an old node, but it's just the priority queue doing its job — nothing was popped and reinserted, it just never got expanded yet.

So: yes, this is standard behavior. The log is essentially exposing the open set's insertion history. A couple of things worth double-checking about the implementation:

1. **Order of expansion** should be by lowest `f(n)`, not by discovery order or DFS/BFS order. If nodes are expanded in discovery order (like a queue) rather than priority order, that's not really A* — it's more like Dijkstra without proper priority ordering, or plain BFS with a heuristic label.
2. **Re-discovery / re-parenting**: if a node already in the open set is reached again via a cheaper path (lower `g`), a correct A* implementation updates its parent and cost rather than logging a duplicate edge. If your log shows the same node appearing as a child of two different parents, check whether the cheaper-path update is actually replacing the old parent pointer, not just appending a new log entry alongside the stale one.
3. **Closed set** should prevent re-expansion of already-finalized nodes (with the caveat above for cheaper re-discovery in graphs with varying edge costs).

If you want, share the actual expansion order (which node gets *popped and expanded* at each step, not just which edges get logged) and I can tell you whether the priority ordering looks correct.

## User

is open set the more common term?

## Assistant

Both are common, but it depends on context:

- **"Open set" / "closed set"** — the terminology from the original Hart, Nilsson & Raphael A* paper (1968) and most textbooks (Russell & Norvig's AIMA uses "frontier" actually, but a lot of classic AI texts and Wikipedia use open/closed set). Very common in academic/theoretical writing.
- **"Frontier"** — the term AIMA (the most widely used AI textbook) and many modern implementations use instead of "open set." Also common in graph-search-general contexts (not just A*).
- **"Open list" / "closed list"** — probably the single most common phrasing in practical/game-dev A* tutorials and implementation-focused writing, since the "open set" is usually literally implemented as a priority queue (a list), not a mathematical set.
- **"Priority queue"** — used when people want to refer to the concrete data structure rather than the conceptual role.

So: "open set" is correct and recognized everywhere, but if you're talking to game/software engineers rather than academics, you'll more often hear **"open list"** (with "closed list" or "visited set" for the other side). "Frontier" is the more modern/AIMA-flavored synonym for the same concept. All refer to the same thing: the collection of discovered-but-not-yet-expanded nodes.

## User

u mention the frontier should be ordered by f(n), why

## Assistant

Because that ordering is what makes A* both **efficient** and **optimal** — it's not an arbitrary implementation choice, it's the definition of the algorithm.

**What f(n) represents**

- `g(n)` = actual cost from the start to `n` (known exactly, since it's the path you already walked).
- `h(n)` = heuristic *estimate* of the remaining cost from `n` to the goal.
- `f(n) = g(n) + h(n)` = your best current estimate of the **total cost of a path from start to goal that goes through n**.

**Why expand lowest f(n) first**

At any point, the open set contains all the "frontier" nodes — the candidate next steps for every path you've partially explored. If you always expand the node with the *lowest estimated total path cost*, you're always working on whichever path currently looks most promising to reach the goal cheaply. That's the greedy-but-informed part of "best-first search" — A* is literally an instance of best-first search where the priority function is f(n).

**Why this gives optimality**

If `h(n)` is *admissible* (never overestimates the true remaining cost), then f(n) is never an overestimate of the true cost of the best path through n. This guarantees: the first time A* pops the goal node off the open set, no other node still in the open set could possibly lead to a cheaper path to the goal — because every other node's f(n) (a lower bound on its best possible path cost) is already ≥ the cost you just found. If it were expanded out of f-order — e.g., by discovery order or depth — you could pop and finalize the goal via a suboptimal path before a cheaper alternative (sitting later in discovery order but with lower f) ever got a chance to be checked.

**Relation to Dijkstra / greedy best-first**

- If `h(n) = 0` everywhere, f(n) = g(n), and A* degenerates to Dijkstra's algorithm (ordered purely by actual cost so far).
- If you order by `h(n)` alone (ignoring g), you get greedy best-first search — fast but not optimal, since it can chase a heuristically promising node down an expensive path.
- A* combines both, which is why the ordering has to be on the *sum*, not either term alone.

So in your logging system: if you see a node expanded that does *not* have the lowest f(n) among everything currently in the open set, either the priority queue has a bug, or f(n)/h(n) is being computed incorrectly (e.g., wrong edge costs, non-admissible heuristic, or a stale g-value not being updated on rediscovery).

## User

right, so g(n) should get larger while h(n) gets smaller as i move closer to the goal?

## Assistant

Roughly yes, but there are some important caveats depending on which "closer to goal" you mean.

**Along a single path you're walking**

- `g(n)` is **monotonically non-decreasing** as you move along any path — since edge costs are ≥ 0, every step adds cost. This is always true, no exceptions (assuming no negative-cost edges).
- `h(n)` **tends to decrease** as you approach the goal, but this isn't guaranteed just from admissibility alone. It's guaranteed if the heuristic is **consistent** (aka monotonic): `h(n) ≤ cost(n, n') + h(n')` for every neighbor n'. A consistent heuristic can never "jump up" by more than the actual edge cost, so it behaves like a well-behaved lower bound that smoothly shrinks toward 0 at the goal.
- Most heuristics used in practice (Euclidean/Manhattan distance for grid pathfinding, for example) are consistent, so in your A* system h(n) should indeed generally shrink as you get physically closer to the goal.

**Consequence: f(n) is non-decreasing along the expansion sequence**

If h is consistent, then f(n) is monotonically non-decreasing over the *order in which nodes get expanded* (not necessarily along a single path, but across the whole search). This is actually a useful sanity check for your logging system: if you track the f-value of each node as it's *popped and expanded*, that sequence should never decrease. If it does decrease, either:
- the heuristic is admissible but not consistent (rare in practice, but possible with hand-tuned heuristics), or
- there's a bug — e.g., g-values not being updated correctly on rediscovery, or the priority queue is broken.

**What's not guaranteed**

- Comparing g(n) and h(n) *across different nodes on different branches* — there's no rule that says node X (closer to goal) always has lower h than node Y (farther away) if X and Y are on different paths with different heuristics of "distance." It's really only meaningful along a consistent path.
- h(n) is not required to decrease monotonically for A* to still be *correct* — only for it to have the nice non-decreasing-f property. With a merely admissible (not consistent) heuristic, A* is still optimal, but f can dip up and down during the search, and you may need to re-expand nodes if you find cheaper paths to already-closed nodes.

So: yes, your intuition matches how it works for the common, well-behaved case (consistent heuristic) — g rises, h falls, and their sum f rises gently and monotonically toward the true cost of the optimal path.

## User

in my scenario, i have a String of requested Resources. A, B, C. resources are linked to each other directly or via Switches (N:M input/outputs). so when im at A g(n) = 0 or 1. the node B, mite have h(n) = 3, while B2 has h(n) = 4 (lets say it has to go thru an extra switch. is this concept ok>

## Assistant

The core mechanic is fine — a node one extra switch-hop away legitimately gets a higher h(n), and that's a sound way to build the heuristic. But there's a bigger design question your example is hinting at, and it matters a lot for correctness: **what exactly is h(n) estimating the remaining cost *to*?**

Standard A* is defined for a single source → single goal. Your scenario — a *string* of requested resources A, B, C that all need to be connected, through a network of N:M switches — isn't quite that. A few possibilities, each with different implications:

**1. Sequential point-to-point search** (find path to B, then from B find path to C, etc.)
This is fine, and your B vs. B2 example fits perfectly here: h(n) estimates hops/cost remaining to reach the *next single target* (B), and B2 having a higher h because it needs an extra switch traversal is a legitimate, admissible estimate — as long as it never overestimates true remaining cost (e.g., if it's "number of switches left to cross," that's a safe lower bound only if each switch costs ≥1 and you're not undercounting shared/blocked capacity).

But sequential search like this is only optimal for the *whole* multi-resource request if the resources genuinely need to be visited in a strict order (A then B then C) with no interaction between the sub-paths. If instead you actually need all three resources *simultaneously connected* (e.g., a shared circuit/multicast tree through switches, where the path to C might reuse capacity from the path to B), then solving it as three independent shortest-path searches can give you a locally optimal but globally suboptimal or even invalid result — because switches have finite N:M capacity, and one search doesn't know what capacity the other search already consumed.

**2. Simultaneous multi-terminal search** (all of A, B, C must end up connected through the switch fabric)
This is structurally a **Steiner tree** problem, not a shortest-path problem, and plain A* with f=g+h toward one goal doesn't directly apply. If this is your actual scenario, the heuristic typically needs to estimate remaining cost to connect *all* outstanding terminals (e.g., sum of minimum spanning distances between unvisited resources), and you need to be careful that summing per-target heuristics doesn't become inadmissible (overestimating) when paths could share links/switches.

So: is your case (1) — you resolve requests one at a time, each as its own point-to-point search — or (2) — you're trying to find one connected structure that satisfies A, B, and C together, sharing switch capacity? That determines whether the B vs. B2 heuristic design you described is just fine as-is, or needs to account for interaction with the other pending resource requests.

## User

i dont get what sharing switch capacity means.
think of a network of machines connected to each other. either direct or via switches. there are flavors of these machines as they do different compute. so when i ask for A -> B -> C, each one is a flavor of machine. Im passing data from A, to B, to C. it must process in this order, and i can attach context as i reach each machine. eg at A i mite write { ctx: 1 }, then at B i mite add { ctx:1, bkey: A } etc. for each flavor of machine, i have actual machines that match that flavor. eg A1, A2, A3. B1, B2. C1, C2. so my topology looks like
A1 - B1
A2 - B2
B1 - Switch1
B2 - Switch1
Switch1 - C1
Switch1 - C2
i have not shown the ports they connect on =, but u can imagine Switch1 has at least 2:2 ports. A*, B*, and C* have 1:1 ports.

so from that topology, i wnat to find a path with A, B, C. so an example would be A1, B1, Switch1, C1. or A1, B1, Switch1, C2. or A2, B2, Switch1, C1.

## Assistant

Ah, that clarifies it — thanks. This isn't a Steiner tree / multicast problem at all; I was overcomplicating it. What you have is a **single sequential path** that must visit one node of flavor A, then one of flavor B, then one of flavor C, through a shared physical graph. "Switch capacity" only matters if you're running *multiple concurrent* A→B→C requests through the same switches at once and need to avoid port contention — for finding *one* path, it's irrelevant. Retracting that concern.

What you actually have is a classic **waypoint-constrained shortest path** problem, and A* handles it cleanly if you set it up right.

**How to model it**

The trick is that your *search state* isn't just "which node am I at" — it's "which node am I at, and which flavor am I currently trying to satisfy." So state = `(node, stage)` where stage ∈ {seeking-B, seeking-C, done} (you start already at an A-flavor node).

- From a state at an A-node in stage "seeking-B", you can only transition to neighbors, and you only advance to stage "seeking-C" once you land on a B-flavor node.
- Switch1 is just a pass-through node in this graph — it doesn't "count" as satisfying any flavor, it's a link between B and C. So a path like A1 → B1 → Switch1 → C1 has stage transitions at B1 (advance to seeking-C) and at C1 (advance to done, goal reached).
- This is sometimes called a **layered graph** or **product graph** technique — you're running A* over `graph × stages` instead of `graph` alone.

**Why this matters for your g/h question**

- `g(n)` is still just accumulated real cost (hops/link weight) from the origin, same as before — the layering doesn't change that.
- `h(n)` needs to estimate remaining cost to finish *all remaining stages*, not just the current one. E.g., if you're at B1 (just advanced to seeking-C), h(B1) should estimate "distance to nearest reachable C-flavor node," not distance to some fixed single goal. If you're still at an A-node seeking B, admissible h needs to account for both remaining legs: distance-to-nearest-B *plus* an estimate of B-to-C distance (or, more conservatively, just the first leg if you don't want to risk overestimating — admissibility requires you never overestimate the true remaining cost).

**Your B vs. B2 example, corrected in this frame**

If B1 and B2 are both valid B-flavor candidates reachable from A1, and B2 requires an extra switch hop to reach *from A1*, then h(B2's predecessor state) > h(B1's predecessor state) is legitimate — same logic as before, just now "goal" means "any node of the required next flavor" rather than one specific node. This is a small but important shift: your heuristic's target is a *set* of acceptable nodes (all instances of the next flavor), so h(n) should really be something like `min distance from n to any node of the next required flavor` — a multi-target/nearest-of-type heuristic, not distance to one fixed point.

Does your search already track stage-in-the-A→B→C sequence as part of node identity/state, or is it currently just doing plain node-to-node A* and hoping the flavor ordering falls out naturally?

## User

interesting, my current system only does node to node. and in the switch case (B to C), if its at B, it will add next nodes which are the switch nodes. then once it gets a switch node, it moves to Switch to C node etc.

## Assistant

That works, and it's actually simpler than the explicit-stage approach I described — but it relies on one assumption you should double check: **the physical topology itself enforces the flavor ordering**, i.e., there's no edge or path that lets you reach a C-flavor node without passing through a B-flavor node first (no A→C shortcut, no A→Switch bypass). Since your topology only has A1–B1, B1–Switch1, Switch1–C1/C2 etc., with no direct A–C links, the graph structure alone guarantees the order — so plain node-to-node search naturally produces valid A→B→(switch)→C paths without needing to track "which stage am I in" as separate search state. If that invariant always holds by construction (flavors physically can't be wired to skip a stage), you don't need the extra complexity I mentioned — your current approach is the right level of simplicity for it.

Worth explicitly verifying though: is it guaranteed by your network design that this holds, or is it just true in your current example topology? If someone could ever wire a machine such that flavor skipping becomes physically possible, plain node-to-node A* would happily find and use that shortcut, silently violating the required processing order.

**One heuristic design point this raises**

Since your real goal isn't one specific node, but "any node with flavor C," h(n) needs to estimate distance to the *nearest* C-flavor node, not a single fixed target. A common way to make this both correct and cheap: precompute exact distances (via one multi-source Dijkstra/BFS run backward from *all* C-flavor nodes simultaneously) once, ahead of time, whenever the topology changes. Then h(n) = precomputed exact distance from n to nearest C-node. This is a perfect heuristic (not just admissible — exact), which means A* using it will only ever expand nodes that lie on some optimal path, no wasted exploration. Given switches/topology are probably fairly static compared to how often you run searches, this precomputation is usually cheap to maintain and makes your search near-optimal in expansion count.

If B and Switch1 are similarly "intermediate" (not the true final goal), and you're doing this as two separate legs (A→B, then B→C) like you described, you'd want the same trick for the first leg: precompute distance-to-nearest-B-flavor-node too.

## User

now apply this thinking to trackplan. with our assembler and coupler

## Assistant

This maps almost exactly onto what we just worked through — and reading your own docs, Trackplan already encodes most of it deliberately, with one explicit divergence from textbook A* that's worth naming clearly.

**The correspondences**

| Our A* conversation | Trackplan |
|---|---|
| Flavor chain A → B → C | Assembler's ordered non-transparent **StationType legs** — one Coupler call per leg |
| "Any node of the required flavor," not one fixed goal | Coupler's **multi-sink goal set G** — concrete Station ids of type T from the agenda |
| Precompute exact distance-to-nearest-goal via one multi-source backward BFS from all goal nodes | **Oracle++** `distToSegmentGoals(n) = min over g in G of oracle.minHops[n][g]`, computed via "one multi-source BFS backward from all goals" per Coupler call (BUILD_SPEC §3.7b) — literally the trick I described last message |
| Switch as a pass-through node, not its own required flavor | **Transparent stations** — stepped through inside one Coupler call, not promoted to their own Assembler leg |
| Waypoint/stage state so search doesn't skip a required flavor | Assembler's leg loop is the outer stage machine; Coupler doesn't need internal stage-state because each call already targets exactly one leg's goal set |
| Watch for stale rediscovery / one bad path poisoning a node | BUILD_SPEC explicitly calls this out: "careful closed-set rules so one bad arrival at N1 does not block another path to N1" — same closed-set subtlety, already flagged in COUPLER_OPTION_A_VS_B.md |

So the shape of the solution is the same one we derived from your A/B/C machine problem. Good sign it converges independently.

**Where Trackplan deliberately diverges from classic A*, and why it's sound here**

BUILD_SPEC is emphatic and repeated: frontier pop is `(g, ExpandKey…)` — **g is the sole primary key**, and ExpandKey (the tuple of `preferInUse, preferNonTransparent, distToSegmentGoals, distToTerminal, neighborRank, names`) is only a **tie-break preference**, never summed into a blended `f = g + h`.

This is a bigger departure from classic A* than it might look, but it's actually a simplification that makes sense given one fact buried in §8: **every accepted hop increments g by exactly 1** — edges are unweighted. With uniform edge cost, g behaves exactly like BFS depth, not like Dijkstra's accumulated weighted cost. That changes the whole calculus:

- In weighted A*, you need `f = g + h` because a locally longer-g path can still be globally cheaper. With unit-cost hops, that can't happen — minimum g *is* the shortest path, full stop. There's no optimality reason to blend in a heuristic; g alone already picks the shortest path.
- What `distToSegmentGoals` / `distToTerminal` are doing here isn't "better estimate total cost" (there's nothing to estimate — g is exact once popped) — they're a **deterministic tie-break among multiple shortest paths**, e.g. preferring a non-transparent neighbor or a station already in use when two candidate expansions have identical g. That's a legitimate and different job from admissibility, and explains why BUILD_SPEC is careful to say "not a competing frontier h score."
- This also sidesteps the messiest part of weighted A* — reopening/re-relaxing nodes when a cheaper g is found later. With unit-cost BFS-shaped search, the first time you pop a node at some g, that g is already optimal, so the closed-set logic is much simpler than in general A*. The "careful closed-set" warning in your docs is about a narrower issue (inspect-fail at a goal shouldn't blacklist the *station*, only that *arrival*), not about cost-reopening.

So: g-dominant + lexicographic tie-break isn't a weaker version of A*, it's the correct simplification once you notice the graph is unweighted — and using ExpandKey to inject determinism/stickiness/first-fit preferences into the tie-break slot (rather than trying to fold "prefer non-transparent" into a cost term) is a clean way to keep search behavior deterministic without corrupting the shortest-path guarantee that g alone already gives you. The one thing I'd double check against your own stated goals: BUILD_SPEC says "sub-optimal OK (first-fit)" — worth confirming that's about *goal choice among G* (first inspect-OK sink wins, not necessarily the "best" sink) rather than about path length to a given sink, since path length to a given sink actually *is* optimal under this scheme (g-dominant pop). Those are two different notions of "optimal" and it's easy to conflate them when reading "sub-optimal OK."
</content>
