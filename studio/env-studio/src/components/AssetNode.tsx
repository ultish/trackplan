import { Handle, Position, type NodeProps } from "@xyflow/react";
import { getResourceType } from "../domain/resourceTypes";
import { inspectAssetTasks } from "../domain/inspector";
import type { Asset } from "../domain/types";

const ROW_HEIGHT = 22;

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
    <div className={`eh-node${selected ? " selected" : ""}`}>
      <div className="nodeHeader asset-drag-handle">
        <div className="nodeTitle">{asset.name}</div>
        <div className="nodeSub">{resourceType.name}</div>
      </div>

      <div style={{ position: "relative", height: bodyHeight, minHeight: ROW_HEIGHT }}>
        {inputRows.map((port, i) => (
          <div key={`in-${port.name}-${port.index}`} className="portRow" style={{ top: i * ROW_HEIGHT, height: ROW_HEIGHT }}>
            <Handle
              type="target"
              position={Position.Left}
              id={portHandleId("input", port.name, port.index)}
              style={{ background: "var(--accent)", width: 12, height: 12, border: "2px solid var(--panel)" }}
            />
            <span className="portLabel" style={{ marginLeft: 10 }}>
              {port.name}[{port.index}]
            </span>
          </div>
        ))}

        {outputRows.map((port, i) => (
          <div
            key={`out-${port.name}-${port.index}`}
            className="portRow"
            style={{ top: i * ROW_HEIGHT, height: ROW_HEIGHT, justifyContent: "flex-end" }}
          >
            <span className="portLabel" style={{ marginRight: 10 }}>
              {port.name}[{port.index}]
            </span>
            <Handle
              type="source"
              position={Position.Right}
              id={portHandleId("output", port.name, port.index)}
              style={{ background: "var(--current)", width: 12, height: 12, border: "2px solid var(--panel)" }}
            />
          </div>
        ))}
      </div>

      <div className={`nodeFooter ${inspect.valid ? "valid" : "invalid"}`}>
        {asset.tasks.length} task{asset.tasks.length === 1 ? "" : "s"} · {inspect.valid ? "valid" : `${inspect.errors.length} error(s)`}
      </div>
    </div>
  );
}
