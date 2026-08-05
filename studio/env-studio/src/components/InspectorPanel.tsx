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
    <label className="eh-field" style={{ flex: 1 }}>
      {label}
      <select
        className="eh-select"
        value={current}
        onChange={(e) => {
          if (e.target.value === NONE) return onChange(null);
          const [name, indexStr] = e.target.value.split(":");
          onChange({ name, index: Number(indexStr) });
        }}
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
      <div className="eh-inspector">
        <div className="eh-panel" style={{ color: "var(--sub)" }}>
          Select an asset to inspect it.
        </div>
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
    <div className="eh-inspector">
      <div className="eh-panel">
        <input
          className="eh-nameInput"
          value={asset.name}
          onChange={(e) => renameAsset(asset.id, e.target.value)}
        />
        <div style={{ color: "var(--sub)", marginTop: 6 }}>{resourceType.name}</div>
        <div style={{ color: "var(--sub)", fontSize: 11, marginTop: 4 }}>{resourceType.description}</div>
        <div style={{ color: "var(--sub)", fontSize: 10.5, fontStyle: "italic", marginTop: 8 }}>
          {resourceType.inspectorRules.portShape}
        </div>
        <div style={{ color: "var(--sub)", fontSize: 10.5, fontStyle: "italic", marginTop: 4 }}>
          {resourceType.inspectorRules.taskingConfig}
        </div>
        <button className="eh-btn danger small" style={{ marginTop: 10 }} onClick={() => removeAsset(asset.id)}>
          Delete asset
        </button>
      </div>

      <div className="eh-panel">
        <h2>
          Fake Inspector
          <span className={`eh-badge ${inspect.valid ? "on" : "off"}`}>{inspect.valid ? "VALID" : "INVALID"}</span>
        </h2>
        {inspect.errors.length === 0 ? (
          <div style={{ color: "var(--sub)", fontSize: 11.5 }}>All tasks are mutually consistent.</div>
        ) : (
          <ul style={{ margin: 0, padding: "0 0 0 16px", fontSize: 11, color: "var(--sub)" }}>
            {inspect.errors.map((err, i) => (
              <li key={i} style={{ marginTop: i === 0 ? 0 : 4 }}>
                {err}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="eh-panel">
        <h2>
          Tasks
          <span className="eh-tag">{asset.tasks.length}</span>
        </h2>
        <div>
          {asset.tasks.map((task) => (
            <div key={task.id} className="eh-taskCard">
              <div style={{ display: "flex", gap: 6 }}>
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
                <label key={field.name} className="eh-field" style={{ marginTop: 6 }}>
                  {field.name}
                  <input
                    className="eh-input"
                    value={task.taskingConfiguration[field.name] ?? ""}
                    onChange={(e) =>
                      updateTask(asset.id, task.id, {
                        taskingConfiguration: { ...task.taskingConfiguration, [field.name]: e.target.value },
                      })
                    }
                  />
                </label>
              ))}
              <button className="eh-btn small" style={{ marginTop: 6 }} onClick={() => removeTask(asset.id, task.id)}>
                Remove task
              </button>
            </div>
          ))}
        </div>

        <div className="eh-taskAdd">
          <div className="eh-sectionLabel" style={{ marginBottom: 6 }}>
            Add task
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <PortSelect label="input" groups={inputGroups} value={draftInput} onChange={setDraftInput} />
            <PortSelect label="output" groups={outputGroups} value={draftOutput} onChange={setDraftOutput} />
          </div>
          {resourceType.taskingConfig.fields.map((field) => (
            <label key={field.name} className="eh-field" style={{ marginTop: 6 }}>
              {field.name}
              <input
                className="eh-input"
                value={draftConfig[field.name] ?? ""}
                onChange={(e) => setDraftConfig({ ...draftConfig, [field.name]: e.target.value })}
              />
            </label>
          ))}
          <button className="eh-btn primary" style={{ marginTop: 8 }} onClick={handleAddTask}>
            Add task
          </button>
        </div>
      </div>
    </div>
  );
}
