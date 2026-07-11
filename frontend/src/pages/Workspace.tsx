import { Outlet } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import './Workspace.css';

export default function Workspace() {
  return (
    <div className="workspace">
      <Sidebar />
      <div className="workspace-content">
        <Outlet />
      </div>
    </div>
  );
}
