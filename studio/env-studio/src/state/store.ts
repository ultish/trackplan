import { create } from "zustand";
import type { Asset, DataflowConnection, PortRef, Task } from "../domain/types";
import { getResourceType, PREDEFINED_RESOURCE_TYPES } from "../domain/resourceTypes";

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

interface EnvState {
  assets: Asset[];
  connections: DataflowConnection[];
  selectedAssetId: string | null;

  addAsset: (resourceTypeId: string, position: { x: number; y: number }) => void;
  updateAssetPosition: (id: string, position: { x: number; y: number }) => void;
  renameAsset: (id: string, name: string) => void;
  removeAsset: (id: string) => void;
  selectAsset: (id: string | null) => void;

  addConnection: (
    from: { assetId: string; port: PortRef },
    to: { assetId: string; port: PortRef }
  ) => void;
  removeConnection: (id: string) => void;

  addTask: (assetId: string, task: Omit<Task, "id" | "assetId">) => void;
  updateTask: (assetId: string, taskId: string, patch: Partial<Omit<Task, "id" | "assetId">>) => void;
  removeTask: (assetId: string, taskId: string) => void;

  loadEnv: (assets: Asset[], connections: DataflowConnection[]) => void;
  clearEnv: () => void;
}

export const useEnvStore = create<EnvState>((set) => ({
  assets: [],
  connections: [],
  selectedAssetId: null,

  addAsset: (resourceTypeId, position) =>
    set((state) => {
      const resourceType = getResourceType(resourceTypeId);
      if (!resourceType) return state;
      const count = state.assets.filter((a) => a.resourceTypeId === resourceTypeId).length + 1;
      const asset: Asset = {
        id: nextId("asset"),
        name: `${resourceType.name} ${count}`,
        resourceTypeId,
        position,
        tasks: [],
      };
      return { assets: [...state.assets, asset] };
    }),

  updateAssetPosition: (id, position) =>
    set((state) => ({
      assets: state.assets.map((a) => (a.id === id ? { ...a, position } : a)),
    })),

  renameAsset: (id, name) =>
    set((state) => ({
      assets: state.assets.map((a) => (a.id === id ? { ...a, name } : a)),
    })),

  removeAsset: (id) =>
    set((state) => ({
      assets: state.assets.filter((a) => a.id !== id),
      connections: state.connections.filter(
        (c) => c.from.assetId !== id && c.to.assetId !== id
      ),
      selectedAssetId: state.selectedAssetId === id ? null : state.selectedAssetId,
    })),

  selectAsset: (id) => set({ selectedAssetId: id }),

  addConnection: (from, to) =>
    set((state) => ({
      connections: [...state.connections, { id: nextId("link"), from, to }],
    })),

  removeConnection: (id) =>
    set((state) => ({
      connections: state.connections.filter((c) => c.id !== id),
    })),

  addTask: (assetId, task) =>
    set((state) => ({
      assets: state.assets.map((a) =>
        a.id === assetId
          ? { ...a, tasks: [...a.tasks, { ...task, id: nextId("task"), assetId }] }
          : a
      ),
    })),

  updateTask: (assetId, taskId, patch) =>
    set((state) => ({
      assets: state.assets.map((a) =>
        a.id === assetId
          ? {
              ...a,
              tasks: a.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)),
            }
          : a
      ),
    })),

  removeTask: (assetId, taskId) =>
    set((state) => ({
      assets: state.assets.map((a) =>
        a.id === assetId ? { ...a, tasks: a.tasks.filter((t) => t.id !== taskId) } : a
      ),
    })),

  loadEnv: (assets, connections) => set({ assets, connections, selectedAssetId: null }),

  clearEnv: () => set({ assets: [], connections: [], selectedAssetId: null }),
}));

export function resourceTypeOptions() {
  return PREDEFINED_RESOURCE_TYPES;
}
