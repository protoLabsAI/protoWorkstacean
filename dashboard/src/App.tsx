import { Routes, Route } from "react-router-dom";
import Layout from "./Layout";
import OverviewGrid from "./components/OverviewGrid";
import SystemGraph from "./components/SystemGraph";
import SkillTrace from "./components/SkillTrace";
import EventStream from "./components/EventStream";
import AgentsView from "./components/AgentsView";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<OverviewGrid />} />
        <Route path="/system" element={<SystemGraph />} />
        <Route path="/trace" element={<SkillTrace />} />
        <Route path="/events" element={<EventStream />} />
        <Route path="/agents" element={<AgentsView />} />
      </Route>
    </Routes>
  );
}
