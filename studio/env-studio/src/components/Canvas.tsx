import { useCallback, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Connection,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeTypes,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEnvStore } from "../state/store";
import { useThemeStore } from "../state/theme";
import { AssetNode, parsePortHandleId, type AssetNodeData } from "./AssetNode";

const nodeTypes: NodeTypes = { asset: AssetNode };

export function Canvas() {
  const assets = useEnvStore((s) => s.assets);
  const connections = useEnvStore((s) => s.connections);
  const updateAssetPosition = useEnvStore((s) => s.updateAssetPosition);
  const addConnection = useEnvStore((s) => s.addConnection);
  const removeConnection = useEnvStore((s) => s.removeConnection);
  const selectAsset = useEnvStore((s) => s.selectAsset);
  const selectedAssetId = useEnvStore((s) => s.selectedAssetId);
  const theme = useThemeStore((s) => s.theme);

  const [rejectMessage, setRejectMessage] = useState<string | null>(null);

  const nodes: Node<AssetNodeData>[] = useMemo(
    () =>
      assets.map((asset) => ({
        id: asset.id,
        type: "asset",
        position: asset.position,
        data: { asset },
        selected: asset.id === selectedAssetId,
        // Only the node header starts a drag — a near-miss click on a port row (trying
        // to hit a handle) does nothing instead of dragging the whole node.
        dragHandle: ".asset-drag-handle",
      })),
    [assets, selectedAssetId]
  );

  const edges: Edge[] = useMemo(
    () =>
      connections.map((c) => ({
        id: c.id,
        source: c.from.assetId,
        sourceHandle: `output:${c.from.port.name}:${c.from.port.index}`,
        target: c.to.assetId,
        targetHandle: `input:${c.to.port.name}:${c.to.port.index}`,
        label: c.from.port.name,
      })),
    [connections]
  );

  const onNodesChange: OnNodesChange<Node<AssetNodeData>> = useCallback(
    (changes) => {
      // Node list is derived from the store (single source of truth), so we just
      // persist drag position changes back to the store instead of keeping local state.
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          updateAssetPosition(change.id, change.position);
        }
      }
    },
    [updateAssetPosition]
  );

  const isValidConnection = useCallback(
    (conn: Connection | Edge): boolean => {
      if (!conn.sourceHandle || !conn.targetHandle) return false;
      if (conn.source === conn.target) return false;
      const from = parsePortHandleId(conn.sourceHandle);
      const to = parsePortHandleId(conn.targetHandle);
      return from.direction === "output" && to.direction === "input" && from.name === to.name;
    },
    []
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.sourceHandle || !conn.targetHandle) return;
      const from = parsePortHandleId(conn.sourceHandle);
      const to = parsePortHandleId(conn.targetHandle);
      if (from.name !== to.name) {
        setRejectMessage(`Cannot connect "${from.name}" output to "${to.name}" input — ioport names must match.`);
        window.setTimeout(() => setRejectMessage(null), 3000);
        return;
      }
      addConnection(
        { assetId: conn.source, port: { name: from.name, index: from.index } },
        { assetId: conn.target, port: { name: to.name, index: to.index } }
      );
    },
    [addConnection]
  );

  const onEdgeClick = useCallback(
    (_: unknown, edge: Edge) => {
      if (window.confirm(`Remove connection ${edge.id}?`)) {
        removeConnection(edge.id);
      }
    },
    [removeConnection]
  );

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => selectAsset(node.id),
    [selectAsset]
  );

  const onPaneClick = useCallback(() => selectAsset(null), [selectAsset]);

  return (
    <div className="eh-canvasWrap">
      {rejectMessage && <div className="eh-toast">{rejectMessage}</div>}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onEdgeClick={onEdgeClick}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        // Handles are small (12px dots); this lets a drag that starts within 30px of one
        // still snap to it as a connection start/end, instead of grabbing the node or pane.
        connectionRadius={30}
        colorMode={theme}
        fitView
      >
        <Background />
        <Controls />
        <MiniMap
          style={{ background: "var(--panel)" }}
          maskColor={theme === "dark" ? "rgba(20,22,31,0.6)" : "rgba(246,247,251,0.6)"}
          nodeColor="var(--idle)"
        />
      </ReactFlow>
    </div>
  );
}
