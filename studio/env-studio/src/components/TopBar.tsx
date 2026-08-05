import { useRef, type ChangeEvent, type CSSProperties } from "react";
import { useEnvStore } from "../state/store";
import { buildExport, downloadExport, parseImport } from "../domain/export";

export function TopBar() {
  const assets = useEnvStore((s) => s.assets);
  const connections = useEnvStore((s) => s.connections);
  const loadEnv = useEnvStore((s) => s.loadEnv);
  const clearEnv = useEnvStore((s) => s.clearEnv);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = () => {
    const env = buildExport(assets, connections);
    downloadExport(env, "env.json");
  };

  const handleImportClick = () => fileInputRef.current?.click();

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const { assets: importedAssets, connections: importedConnections } = parseImport(text);
      loadEnv(importedAssets, importedConnections);
    } catch (err) {
      window.alert(`Failed to import: ${(err as Error).message}`);
    } finally {
      e.target.value = "";
    }
  };

  return (
    <div
      style={{
        height: 48,
        borderBottom: "1px solid #334155",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 12px",
        flexShrink: 0,
      }}
    >
      <div style={{ fontWeight: 700 }}>Env Studio</div>
      <div style={{ opacity: 0.6, fontSize: 12 }}>Trackplan — resource types, assets, dataflow</div>
      <div style={{ flex: 1 }} />
      <button onClick={handleImportClick} style={btnStyle}>
        Import
      </button>
      <input ref={fileInputRef} type="file" accept="application/json" onChange={handleFileChange} style={{ display: "none" }} />
      <button onClick={handleExport} style={btnStyle}>
        Export JSON
      </button>
      <button
        onClick={() => {
          if (window.confirm("Clear all assets and connections?")) clearEnv();
        }}
        style={{ ...btnStyle, background: "#7f1d1d" }}
      >
        Clear
      </button>
    </div>
  );
}

const btnStyle: CSSProperties = {
  background: "#1e293b",
  color: "#e2e8f0",
  border: "1px solid #334155",
  borderRadius: 6,
  padding: "6px 12px",
  cursor: "pointer",
  fontSize: 12,
};
