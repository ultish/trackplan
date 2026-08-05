import { Handle, Position, type NodeProps } from "@xyflow/react";
import { getResourceType } from "../domain/resourceTypes";
import { inspectAssetTasks } from "../domain/inspector";
import type { Asset } from "../domain/types";

const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 40;

export function portHandleId(direction: "input" | "output", name: string, index: number) {
  return `${direction}:${name}:${index}`;
}

export function parsePortHandleId(handleId: string) {
  const [direction, name, indexStr] = handleId.split(":");
  return { direction: direction as "input" | "output", name, index: Number(indexStr) };
}

export type AssetNodeData = { asset: Asset };

export function AssetNode({ data, selected }: NodeProps & { data: AssetNodeData }) {
  const { asset } = data;
  const resourceType = getResourceType(asset.resourceTypeId);
  if (!resourceType) return null;

  const inputGroups = resourceType.ioPorts.filter((p) => p.direction === "input");
  const outputGroups = resourceType.ioPorts.filter((p) => p.direction === "output");
  const inputRows = inputGroups.flatMap((g) =>
    Array.from({ length: g.count }, (_, i) => ({ name: g.name, index: i }))
  );
  const outputRows = outputGroups.flatMap((g) =>
    Array.from({ length: g.count }, (_, i) => ({ name: g.name, index: i }))
  );
  const rowCount = Math.max(inputRows.length, outputRows.length, 1);
  const bodyHeight = rowCount * ROW_HEIGHT;

  const inspect = inspectAssetTasks(resourceType, asset.tasks);

  return (
    <div
      style={{
        width: 220,
        border: `2px solid ${selected ? "#2563eb" : "#334155"}`,
        borderRadius: 8,
        background: "#0f172a",
        color: "#e2e8f0",
        fontSize: 12,
        boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
      }}
    >
      <div
        className="asset-drag-handle"
        style={{
          height: HEADER_HEIGHT,
          padding: "6px 10px",
          borderBottom: "1px solid #334155",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          cursor: "grab",
        }}
      >
        <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {asset.name}
        </div>
        <div style={{ opacity: 0.7, fontSize: 10 }}>{resourceType.name}</div>
      </div>

      <div style={{ position: "relative", height: bodyHeight, minHeight: ROW_HEIGHT }}>
        {inputRows.map((port, i) => (
          <div key={`in-${port.name}-${port.index}`} style={{ position: "absolute", top: i * ROW_HEIGHT, left: 0, right: 0, height: ROW_HEIGHT, display: "flex", alignItems: "center" }}>
            <Handle
              type="target"
              position={Position.Left}
              id={portHandleId("input", port.name, port.index)}
              style={{ background: "#38bdf8", width: 12, height: 12 }}
            />
            <span style={{ marginLeft: 10, fontSize: 10, opacity: 0.85 }}>
              {port.name}[{port.index}]
            </span>
          </div>
        ))}

        {outputRows.map((port, i) => (
          <div key={`out-${port.name}-${port.index}`} style={{ position: "absolute", top: i * ROW_HEIGHT, left: 0, right: 0, height: ROW_HEIGHT, display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
            <span style={{ marginRight: 10, fontSize: 10, opacity: 0.85 }}>
              {port.name}[{port.index}]
            </span>
            <Handle
              type="source"
              position={Position.Right}
              id={portHandleId("output", port.name, port.index)}
              style={{ background: "#fb923c", width: 12, height: 12 }}
            />
          </div>
        ))}
      </div>

      <div
        style={{
          padding: "4px 10px",
          borderTop: "1px solid #334155",
          fontSize: 10,
          color: inspect.valid ? "#4ade80" : "#f87171",
        }}
      >
        {asset.tasks.length} task{asset.tasks.length === 1 ? "" : "s"} · {inspect.valid ? "valid" : `${inspect.errors.length} error(s)`}
      </div>
    </div>
  );
}
