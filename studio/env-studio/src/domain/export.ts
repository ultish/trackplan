import { getResourceType } from "./resourceTypes";
import type { Asset, DataflowConnection, ResourceType } from "./types";

export interface EnvExport {
  env_studio_version: 1;
  resourceTypes: ResourceType[];
  assets: Asset[];
  connections: DataflowConnection[];
}

/** Self-contained export: embeds full ResourceType defs (not just ids) so the JSON
 * can be handed to an LLM / test runner without needing this app's source. */
export function buildExport(assets: Asset[], connections: DataflowConnection[]): EnvExport {
  const usedTypeIds = new Set(assets.map((a) => a.resourceTypeId));
  const resourceTypes = [...usedTypeIds]
    .map((id) => getResourceType(id))
    .filter((rt): rt is ResourceType => Boolean(rt))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    env_studio_version: 1,
    resourceTypes,
    assets: [...assets].sort((a, b) => a.id.localeCompare(b.id)),
    connections: [...connections].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function downloadExport(env: EnvExport, filename = "env.json") {
  const blob = new Blob([JSON.stringify(env, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function parseImport(json: string): { assets: Asset[]; connections: DataflowConnection[] } {
  const parsed = JSON.parse(json) as EnvExport;
  if (parsed.env_studio_version !== 1) {
    throw new Error(`Unsupported env_studio_version: ${parsed.env_studio_version}`);
  }
  return { assets: parsed.assets, connections: parsed.connections };
}
