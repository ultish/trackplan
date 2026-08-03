#!/usr/bin/env python3
"""
Walkthrough Coupler simulator for Trackplan walkthrough accuracy.

ExpandKey (lexicographic, DECIDED BUILD_SPEC §3.7b):
  0 preferInUse (higher) — neighbor has tasking
  1 preferNonTransparent (higher)
  2 distToSegmentGoals (lower) — Oracle++ hops to nearest multi-sink goal in G
  3 distToTerminal (lower) — Oracle++ hop length to nearest terminal
  4 neighborRank (higher) — default 0
  5 stationName (lower)
  6 portName / out track (lower)

Usage:
  python3 coupler_walkthrough_sim.py simple
  python3 coupler_walkthrough_sim.py multiyard
  python3 coupler_walkthrough_sim.py loopback
  python3 coupler_walkthrough_sim.py all
"""

from __future__ import annotations

import heapq
import sys
from dataclasses import dataclass, field
from typing import Any, FrozenSet, Optional

# --- Topology (matches booking-assembler-design.html) ---

TRANSPARENT = {"Y1", "Y2"}
TERMINAL_TYPE = "Docking"

STATIONS = {
    "R-17": {"type": "Refrigerated", "seats": None, "tasking": False},
    "R-22": {"type": "Refrigerated", "seats": None, "tasking": False},
    "N-04": {"type": "Normal", "seats": 8, "tasking": False},
    "N-08": {"type": "Normal", "seats": 4, "tasking": False},
    "N-12": {"type": "Normal", "seats": 12, "tasking": False},
    "Y1": {"type": "Switch", "seats": None, "tasking": False},
    "Y2": {"type": "Switch", "seats": None, "tasking": False},
    "D-02": {"type": "Docking", "seats": None, "tasking": False},
    "D-11": {"type": "Docking", "seats": None, "tasking": False},
}

LEGAL = {
    "Y1": {("1", "1"), ("1", "2"), ("1", "3"), ("5", "6")},
    "Y2": {("1", "5"), ("1", "6")},
}

# free stations: any in → any out (single port models use "1")
def legal_pairs(station: str, in_track: Optional[str]) -> list[tuple[str, str]]:
    if station in LEGAL:
        if in_track is None:
            return []
        return sorted((i, o) for i, o in LEGAL[station] if i == in_track)
    # non-switch: if we arrived on in, leave on out 1 if link exists; start stations have no in
    if in_track is None:
        return [("0", "1")]  # synthetic start out
    return [(in_track, "1")]


LINKS: list[tuple[str, str, str, str]] = [
    ("R-17", "1", "Y1", "1"),
    ("Y1", "1", "N-04", "1"),
    ("Y1", "2", "Y2", "1"),
    ("Y1", "3", "N-08", "1"),
    ("Y1", "6", "N-12", "1"),
    ("Y2", "5", "N-04", "1"),
    ("Y2", "6", "Y1", "5"),
    ("N-04", "1", "D-02", "1"),
    ("N-12", "1", "D-11", "1"),
    # busy alt not used unless scenario enables
]


def links_from(station: str, out_track: str) -> list[tuple[str, str]]:
    return [(b, bt) for a, at, b, bt in LINKS if a == station and at == out_track]


def links_to(station: str, in_track: str) -> list[tuple[str, str]]:
    return [(a, at) for a, at, b, bt in LINKS if b == station and bt == in_track]


# Oracle++: hop distance on undirected? Use directed Link graph, hop = 1 per link
# Internal legal pair also counts as 1 hop for distance

def build_graph():
    """Nodes: (station, track, side) side in 'in'|'out'|'free' """
    # Simpler node model for BFS distance: station only for terminal distance estimate
    # Use port graph: after leaving on out, follow link to in
    adj: dict[str, list[str]] = {s: [] for s in STATIONS}
    for a, at, b, bt in LINKS:
        adj[a].append(b)
    # also: at switch, from arrival you can leave to neighbors via legal outs
    return adj


