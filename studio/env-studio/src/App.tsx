import { ReactFlowProvider } from "@xyflow/react";
import { TopBar } from "./components/TopBar";
import { Palette } from "./components/Palette";
import { Canvas } from "./components/Canvas";
import { InspectorPanel } from "./components/InspectorPanel";

export default function App() {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#0b1220", color: "#e2e8f0" }}>
      <TopBar />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <Palette />
        <ReactFlowProvider>
          <Canvas />
        </ReactFlowProvider>
        <InspectorPanel />
      </div>
    </div>
  );
}
