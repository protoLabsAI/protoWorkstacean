import { Routes, Route } from "react-router-dom";
import Shell from "./Shell";
import OverviewGrid from "./components/OverviewGrid";
import SystemGraph from "./components/SystemGraph";
import SkillTrace from "./components/SkillTrace";
import EventStream from "./components/EventStream";
import Executions from "./components/Executions";
import Palette from "./components/Palette";
import AgentsView from "./components/AgentsView";
import Console from "./components/Console";

export default function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/" element={<OverviewGrid />} />
        <Route path="/system" element={<SystemGraph />} />
        <Route path="/trace" element={<SkillTrace />} />
        <Route path="/events" element={<EventStream />} />
        <Route path="/executions" element={<Executions />} />
        <Route path="/palette" element={<Palette />} />
        <Route path="/agents" element={<AgentsView />} />
        <Route path="/console" element={<Console />} />
      </Route>
    </Routes>
  );
}
