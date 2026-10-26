(function () {
  const $ = (sel) => document.querySelector(sel);

  const state = {
    sceneId: "root",
    selected: null,
    hovered: null,
    tab: "does",
    cam: { x: 0, y: 0, k: 1 },
    panning: false,
    panFrom: null,
    flowOn: false,
    flowStep: -1,
    flowTimer: null,
    tokenT: 0,
    tokenPts: null,
    reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  };

  const svg = $("#stage-svg");
  const world = $("#iso-world");
  const stage = $("#stage");
  const side = $("#side");
  const essay = $("#essay-body");
  const crumb = $("#crumb");
  const flowBanner = $("#flow-banner");

  function machineName() {
    return (TP.META && TP.META.name) || "Machine";
  }

  const PAPER_PRESETS = {
    light: "#efe6c4",
    khaki: "#c8b56a",
    bone: "#f4f0e2",
    linen: "#e7e0d2",
  };
  const PAPER_KEY = "machine-map-paper";

  function hexToRgb(hex) {
    const h = hex.replace("#", "");
    const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function shadeHex(hex, delta) {
    const { r, g, b } = hexToRgb(hex);
    const t = (c) => Math.max(0, Math.min(255, c + delta));
    return (
      "#" +
      [t(r), t(g), t(b)]
        .map((c) => c.toString(16).padStart(2, "0"))
        .join("")
    );
  }

  function applyPaper(value) {
    const root = document.documentElement;
    const custom = $("#paper-custom");
    if (PAPER_PRESETS[value]) {
      root.removeAttribute("style");
      root.setAttribute("data-paper", value);
      if (custom) custom.value = PAPER_PRESETS[value];
    } else if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {
      root.setAttribute("data-paper", "custom");
      root.style.setProperty("--paper", value);
      root.style.setProperty("--paper-2", shadeHex(value, -12));
      root.style.setProperty("--paper-3", shadeHex(value, -24));
      if (custom) {
        custom.value =
          value.length === 4
            ? "#" + value.slice(1).split("").map((c) => c + c).join("")
            : value;
      }
    } else {
      root.setAttribute("data-paper", "light");
      value = "light";
    }
    try {
      localStorage.setItem(PAPER_KEY, value);
    } catch (e) { /* ignore */ }
    document.querySelectorAll("#paper-tray [data-paper]").forEach((b) => {
      b.classList.toggle("is-on", b.dataset.paper === value);
    });
  }

  function initPaper() {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get("paper");
    let stored = null;
    try {
      stored = localStorage.getItem(PAPER_KEY);
    } catch (e) { /* ignore */ }
    applyPaper(fromUrl || stored || "light");
    const tray = $("#paper-tray");
    if (tray) {
      tray.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-paper]");
        if (btn) applyPaper(btn.dataset.paper);
      });
    }
    const custom = $("#paper-custom");
    if (custom) {
      custom.addEventListener("input", () => applyPaper(custom.value));
    }
  }

  TPIso.ensureDefs(svg);

  function scene() {
    return TP.SCENES[state.sceneId];
  }

  function currentCopyTarget() {
    const sc = scene();
    const id = state.hovered || state.selected;
    if (!id) return { kind: "root", node: null };
    return { kind: "node", node: TP.nodeById(sc, id) };
  }

  function renderMarkup(blocks) {
    if (!blocks) return "";
    return blocks
      .map((b) => {
        if (b.p) {
          const html = b.p
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
            .replace(/`([^`]+)`/g, "<code>$1</code>");
          return "<p>" + html + "</p>";
        }
        if (b.list) {
          return (
            "<ul>" +
            b.list
              .map((item) => {
                const html = String(item)
                  .replace(/&/g, "&amp;")
                  .replace(/</g, "&lt;")
                  .replace(/`([^`]+)`/g, "<code>$1</code>");
                return "<li>" + html + "</li>";
              })
              .join("") +
            "</ul>"
          );
        }
        if (b.code) {
          return "<pre>" + b.code.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</pre>";
        }
        return "";
      })
      .join("");
  }

  function renderEssay() {
    const sc = scene();
    const target = currentCopyTarget();
    const tab = state.tab;
    let title, lead, sections, kicker, inside;

    if (target.kind === "root" || !target.node) {
      const host = sc.id !== "root" && sc.focus ? TP.nodeById(TP.SCENES.root, sc.focus) : null;
      if (host) {
        const copy = host[tab];
        title = copy.title;
        lead = copy.lead;
        sections = copy.sections;
        kicker = "Inside · " + host.name;
        inside = null;
      } else {
        const copy = TP.ROOT_COPY[tab];
        title = copy.title;
        lead = copy.lead;
        sections = copy.sections;
        kicker = machineName();
        inside = null;
      }
    } else {
      const copy = target.node[tab];
      title = copy.title;
      lead = copy.lead;
      sections = copy.sections;
      kicker = (sc.id === "root" ? machineName() : sc.title) + " · " + target.node.id;
      inside = target.node.inside;
    }

    let html = '<p class="essay-kicker">' + kicker + "</p>";
    html += "<h1>" + title + "</h1>";
    if (lead) html += '<p class="essay-lead">' + lead + "</p>";
    sections.forEach((sec) => {
      html += "<h2>" + sec.h + "</h2>";
      html += renderMarkup(sec.blocks);
    });
    if (inside && tab === "does") {
      html +=
        '<button class="go-inside" type="button" data-go="' +
        inside +
        '">→ goes inside</button>';
    }
    essay.innerHTML = html;
  }

  function renderSidebar() {
    const sc = scene();
    const groups =
      sc.id === "root"
        ? TP.GROUPS
        : [{ id: "inner", title: sc.title }];
    const byGroup = {};
    sc.nodes.forEach((n) => {
      const g = sc.id === "root" ? n.group : "inner";
      (byGroup[g] || (byGroup[g] = [])).push(n);
    });

    let html = '<div class="side-head">The system</div>';
    groups.forEach((g) => {
      const items = byGroup[g.id];
      if (!items || !items.length) return;
      html += '<div class="side-group">';
      html += '<div class="side-group-title">' + g.title + "</div>";
      items.forEach((n) => {
        const cls = [
          "side-item",
          n.off ? "is-off" : "",
          n.inside ? "has-inside" : "",
          state.selected === n.id ? "is-selected" : "",
          isFlowNode(n.id) ? "is-flow" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const count = n.steps ? '<span class="n">' + n.steps + "</span>" : '<span class="n"></span>';
        html +=
          '<button class="' +
          cls +
          '" type="button" data-id="' +
          n.id +
          '">' +
          '<span class="letter">' +
          (n.letter || n.id) +
          "</span>" +
          '<span class="label">' +
          n.name +
          "</span>" +
          count +
          "</button>";
      });
      html += "</div>";
    });
    side.innerHTML = html;
  }

  function isFlowNode(id) {
    if (state.flowStep < 0 || state.sceneId !== "root") return false;
    const step = TP.FLOW[state.flowStep];
    return step && step.nodes.indexOf(id) !== -1;
  }

  function isFlowEdge(e) {
    if (state.flowStep < 0 || state.sceneId !== "root") return false;
    const step = TP.FLOW[state.flowStep];
    return step && step.edges && step.edges.indexOf(TP.edgeKey(e)) !== -1;
  }

  function renderCrumb() {
    const sc = scene();
    if (sc.id === "root") {
      crumb.innerHTML = "";
      return;
    }
    crumb.innerHTML =
      '<button type="button" data-back="1">← come back out</button>' +
      "<span>" +
      sc.title +
      "</span>";
  }

  function applyCamera() {
    world.setAttribute(
      "transform",
      "translate(" +
        state.cam.x.toFixed(2) +
        " " +
        state.cam.y.toFixed(2) +
        ") scale(" +
        state.cam.k.toFixed(4) +
        ")"
    );
  }

  function fitScene() {
    const sc = scene();
    const b = TPIso.sceneBounds(sc);
    const rect = stage.getBoundingClientRect();
    const pad = 16;
    const kx = (rect.width - pad * 2) / b.width;
    const ky = (rect.height - pad * 2) / b.height;
    const k = Math.max(0.4, Math.min(1.7, Math.min(kx, ky) * 1.04));
    state.cam.k = k;
    state.cam.x = rect.width / 2 - ((b.minX + b.maxX) / 2) * k;
    state.cam.y = rect.height / 2 - ((b.minY + b.maxY) / 2) * k;
    applyCamera();
  }

  function renderWorld() {
    const sc = scene();
    world.innerHTML = "";
    TPIso.ensureDefs(svg);
    const layerEdges = TPIso.svgEl("g", { class: "iso-edges" });
    const layerBoxes = TPIso.svgEl("g", { class: "iso-boxes" });
    const layerToken = TPIso.svgEl("g", { class: "iso-tokens" });
    world.appendChild(layerEdges);
    world.appendChild(layerBoxes);
    world.appendChild(layerToken);

    TPIso.drawEnclosure(layerEdges, sc.enclosure);

    const byId = {};
    sc.nodes.forEach((n) => {
      byId[n.id] = n;
    });

    const paths = [];
    sc.edges.forEach((e) => {
      const a = byId[e.from];
      const b = byId[e.to];
      if (!a || !b) return;
      const flow = isFlowEdge(e);
      const pts = TPIso.drawEdge(
        layerEdges,
        a,
        b,
        e.kind,
        flow ? " is-flow" : "",
        e.via
      );
      if (flow) paths.push(pts);
    });

    const pieces = [];
    sc.nodes.forEach((n) => {
      TPIso.expandShape(n).forEach((p) => {
        const c = TPIso.boxCorners(p);
        pieces.push({ piece: p, near: c.near, node: n });
      });
    });
    pieces.sort((a, b) => a.near - b.near);
    pieces.forEach(({ piece, node }) => {
      TPIso.drawBox(layerBoxes, piece, {
        selected: state.selected === node.id,
        hovered: state.hovered === node.id && state.selected !== node.id,
        flow: isFlowNode(node.id),
      });
    });
    sc.nodes.forEach((n) => {
      if (n.shape === "stack" || n.shape === "slabs") {
        TPIso.drawLabel(layerBoxes, n, state.selected === n.id);
      }
    });

    if (paths.length && state.flowStep >= 0) {
      const pts = paths[0];
      state.tokenPts = pts;
      const pos = TPIso.tokenAlong(pts, state.tokenT);
      if (pos) {
        const tok = TPIso.svgEl("rect", {
          x: (pos.x - 4).toFixed(2),
          y: (pos.y - 4).toFixed(2),
          width: "8",
          height: "8",
          transform: "rotate(45 " + pos.x.toFixed(2) + " " + pos.y.toFixed(2) + ")",
          class: "iso-token",
        });
        layerToken.appendChild(tok);
      }
    } else {
      state.tokenPts = null;
    }

    renderFlowBanner();
  }

  function renderFlowBanner() {
    if (state.flowStep < 0 || state.sceneId !== "root") {
      flowBanner.hidden = true;
      return;
    }
    const step = TP.FLOW[state.flowStep];
    flowBanner.hidden = false;
    flowBanner.innerHTML =
      '<div class="k">Step ' +
      (state.flowStep + 1) +
      " / " +
      TP.FLOW.length +
      "</div>" +
      '<div class="t">' +
      step.title +
      "</div>";
  }

  function render() {
    renderSidebar();
    renderWorld();
    renderEssay();
    renderCrumb();
    $("#btn-resume").classList.toggle("is-on", state.flowOn);
    document.querySelectorAll(".tabs button").forEach((b) => {
      b.classList.toggle("is-on", b.dataset.tab === state.tab);
    });
  }

  function writeHash() {
    const sc = scene();
    let hash = "";
    if (sc.id !== "root") hash = sc.id;
    if (state.selected) hash += (hash ? "/" : "") + state.selected;
    const next = hash ? "#" + hash : "#";
    if (location.hash !== next && location.hash !== (hash ? "#" + hash : "")) {
      history.replaceState(null, "", hash ? "#" + hash : location.pathname + location.search);
    }
  }

  function readHash() {
    const params = new URLSearchParams(location.search);
    if (params.get("tab") === "built" || params.get("tab") === "does") {
      state.tab = params.get("tab");
    }
    const raw = (location.hash || "").replace(/^#/, "");
    if (!raw) return;
    const parts = raw.split("/").filter(Boolean);
    if (parts[0] && TP.SCENES[parts[0]]) {
      state.sceneId = parts[0];
      state.selected = parts[1] || null;
      return;
    }
    if (parts[0] && TP.nodeById(TP.SCENES.root, parts[0])) {
      state.sceneId = "root";
      state.selected = parts[0];
    }
  }

  function select(id) {
    state.selected = id;
    if (id) state.hovered = null;
    writeHash();
    render();
  }

  function enter(sceneId) {
    if (!TP.SCENES[sceneId]) return;
    stopFlow(false);
    state.sceneId = sceneId;
    state.selected = null;
    state.hovered = null;
    writeHash();
    render();
    fitScene();
  }

  function leave() {
    const sc = scene();
    const parent = sc.parent || "root";
    const focus = sc.focus;
    state.sceneId = parent;
    state.selected = focus || null;
    state.hovered = null;
    writeHash();
    render();
    fitScene();
  }

  function hover(id) {
    if (state.hovered === id) return;
    state.hovered = id;
    renderWorld();
    renderEssay();
  }

  function stepFlow() {
    if (state.sceneId !== "root") enter("root");
    state.flowStep = (state.flowStep + 1) % TP.FLOW.length;
    state.tokenT = 0;
    const step = TP.FLOW[state.flowStep];
    state.selected = step.nodes[0];
    render();
    if (!state.reduced) animateToken();
  }

  function animateToken() {
    if (state.reduced) {
      state.tokenT = 1;
      renderWorld();
      return;
    }
    const start = performance.now();
    const dur = 700;
    function tick(now) {
      const t = Math.min(1, (now - start) / dur);
      state.tokenT = t;
      renderWorld();
      if (t < 1 && (state.flowOn || state.flowStep >= 0)) {
        requestAnimationFrame(tick);
      }
    }
    requestAnimationFrame(tick);
  }

  function startFlow() {
    if (state.sceneId !== "root") enter("root");
    state.flowOn = true;
    if (state.flowStep < 0) stepFlow();
    else render();
    if (state.flowTimer) clearInterval(state.flowTimer);
    if (state.reduced) return;
    state.flowTimer = setInterval(stepFlow, 1600);
  }

  function stopFlow(reset) {
    state.flowOn = false;
    if (state.flowTimer) {
      clearInterval(state.flowTimer);
      state.flowTimer = null;
    }
    if (reset) {
      state.flowStep = -1;
      state.tokenT = 0;
    }
    $("#btn-resume").classList.remove("is-on");
  }

  function neighborsOf(id) {
    const sc = scene();
    const set = new Set();
    sc.edges.forEach((e) => {
      if (e.from === id) set.add(e.to);
      if (e.to === id) set.add(e.from);
    });
    return Array.from(set);
  }

  /* ---------- events ---------- */
  side.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-id]");
    if (!btn) return;
    const id = btn.dataset.id;
    const node = TP.nodeById(scene(), id);
    if (state.selected === id && node && node.inside) {
      enter(node.inside);
      return;
    }
    select(id);
  });

  essay.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-go]");
    if (btn) enter(btn.dataset.go);
  });

  crumb.addEventListener("click", (e) => {
    if (e.target.closest("[data-back]")) leave();
  });

  document.querySelectorAll(".tabs button").forEach((b) => {
    b.addEventListener("click", () => {
      state.tab = b.dataset.tab;
      renderEssay();
      document.querySelectorAll(".tabs button").forEach((x) => {
        x.classList.toggle("is-on", x.dataset.tab === state.tab);
      });
    });
  });

  $("#btn-resume").addEventListener("click", () => {
    if (state.flowOn) {
      stopFlow(false);
      render();
    } else {
      startFlow();
    }
  });
  $("#btn-step").addEventListener("click", () => {
    stopFlow(false);
    stepFlow();
  });
  $("#btn-reset").addEventListener("click", () => {
    stopFlow(true);
    state.sceneId = "root";
    state.selected = null;
    state.hovered = null;
    render();
    fitScene();
  });
  $("#btn-zoom-in").addEventListener("click", () => {
    zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1.18);
  });
  $("#btn-zoom-out").addEventListener("click", () => {
    zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1 / 1.18);
  });

  function zoomAt(cx, cy, factor) {
    const k = Math.max(0.28, Math.min(2.6, state.cam.k * factor));
    const wx = (cx - state.cam.x) / state.cam.k;
    const wy = (cy - state.cam.y) / state.cam.k;
    state.cam.k = k;
    state.cam.x = cx - wx * k;
    state.cam.y = cy - wy * k;
    applyCamera();
  }

  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
    },
    { passive: false }
  );

  stage.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".zoom") || e.target.closest(".crumb") || e.target.closest(".paper-tray")) return;
    if (e.button !== 0) return;
    state.panning = true;
    state.panFrom = { x: e.clientX, y: e.clientY, cx: state.cam.x, cy: state.cam.y };
    stage.classList.add("is-panning");
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    if (!state.panning) return;
    state.cam.x = state.panFrom.cx + (e.clientX - state.panFrom.x);
    state.cam.y = state.panFrom.cy + (e.clientY - state.panFrom.y);
    applyCamera();
  });
  stage.addEventListener("pointerup", () => {
    state.panning = false;
    stage.classList.remove("is-panning");
  });
  stage.addEventListener("pointercancel", () => {
    state.panning = false;
    stage.classList.remove("is-panning");
  });

  svg.addEventListener("pointermove", (e) => {
    if (state.panning) return;
    const g = e.target.closest("[data-id]");
    hover(g ? g.getAttribute("data-id") : null);
  });
  svg.addEventListener("pointerleave", () => {
    if (state.hovered) {
      state.hovered = null;
      renderWorld();
      renderEssay();
    }
  });
  svg.addEventListener("click", (e) => {
    const g = e.target.closest("[data-id]");
    if (!g) {
      select(null);
      return;
    }
    const id = g.getAttribute("data-id");
    const node = TP.nodeById(scene(), id);
    if (state.selected === id && node && node.inside) {
      enter(node.inside);
      return;
    }
    select(id);
  });
  svg.addEventListener("dblclick", (e) => {
    const g = e.target.closest("[data-id]");
    if (!g) return;
    const node = TP.nodeById(scene(), g.getAttribute("data-id"));
    if (node && node.inside) enter(node.inside);
  });

  window.addEventListener("keydown", (e) => {
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;
    if (e.key === "Escape" || e.key === "Backspace") {
      if (state.sceneId !== "root") {
        e.preventDefault();
        leave();
      }
      return;
    }
    if (e.key === "Enter") {
      const id = state.selected;
      const node = id && TP.nodeById(scene(), id);
      if (node && node.inside) enter(node.inside);
      return;
    }
    if (e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      stopFlow(false);
      stepFlow();
      return;
    }
    if (e.key === "f" || e.key === "F") {
      if (state.flowOn) {
        stopFlow(false);
        render();
      } else startFlow();
      return;
    }
    if (e.key === "r" || e.key === "R") {
      $("#btn-reset").click();
      return;
    }
    if (e.key === "1") {
      state.tab = "does";
      renderEssay();
      document.querySelectorAll(".tabs button").forEach((x) => {
        x.classList.toggle("is-on", x.dataset.tab === state.tab);
      });
      return;
    }
    if (e.key === "2") {
      state.tab = "built";
      renderEssay();
      document.querySelectorAll(".tabs button").forEach((x) => {
        x.classList.toggle("is-on", x.dataset.tab === state.tab);
      });
      return;
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].indexOf(e.key) !== -1) {
      e.preventDefault();
      const sc = scene();
      const cur = state.selected || sc.nodes[0].id;
      const nbs = neighborsOf(cur);
      const pool = nbs.length ? nbs : sc.nodes.map((n) => n.id);
      const nodes = pool.map((id) => TP.nodeById(sc, id)).filter(Boolean);
      const me = TP.nodeById(sc, cur);
      let best = null;
      let bestScore = Infinity;
      nodes.forEach((n) => {
        if (n.id === cur) return;
        const dx = n.x - me.x;
        const dy = n.y - me.y;
        let score = Infinity;
        if (e.key === "ArrowRight") score = dx > 0.05 ? dx + Math.abs(dy) * 0.4 : Infinity;
        if (e.key === "ArrowLeft") score = dx < -0.05 ? -dx + Math.abs(dy) * 0.4 : Infinity;
        if (e.key === "ArrowDown") score = dy > 0.05 ? dy + Math.abs(dx) * 0.4 : Infinity;
        if (e.key === "ArrowUp") score = dy < -0.05 ? -dy + Math.abs(dx) * 0.4 : Infinity;
        if (score < bestScore) {
          bestScore = score;
          best = n.id;
        }
      });
      if (best) select(best);
    }
  });

  window.addEventListener("resize", () => {
    applyCamera();
  });

  function renderStats() {
    const el = $("#stats");
    el.innerHTML = TP.STATS.map(
      (s) =>
        '<div class="stat"><div class="k">' +
        s.k +
        '</div><div class="v">' +
        s.v +
        "</div></div>"
    ).join("");
  }

  initPaper();
  renderStats();
  readHash();
  render();
  requestAnimationFrame(() => {
    fitScene();
    renderWorld();
  });
  window.addEventListener("hashchange", () => {
    readHash();
    render();
    fitScene();
  });
})();
