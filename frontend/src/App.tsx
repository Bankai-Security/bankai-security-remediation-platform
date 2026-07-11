import { Navigate, Route, Routes } from 'react-router-dom';
import Login from './pages/Login';
import SignUp from './pages/SignUp';
import Onboarding from './pages/Onboarding';
import Projects from './pages/Projects';
import NewProject from './pages/NewProject';
import Workspace from './pages/Workspace';
import {
  RemediationWorkflow,
  Overview,
  ReportIntake,
  AITriage,
  Tickets,
  Activity,
  Settings,
} from './pages/stubs';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<SignUp />} />
      <Route path="/onboarding" element={<Onboarding />} />
      <Route path="/projects" element={<Projects />} />
      <Route path="/projects/new" element={<NewProject />} />

      <Route path="/workspace" element={<Workspace />}>
        <Route index element={<Navigate to="workflow" replace />} />
        <Route path="workflow" element={<RemediationWorkflow />} />
        <Route path="overview" element={<Overview />} />
        <Route path="intake" element={<ReportIntake />} />
        <Route path="triage" element={<AITriage />} />
        <Route path="tickets" element={<Tickets />} />
        <Route path="activity" element={<Activity />} />
        <Route path="settings" element={<Settings />} />
      </Route>

      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}
