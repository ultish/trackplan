# Vendored front-end libs (offline docs)

Used by `booking-assembler-design.html`. **No CDN at runtime.**

| File | Package | Version (approx) |
|------|---------|------------------|
| `cytoscape.min.js` | [cytoscape](https://js.cytoscape.org/) | 3.30.4 |
| `mermaid.min.js` | [mermaid](https://mermaid.js.org/) | 11.4.1 |

## Re-download (when online)

```bash
cd docs/vendor
curl -fsSL "https://cdn.jsdelivr.net/npm/cytoscape@3.30.4/dist/cytoscape.min.js" -o cytoscape.min.js
curl -fsSL "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js" -o mermaid.min.js
```

Open HTML via `file://` or a local static server; both work as long as `vendor/` sits next to the HTML under `docs/`.