def dist_to_terminal(station: str, offline_links: set[tuple[str, str, str, str]] | None = None) -> int:
    offline = offline_links or set()
    # BFS stations via LINKS not offline
    q = [(station, 0)]
    seen = {station}
    terms = {s for s, m in STATIONS.items() if m["type"] == TERMINAL_TYPE}
    if station in terms:
        return 0
    i = 0
    while i < len(q):
        cur, d = q[i]
        i += 1
        for a, at, b, bt in LINKS:
            if (a, at, b, bt) in offline:
                continue
            if a == cur and b not in seen:
                if b in terms:
                    return d + 1
                seen.add(b)
                q.append((b, d + 1))
        # internal: from cur if switch, can reach outs without changing station for terminal bfs
        # already covered by links from outs
    return 10**9


def dist_to_goals(station: str, goals: set[str], offline_links=None) -> int:
    """Min hop distance to any station in multi-sink set G. 0 if station ∈ G."""
    if station in goals:
        return 0
    offline = offline_links or set()
    q = [(station, 0)]
    seen = {station}
    i = 0
    while i < len(q):
        cur, d = q[i]
        i += 1
        for a, at, b, bt in LINKS:
            if (a, at, b, bt) in offline:
                continue
            if a == cur and b not in seen:
                if b in goals:
                    return d + 1
                seen.add(b)
                q.append((b, d + 1))
    return 10**9


def expand_key(
    to_station: str,
    out_or_in_port: str,
    offline_links=None,
    goals: set[str] | None = None,
) -> tuple:
    meta = STATIONS[to_station]
    in_use = 1 if meta.get("tasking") else 0
    non_trans = 0 if to_station in TRANSPARENT else 1
    gset = goals or set()
    dist_seg = dist_to_goals(to_station, gset, offline_links) if gset else 0
    dist_term = dist_to_terminal(to_station, offline_links)
    rank = 0
    # prefer higher in_use, non_trans, rank; lower distances, name, port
    return (
        -in_use,
        -non_trans,
        dist_seg,
        dist_term,
        -rank,
        to_station,
        str(out_or_in_port),
    )


@dataclass(order=True)
class PQItem:
    """Open-set order: hop g, then ExpandKey, then seq.
    ExpandKey ranks siblings; A* h is logged via dist but ExpandKey (not f-sum)
    decides which legal child is tried next among same g (BUILD_SPEC §3.7b pedagogy).
    """
    g: int
    ek: tuple
    seq: int
    state_id: str = field(compare=False)


@dataclass
class State:
    station: str
    in_track: Optional[str]  # None = virtual start / free start
    context: FrozenSet[str]
    g: int
    hops: tuple[str, ...]
    parent: Optional[str]
    via: str  # description of last edge


def hop_str(inn: str, st: str, out: str) -> str:
    return f"{inn}:{st}:{out}"


def prefilter_normal(station: str, min_seats: int = 6) -> bool:
    seats = STATIONS[station]["seats"]
    return seats is not None and seats >= min_seats


def inspect(station: str, context: FrozenSet[str], goal_types: set[str], min_seats: int = 6) -> tuple[bool, FrozenSet[str], str]:
    """Returns (ok, new_context, reason)."""
    meta = STATIONS[station]
    ctx = set(context)

    if station in TRANSPARENT:
        # every visit: Y2 writes stamp
        if station == "Y2":
            ctx.add("clearance.y2_stamp")
            return True, frozenset(ctx), "Y2 inspect OK · wrote clearance.y2_stamp"
        return True, frozenset(ctx), f"{station} transparent inspect OK"

    if meta["type"] == "Refrigerated":
        return True, frozenset(ctx | {"cabinets=4"}), "Refrigerated inspect OK"

    if meta["type"] == "Normal":
        if station not in goal_types and meta["type"] not in {STATIONS[g]["type"] for g in goal_types}:
            # treat goal set by station ids
            pass
        if not prefilter_normal(station, min_seats):
            return False, frozenset(ctx), "INSPECT_FAIL seats (should have been prefiltered)"
        if "clearance.y2_stamp" not in ctx:
            return False, frozenset(ctx), "INSPECT_FAIL missing clearance.y2_stamp"
        return True, frozenset(ctx | {f"seats={meta['seats']}"}), "Normal inspect OK · stamp+seats"

    if meta["type"] == "Docking":
        return True, frozenset(ctx), "Docking inspect OK"

    return True, frozenset(ctx), "inspect OK"


def is_goal(station: str, goals: set[str]) -> bool:
    return station in goals


_seq = 0


