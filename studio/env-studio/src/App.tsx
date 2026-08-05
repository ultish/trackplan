import { ReactFlowProvider } from "@xyflow/react";
import { TopBar } from "./components/TopBar";
import { Palette } from "./components/Palette";
import { Canvas } from "./components/Canvas";
import { InspectorPanel } from "./components/InspectorPanel";

export default function App() {
  return (
    <div className="eh-app">
      <TopBar />
      <div className="eh-body">
        <Palette />
        <ReactFlowProvider>
          <Canvas />
        </ReactFlowProvider>
        <InspectorPanel />
      </div>
    </div>
  );
}
