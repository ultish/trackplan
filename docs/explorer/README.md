# Trackplan explorer

Interactive isometric map of the specified machine — services, data, and the resolve loop.

```bash
open docs/explorer/index.html
# or
python3 -m http.server --directory docs/explorer
```

Hover a box to read it. Click to pin. Click again (or **Enter**) to go inside Assembler, Coupler, World, Sticky, Catalog, Fabric, Kafka inbound, Plans, Bookings, or Inspector. **Esc** comes back out. **Space** traces one step of a resolve. **F** plays the flow.

Hash links: `#C` selects the Coupler, `#assembler` opens its insides, `?tab=built#C` opens the implementer tab.

Sourced from `docs/BUILD_SPEC.md` and `docs/SPEC.md`. The machine is specified, not running.