def couple(
    start_station: Optional[str],
    start_out: Optional[str],
    goals: set[str],
    label: str,
    offline_links: set[tuple[str, str, str, str]] | None = None,
    max_expansions: int = 5000,
    need_stamp_for_normal: bool = True,
) -> list[str]:
    """
    Multi-sink couple. If start_station is None, S0 to all Refrigerated in goals or free starts.
    start_out: if start is bound station, begin by leaving on that out (tail).
    """
    global _seq
    offline = offline_links or set()
    log: list[str] = []
    log.append(f"=== couple: {label} ===")
    log.append(f"goals={sorted(goals)} offline_links={len(offline)}")

    # state key: station|in|context|hops_len
    open_heap: list[PQItem] = []
    states: dict[str, State] = {}
    best_g: dict[tuple, int] = {}

    def state_key(st: State) -> tuple:
        return (st.station, st.in_track, st.context)

    def push_state(st: State, port_hint: Optional[str] = None):
        global _seq
        sk = state_key(st)
        prev = best_g.get(sk)
        if prev is not None and prev <= st.g:
            return
        best_g[sk] = st.g
        sid = f"{st.station}:{st.in_track}:{st.g}:{_seq}"
        _seq += 1
        states[sid] = st
        # ExpandKey for open-set among same g (lexicographic, not summed f)
        port = port_hint if port_hint is not None else (st.in_track or "1")
        ek = expand_key(st.station, port, offline, goals)
        heapq.heappush(open_heap, PQItem(st.g, ek, _seq, sid))

    # Seed
    if start_station is None:
        # S0 → each goal station (or candidates)
        seeds = sorted(goals)
        log.append(f"S0 expand order (ExpandKey):")
        ranked = sorted(seeds, key=lambda s: expand_key(s, "1", offline, goals))
        for s in ranked:
            log.append(f"  S0 → {s}  key={expand_key(s, '1', offline, goals)}")
            st = State(s, None, frozenset(), 0, (), None, f"S0→{s}")
            # inspect at goal immediately as start
            push_state(st)
    else:
        # At tail: station ready to leave on start_out (we are "at" station with synthetic in)
        st = State(start_station, "tail", frozenset({"cabinets=4"}), 0, (), None, f"tail {start_station}:{start_out}")
        push_state(st)
        log.append(f"start tail={start_station} out={start_out} ctx=cabinets=4")

    expansions = 0
    while open_heap and expansions < max_expansions:
        item = heapq.heappop(open_heap)
        st = states[item.state_id]
        expansions += 1

        # Goal check if station is a goal and we "arrived" (in_track not tail-only free start without arrival)
        # For S0 seeds, station is candidate — run inspect as start bind
        at_goal = is_goal(st.station, goals)
        arrived = st.in_track is not None and st.in_track != "tail"
        started = st.in_track is None  # S0 pick

        if at_goal and (arrived or started):
            ok, new_ctx, reason = inspect(st.station, st.context, goals)
            log.append(
                f"[{expansions}] GOAL? {st.station} hops={list(st.hops)} ctx={sorted(st.context)} → {reason}"
            )
            if ok:
                log.append(f"SUCCESS path={list(st.hops)} station={st.station} ctx={sorted(new_ctx)}")
                log.append(f"expansions={expansions}")
                return log
            # fail: continue expand from here only if non-terminal exploration; for Normal fail, still can expand outs?
            # Spec: goal reject continue search — do not expand further from failed goal as success; may still expand if fabric continues
            # For simplicity: don't expand outs from failed Normal goal (dead for this path); other open states continue
            continue

        # Arrived at non-goal, non-transparent fabric station (e.g. N-08 seats drop): not a goal
        if arrived and not at_goal and st.station not in TRANSPARENT:
            log.append(
                f"[{expansions}] NOT_GOAL {st.station} hops={list(st.hops)} "
                f"ctx={sorted(st.context)} → not a multi-sink goal (e.g. prefilter seats)"
            )
            # Still expand outs if any (reference map: N-08 has none)
            # fall through to expand

        # Transparent mid-path: if we arrived on a transparent station, inspect then expand
        if arrived and st.station in TRANSPARENT:
            ok, new_ctx, reason = inspect(st.station, st.context, goals)
            log.append(f"[{expansions}] TRANSPARENT {st.station} in={st.in_track} {reason} ctx→{sorted(new_ctx)}")
            if not ok:
                continue
            st = State(st.station, st.in_track, new_ctx, st.g, st.hops, st.parent, st.via)

        # Expand legal pairs + links
        # If tail mode: leave on fixed out
        if st.in_track == "tail":
            pairs = [("tail", start_out or "1")]
        elif st.in_track is None:
            # S0 already at station — should have been goal inspected; if not goal expand outs
            pairs = legal_pairs(st.station, "1") if st.station in LEGAL else [("1", "1")]
        else:
            pairs = legal_pairs(st.station, st.in_track)

        # Build candidate expansions: (to_station, to_in, hop, out_track)
        cands = []
        for inn, out in pairs:
            if st.in_track == "tail":
                inn_h = "·"
                out = start_out or "1"
            else:
                inn_h = inn if inn != "0" else "1"
            for b, bt in links_from(st.station, out):
                link = (st.station, out, b, bt)
                if link in offline:
                    continue
                hop = hop_str(inn_h if st.in_track != "tail" else "1", st.station, out) if st.station in LEGAL or st.in_track == "tail" else hop_str("1", st.station, out)
                if st.in_track == "tail":
                    hop = hop_str("1", st.station, out)
                cands.append((b, bt, hop, out, link))

        # Sort by ExpandKey of destination (lexicographic — NOT sum)
        cands.sort(key=lambda c: expand_key(c[0], c[3], offline, goals))

        if cands:
            log.append(f"[{expansions}] EXPAND {st.station} in={st.in_track} ctx={sorted(st.context)} children (ExpandKey order):")
            for b, bt, hop, out, link in cands:
                tag = (
                    "goal"
                    if is_goal(b, goals)
                    else ("transparent" if b in TRANSPARENT else "not-goal")
                )
                log.append(
                    f"    → {hop} Link→ {b}:{bt}  [{tag}]  key={expand_key(b, out, offline, goals)}"
                )

        for b, bt, hop, out, link in cands:
            new_hops = st.hops + (hop,)
            # count internal hop + link as g+1 for link only
            new_st = State(b, bt, st.context, st.g + 1, new_hops, item.state_id, f"{hop}→{b}")
            push_state(new_st, port_hint=out)

    log.append("FAIL exhausted")
    log.append(f"expansions={expansions}")
    return log


