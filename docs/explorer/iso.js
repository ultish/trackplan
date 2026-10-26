/* Isometric technical drawing for a machine map. */
(function (global) {
  const TILE_W = 88;
  const TILE_H = 44;
  const TILE_Z = 34;

  function project(x, y, z) {
    return {
      x: (x - y) * (TILE_W / 2),
      y: (x + y) * (TILE_H / 2) - z * TILE_Z,
    };
  }

  function pstr(pt) {
    return pt.x.toFixed(2) + "," + pt.y.toFixed(2);
  }

  function poly(pts) {
    return pts.map(pstr).join(" ");
  }

  function boxCorners(n) {
    const { x, y, z, w, d, h } = n;
    const c = (dx, dy, dz) => project(x + dx, y + dy, z + dz);
    return {
      top: [c(0, 0, h), c(w, 0, h), c(w, d, h), c(0, d, h)],
      left: [c(0, d, 0), c(w, d, 0), c(w, d, h), c(0, d, h)],
      right: [c(w, 0, 0), c(w, d, 0), c(w, d, h), c(w, 0, h)],
      topCenter: project(x + w / 2, y + d / 2, z + h),
      attach: project(x + w / 2, y + d / 2, z + h),
      foot: project(x + w / 2, y + d / 2, z),
      near: x + y + w + d,
    };
  }

  function expandShape(node) {
    if (node.shape === "stack") {
      const plates = 5;
      const gap = 0.045;
      const ph = (node.h - gap * (plates - 1)) / plates;
      const out = [];
      for (let i = 0; i < plates; i++) {
        out.push({
          ...node,
          id: node.id + "::p" + i,
          parentId: node.id,
          z: node.z + i * (ph + gap),
          h: ph,
          shape: "plate",
          isPlate: true,
          plateIndex: i,
          plateCount: plates,
        });
      }
      return out;
    }
    if (node.shape === "slabs") {
      const count = node.slabs || 4;
      const gap = 0.1;
      const sw = (node.w - gap * (count - 1)) / count;
      const out = [];
      for (let i = 0; i < count; i++) {
        out.push({
          ...node,
          id: node.id + "::s" + i,
          parentId: node.id,
          x: node.x + i * (sw + gap),
          w: sw,
          shape: "cube",
          isSlab: true,
          slabIndex: i,
          slabCount: count,
        });
      }
      return out;
    }
    return [{ ...node, parentId: node.id }];
  }

  function svgEl(name, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const k in attrs) {
      if (attrs[k] !== undefined && attrs[k] !== null) el.setAttribute(k, attrs[k]);
    }
    return el;
  }

  function ensureDefs(svg) {
    let defs = svg.querySelector("defs");
    if (defs) return defs;
    defs = svgEl("defs", {});
    svg.insertBefore(defs, svg.firstChild);

    const hatches = [
      ["hatch-a", 45, 7, 0.85],
      ["hatch-b", 135, 6, 0.8],
      ["hatch-c", 30, 8, 0.75],
      ["hatch-d", 60, 5.5, 0.9],
      ["hatch-e", 120, 7.5, 0.8],
      ["hatch-f", 15, 6.5, 0.85],
      ["hatch-g", 75, 7, 0.8],
      ["hatch-h", 105, 6, 0.85],
      ["hatch-i", 150, 8, 0.75],
      ["hatch-j", 20, 5.5, 0.9],
      ["hatch-k", 160, 7, 0.8],
      ["hatch-off", 45, 10, 0.55],
      ["hatch-inv", 45, 6, 0.7],
    ];
    hatches.forEach(([id, rot, size, sw]) => {
      const pat = svgEl("pattern", {
        id,
        width: size,
        height: size,
        patternUnits: "userSpaceOnUse",
        patternTransform: "rotate(" + rot + ")",
      });
      pat.appendChild(
        svgEl("line", {
          x1: "0",
          y1: "0",
          x2: "0",
          y2: String(size),
          stroke: "var(--ink)",
          "stroke-width": String(sw),
        })
      );
      defs.appendChild(pat);
    });

    const inv = svgEl("pattern", {
      id: "hatch-on-ink",
      width: "6",
      height: "6",
      patternUnits: "userSpaceOnUse",
      patternTransform: "rotate(45)",
    });
    inv.appendChild(
      svgEl("line", {
        x1: "0",
        y1: "0",
        x2: "0",
        y2: "6",
        stroke: "var(--paper)",
        "stroke-width": "0.75",
      })
    );
    defs.appendChild(inv);
    return defs;
  }

  function drawEnclosure(g, box) {
    if (!box) return;
    const { x, y, w, d } = box;
    const z = 0;
    const c = (dx, dy) => project(x + dx, y + dy, z);
    const pts = [c(0, 0), c(w, 0), c(w, d), c(0, d)];
    g.appendChild(
      svgEl("polygon", {
        points: poly(pts),
        class: "iso-enclosure",
      })
    );
  }

  function attachPoint(node) {
    return project(node.x + node.w / 2, node.y + node.d / 2, node.z + node.h);
  }

  function route(a, b, vias) {
    const pa = attachPoint(a);
    const pb = attachPoint(b);
    if (vias && vias.length) {
      return [pa].concat(vias.map((v) => project(v[0], v[1], v[2] || 0.4))).concat([pb]);
    }
    const midWorld = {
      x: b.x + b.w / 2,
      y: a.y + a.d / 2,
      z: Math.max(a.z + a.h, b.z + b.h) + 0.28,
    };
    const mid = project(midWorld.x, midWorld.y, midWorld.z);
    const sameLane = Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) < 0.35 ||
      Math.abs(a.y + a.d / 2 - (b.y + b.d / 2)) < 0.35;
    if (sameLane) return [pa, pb];
    return [pa, mid, pb];
  }

  function drawEdge(g, a, b, kind, state, vias) {
    const pts = route(a, b, vias);
    const d = pts
      .map((p, i) => (i === 0 ? "M" : "L") + p.x.toFixed(2) + " " + p.y.toFixed(2))
      .join(" ");
    const path = svgEl("path", {
      d,
      class: "iso-edge iso-edge-" + (kind || "data") + (state || ""),
    });
    g.appendChild(path);
    for (let i = 1; i < pts.length - 1; i++) {
      g.appendChild(
        svgEl("rect", {
          x: (pts[i].x - 3).toFixed(2),
          y: (pts[i].y - 3).toFixed(2),
          width: "6",
          height: "6",
          transform: "rotate(45 " + pts[i].x.toFixed(2) + " " + pts[i].y.toFixed(2) + ")",
          class: "iso-joint" + (state || ""),
        })
      );
    }
    return pts;
  }

  function drawBox(g, piece, state) {
    const c = boxCorners(piece);
    const hatch = piece.hatch || "a";
    const fill = "url(#hatch-" + (piece.off ? "off" : hatch) + ")";
    const cls =
      "iso-box" +
      (state.selected ? " is-selected" : "") +
      (state.hovered ? " is-hovered" : "") +
      (state.flow ? " is-flow" : "") +
      (piece.off ? " is-off" : "");

    const group = svgEl("g", {
      class: cls,
      "data-id": piece.parentId,
    });

    const face = (pts, faceCls, extraFill) => {
      const p = svgEl("polygon", {
        points: poly(pts),
        class: "iso-face " + faceCls,
        fill: extraFill || fill,
      });
      group.appendChild(p);
    };

    const leftFill = "url(#hatch-" + (piece.off ? "off" : "b") + ")";
    const rightFill = "url(#hatch-" + (piece.off ? "off" : "d") + ")";
    if (state.selected) {
      face(c.left, "face-left", "url(#hatch-on-ink)");
      face(c.right, "face-right", "url(#hatch-on-ink)");
      face(c.top, "face-top", "var(--ink)");
    } else {
      face(c.left, "face-left", leftFill);
      face(c.right, "face-right", rightFill);
      face(c.top, "face-top", fill);
    }

    if (!piece.isPlate && !piece.isSlab) {
      const letter = piece.letter || piece.id;
      const text = svgEl("text", {
        x: c.topCenter.x.toFixed(2),
        y: (c.topCenter.y + 5).toFixed(2),
        class: "iso-label" + (state.selected ? " is-selected" : ""),
      });
      text.textContent = letter;
      group.appendChild(text);
    }

    g.appendChild(group);
    return group;
  }

  function drawLabel(g, node, selected) {
    const pt = project(node.x + node.w / 2, node.y + node.d / 2, node.z + node.h + 0.06);
    const text = svgEl("text", {
      x: pt.x.toFixed(2),
      y: (pt.y + 5).toFixed(2),
      class: "iso-label" + (selected ? " is-selected" : ""),
    });
    text.textContent = node.letter || node.id;
    g.appendChild(text);
  }

  function sceneBounds(scene) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    scene.nodes.forEach((n) => {
      const corners = [
        project(n.x, n.y, n.z),
        project(n.x + n.w, n.y, n.z),
        project(n.x, n.y + n.d, n.z),
        project(n.x + n.w, n.y + n.d, n.z),
        project(n.x, n.y, n.z + n.h),
        project(n.x + n.w, n.y, n.z + n.h),
        project(n.x, n.y + n.d, n.z + n.h),
        project(n.x + n.w, n.y + n.d, n.z + n.h),
      ];
      corners.forEach((p) => {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      });
    });
    const pad = 80;
    return {
      minX: minX - pad,
      minY: minY - pad,
      maxX: maxX + pad,
      maxY: maxY + pad,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2,
    };
  }

  function tokenAlong(pts, t) {
    if (!pts || pts.length < 2) return null;
    const segs = [];
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x;
      const dy = pts[i + 1].y - pts[i].y;
      const len = Math.hypot(dx, dy);
      segs.push({ a: pts[i], b: pts[i + 1], len });
      total += len;
    }
    if (total === 0) return pts[0];
    let dist = t * total;
    for (const s of segs) {
      if (dist <= s.len) {
        const u = s.len === 0 ? 0 : dist / s.len;
        return { x: s.a.x + (s.b.x - s.a.x) * u, y: s.a.y + (s.b.y - s.a.y) * u };
      }
      dist -= s.len;
    }
    return pts[pts.length - 1];
  }

  global.TPIso = {
    project,
    expandShape,
    svgEl,
    ensureDefs,
    drawEnclosure,
    drawEdge,
    drawBox,
    attachPoint,
    route,
    sceneBounds,
    tokenAlong,
    boxCorners,
    drawLabel,
    TILE_W,
    TILE_H,
    TILE_Z,
  };
})(window);
