import { PREDEFINED_RESOURCE_TYPES } from "../domain/resourceTypes";
import { useEnvStore } from "../state/store";

export function Palette() {
  const assets = useEnvStore((s) => s.assets);
  const addAsset = useEnvStore((s) => s.addAsset);

  const handleAdd = (resourceTypeId: string) => {
    const col = assets.length % 4;
    const row = Math.floor(assets.length / 4);
    addAsset(resourceTypeId, { x: 80 + col * 280, y: 80 + row * 220 });
  };

  return (
    <div
      style={{
        width: 260,
        borderRight: "1px solid #334155",
        padding: 12,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Resource Types</div>
      {PREDEFINED_RESOURCE_TYPES.map((rt) => (
        <button
          key={rt.id}
          onClick={() => handleAdd(rt.id)}
          style={{
            textAlign: "left",
            padding: "8px 10px",
            border: "1px solid #334155",
            borderRadius: 6,
            background: "#1e293b",
            color: "#e2e8f0",
            cursor: "pointer",
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 12 }}>{rt.name}</div>
          <div style={{ fontSize: 10, opacity: 0.75, marginTop: 2 }}>{rt.description}</div>
          <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>
            fanRule: {rt.fanRule} · config: {rt.taskingConfig.sharing}
          </div>
          <div style={{ fontSize: 10, opacity: 0.55, marginTop: 4, fontStyle: "italic" }}>
            {rt.inspectorRules.portShape}
          </div>
          <div style={{ fontSize: 10, opacity: 0.55, marginTop: 2, fontStyle: "italic" }}>
            {rt.inspectorRules.taskingConfig}
          </div>
        </button>
      ))}
    </div>
  );
}