def run_simple():
    log = []
    log.append("######## SCENARIO simple: R→N→D (stamp world) ########")
    # Segment 1 S0 → R
    log.extend(couple(None, None, {"R-17", "R-22"}, "S0→Refrigerated"))
    # Segment 2 from R-17 out1 → Normal goals
    log.extend(
        couple(
            "R-17",
            "1",
            {"N-04", "N-12"},
            "R-17:out1→Normal goals {N-04,N-12}",
        )
    )
    # Segment 3 would be N-04 out1 → D — only if N-04 bound
    log.extend(couple("N-04", "1", {"D-02", "D-11"}, "N-04:out1→Docking"))
    return log


def run_multiyard():
    # same as simple N segment — stamp discovery
    log = []
    log.append("######## SCENARIO multiyard (N segment only) ########")
    log.extend(couple("R-17", "1", {"N-04", "N-12"}, "R→N multiyard"))
    return log


def run_loopback():
    log = []
    log.append("######## SCENARIO loopback: Y2→N-04 offline ########")
    offline = {("Y2", "5", "N-04", "1")}
    log.extend(
        couple(
            "R-17",
            "1",
            {"N-04", "N-12"},
            "R→N with Y2:5→N-04 OFFLINE",
            offline_links=offline,
        )
    )
    return log


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "simple"
    runners = {
        "simple": run_simple,
        "multiyard": run_multiyard,
        "loopback": run_loopback,
        "all": lambda: run_simple() + run_multiyard() + run_loopback(),
    }
    if which not in runners:
        print("usage: simple|multiyard|loopback|all", file=sys.stderr)
        sys.exit(2)
    lines = runners[which]()
    text = "\n".join(lines)
    print(text)
    out = f"/Users/jxhui/Developer/trackplan/docs/scripts/sim_out_{which}.txt"
    with open(out, "w") as f:
        f.write(text)
    print(f"\n# wrote {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
