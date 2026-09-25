import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './lib/auth-context';
import { WorkspaceProvider } from './lib/workspace-context';
import { ProtectedRoute } from './components/protected-route';
import { AdminRoute } from './components/admin-route';
import { AppLayout } from './components/layout/app-layout';
import { LoginPage } from './pages/login';
import { RegisterPage } from './pages/register';
import { DashboardPage } from './pages/dashboard';
import { ProjectsPage } from './pages/projects';
import { ProjectDetailPage } from './pages/project-detail';
import { RunsPage } from './pages/runs';
import { RecordsPage } from './pages/records';
import { RecordDetailPage } from './pages/record-detail';
import { SettingsPage } from './pages/settings';
import { AccountPage } from './pages/account';
import { AdminModulesPage } from './pages/admin/modules';
import { AdminProjectsPage } from './pages/admin/projects';
import { AdminWorkspaceModulesPage } from './pages/admin/workspace-modules';
import './domains'; // registers every domain renderer as a side effect — see domains/index.ts

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <WorkspaceProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route
              element={
                <ProtectedRoute>
                  <AppLayout />
                </ProtectedRoute>
              }
            >
              <Route path="/" element={<DashboardPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/:id" element={<ProjectDetailPage />} />
              <Route path="/runs" element={<RunsPage />} />
              <Route path="/records" element={<RecordsPage />} />
              <Route path="/records/:id" element={<RecordDetailPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/account" element={<AccountPage />} />
              <Route path="/admin/modules" element={<AdminRoute><AdminModulesPage /></AdminRoute>} />
              <Route path="/admin/workspace-modules" element={<AdminRoute><AdminWorkspaceModulesPage /></AdminRoute>} />
              <Route path="/admin/projects" element={<AdminRoute><AdminProjectsPage /></AdminRoute>} />
            </Route>
          </Routes>
        </WorkspaceProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
