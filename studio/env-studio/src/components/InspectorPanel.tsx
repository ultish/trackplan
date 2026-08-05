import { useState } from "react";
import { useEnvStore } from "../state/store";
import { getResourceType } from "../domain/resourceTypes";
import { inspectAssetTasks } from "../domain/inspector";
import type { PortRef } from "../domain/types";

const NONE = "__none__";

function PortSelect({
  label,
  groups,
  value,
  onChange,
}: {
  label: string;
  groups: { name: string; count: number }[];
  value: PortRef | null;
  onChange: (v: PortRef | null) => void;
}) {
  if (groups.length === 0) return null;
  const current = value ? `${value.name}:${value.index}` : NONE;
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11 }}>
      {label}
      <select
        value={current}
        onChange={(e) => {
          if (e.target.value === NONE) return onChange(null);
          const [name, indexStr] = e.target.value.split(":");
          onChange({ name, index: Number(indexStr) });
        }}
        style={{ background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 4, padding: 4 }}
      >
        <option value={NONE}>(none)</option>
        {groups.flatMap((g) =>
          Array.from({ length: g.count }, (_, i) => (
            <option key={`${g.name}:${i}`} value={`${g.name}:${i}`}>
              {g.name}[{i}]
            </option>
          ))
        )}
      </select>
    </label>
  );
}

export function InspectorPanel() {
  const selectedAssetId = useEnvStore((s) => s.selectedAssetId);
  const assets = useEnvStore((s) => s.assets);
  const renameAsset = useEnvStore((s) => s.renameAsset);
  const removeAsset = useEnvStore((s) => s.removeAsset);
  const addTask = useEnvStore((s) => s.addTask);
  const updateTask = useEnvStore((s) => s.updateTask);
  const removeTask = useEnvStore((s) => s.removeTask);

  const asset = assets.find((a) => a.id === selectedAssetId) ?? null;

  const [draftInput, setDraftInput] = useState<PortRef | null>(null);
  const [draftOutput, setDraftOutput] = useState<PortRef | null>(null);
  const [draftConfig, setDraftConfig] = useState<Record<string, string>>({});

  if (!asset) {
    return (
      <div style={{ width: 320, borderLeft: "1px solid #334155", padding: 12, fontSize: 12, opacity: 0.6 }}>
        Select an asset to inspect it.
      </div>
    );
  }

  const resourceType = getResourceType(asset.resourceTypeId);
  if (!resourceType) return null;

  const inputGroups = resourceType.ioPorts.filter((p) => p.direction === "input");
  const outputGroups = resourceType.ioPorts.filter((p) => p.direction === "output");
  const inspect = inspectAssetTasks(resourceType, asset.tasks);

  const handleAddTask = () => {
    const config: Record<string, string> = {};
    for (const field of resourceType.taskingConfig.fields) {
      config[field.name] = draftConfig[field.name] ?? "";
    }
    addTask(asset.id, { input: draftInput, output: draftOutput, taskingConfiguration: config });
    setDraftInput(null);
    setDraftOutput(null);
    setDraftConfig({});
  };

  return (
    <div style={{ width: 320, borderLeft: "1px solid #334155", padding: 12, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, fontSize: 12 }}>
      <div>
        <input
          value={asset.name}
          onChange={(e) => renameAsset(asset.id, e.target.value)}
          style={{ width: "100%", background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 4, padding: 6, fontWeight: 600 }}
        />
        <div style={{ opacity: 0.7, marginTop: 4 }}>{resourceType.name}</div>
        <div style={{ opacity: 0.6, fontSize: 10, marginTop: 2 }}>{resourceType.description}</div>
        <div style={{ opacity: 0.55, fontSize: 10, marginTop: 6, fontStyle: "italic" }}>
          {resourceType.inspectorRules.portShape}
        </div>
        <div style={{ opacity: 0.55, fontSize: 10, marginTop: 4, fontStyle: "italic" }}>
          {resourceType.inspectorRules.taskingConfig}
        </div>
        <button
          onClick={() => removeAsset(asset.id)}
          style={{ marginTop: 8, background: "#7f1d1d", color: "white", border: "none", borderRadius: 4, padding: "4px 8px", cursor: "pointer" }}
        >
          Delete asset
        </button>
      </div>

      <div
        style={{
          padding: 8,
          borderRadius: 6,
          background: inspect.valid ? "#052e16" : "#450a0a",
          border: `1px solid ${inspect.valid ? "#166534" : "#991b1b"}`,
        }}
      >
        <div style={{ fontWeight: 600, color: inspect.valid ? "#4ade80" : "#f87171" }}>
          Fake Inspector: {inspect.valid ? "VALID" : "INVALID"}
        </div>
        {inspect.errors.map((err, i) => (
          <div key={i} style={{ fontSize: 10, marginTop: 4, opacity: 0.9 }}>
            {err}
          </div>
        ))}
      </div>

      <div>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Tasks ({asset.tasks.length})</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {asset.tasks.map((task) => (
            <div key={task.id} style={{ border: "1px solid #334155", borderRadius: 6, padding: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                <PortSelect
                  label="input"
                  groups={inputGroups}
                  value={task.input}
                  onChange={(v) => updateTask(asset.id, task.id, { input: v })}
                />
                <PortSelect
                  label="output"
                  groups={outputGroups}
                  value={task.output}
                  onChange={(v) => updateTask(asset.id, task.id, { output: v })}
                />
              </div>
              {resourceType.taskingConfig.fields.map((field) => (
                <label key={field.name} style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 6 }}>
                  {field.name}
                  <input
                    value={task.taskingConfiguration[field.name] ?? ""}
                    onChange={(e) =>
                      updateTask(asset.id, task.id, {
                        taskingConfiguration: { ...task.taskingConfiguration, [field.name]: e.target.value },
                      })
                    }
                    style={{ background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 4, padding: 4 }}
                  />
                </label>
              ))}
              <button
                onClick={() => removeTask(asset.id, task.id)}
                style={{ marginTop: 6, background: "#334155", color: "#e2e8f0", border: "none", borderRadius: 4, padding: "2px 6px", cursor: "pointer", fontSize: 10 }}
              >
                Remove task
              </button>
            </div>
          ))}
        </div>
      </div>

      <div style={{ border: "1px dashed #475569", borderRadius: 6, padding: 8 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Add task</div>
        <div style={{ display: "flex", gap: 6 }}>
          <PortSelect label="input" groups={inputGroups} value={draftInput} onChange={setDraftInput} />
          <PortSelect label="output" groups={outputGroups} value={draftOutput} onChange={setDraftOutput} />
        </div>
        {resourceType.taskingConfig.fields.map((field) => (
          <label key={field.name} style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 6 }}>
            {field.name}
            <input
              value={draftConfig[field.name] ?? ""}
              onChange={(e) => setDraftConfig({ ...draftConfig, [field.name]: e.target.value })}
              style={{ background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 4, padding: 4 }}
            />
          </label>
        ))}
        <button
          onClick={handleAddTask}
          style={{ marginTop: 8, background: "#2563eb", color: "white", border: "none", borderRadius: 4, padding: "4px 10px", cursor: "pointer" }}
        >
          Add task
        </button>
      </div>
    </div>
  );
}
