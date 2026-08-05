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
    <div className="eh-sidebar">
      <div className="eh-sectionLabel">Resource Types</div>
      {PREDEFINED_RESOURCE_TYPES.map((rt) => (
        <button key={rt.id} className="eh-resourceCard" onClick={() => handleAdd(rt.id)}>
          <div className="title">{rt.name}</div>
          <div className="desc">{rt.description}</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
            <span className="eh-chip">fanRule: {rt.fanRule}</span>
            <span className="eh-chip">config: {rt.taskingConfig.sharing}</span>
          </div>
          <div className="rules">{rt.inspectorRules.portShape}</div>
          <div className="rules">{rt.inspectorRules.taskingConfig}</div>
        </button>
      ))}
    </div>
  );
}
