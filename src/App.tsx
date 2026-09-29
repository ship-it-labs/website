import { Navigate, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth-context";
import { LoginPage } from "@/pages/login";
import { SignupPage } from "@/pages/signup";
import { DashboardPage } from "@/pages/dashboard";
import { ApiKeysPage } from "@/pages/api-keys";
import { BillingPage } from "@/pages/billing";

function Protected({ children }: { children: ReactNode }) {
  const { userId, loading } = useAuth();
  if (loading) return <p className="p-6">Loading...</p>;
  if (!userId) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route
        path="/dashboard"
        element={
          <Protected>
            <DashboardPage />
          </Protected>
        }
      />
      <Route
        path="/dashboard/keys"
        element={
          <Protected>
            <ApiKeysPage />
          </Protected>
        }
      />
      <Route
        path="/dashboard/billing"
        element={
          <Protected>
            <BillingPage />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
