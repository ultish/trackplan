import { useRef, type ChangeEvent } from "react";
import { useEnvStore } from "../state/store";
import { useThemeStore } from "../state/theme";
import { buildExport, downloadExport, parseImport } from "../domain/export";

export function TopBar() {
  const assets = useEnvStore((s) => s.assets);
  const connections = useEnvStore((s) => s.connections);
  const loadEnv = useEnvStore((s) => s.loadEnv);
  const clearEnv = useEnvStore((s) => s.clearEnv);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
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
    <header className="eh-header">
      <div>
        <h1>Env Studio</h1>
        <p>
          Trackplan — author Resource Types, Assets, and Dataflow connections by hand, then export
          JSON for an LLM session to check whether a SPEC document covers the scenario.
        </p>
      </div>
      <div className="eh-headerActions">
        <button className="eh-btn" onClick={handleImportClick}>
          Import
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          onChange={handleFileChange}
          style={{ display: "none" }}
        />
        <button className="eh-btn primary" onClick={handleExport}>
          Export JSON
        </button>
        <button
          className="eh-btn danger"
          onClick={() => {
            if (window.confirm("Clear all assets and connections?")) clearEnv();
          }}
        >
          Clear
        </button>
        <button className="eh-btn" type="button" onClick={toggleTheme} title="Toggle theme">
          Toggle theme
        </button>
      </div>
    </header>
  );
}
