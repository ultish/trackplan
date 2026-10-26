/* Trackplan system graph — sourced from docs/BUILD_SPEC.md + docs/SPEC.md.
   Body text uses the spec’s current names (Station, Assembler, Coupler…).
   Target network names appear in How it’s built when they matter. */
(function (global) {
  const P = (text) => ({ p: text });
  const L = (items) => ({ list: items });
  const C = (text) => ({ code: text });

  const GROUPS = [
    { id: "loop", title: "The resolve loop" },
    { id: "support", title: "Supporting the loop" },
    { id: "plant", title: "The plant" },
    { id: "in", title: "What comes in" },
    { id: "out", title: "What comes out" },
    { id: "off", title: "Specified, not switched on" },
  ];

  const STATS = [
    { k: "Repository", v: "trackplan · spec" },
    { k: "Engines", v: "2 — Kafka not switched on" },
    { k: "Phases", v: "P0–P5 domain · P6 later" },
    { k: "Goldens", v: "G1–G12" },
    { k: "Deferred", v: "1 — force-priority" },
    { k: "Stack", v: "Kotlin / JVM" },
  ];

  const ROOT_COPY = {
    does: {
      title: "The scheduling machine",
      lead: "how a booking gets bound, routed, tasked and filed",
      sections: [
        {
          h: "What this is",
          blocks: [
            P("This repository is a spec for a sticky booking placer. A user asks for an ordered chain of StationTypes. A language-shaped engine binds concrete Stations, walks the fabric through switches the user never named, writes Tasks, and stays still when the world has not hopefully changed."),
            P("The diagram is a loop because the system is one: world → queue → assemble a booking → screen candidates → ask Oracle++ → couple a path → inspect → cache → commit → back to the world. Everything below the loop is the plant itself. Everything to the right is what comes out. Kafka adapters sit beside it, specified and not yet switched on."),
            P("Nearly every hard problem here is a measurement problem rather than a packing one — how to score a path that failed inspect, how to rank stations this booking has never used, how to tell a rejected arrival from a search that never ran, how to know two plans are actually different. The tall structures are the measuring parts."),
          ],
        },
        {
          h: "How to read it",
          blocks: [
            P("Hover anything for a plain description. The How it’s built tab gives the implementer contract. Condition lists what is currently wrong, open, or not switched on. → goes inside a structure to see its steps in execution."),
          ],
        },
      ],
    },
    built: {
      title: "How the spec is stacked",
      lead: "BUILD_SPEC is canonical · SPEC is intent · this page is a map",
      sections: [
        {
          h: "Authority",
          blocks: [
            P("BUILD_SPEC §1–§4 plus §3.7–§3.10 win on mechanism. SPEC.md is rationale and open questions. Entity diagrams are a view of the same model, not a second one."),
            L([
              "Domain goldens G1–G12 before Kafka adapters (P6).",
              "One engine run at a time. Bookings in a run are serial: priority, then submitTime, then id.",
              "Inspectors are time-dumb. Assembler owns time slices.",
              "Sole deferred product feature: force-priority preemption (SPEC Q16).",
            ]),
          ],
        },
        {
          h: "Packages (suggested)",
          blocks: [
            C("catalog/   StationType SPI, StationTypeRef, Class.forName\nfabric/    port graph, Oracle++\ncoupler/   multi-sink ExpandKey search\nassembler/ resolve loop, C2b backtrack\nreserve/   exclusive capacity\ncache/     sticky SAT + negative UNSAT\napi/       resolve/release facade\nkafka/     adapters only — zero Kafka types in domain"),
          ],
        },
        {
          h: "Condition",
          blocks: [
            P("The machine on this page is specified, not running. There is no Kotlin service in-tree yet. Numeric budgets are DEFAULT (H=16, V=3, expansions=50_000, wall_ms=500) and configurable. Combine/share on aggregator ports is out of scope, not deferred. Kafka topic names are illustrative."),
          ],
        },
      ],
    },
  };

  const NODES = [
    {
      id: "W",
      name: "World projection",
      group: "loop",
      shape: "stack",
      x: 2.2, y: 1.5, z: 0, w: 2.15, d: 1.95, h: 1.7,
      hatch: "a",
      inside: "world",
      does: {
        title: "World projection",
        lead: "the committed plant the engine reads",
        sections: [
          {
            h: "What it holds",
            blocks: [
              P("Stations (setup, liveData, links), Bookings (demand + planSegments), and the catalog refs needed to boot types. Tasking you see on a Station at time t is a projection of committed planSegments, not a second ledger."),
              P("One engine run reads this world, then writes it only when a whole booking SAT-commits. A failed booking discards its overlay. The next booking in the same run sees the new commit."),
            ],
          },
        ],
      },
      built: {
        title: "CommittedWorld",
        lead: "durable view · overlay is path-local",
        sections: [
          {
            h: "Shape",
            blocks: [
              C("CommittedWorld\n  stations[]   setup, liveData, inputs/outputs, online\n  links        via Station.inputs / outputs\n  bookings[]   legs + planSegments + status\n  catalog      StationTypeRef { id, className }"),
              P("projectTasking(world, at, exclude) walks SAT planSegments covering at and gathers stationTasks. Coupler/inspect see that projection plus the current path overlay."),
            ],
          },
          {
            h: "Condition",
            blocks: [
              P("Persistence (DB vs in-memory) is a service choice, not a domain one. Tests feed a snapshot. Kafka handlers upsert into this projection; they do not live here."),
            ],
          },
        ],
      },
    },
    {
      id: "Q",
      name: "Engine queue",
      group: "loop",
      shape: "cube",
      x: 5.4, y: 1.7, z: 0, w: 1.2, d: 1.2, h: 1.2,
      hatch: "b",
      does: {
        title: "Engine queue",
        lead: "one run, one booking at a time",
        sections: [
          {
            h: "What it does",
            blocks: [
              P("A wake arrives (API resolve, Kafka event, or a same-run re-place). The queue is the wake set plus every UNSAT booking that still intersects the horizon. Sort: priority ascending (1 first), then submitTime, then id."),
              P("Runs do not overlap. Within a run, booking 2 does not start until booking 1 has committed or discarded."),
            ],
          },
        ],
      },
      built: {
        title: "engineRun",
        lead: "serial · §3.9b · §11",
        sections: [
          {
            h: "Order",
            blocks: [
              C("queue = sort(wake ∪ unsats-in-horizon,\n            priority, submitTime, id)\nfor booking in queue:\n  placeBookingOverTime(...)\n  SAT  → commit, then re-place lower-priority victims\n  UNSAT → discard overlay, save sticky UNSAT"),
              P("submitTime is when the booking is handed to Trackplan, not createTime. forcePriority is reserved and not implemented."),
            ],
          },
          {
            h: "Condition",
            blocks: [
              P("Fine-grained “which bookings touch Link X” is OPEN for ops scale. DEFAULT v1 may wake coarsely and let sticky skip the work."),
            ],
          },
        ],
      },
    },
    {
      id: "A",
      name: "Assembler",
      group: "loop",
      shape: "slabs",
      slabs: 4,
      x: 7.6, y: 1.45, z: 0, w: 2.55, d: 1.4, h: 1.3,
      hatch: "c",
      inside: "assembler",
      does: {
        title: "Assembler",
        lead: "the outer engine — legs, time, sticky, commit",
        sections: [
          {
            h: "What it does",
            blocks: [
              P("The Assembler takes one booking and places it over time. It clips the booking’s window to the horizon, cuts that span into open slices where peer occupancy is constant, and for each slice walks the demand legs."),
              P("It does not walk switches. For each non-transparent type it prefilters Stations, asks Oracle++ which finishes still reach the terminal, sorts that agenda by ExpandKey, and makes one couple() call. Inspect failures stay inside the Coupler. Unused goals stay as alts until the type is checkpointed."),
              P("A later-leg fail may backtrack, but only as far as the last checkpoint. Only a whole-booking SAT commits. Inspectors never see a clock."),
            ],
          },
        ],
      },
      built: {
        title: "placeBookingOverTime + placeBookingPath",
        lead: "C2 multi-sink · C2b backtrack · C2c alts",
        sections: [
          {
            h: "Contract",
            blocks: [
              L([
                "First leg: virtual S0 → Coupler, not a bind-only shortcut.",
                "Tail for the next segment = accepted Task.output, not the Station alone.",
                "Checkpoint a type only after the next non-transparent leg has a working Task (or last leg at SAT).",
                "Any open slice FAIL → whole booking UNSAT. No partial planSegments.",
                "Same-run re-place: a higher SAT can take a station; lower-priority overlapping plans re-run in this run.",
              ]),
            ],
          },
          {
            h: "Condition",
            blocks: [
              P("G1–G12 may use a single open slice so path behaviour is tested without contention. Time and re-place are still required v1, not a later phase."),
            ],
          },
        ],
      },
    },
    {
      id: "F",
      name: "Prefilter",
      group: "loop",
      shape: "cube",
      x: 11.15, y: 1.7, z: 0, w: 1.15, d: 1.15, h: 1.1,
      hatch: "d",
      does: {
        title: "Prefilter",
        lead: "canUse — cheap screen, no path yet",
        sections: [
          {
            h: "What it does",
            blocks: [
              P("Before the Coupler runs, the Assembler asks each OPEN station of the next type: given this setup, this request, and liveData, could you ever work? No Task. No context. If a future path could fix the reason, canUse must not reject."),
              P("A station that fails seats here never enters the agenda. A station that might need a stamp from a switch still does — that check is inspect, later, with context in hand."),
            ],
          },
        ],
      },
      built: {
        title: "StationType.canUse",
        lead: "SPI · optional · default pass-all",
        sections: [
          {
            h: "Signature",
            blocks: [
              C("canUse(setup, request, liveData) → ok | reject(code, message)\n// request == null → no request-based filtering"),
              P("Transparent stations are not prefiltered mid-path. First-leg candidates still are, then S0 edges pick among them."),
            ],
          },
          {
            h: "Condition",
            blocks: [
              P("Wrong: full inspect at Assembler dropping stations for missing path stamps. Right: only irreversible/static checks here."),
            ],
          },
        ],
      },
    },
    {
      id: "O",
      name: "Oracle++",
      group: "loop",
      shape: "cube",
      x: 13.3, y: 0.55, z: 0.55, w: 1.15, d: 1.15, h: 1.25,
      hatch: "e",
      does: {
        title: "Oracle++",
        lead: "topology distances, not inspect",
        sections: [
          {
            h: "What it does",
            blocks: [
              P("Oracle++ answers questions about the fabric that do not need an Inspector: can this tail reach any station of type T? which finishes of T are reachable? can that finish still reach the terminal? how many hops?"),
              P("The Assembler uses those answers to drop dead-end sinks before couple(). The Coupler uses the hop lengths as ExpandKey components. Tasking, request, and stamps are invisible here."),
            ],
          },
        ],
      },
      built: {
        title: "Distance index on the port graph",
        lead: "rebuild on topology, read-only in a resolve",
        sections: [
          {
            h: "Queries",
            blocks: [
              L([
                "Reach type / candidate sinks for T_next.",
                "Non-transparent chain T_i → T_j and to terminal Tk.",
                "Numeric distToSegmentGoals (this couple’s G) and distToTerminal.",
              ]),
              P("Same loop rules as Coupler: hop_key uniqueness, H, V, online Links and OPEN Stations only. A multi-source BFS backward from G gives O(1) lookups for the current couple()."),
            ],
          },
          {
            h: "Condition",
            blocks: [
              P("The name is frozen as Oracle++. DistanceOracle is the literal fit (it returns numbers, not only reachability). Revisit only if that vocabulary freeze reopens."),
            ],
          },
        ],
      },
    },
    {
      id: "C",
      name: "Coupler",
      group: "loop",
      shape: "plate",
      x: 11.0, y: 4.35, z: 0, w: 2.7, d: 2.15, h: 0.44,
      hatch: "f",
      inside: "coupler",
      does: {
        title: "Coupler",
        lead: "one multi-sink search per segment",
        sections: [
          {
            h: "What it does",
            blocks: [
              P("The Coupler is given a tail (or virtual S0) and a set of finishes — the agenda. It searches the track graph once. Frontier pop is (g, ExpandKey…), not f=g+h, not a summed edge cost."),
              P("Every completed hop on a transparent station runs inspect with request=null. Arriving at a goal runs inspect with the leg request. A fail prunes that branch and the search continues. The first inspect-OK goal wins (first-fit) and returns hops plus Tasks. Exhaustion or budget is failure."),
            ],
          },
        ],
      },
      built: {
        title: "couple(tail, goals=agenda)",
        lead: "Option A · C2d on every transparent hop",
        sections: [
          {
            h: "ExpandKey (lexicographic)",
            blocks: [
              C("preferInUse          higher   fill-first\npreferNonTransparent higher   demand types first\ndistToSegmentGoals   lower    Oracle++ to G\ndistToTerminal       lower    Oracle++ to Tk\nneighborRank         higher   optional SPI, default 0\nstationName          lower    stable id\nportName             lower    track id"),
              P("Closed set is (locus, contextFingerprint). Re-entry is allowed only with a new hop_key. Option B (Assembler peel + tryTarget) is not v1."),
            ],
          },
          {
            h: "Condition",
            blocks: [
              P("Hot path is specified as int ports + CSR, primitive closed set, no String hashes in expand. The Kotlin service is not written yet; this is the contract the expand loop must meet."),
            ],
          },
        ],
      },
    },
    {
      id: "I",
      name: "Inspector",
      group: "loop",
      shape: "cube",
      x: 8.2, y: 4.85, z: 0, w: 1.3, d: 1.3, h: 1.4,
      hatch: "g",
      inside: "inspector",
      does: {
        title: "Inspector",
        lead: "accept, rewrite tasking, write context",
        sections: [
          {
            h: "What it does",
            blocks: [
              P("Inspect is the only writer of durable path facts. The Coupler appends one candidate Task (in/out from topology, context copied from the previous hop). Inspect returns a full replacement Task[] or a Failure."),
              P("On OK it may put request material into taskingConfiguration and stamps into Task.context. That map is what the next hop sees. Inspectors must not name fabric stations (“go via SW-2”). They only reject missing keys; the search finds the writer."),
            ],
          },
        ],
      },
      built: {
        title: "StationType.inspect",
        lead: "required SPI · one class per type",
        sections: [
          {
            h: "Signature",
            blocks: [
              C("inspect(setup, tasking, request, liveData) → Task[] | Failure\n// tasking = existing + exactly one candidate"),
              P("Goal inspect uses the leg request. Transparent mid-path inspect uses request=null. Failed inspect never writes the candidate into Station.tasking. There is no publish_on_hop registry."),
            ],
          },
          {
            h: "Condition",
            blocks: [
              P("Production StationType schemas and fact-key conventions are still OPEN. Walkthrough types (Refrigerated, Normal, Switch, Docking) are enough for G1–G12."),
            ],
          },
        ],
      },
    },
    {
      id: "Y",
      name: "Sticky cache",
      group: "loop",
      shape: "cube",
      x: 5.7, y: 4.9, z: 0, w: 1.25, d: 1.25, h: 1.25,
      hatch: "h",
      inside: "sticky",
      does: {
        title: "Sticky cache",
        lead: "skip the search when the answer is still good",
        sections: [
          {
            h: "What it does",
            blocks: [
              P("Sticky is not a second schedule. It stores or points at the last SAT plan or UNSAT FailureReport for this booking, under a demand hash and the epochs of the resources that actually matter to that result."),
              P("A SAT stays valid while this booking’s plan still matches the world. An UNSAT stays valid while nothing hopeful has happened on the types that could have unblocked it. Unrelated plant noise does not bust either."),
            ],
          },
        ],
      },
      built: {
        title: "Relevance-scoped SAT + UNSAT",
        lead: "two bust tables · not a global hopeful_rev",
        sections: [
          {
            h: "Rules",
            blocks: [
              L([
                "SAT relevance ⊆ stations/links/types on the plan.",
                "UNSAT relevance ⊆ demand StationTypes (+ optional failure samples).",
                "New claims elsewhere do not bust this UNSAT by themselves.",
                "Link opened / station OPENED / tasking freed on relevant types do.",
                "force: true bypasses both caches.",
              ]),
            ],
          },
          {
            h: "Condition",
            blocks: [
              P("Coarse Kafka wake tokens may still exist for I/O. They are not the validity contract. liveData does not auto-bust."),
            ],
          },
        ],
      },
    },
    {
      id: "T",
      name: "Commit",
      group: "loop",
      shape: "cube",
      x: 3.3, y: 4.75, z: 0, w: 1.25, d: 1.25, h: 1.1,
      hatch: "i",
      does: {
        title: "Commit",
        lead: "whole booking or nothing",
        sections: [
          {
            h: "What it does",
            blocks: [
              P("Working state is a path-local overlay: only stations this branch has inspected-OK. If every open slice of the placeSpan succeeds, planSegments (with materialized stationTasks) replace the booking’s prior plan and the overlay merges into the world."),
              P("Any slice fail drops the entire overlay. The world does not move. Adjacent identical slices merge. Display route/bindings are denormalized from the segments."),
            ],
          },
        ],
      },
      built: {
        title: "commitBooking",
        lead: "planSegments are the schedule SSOT",
        sections: [
          {
            h: "Write",
            blocks: [
              C("SAT  → planSegments, status=sat, stickySAT.save\n      denormalize route/bindings\n      victims = lower-priority overlapping stationIds\nUNSAT → clear planSegments, status=unsat, stickyUNSAT.save"),
              P("stationTasks are full Task objects so later projectTasking never re-runs Inspector."),
            ],
          },
          {
            h: "Condition",
            blocks: [
              P("Hard-claim until release is DECIDED for v1 SAT. Surgical re-inspect of every peer booking on cancel is not required beyond drop-empty-Tasks + engine wake."),
            ],
          },
        ],
      },
    },
    {
      id: "L",
      name: "Catalog / SPI",
      group: "support",
      shape: "tall",
      x: 0.1, y: 0.2, z: 0, w: 1.2, d: 1.2, h: 2.25,
      hatch: "j",
      inside: "catalog",
      does: {
        title: "Catalog / SPI",
        lead: "types are code, instances are data",
        sections: [
          {
            h: "What it does",
            blocks: [
              P("A StationType is a class: schemas, track kinds, legalPairs, heuristics, canUse, inspect, optional neighborRank. The world stores Stations and a thin StationTypeRef { id, className }. Boot is Class.forName, not dual plugin ids."),
              P("transparent=true means the type is omitted from demand legs. It is still a real station on the fabric. Users do not author requests for it in v1."),
            ],
          },
        ],
      },
      built: {
        title: "One class = one StationType",
        lead: "external JAR / module · shared SPI",
        sections: [
          {
            h: "Load",
            blocks: [
              C("StationTypeRef { id, className }\n→ Class.forName → SPI instance\nDEFAULT discovery: explicit allow-list\noptional ServiceLoader to find candidates"),
              P("Do not persist inspector/prefilter blobs. Heuristics are checkpoint + fillFirst only — no edgeCostId, no summed preference ladder."),
            ],
          },
          {
            h: "Condition",
            blocks: [
              P("Production type list and request schemas are OPEN (SPEC Q8). The walkthrough set is Refrigerated, Normal, Switch (Y1/Y2), Docking."),
            ],
          },
        ],
      },
    },
    {
      id: "P",
      name: "Policy",
      group: "support",
      shape: "cube",
      x: 0.15, y: 2.75, z: 0, w: 1.15, d: 1.15, h: 1.1,
      hatch: "k",
      does: {
        title: "Policy",
        lead: "caps and knobs, not a second algorithm",
        sections: [
          {
            h: "What it does",
            blocks: [
              P("Policy holds the numbers the engines must not invent: horizon, max hops H, max visits V, expansion budget, wall clock, first-fit, checkpoint overrides. Changing a number changes when you get BUDGET, not which ExpandKey column wins."),
            ],
          },
        ],
      },
      built: {
        title: "Policy.assembler / Policy.coupler",
        lead: "DEFAULT v1 numbers",
        sections: [
          {
            h: "Defaults",
            blocks: [
              L([
                "horizon = 8 hours from run now",
                "H = 16, V = 3",
                "expansions = 50_000",
                "max_wall_ms = 500 per resolve",
              ]),
              P("All configurable per engine/resolve. Exact production numbers are still a human confirm (Q9) — the knobs themselves are in scope."),
            ],
          },
          {
            h: "Condition",
            blocks: [
              P("Do not add a summed edgeCost or f=g+h preference via policy. That is a rejected algorithm, not a tunable."),
            ],
          },
        ],
      },
    },
    {
      id: "G",
      name: "Fabric",
      group: "support",
      shape: "plate",
      x: 2.3, y: 7.55, z: 0, w: 2.5, d: 1.75, h: 0.4,
      hatch: "a",
      inside: "fabric",
      does: {
        title: "Fabric",
        lead: "stations, tracks, links — the graph the Coupler walks",
        sections: [
          {
            h: "What it does",
            blocks: [
              P("The plant is not a device graph. A StationType owns TrackDefs (in and out). A Station wires those defs to peers with Links. The Coupler expands legal in→out pairs on a visit, then a Link from that out to a neighbour’s in."),
              P("CLOSED / offline stations and links are not walked. Loopbacks are allowed. Infinite spin is not — hop_key uniqueness plus H and V."),
            ],
          },
        ],
      },
      built: {
        title: "Port graph + CSR",
        lead: "rebuild on topology change only",
        sections: [
          {
            h: "Hot path",
            blocks: [
              C("PortIndex: stringKey → Int 0..P-1\nCSR: offsets[], neighbors[]\nhop_key packed Long  (station, in, out)\noccupancy: bitset, not Set<String>"),
              P("Oracle++ and Coupler share the same loop rules. Tasking changes do not rebuild the CSR."),
            ],
          },
          {
            h: "Condition",
            blocks: [
              P("Reference topology for goldens: R-17/R-22, N-04/N-08/N-12, D-02/D-11, switches Y1/Y2. Y1 has restricted legalPairs (not 1→6). Y2 may write clearance.y2_stamp."),
            ],
          },
        ],
      },
    },
    {
      id: "R",
      name: "Reserve",
      group: "support",
      shape: "cube",
      x: 0.2, y: 5.15, z: 0, w: 1.1, d: 1.1, h: 1.05,
      hatch: "b",
      does: {
        title: "Reserve",
        lead: "exclusive capacity, hard-claim on SAT",
        sections: [
          {
            h: "What it does",
            blocks: [
              P("v1 capacity is exclusive. Aggregator and expander ports are mutex, not a soft combine. A SAT hard-claims the hop resources on its plan until release. Place uses free capacity only — if nothing is free, the attempt fails or backtracks."),
              P("Same-run re-place is scheduling repair when a higher-priority booking SAT-commits onto a station a lower one held. It is not force-kick."),
            ],
          },
        ],
      },
      built: {
        title: "Exclusive only",
        lead: "G6 · §6 yard families",
        sections: [
          {
            h: "Families",
            blocks: [
              L([
                "direct / restricted / full: hop_key exclusive.",
                "aggregator: exclusive on out Ag.",
                "expander: exclusive on in Ag; each out exclusive.",
              ]),
              P("Cancel: strip bookingId from Tasks; drop Tasks whose bookingIds become empty; wake the engine so UNSATs may succeed."),
            ],
          },
          {
            h: "Condition",
            blocks: [
              P("Soft multi-booking combine/share is out of scope — a rejected product rule, not a v2 roadmap item. forcePriority eviction is the sole deferred feature."),
            ],
          },
        ],
      },
    },
    {
      id: "M",
      name: "Metrics",
      group: "support",
      shape: "cube",
      x: 16.7, y: 8.0, z: 0, w: 1.05, d: 1.05, h: 1.0,
      hatch: "c",
      does: {
        title: "Metrics",
        lead: "prove the search, don’t dump the frontier",
        sections: [
          {
            h: "What it does",
            blocks: [
              P("Counters and histograms on SAT/UNSAT, sticky hits, coupler expansions, resolve time, fail codes, candidates in vs after inspect. A debug trace is one resolve id: leg start, counts, coupler result, fail stage."),
              P("FailureReport may carry a capped set of inspector_samples. It must not carry the frontier."),
            ],
          },
        ],
      },
      built: {
        title: "Observability §12",
        lead: "stage of first empty options",
        sections: [
          {
            h: "Names",
            blocks: [
              C("resolve_sat / resolve_unsat\nsticky_hit / negative_cache_hit\ncoupler_expansions p50/p99\nresolve_ms\nfail_code{code=}\ncandidates_in / candidates_after_inspector"),
            ],
          },
          {
            h: "Condition",
            blocks: [
              P("Samples may be empty on a given result. The capability is in scope; dumping Coupler internals is not."),
            ],
          },
        ],
      },
    },
    {
      id: "S1",
      name: "canUse",
      group: "support",
      shape: "small",
      x: 14.35, y: -0.55, z: 0.95, w: 0.78, d: 0.78, h: 0.78,
      hatch: "d",
      parentHint: "L",
      does: {
        title: "canUse",
        lead: "the prefilter method on the type",
        sections: [
          {
            h: "What it does",
            blocks: [
              P("Optional SPI. Default is pass-all. It may look at setup, request, and liveData. It must not look at Task.context. A reject here is a claim that no future path can fix the problem."),
            ],
          },
        ],
      },
      built: {
        title: "Prefilter SPI",
        lead: "same class as inspect",
        sections: [
          {
            h: "Example",
            blocks: [
              C("if CLOSED/offline → OFFLINE\nif setup.max_seats < request.min_seats → SEATS\nelse ok"),
              P("N-08 (4 seats vs min 6) dies here. N-04 (needs a Y2 stamp) must not."),
            ],
          },
        ],
      },
    },
    {
      id: "S2",
      name: "inspect",
      group: "support",
      shape: "small",
      x: 15.6, y: -0.05, z: 0.65, w: 0.78, d: 0.78, h: 0.78,
      hatch: "e",
      parentHint: "I",
      does: {
        title: "inspect",
        lead: "the required method on the type",
        sections: [
          {
            h: "What it does",
            blocks: [
              P("Required. Sees the candidate Task the Coupler just appended. Returns a full Task[] for that station or a Failure. This is where track route, capacity, and path stamps are decided."),
            ],
          },
        ],
      },
      built: {
        title: "Goal vs transparent",
        lead: "same method, different request",
        sections: [
          {
            h: "Calls",
            blocks: [
              L([
                "Goal of this couple(): request = the leg request.",
                "Transparent hop (C2d): request = null.",
                "One candidate per call. Replacement list, not a patch.",
              ]),
            ],
          },
        ],
      },
    },
    {
      id: "S3",
      name: "neighborRank",
      group: "support",
      shape: "small",
      x: 16.85, y: 0.55, z: 0.4, w: 0.78, d: 0.78, h: 0.78,
      hatch: "f",
      parentHint: "O",
      does: {
        title: "neighborRank",
        lead: "ExpandKey column 4",
        sections: [
          {
            h: "What it does",
            blocks: [
              P("Optional SmartNode hook. When fill-first, non-transparent, and both Oracle distances have already tied, a type may push a neighbour sooner. Default 0. It does not override ExpandKey and it is not an edge cost."),
            ],
          },
        ],
      },
      built: {
        title: "StationType.neighborRank",
        lead: "Long · higher = sooner",
        sections: [
          {
            h: "Signature",
            blocks: [
              C("neighborRank(tasking, setup, liveData, candidate, request?) → Long"),
              P("Called rarely compared to expand. Do not put work here that belongs in inspect."),
            ],
          },
        ],
      },
    },
    {
      id: "S4",
      name: "schemas",
      group: "support",
      shape: "small",
      x: 15.75, y: 1.7, z: 0.2, w: 0.78, d: 0.78, h: 0.78,
      hatch: "g",
      parentHint: "L",
      does: {
        title: "schemas",
        lead: "type owns shape, instance owns values",
        sections: [
          {
            h: "What it does",
            blocks: [
              P("setupSchema, taskingSchema, requestSchema live on the StationType. A Station holds setup / tasking / liveData values. A Booking leg holds a request. Empty request schemas are allowed."),
            ],
          },
        ],
      },
      built: {
        title: "JSON Schema or equivalent",
        lead: "not dual plugin config blobs",
        sections: [
          {
            h: "Split",
            blocks: [
              L([
                "setup — semi-static, often human, not booking-driven.",
                "tasking — Inspector contract for Task[].",
                "request — demand on a non-transparent leg.",
              ]),
            ],
          },
        ],
      },
    },
    {
      id: "S",
      name: "Stations",
      group: "plant",
      shape: "cube",
      x: 6.55, y: 7.8, z: 0, w: 1.2, d: 1.2, h: 1.0,
      hatch: "h",
      does: {
        title: "Stations",
        lead: "instances of a StationType",
        sections: [
          {
            h: "What they are",
            blocks: [
              P("A Station is a deployed instance: online flag, setup, tasking, liveData, and the Links on its input and output tracks. It does not own TrackDefs — the type does. CLOSED means the Coupler must not use it."),
            ],
          },
        ],
      },
      built: {
        title: "Station",
        lead: "id · stationTypeId · online · setup · tasking · liveData · links",
        sections: [
          {
            h: "Ids",
            blocks: [
              P("Opaque strings (st_…). Stable sort is lexicographic id unless a sticky id overrides. Target network name: Asset."),
            ],
          },
        ],
      },
    },
    {
      id: "X",
      name: "Links",
      group: "plant",
      shape: "cube",
      x: 8.6, y: 7.85, z: 0, w: 1.15, d: 1.15, h: 0.9,
      hatch: "i",
      does: {
        title: "Links",
        lead: "OUT track → peer IN track",
        sections: [
          {
            h: "What they are",
            blocks: [
              P("A Link is wiring, not a booking. It has an online flag. Topology changes rebuild Oracle++ and the CSR. Tasking changes do not. Target network name: Dataflow."),
            ],
          },
        ],
      },
      built: {
        title: "Link",
        lead: "owned on the Station’s inputs / outputs",
        sections: [
          {
            h: "Rule",
            blocks: [
              P("Stations of a type connect to peers only via that type’s TrackDefs. Typical scale: up to ~32 in and ~32 out per type."),
            ],
          },
        ],
      },
    },
    {
      id: "B",
      name: "Bookings",
      group: "plant",
      shape: "plate",
      x: 10.55, y: 7.9, z: 0, w: 1.65, d: 1.45, h: 0.42,
      hatch: "j",
      inside: "booking",
      does: {
        title: "Bookings",
        lead: "demand in, plan out",
        sections: [
          {
            h: "What they are",
            blocks: [
              P("A Booking is ordered legs (non-transparent StationType + request), a time window, a priority, and a submitTime. After resolve it also has planSegments — the schedule SSOT — plus a denormalized route and bindings for display."),
              P("status is pending, sat, or unsat. Target network name: Strategy. Legs become Steps. Route becomes Path."),
            ],
          },
        ],
      },
      built: {
        title: "Booking",
        lead: "§3.8 · time only here",
        sections: [
          {
            h: "Fields",
            blocks: [
              C("id, priority (1=highest), status\nsubmitTime          FCFS, not createTime\ntimeWindow          half-open [start,end)\nlegs[]              demand\nplanSegments[]      schedule SSOT\nroute / bindings    display\nfailure             on unsat"),
            ],
          },
        ],
      },
    },
    {
      id: "K",
      name: "Tasking",
      group: "plant",
      shape: "cube",
      x: 5.05, y: 7.7, z: 0, w: 1.15, d: 1.15, h: 1.1,
      hatch: "k",
      does: {
        title: "Tasking",
        lead: "live / planned-live assignment truth",
        sections: [
          {
            h: "What it is",
            blocks: [
              P("Tasking is Task[] on a Station. A Task is one use: input, output, context, taskingConfiguration, bookingIds. One Task may list many bookings when the inspector merges. Tasks have no time fields."),
              P("Context is per Task, not a booking-global map. It is seeded from the previous hop and extended only by inspect."),
            ],
          },
        ],
      },
      built: {
        title: "Task",
        lead: "working overlay until SAT",
        sections: [
          {
            h: "Rules",
            blocks: [
              L([
                "input null OK on first-type start.",
                "output null OK on terminal arrival.",
                "Failed inspect never commits the candidate.",
                "Cancel strips bookingId; empty bookingIds drops the Task.",
              ]),
            ],
          },
        ],
      },
    },
    {
      id: "J",
      name: "Kafka inbound",
      group: "in",
      shape: "cube",
      x: -0.05, y: 8.5, z: 0, w: 1.2, d: 1.2, h: 1.2,
      hatch: "a",
      inside: "kafkain",
      does: {
        title: "Kafka inbound",
        lead: "world and demand as upserts",
        sections: [
          {
            h: "What it does",
            blocks: [
              P("Production wake is events: catalog, stations, links, booking commands, optional external occupancy. Handlers apply them idempotently to the projection and classify the change: hopeful, tightening, demand, topology, or no-op."),
              P("Do not re-resolve every message. Prefer sticky revalidate. Domain tests never need this box."),
            ],
          },
        ],
      },
      built: {
        title: "kafka/ inbound adapters",
        lead: "SPEC §10.1 · P6",
        sections: [
          {
            h: "Suggested roles",
            blocks: [
              C("in: catalog.station_types\nin: catalog.stations\nin: fabric.links\nin: bookings.commands\nin: occupancy.events"),
              P("Exact names and schemas are platform standard (Avro/Protobuf/JSON). Not implemented in engine v1."),
            ],
          },
          {
            h: "Condition",
            blocks: [
              P("Specified, not switched on. Zero Kafka types may leak into coupler / assembler / inspectors."),
            ],
          },
        ],
      },
    },
    {
      id: "E",
      name: "Resolve API",
      group: "in",
      shape: "cube",
      x: -0.05, y: 10.2, z: 0, w: 1.2, d: 1.2, h: 1.0,
      hatch: "b",
      does: {
        title: "Resolve API",
        lead: "the synchronous edge",
        sections: [
          {
            h: "What it does",
            blocks: [
              P("PUT a booking’s legs. POST resolve (optional force). POST release. GET the booking and its last result. resolve without force, same demand hash, valid sticky → identical answer. force skips both caches."),
              P("resolve is a blocking domain call inside a run/txn boundary. Coroutines belong at the HTTP edge, not inside expand."),
            ],
          },
        ],
      },
      built: {
        title: "§9 operations",
        lead: "REST/gRPC is a service choice",
        sections: [
          {
            h: "Contract",
            blocks: [
              C("PUT  /bookings/{id}            legs[]\nPOST /bookings/{id}/resolve   { force?, forcePriority? }\nPOST /bookings/{id}/release\nGET  /bookings/{id}"),
              P("forcePriority is reserved. Do not implement Q16 behind this flag. Timeouts return BUDGET; do not hang. DEFAULT max_wall_ms is 500."),
            ],
          },
        ],
      },
    },
    {
      id: "D",
      name: "Plans",
      group: "out",
      shape: "plate",
      x: 14.7, y: 4.7, z: 0, w: 2.35, d: 2.15, h: 0.5,
      hatch: "c",
      inside: "plans",
      does: {
        title: "Plans",
        lead: "intentions other services execute",
        sections: [
          {
            h: "What comes out",
            blocks: [
              P("After a plan changes: claims (which Stations and hop_keys this booking holds), setups to arm on those Stations (including transparent ones), and a plan/status record (sat or unsat, bindings, route summary). Downstream is device controllers, UI, inventory — not the Coupler."),
              P("Emit only when the plan actually changes, or on explicit force."),
            ],
          },
        ],
      },
      built: {
        title: "Kafka out + ResolveResult",
        lead: "domain events, then adapters",
        sections: [
          {
            h: "Topics (illustrative)",
            blocks: [
              C("out: bookings.plans     sat|unsat, bindings, route\nout: claims.commands    claim/release hop resources\nout: setups.commands    arm Setup on Station"),
            ],
          },
          {
            h: "Condition",
            blocks: [
              P("Who applies setups — this service or actuators — DEFAULT is publish commands, actuators apply, occupancy confirmations may come back. Exact topic contracts are OPEN (Q13)."),
            ],
          },
        ],
      },
    },
    {
      id: "H",
      name: "FailureReport",
      group: "out",
      shape: "cube",
      x: 14.85, y: 2.95, z: 0, w: 1.2, d: 1.2, h: 1.2,
      hatch: "d",
      does: {
        title: "FailureReport",
        lead: "explain the first stage that emptied options",
        sections: [
          {
            h: "What it does",
            blocks: [
              P("UNSAT is not a stack dump. The report names a code, the failing leg if any, a station if any, and optionally a short pathTaken. It may include capped inspector samples. It must be enough to know whether you have no candidates, a context dead-end, a budget, or a closed fabric."),
            ],
          },
        ],
      },
      built: {
        title: "FailureReport",
        lead: "§9.3 · align with §3.10",
        sections: [
          {
            h: "Codes",
            blocks: [
              C("NO_CANDIDATES  INSPECT_FAIL  UNREACHABLE\nBUDGET  CAPACITY  ALL_BUSY\nCONTEXT_DEAD_END  POLICY"),
              P("Aliases exist in older prose (INSPECTOR_REJECT, CAPACITY_BLOCKED). Prefer the names above."),
            ],
          },
        ],
      },
    },
    {
      id: "Z",
      name: "Kafka adapters",
      group: "off",
      shape: "cube",
      off: true,
      x: 0.2, y: 6.55, z: 0, w: 1.1, d: 1.1, h: 0.9,
      hatch: "off",
      does: {
        title: "Kafka adapters",
        lead: "specified · P6 · not switched on",
        sections: [
          {
            h: "What this is",
            blocks: [
              P("The production wrap around the domain: inbound handlers that update the projection and decide whether to wake, outbound mappers that turn Plan / Claim / Setup into topics. The engine in the middle is the same one the goldens run."),
              P("Finished as a contract. Not built. Domain must stay testable without this box."),
            ],
          },
        ],
      },
      built: {
        title: "kafka/ package",
        lead: "after G1–G12 are green",
        sections: [
          {
            h: "Boundary",
            blocks: [
              C("Kafka IN → projection + reschedule policy → domain resolve\ndomain plan → Kafka OUT (claims, setups, status)"),
              P("Topic list, registry schemas, exactly-once, consumer groups: out of scope for the first engine slice."),
            ],
          },
          {
            h: "Condition",
            blocks: [
              P("Not optional forever — it is sequenced as P6. It is optional for declaring the domain done."),
            ],
          },
        ],
      },
    },
    {
      id: "FP",
      name: "Force-priority",
      group: "off",
      shape: "cube",
      off: true,
      x: 16.95, y: 3.05, z: 0, w: 1.1, d: 1.1, h: 0.9,
      hatch: "off",
      does: {
        title: "Force-priority",
        lead: "the sole deferred product feature",
        sections: [
          {
            h: "What this is",
            blocks: [
              P("A flag that would let a higher-priority booking take resources already held, with an eviction cascade and an audit. It is not place-first. It is not the same-run re-place that already exists when a higher booking SAT-commits onto free-at-place-time capacity."),
              P("Do not implement it. The API field is reserved so the name does not get reused for something else."),
            ],
          },
        ],
      },
      built: {
        title: "SPEC Q16",
        lead: "strawman only",
        sections: [
          {
            h: "In v1 instead",
            blocks: [
              L([
                "Place queue: priority 1, then FCFS submitTime.",
                "Free capacity only when placing.",
                "Same-run plan re-place after a higher SAT.",
              ]),
              P("Eviction events, kick order, and audit are not designed. Building them from inference is forbidden."),
            ],
          },
          {
            h: "Condition",
            blocks: [
              P("If a session implements forcePriority, it has left the spec."),
            ],
          },
        ],
      },
    },
  ];

  const EDGES = [
    { from: "W", to: "Q", kind: "loop" },
    { from: "Q", to: "A", kind: "loop" },
    { from: "A", to: "F", kind: "loop" },
    { from: "F", to: "O", kind: "loop" },
    { from: "O", to: "C", kind: "loop" },
    { from: "A", to: "C", kind: "loop" },
    { from: "C", to: "I", kind: "loop" },
    { from: "I", to: "Y", kind: "loop" },
    { from: "Y", to: "T", kind: "loop" },
    { from: "T", to: "W", kind: "loop" },
    { from: "L", to: "S1", kind: "support" },
    { from: "L", to: "S2", kind: "support" },
    { from: "L", to: "S3", kind: "support" },
    { from: "L", to: "S4", kind: "support" },
    { from: "G", to: "C", kind: "support" },
    { from: "P", to: "A", kind: "support" },
    { from: "J", to: "W", kind: "in" },
    { from: "E", to: "Q", kind: "in" },
    { from: "T", to: "D", kind: "out" },
    { from: "D", to: "H", kind: "out" },
    { from: "Z", to: "J", kind: "off" },
    { from: "Z", to: "D", kind: "off", via: [[0.6, 11.6, 0.35], [15.9, 11.6, 0.35]] },
  ];

  const FLOW = [
    {
      nodes: ["J", "E"],
      edges: ["J|W", "E|Q"],
      title: "A wake arrives",
      text: "A booking command or a world event hits the edge. Kafka inbound upserts the projection. The Resolve API can also force a run. Nothing searches yet.",
    },
    {
      nodes: ["W"],
      edges: ["J|W"],
      title: "Projection updates",
      text: "Stations, links, and bookings are now the committed world. Epochs bump on the resources that actually changed. Unrelated bookings keep their sticky records.",
    },
    {
      nodes: ["Q"],
      edges: ["W|Q", "E|Q"],
      title: "Queue the run",
      text: "Wake set plus horizon UNSATs, sorted by priority then submitTime. One run at a time. This booking is next.",
    },
    {
      nodes: ["Y", "A"],
      edges: ["Q|A"],
      title: "Sticky probe",
      text: "If SAT or UNSAT is still valid for this demand and these relevant epochs, return it. Expansions stay at zero. Otherwise the Assembler starts.",
    },
    {
      nodes: ["A"],
      edges: ["Q|A"],
      title: "Cut the horizon",
      text: "placeSpan = timeWindow ∩ [now, now+horizon). Open slices at every peer window boundary. Any slice fail will UNSAT the whole booking.",
    },
    {
      nodes: ["F"],
      edges: ["A|F"],
      title: "Prefilter the pool",
      text: "OPEN stations of the next demanded type. canUse sees setup, request, liveData. Path stamps cannot kill a station here.",
    },
    {
      nodes: ["O"],
      edges: ["F|O"],
      title: "Oracle++ filters goals",
      text: "Keep finishes reachable from the tail that can still reach the terminal (and later demand types). Sort the agenda by ExpandKey.",
    },
    {
      nodes: ["C"],
      edges: ["O|C", "A|C", "G|C"],
      title: "One couple() ",
      text: "Multi-sink search from the tail (or S0). Frontier is (g, ExpandKey). Transparent hops inspect as they go. Goal fails stay inside this call.",
    },
    {
      nodes: ["I"],
      edges: ["C|I"],
      title: "Inspect the arrival",
      text: "Candidate Task appended. inspect returns Task[] or Failure. Context may grow. A fail prunes only this branch.",
    },
    {
      nodes: ["C", "I"],
      edges: ["C|I"],
      title: "First-fit or continue",
      text: "OK → hops and Tasks return to the Assembler. Fail → keep popping the frontier. Exhaustion or budget becomes UNREACHABLE / INSPECT_FAIL / BUDGET.",
    },
    {
      nodes: ["A"],
      edges: ["A|C"],
      title: "Checkpoint or backtrack",
      text: "Next non-transparent OK checkpoints the previous type and drops its alts. A later fail restores to the last checkpoint and tries remaining alts. Never past a checkpoint.",
    },
    {
      nodes: ["Y", "T"],
      edges: ["I|Y", "Y|T"],
      title: "File the answer",
      text: "SAT saves planSegments and a SAT sticky record. UNSAT saves the FailureReport. Either way the search does not run again until something relevant changes.",
    },
    {
      nodes: ["T", "W"],
      edges: ["T|W"],
      title: "Commit the world",
      text: "Only whole-booking SAT merges the overlay. Lower-priority victims that share a station are re-placed in this same run. The next queued booking sees the new world.",
    },
    {
      nodes: ["D", "H"],
      edges: ["T|D", "D|H"],
      title: "Publish intentions",
      text: "Claims, setups, plan status. UNSAT goes out as a FailureReport. Downstream actuators apply. The Coupler is not a consumer of these topics.",
    },
  ];

  function n(id, extra) {
    return Object.assign(
      {
        group: "inner",
        shape: "cube",
        z: 0,
        w: 1.05,
        d: 1.05,
        h: 1.0,
        hatch: "a",
        off: false,
      },
      extra,
      { id }
    );
  }

  const SCENES = {
    root: {
      id: "root",
      title: "Trackplan",
      parent: null,
      nodes: NODES,
      edges: EDGES,
      enclosure: { x: 1.9, y: 1.15, w: 12.2, d: 5.6 },
    },
    assembler: {
      id: "assembler",
      title: "Assembler",
      parent: "root",
      focus: "A",
      nodes: [
        n("A.WQ", {
          name: "Wake & sort",
          letter: "WQ",
          x: 1.2, y: 1.2, hatch: "b",
          does: { title: "Wake & sort", lead: "build the queue", sections: [{ h: "Step", blocks: [P("Take the wake set, add horizon UNSATs, sort by priority then submitTime then id. This is the only ordering the engine has.")] }] },
          built: { title: "engineRun", lead: "§3.9b", sections: [{ h: "Code", blocks: [C("queue = sort(candidates, priority, submitTime, id)")] }] },
        }),
        n("A.SK", {
          name: "Sticky probe",
          letter: "SK",
          x: 3.2, y: 1.2, hatch: "c",
          does: { title: "Sticky probe", lead: "maybe we already know", sections: [{ h: "Step", blocks: [P("SAT hit returns the cached plan. UNSAT hit returns the cached FailureReport. force skips both.")] }] },
          built: { title: "StickyRecord", lead: "demandHash + relevant epochs", sections: [{ h: "Grain", blocks: [P("DEFAULT v1 is booking-grain, not per-slice.")] }] },
        }),
        n("A.SL", {
          name: "Open slices",
          letter: "SL",
          shape: "slabs", slabs: 3, w: 1.8, d: 1.1, h: 1.05,
          x: 5.3, y: 1.1, hatch: "d",
          does: { title: "Open slices", lead: "Assembler-owned time", sections: [{ h: "Step", blocks: [P("Cuts are this booking’s placeSpan endpoints plus every other booking window that falls strictly inside. Each open interval has a constant set of peer planSegments.")] }] },
          built: { title: "placeSpan ∩ cuts", lead: "half-open", sections: [{ h: "Empty span", blocks: [P("SAT with planSegments=[]. Not a failure.")] }] },
        }),
        n("A.PF", {
          name: "Prefilter pool",
          letter: "PF",
          x: 8.0, y: 1.2, hatch: "e",
          does: { title: "Prefilter pool", lead: "OPEN stations of T_i", sections: [{ h: "Step", blocks: [P("Drop CLOSED. Run canUse. What remains is the pool Oracle++ will filter.")] }] },
          built: { title: "canUse", lead: "no context", sections: [{ h: "Wrong", blocks: [P("Do not inspect here.")] }] },
        }),
        n("A.OG", {
          name: "Oracle++ agenda",
          letter: "OG",
          x: 10.1, y: 1.05, z: 0.25, hatch: "f",
          does: { title: "Oracle++ agenda", lead: "goals, not paths", sections: [{ h: "Step", blocks: [P("Keep sinks reachable from the tail that can still reach later types and the terminal. Sort by ExpandKey. Do not precompute fabric paths into the agenda.")] }] },
          built: { title: "goals = finishes", lead: "e.g. 1:N1", sections: [{ h: "Then", blocks: [C("couple(tail, goals=agenda)")] }] },
        }),
        n("A.CP", {
          name: "couple()",
          letter: "CP",
          shape: "plate", w: 2.1, d: 1.6, h: 0.4,
          x: 8.4, y: 3.3, hatch: "a",
          does: { title: "couple()", lead: "one call per segment try", sections: [{ h: "Step", blocks: [P("The Assembler does not peel targets. Inspect/path fails stay in the Coupler. Unused goals remain alts until checkpoint (C2c).")] }] },
          built: { title: "Option A", lead: "not tryTarget", sections: [{ h: "Return", blocks: [P("{ station, hops, tasks } or failure.")] }] },
        }),
        n("A.CK", {
          name: "Checkpoint",
          letter: "CK",
          x: 6.0, y: 3.5, hatch: "g",
          does: { title: "Checkpoint", lead: "freeze a type’s station", sections: [{ h: "Step", blocks: [P("Checkpoint type T only after the next non-transparent leg has a working Task, or T is last and the booking is SAT. Too early and you cannot switch stations when the next leg fails.")] }] },
          built: { title: "C2c", lead: "alts discarded after checkpoint", sections: [{ h: "Default", blocks: [P("Checkpoint blocks other Stations of the type, not necessarily other outs of the same station.")] }] },
        }),
        n("A.BT", {
          name: "Backtrack",
          letter: "BT",
          x: 3.9, y: 3.5, hatch: "h",
          does: { title: "Backtrack", lead: "C2b — floor is last checkpoint", sections: [{ h: "Step", blocks: [P("Later-leg fail restores the working overlay to the last checkpoint boundary and resumes with remaining alts. Never reopen a checkpointed type.")] }] },
          built: { title: "C2b", lead: "large search space", sections: [{ h: "Mitigations", blocks: [P("Oracle++ terminal filter, ExpandKey, H/V/expansion/wall caps, checkpoint as soon as allowed.")] }] },
        }),
        n("A.CM", {
          name: "Commit / discard",
          letter: "CM",
          x: 1.5, y: 3.5, hatch: "i",
          does: { title: "Commit / discard", lead: "all slices or none", sections: [{ h: "Step", blocks: [P("Every open slice of placeSpan must SAT. Then write planSegments and merge the overlay. Any fail discards every working segment.")] }] },
          built: { title: "whole-booking", lead: "§3.9c", sections: [{ h: "After SAT", blocks: [P("Re-place lower-priority victims that share a stationId on a time-overlapping segment.")] }] },
        }),
      ],
      edges: [
        { from: "A.WQ", to: "A.SK", kind: "loop" },
        { from: "A.SK", to: "A.SL", kind: "loop" },
        { from: "A.SL", to: "A.PF", kind: "loop" },
        { from: "A.PF", to: "A.OG", kind: "loop" },
        { from: "A.OG", to: "A.CP", kind: "loop" },
        { from: "A.CP", to: "A.CK", kind: "loop" },
        { from: "A.CK", to: "A.BT", kind: "data" },
        { from: "A.BT", to: "A.PF", kind: "data" },
        { from: "A.CK", to: "A.CM", kind: "loop" },
        { from: "A.BT", to: "A.CM", kind: "loop" },
      ],
    },
    coupler: {
      id: "coupler",
      title: "Coupler",
      parent: "root",
      focus: "C",
      nodes: [
        n("C.TL", {
          name: "Tail / S0",
          letter: "TL",
          x: 1.3, y: 1.4, hatch: "b",
          does: { title: "Tail / S0", lead: "where this search starts", sections: [{ h: "Step", blocks: [P("First leg: virtual source S0 with edges to each prefiltered start station (no inbound Link required). Later legs: the accepted Task.output of the previous bind.")] }] },
          built: { title: "§3.7 first leg · §8.3 tail", lead: "out-track, not Station", sections: [{ h: "Terminal", blocks: [P("Last type often arrives with output null.")] }] },
        }),
        n("C.FR", {
          name: "Frontier",
          letter: "FR",
          shape: "slabs", slabs: 3, w: 1.7, d: 1.1, h: 1.1,
          x: 3.5, y: 1.3, hatch: "c",
          does: { title: "Frontier", lead: "pop (g, ExpandKey…)", sections: [{ h: "Step", blocks: [P("Primary order is ExpandKey, lexicographic. g is hop count for hygiene. Do not build f=g+h. Do not sum the ExpandKey columns.")] }] },
          built: { title: "Heap of node indices", lead: "not objects if you can help it", sections: [{ h: "DEFAULT v1", blocks: [P("PriorityQueue ordered ExpandKey-dominated is acceptable; profile before a custom allocator.")] }] },
        }),
        n("C.EX", {
          name: "Expand",
          letter: "EX",
          x: 6.2, y: 1.4, hatch: "d",
          does: { title: "Expand", lead: "legal in→out, then a Link", sections: [{ h: "Step", blocks: [P("From the current out (or S0), walk legal pairs on this station and online Links to neighbour ins. Only rank legal edges. Illegality is inspect, not a key.")] }] },
          built: { title: "CSR walk", lead: "int ports", sections: [{ h: "Hot path", blocks: [P("No String hashes. No per-edge lambda allocation.")] }] },
        }),
        n("C.CL", {
          name: "Closed set",
          letter: "CL",
          x: 8.5, y: 1.25, z: 0.2, hatch: "e",
          does: { title: "Closed set", lead: "(locus, contextFingerprint)", sections: [{ h: "Step", blocks: [P("A goal that failed inspect is not closed as the port alone — a later path may arrive with a different context and succeed. Fingerprint must be cheap.")] }] },
          built: { title: "§8.2.1", lead: "Long xor of stamps", sections: [{ h: "Empty context", blocks: [P("A BooleanArray on port can be enough.")] }] },
        }),
        n("C.TI", {
          name: "Transparent inspect",
          letter: "TI",
          x: 4.0, y: 3.6, hatch: "f",
          does: { title: "Transparent inspect", lead: "C2d — every visit", sections: [{ h: "Step", blocks: [P("Before the path may leave a switch, build a candidate Task and run inspect with request=null. OK flows accepted context onward. FAIL prunes this branch only.")] }] },
          built: { title: "C2d", lead: "not topology-only skip", sections: [{ h: "Why", blocks: [P("Switches write stamps. Skipping inspect hides the only communication channel.")] }] },
        }),
        n("C.GI", {
          name: "Goal inspect",
          letter: "GI",
          x: 6.5, y: 3.6, hatch: "g",
          does: { title: "Goal inspect", lead: "leg request, first-fit", sections: [{ h: "Step", blocks: [P("Arriving at a finish in G runs inspect with the demand request. OK is success for this couple(). FAIL continues the frontier — the Assembler is not recalled per target.")] }] },
          built: { title: "C2", lead: "fail ≠ segment UNSAT", sections: [{ h: "Until", blocks: [P("Frontier exhausted or budget.")] }] },
        }),
        n("C.FF", {
          name: "First-fit return",
          letter: "FF",
          shape: "plate", w: 1.6, d: 1.3, h: 0.38,
          x: 8.7, y: 3.55, hatch: "h",
          does: { title: "First-fit return", lead: "first inspect-OK wins", sections: [{ h: "Step", blocks: [P("Return the station, the hop list, and the accepted Tasks. Path reconstruction walks parent indices once. Store pathTaken for FailureReport and sticky.")] }] },
          built: { title: "No best-of-K", lead: "Q3 resolved", sections: [{ h: "Why", blocks: [P("Determinism + ExpandKey order. Best-of-K is a different product.")] }] },
        }),
        n("C.BD", {
          name: "Budget",
          letter: "BD",
          x: 1.5, y: 3.6, hatch: "i",
          does: { title: "Budget", lead: "H · V · expansions · wall", sections: [{ h: "Step", blocks: [P("max hops, max visits per station, expansion count, wall clock. Hitting a cap is BUDGET or UNREACHABLE, not a hang. Loopbacks are fine; spin is not.")] }] },
          built: { title: "Policy.coupler", lead: "DEFAULT H=16 V=3 exp=50k wall=500ms", sections: [{ h: "G2", blocks: [P("Y1↔Y2 cables present must still terminate.")] }] },
        }),
      ],
      edges: [
        { from: "C.TL", to: "C.FR", kind: "loop" },
        { from: "C.FR", to: "C.EX", kind: "loop" },
        { from: "C.EX", to: "C.CL", kind: "loop" },
        { from: "C.EX", to: "C.TI", kind: "loop" },
        { from: "C.TI", to: "C.FR", kind: "data" },
        { from: "C.EX", to: "C.GI", kind: "loop" },
        { from: "C.GI", to: "C.FF", kind: "loop" },
        { from: "C.GI", to: "C.FR", kind: "data" },
        { from: "C.BD", to: "C.FR", kind: "support" },
        { from: "C.CL", to: "C.EX", kind: "support" },
      ],
    },
    world: {
      id: "world",
      title: "World projection",
      parent: "root",
      focus: "W",
      nodes: [
        n("W.ST", { name: "Station", letter: "ST", x: 1.6, y: 1.5, hatch: "a",
          does: { title: "Station", lead: "instance", sections: [{ h: "Holds", blocks: [P("setup, tasking, liveData, online, inputs/outputs. Does not own TrackDefs.")] }] },
          built: { title: "st_…", lead: "Asset in the target vocabulary", sections: [{ h: "Type", blocks: [P("stationTypeId → catalog instance.")] }] } }),
        n("W.LK", { name: "Link", letter: "LK", x: 3.8, y: 1.5, hatch: "b",
          does: { title: "Link", lead: "OUT → IN", sections: [{ h: "Holds", blocks: [P("Wiring plus online. Topology, not assignment.")] }] },
          built: { title: "Dataflow", lead: "owned on Station", sections: [{ h: "Rebuild", blocks: [P("Add/remove/online rebuilds CSR and Oracle++.")] }] } }),
        n("W.BK", { name: "Booking", letter: "BK", x: 6.0, y: 1.5, hatch: "c",
          does: { title: "Booking", lead: "demand + plan", sections: [{ h: "Holds", blocks: [P("legs, timeWindow, priority, submitTime, planSegments, status.")] }] },
          built: { title: "Strategy", lead: "target name", sections: [{ h: "SSOT", blocks: [P("planSegments, not route.")] }] } }),
        n("W.PS", { name: "PlanSegment", letter: "PS", shape: "plate", w: 1.7, d: 1.4, h: 0.4, x: 8.1, y: 1.45, hatch: "d",
          does: { title: "PlanSegment", lead: "one constant occupancy interval", sections: [{ h: "Holds", blocks: [P("start, end, route, bindings, stationTasks. Written at path SAT so projection never re-inspects.")] }] },
          built: { title: "mergeAdjacentIdentical", lead: "by value", sections: [{ h: "Multi-segment", blocks: [P("Contention/priority, not Inspector knowing time.")] }] } }),
        n("W.TK", { name: "Task", letter: "TK", x: 3.2, y: 3.7, hatch: "e",
          does: { title: "Task", lead: "one use of a station", sections: [{ h: "Holds", blocks: [P("input, output, context, taskingConfiguration, bookingIds.")] }] },
          built: { title: "No time fields", lead: "Inspectors are time-dumb", sections: [{ h: "Merge", blocks: [P("One Task may serve many bookings.")] }] } }),
        n("W.CX", { name: "Context", letter: "CX", x: 5.5, y: 3.7, hatch: "f",
          does: { title: "Context", lead: "path facts on the Task", sections: [{ h: "Holds", blocks: [P("Record<string, JsonValue>. Seeded from the previous hop. Written only by inspect.")] }] },
          built: { title: "No booking-global map", lead: "§4.2", sections: [{ h: "currentContext", blocks: [P("Copy of the latest accepted Task.context on the working path.")] }] } }),
      ],
      edges: [
        { from: "W.ST", to: "W.LK", kind: "data" },
        { from: "W.ST", to: "W.TK", kind: "data" },
        { from: "W.BK", to: "W.PS", kind: "data" },
        { from: "W.PS", to: "W.TK", kind: "data" },
        { from: "W.TK", to: "W.CX", kind: "data" },
        { from: "W.BK", to: "W.ST", kind: "support" },
      ],
    },
    sticky: {
      id: "sticky",
      title: "Sticky cache",
      parent: "root",
      focus: "Y",
      nodes: [
        n("Y.SA", { name: "SAT table", letter: "SA", x: 2.0, y: 1.6, w: 1.4, d: 1.4, h: 1.2, hatch: "a",
          does: { title: "SAT table", lead: "reuse the plan", sections: [{ h: "Valid while", blocks: [P("demandHash unchanged, plan resources still held, relevant setup/topo/policy epochs on the plan still match.")] }] },
          built: { title: "plan-relevant", lead: "unrelated plant noise is ignored", sections: [{ h: "Bust", blocks: [P("legs, window, setup/CLOSED on used stations, Link CLOSED on used links, cancel, unsubmit.")] }] } }),
        n("Y.UN", { name: "UNSAT table", letter: "UN", x: 4.8, y: 1.6, w: 1.4, d: 1.4, h: 1.2, hatch: "b",
          does: { title: "UNSAT table", lead: "reuse the failure", sections: [{ h: "Valid while", blocks: [P("demand unchanged and no hopeful change on relevant types/stations/links.")] }] },
          built: { title: "hope only", lead: "new claims elsewhere do not bust", sections: [{ h: "Bust", blocks: [P("demand edit, relevant setup, Link/station OPENED useful to relevant types, tasking freed, policy loosen.")] }] } }),
        n("Y.EP", { name: "Epochs", letter: "EP", x: 7.6, y: 1.6, hatch: "c",
          does: { title: "Epochs", lead: "per-resource, not one plant token", sections: [{ h: "What", blocks: [P("relevantSetupEpochs and relevantTopoEpochs on the StickyRecord. Coarse topology_rev / setup_rev may exist for Kafka wake only.")] }] },
          built: { title: "§3.10 / §10.1", lead: "not hopeful_rev as validity", sections: [{ h: "Maps", blocks: [C("Map<Id, long>  — only relevant ids")] }] } }),
        n("Y.BU", { name: "Bust tables", letter: "BU", shape: "plate", w: 2.0, d: 1.5, h: 0.4, x: 3.8, y: 3.8, hatch: "d",
          does: { title: "Bust tables", lead: "SAT and UNSAT disagree on purpose", sections: [{ h: "What", blocks: [P("The same world event can bust one booking’s SAT and another’s UNSAT without busting everything. CLOSED busts SAT on users; it does not bust UNSAT. OPEN does the reverse.")] }] },
          built: { title: "Two tables", lead: "DECIDED", sections: [{ h: "liveData", blocks: [P("No auto bust on either table.")] }] } }),
      ],
      edges: [
        { from: "Y.EP", to: "Y.SA", kind: "data" },
        { from: "Y.EP", to: "Y.UN", kind: "data" },
        { from: "Y.SA", to: "Y.BU", kind: "loop" },
        { from: "Y.UN", to: "Y.BU", kind: "loop" },
      ],
    },
    catalog: {
      id: "catalog",
      title: "Catalog / SPI",
      parent: "root",
      focus: "L",
      nodes: [
        n("L.RF", { name: "StationTypeRef", letter: "RF", x: 1.5, y: 1.6, hatch: "a",
          does: { title: "StationTypeRef", lead: "boot handle", sections: [{ h: "What", blocks: [P("id + className. Classpath is not enough — the engine needs the FQCN.")] }] },
          built: { title: "Class.forName", lead: "then SPI instance", sections: [{ h: "Discovery", blocks: [P("Explicit allow-list. ServiceLoader may find candidates.")] }] } }),
        n("L.TY", { name: "StationType", letter: "TY", shape: "tall", h: 1.8, x: 3.7, y: 1.4, hatch: "b",
          does: { title: "StationType", lead: "the class", sections: [{ h: "What", blocks: [P("Metadata + canUse + inspect + optional neighborRank. One class, not inspectorId + prefilterId.")] }] },
          built: { title: "ResourceType", lead: "target name", sections: [{ h: "transparent", blocks: [P("Omitted from demand; still real on the fabric.")] }] } }),
        n("L.TD", { name: "TrackDef", letter: "TD", x: 6.0, y: 1.6, hatch: "c",
          does: { title: "TrackDef", lead: "type-owned port kind", sections: [{ h: "What", blocks: [P("id, name (kind), number. Side is which list it sits on: inputTracks vs outputTracks.")] }] },
          built: { title: "IoPort", lead: "target name", sections: [{ h: "Scale", blocks: [P("Up to ~32 in and ~32 out per type.")] }] } }),
        n("L.LP", { name: "legalPairs", letter: "LP", x: 8.2, y: 1.6, hatch: "d",
          does: { title: "legalPairs", lead: "possible in→out on one visit", sections: [{ h: "What", blocks: [P("Capability. Concurrent legality is still inspect(). Y1 walkthrough is restricted (not 1→6).")] }] },
          built: { title: "TrackDef.id pairs", lead: "on this type", sections: [{ h: "Families", blocks: [P("direct, aggregator, expander, restricted, full — §6.")] }] } }),
        n("L.HE", { name: "heuristics", letter: "HE", x: 4.8, y: 3.8, hatch: "e",
          does: { title: "heuristics", lead: "checkpoint · fillFirst", sections: [{ h: "What", blocks: [P("fillFirst default true (ExpandKey preferInUse). checkpoint is a type flag the Assembler honours after the next leg succeeds.")] }] },
          built: { title: "No cost ladder", lead: "DECIDED", sections: [{ h: "Absent", blocks: [P("No edgeCostId, transparentCost, or summed preference.")] }] } }),
      ],
      edges: [
        { from: "L.RF", to: "L.TY", kind: "loop" },
        { from: "L.TY", to: "L.TD", kind: "data" },
        { from: "L.TY", to: "L.LP", kind: "data" },
        { from: "L.TY", to: "L.HE", kind: "data" },
      ],
    },
    fabric: {
      id: "fabric",
      title: "Fabric",
      parent: "root",
      focus: "G",
      nodes: [
        n("G.PG", { name: "Port graph", letter: "PG", shape: "plate", w: 1.8, d: 1.5, h: 0.4, x: 1.6, y: 1.6, hatch: "a",
          does: { title: "Port graph", lead: "dense int ports", sections: [{ h: "What", blocks: [P("String ids become 0..P-1 at load. CSR adjacency is read-only after a topology build.")] }] },
          built: { title: "CSR", lead: "offsets + neighbors", sections: [{ h: "Rebuild", blocks: [P("Links add/remove/online, Station OPEN/CLOSED, legalPairs change.")] }] } }),
        n("G.HK", { name: "hop_key", letter: "HK", x: 4.3, y: 1.7, hatch: "b",
          does: { title: "hop_key", lead: "(stationId, in, out)", sections: [{ h: "What", blocks: [P("A visit identity. Re-entry is allowed only with a new key. Nulls matter for entry and terminal hops.")] }] },
          built: { title: "Packed Long", lead: "hot path", sections: [{ h: "Anti-loop", blocks: [P("No repeat hop_key on a path. max H / V on top.")] }] } }),
        n("G.OD", { name: "Distances", letter: "OD", x: 6.5, y: 1.55, z: 0.2, hatch: "c",
          does: { title: "Distances", lead: "Oracle++ numbers", sections: [{ h: "What", blocks: [P("min hops to G and to terminal. Unreachable is ∞ and filtered from goals.")] }] },
          built: { title: "Backward multi-source BFS", lead: "once per couple()", sections: [{ h: "Not", blocks: [P("Tasking, request, inspect.")] }] } }),
        n("G.ON", { name: "Online maps", letter: "ON", x: 3.8, y: 3.8, hatch: "d",
          does: { title: "Online maps", lead: "Station + Link", sections: [{ h: "What", blocks: [P("CLOSED station or offline Link is not walked. OPEN is hopeful (busts relevant UNSAT). CLOSED on a used resource busts that SAT.")] }] },
          built: { title: "Same as Link.online", lead: "§3.10", sections: [{ h: "liveData", blocks: [P("Does not belong here and does not rebuild the graph.")] }] } }),
      ],
      edges: [
        { from: "G.PG", to: "G.HK", kind: "loop" },
        { from: "G.PG", to: "G.OD", kind: "loop" },
        { from: "G.ON", to: "G.PG", kind: "support" },
        { from: "G.OD", to: "G.HK", kind: "data" },
      ],
    },
    kafkain: {
      id: "kafkain",
      title: "Kafka inbound",
      parent: "root",
      focus: "J",
      nodes: [
        n("J.CT", { name: "catalog.*", letter: "CT", x: 1.4, y: 1.5, hatch: "a",
          does: { title: "catalog.*", lead: "types and stations", sections: [{ h: "Events", blocks: [P("New StationType, setup allowed, station OPEN/CLOSED, setup armed.")] }] },
          built: { title: "upsert / delete", lead: "idempotent", sections: [{ h: "Then", blocks: [P("Bump catalog/setup epochs. Classify hopeful vs tightening.")] }] } }),
        n("J.FL", { name: "fabric.links", letter: "FL", x: 3.6, y: 1.5, hatch: "b",
          does: { title: "fabric.links", lead: "topology", sections: [{ h: "Events", blocks: [P("Link add/remove/online. Rebuild CSR and Oracle++.")] }] },
          built: { title: "Topology change", lead: "re-validate SAT paths", sections: [{ h: "Policy", blocks: [P("Re-resolve broken, or a coarse pending set.")] }] } }),
        n("J.BC", { name: "bookings.commands", letter: "BC", x: 5.8, y: 1.5, hatch: "c",
          does: { title: "bookings.commands", lead: "create / update / cancel / submit", sections: [{ h: "Events", blocks: [P("Demand change busts that booking’s sticky and UNSAT, then resolve. submitTime is when it enters the engine.")] }] },
          built: { title: "One booking, plus unsats", lead: "§3.9", sections: [{ h: "Cancel", blocks: [P("Strip Tasks, drop empties, hopeful wake.")] }] } }),
        n("J.OC", { name: "occupancy", letter: "OC", x: 8.0, y: 1.5, hatch: "d",
          does: { title: "occupancy.events", lead: "optional external claims", sections: [{ h: "Events", blocks: [P("Claims held by other systems, if any. Treat as upserts into the projection.")] }] },
          built: { title: "Optional", lead: "§10.1.1", sections: [{ h: "Note", blocks: [P("New claims elsewhere do not bust this booking’s UNSAT by themselves.")] }] } }),
        n("J.CL", { name: "Classify", letter: "CL", shape: "plate", w: 2.0, d: 1.5, h: 0.4, x: 3.8, y: 3.6, hatch: "e",
          does: { title: "Classify", lead: "hopeful · tightening · demand · topology · no-op", sections: [{ h: "What", blocks: [P("This is the policy that keeps you from empty-running every booking on every poll. Sticky validity stays relevance-scoped even if the wake is coarse.")] }] },
          built: { title: "Then enqueue", lead: "serial engine", sections: [{ h: "Emit", blocks: [P("Outputs only when a plan changes.")] }] } }),
      ],
      edges: [
        { from: "J.CT", to: "J.CL", kind: "loop" },
        { from: "J.FL", to: "J.CL", kind: "loop" },
        { from: "J.BC", to: "J.CL", kind: "loop" },
        { from: "J.OC", to: "J.CL", kind: "loop" },
      ],
    },
    plans: {
      id: "plans",
      title: "Plans",
      parent: "root",
      focus: "D",
      nodes: [
        n("D.PL", { name: "bookings.plans", letter: "PL", shape: "plate", w: 1.8, d: 1.5, h: 0.42, x: 1.6, y: 1.6, hatch: "a",
          does: { title: "bookings.plans", lead: "status + summary", sections: [{ h: "What", blocks: [P("sat|unsat, bindings, route summary, optional FailureReport. The display copy of what committed.")] }] },
          built: { title: "ResolveResult", lead: "§9.2", sections: [{ h: "Also", blocks: [P("sticky_hit, negative_cache_hit, metrics.")] }] } }),
        n("D.CC", { name: "claims.commands", letter: "CC", x: 4.4, y: 1.7, hatch: "b",
          does: { title: "claims.commands", lead: "hold hop resources", sections: [{ h: "What", blocks: [P("Claim or release a Station + hop_key / track / Link. Hard-claim on SAT until release.")] }] },
          built: { title: "Actuators consume", lead: "not Coupler", sections: [{ h: "Order", blocks: [P("Publish after commit. Same-run re-place may release then claim again.")] }] } }),
        n("D.SU", { name: "setups.commands", letter: "SU", x: 6.7, y: 1.7, hatch: "c",
          does: { title: "setups.commands", lead: "arm setup on used stations", sections: [{ h: "What", blocks: [P("Including transparent stations on the route. Setup values themselves stay human / rare; this is the arming command.")] }] },
          built: { title: "DEFAULT Q15", lead: "this service publishes", sections: [{ h: "Apply", blocks: [P("Actuators apply and may emit occupancy confirmations.")] }] } }),
      ],
      edges: [
        { from: "D.PL", to: "D.CC", kind: "out" },
        { from: "D.PL", to: "D.SU", kind: "out" },
      ],
    },
    booking: {
      id: "booking",
      title: "Booking",
      parent: "root",
      focus: "B",
      nodes: [
        n("B.LG", { name: "Legs", letter: "LG", shape: "slabs", slabs: 3, w: 1.8, d: 1.1, h: 1.05, x: 1.5, y: 1.5, hatch: "a",
          does: { title: "Legs", lead: "the demand string", sections: [{ h: "What", blocks: [P("Ordered non-transparent StationTypes, each with a request. Users do not author transparent legs.")] }] },
          built: { title: "Step", lead: "target name", sections: [{ h: "Hash", blocks: [P("legs + requests + window + priority + submitTime = demandHash.")] }] } }),
        n("B.TW", { name: "Time window", letter: "TW", x: 4.2, y: 1.55, hatch: "b",
          does: { title: "Time window", lead: "the only clock on the demand", sections: [{ h: "What", blocks: [P("Half-open [start, end). No RRULE. Assembler clips to the horizon and slices at peer boundaries.")] }] },
          built: { title: "placeSpan", lead: "∩ [now, now+horizon)", sections: [{ h: "Past window", blocks: [P("Empty span → SAT with no segments.")] }] } }),
        n("B.RT", { name: "Route", letter: "RT", x: 6.4, y: 1.55, hatch: "c",
          does: { title: "Route", lead: "full hop list after resolve", sections: [{ h: "What", blocks: [P("User-visible plan string, including switches. May list the same station twice with different hop_keys.")] }] },
          built: { title: "Path / Hop", lead: "denormalized display", sections: [{ h: "Prefer", blocks: [P("planSegments when there is more than one slice.")] }] } }),
        n("B.BN", { name: "Bindings", letter: "BN", x: 3.2, y: 3.7, hatch: "d",
          does: { title: "Bindings", lead: "this booking uses this Station", sections: [{ h: "What", blocks: [P("legIndex null if the station is transparent / path. role is leg or path.")] }] },
          built: { title: "AllocatedAsset", lead: "target name", sections: [{ h: "DEFAULT", blocks: [P("Copy of the single segment; null if multi-segment.")] }] } }),
        n("B.PS", { name: "PlanSegments", letter: "PS", shape: "plate", w: 1.8, d: 1.4, h: 0.4, x: 5.8, y: 3.6, hatch: "e",
          does: { title: "PlanSegments", lead: "schedule SSOT", sections: [{ h: "What", blocks: [P("Time-sliced route + bindings + materialized stationTasks. Adjacent identical slices merge.")] }] },
          built: { title: "§3.9b", lead: "Inspector never writes these", sections: [{ h: "Commit", blocks: [P("Replace prior segments for this booking only.")] }] } }),
      ],
      edges: [
        { from: "B.LG", to: "B.TW", kind: "data" },
        { from: "B.LG", to: "B.RT", kind: "loop" },
        { from: "B.RT", to: "B.BN", kind: "data" },
        { from: "B.TW", to: "B.PS", kind: "loop" },
        { from: "B.RT", to: "B.PS", kind: "loop" },
      ],
    },
    inspector: {
      id: "inspector",
      title: "Inspector",
      parent: "root",
      focus: "I",
      nodes: [
        n("I.CU", { name: "canUse", letter: "CU", x: 1.6, y: 1.6, hatch: "a",
          does: { title: "canUse", lead: "Assembler, before couple", sections: [{ h: "Sees", blocks: [P("setup, request, liveData. Must not reject a station a later path could save.")] }] },
          built: { title: "Optional", lead: "default pass-all", sections: [{ h: "Same class", blocks: [P("Not a separate prefilter plugin.")] }] } }),
        n("I.IN", { name: "inspect", letter: "IN", w: 1.4, d: 1.4, h: 1.3, x: 4.0, y: 1.45, hatch: "b",
          does: { title: "inspect", lead: "Coupler, at hop and goal", sections: [{ h: "Sees", blocks: [P("setup, tasking+candidate, request, liveData. Returns full Task[] or Failure.")] }] },
          built: { title: "Required", lead: "one candidate per call", sections: [{ h: "request", blocks: [P("Leg request at goals. null on transparent hops.")] }] } }),
        n("I.NR", { name: "neighborRank", letter: "NR", x: 6.6, y: 1.6, hatch: "c",
          does: { title: "neighborRank", lead: "ranking only", sections: [{ h: "Sees", blocks: [P("Enough to break ties already tied on ExpandKey 0–3. Default 0.")] }] },
          built: { title: "Column 4", lead: "not an API of its own", sections: [{ h: "Not", blocks: [P("rank_cost, edgeCost, f=g+h.")] }] } }),
        n("I.CX", { name: "Context write", letter: "CX", shape: "plate", w: 1.8, d: 1.4, h: 0.4, x: 3.6, y: 3.7, hatch: "d",
          does: { title: "Context write", lead: "the only publisher", sections: [{ h: "What", blocks: [P("On inspect OK the type may add keys (refrigerated.cabinets, clearance.y2_stamp). The Coupler copies that map into the next candidate. There is no publish_on_hop table.")] }] },
          built: { title: "§4.2", lead: "Inspector is the writer", sections: [{ h: "Closed set", blocks: [P("Search state carries (out-port, context) so alternate paths can differ.")] }] } }),
      ],
      edges: [
        { from: "I.CU", to: "I.IN", kind: "loop" },
        { from: "I.IN", to: "I.CX", kind: "loop" },
        { from: "I.NR", to: "I.IN", kind: "support" },
      ],
    },
  };

  function childCount(node) {
    if (!node.inside || !SCENES[node.inside]) return 0;
    return SCENES[node.inside].nodes.length;
  }

  NODES.forEach((node) => {
    node.steps = childCount(node);
    if (!node.letter) node.letter = node.id;
  });
  Object.keys(SCENES).forEach((sid) => {
    if (sid === "root") return;
    SCENES[sid].nodes.forEach((node) => {
      node.steps = 0;
      if (!node.letter) node.letter = node.id.split(".").pop();
    });
  });

  global.TP = {
    META: { name: "Trackplan" },
    GROUPS,
    STATS,
    ROOT_COPY,
    SCENES,
    FLOW,
    nodeById(scene, id) {
      return scene.nodes.find((n) => n.id === id) || null;
    },
    edgeKey(e) {
      return e.from + "|" + e.to;
    },
  };
})(window);
