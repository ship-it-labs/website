import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth-context";
import { AuthProvider } from "@/lib/auth-context";
import { LoginPage } from "@/pages/login";
import { SignupPage } from "@/pages/signup";
import { DashboardPage } from "@/pages/dashboard";
import { ApiKeysPage } from "@/pages/api-keys";
import { BillingPage } from "@/pages/billing";
import { SettingsPage } from "@/pages/settings";
import { PrivacyPage } from "@/pages/privacy";
import { FaqPage } from "@/pages/faq";
import { ContactPage } from "@/pages/contact";
import { ChangelogPage } from "@/pages/changelog";
import { StatusPage } from "@/pages/status";
import { ForgotPasswordPage, ResetPasswordPage } from "@/pages/password";
import { AdminPage } from "@/pages/admin";
import { HomePage } from "@/pages/home";
import { PricingPage } from "@/pages/pricing";
import { DocsPage } from "@/pages/docs";
import { TermsPage } from "@/pages/terms";

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <p className="p-6 text-zinc-400">Loading…</p>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// The tab is hidden for non-admins, but a hidden tab is not a guard: anyone
// can type the URL. The server re-checks every /admin/* request, so this only
// decides what renders, never what is allowed.
function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!user?.is_admin) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/pricing" element={<PricingPage />} />
      <Route path="/docs" element={<DocsPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/faq" element={<FaqPage />} />
      <Route path="/contact" element={<ContactPage />} />
      <Route path="/changelog" element={<ChangelogPage />} />
      <Route path="/status" element={<StatusPage />} />
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
      <Route
        path="/dashboard/settings"
        element={
          <Protected>
            <SettingsPage />
          </Protected>
        }
      />
      <Route
        path="/dashboard/admin"
        element={
          <Protected>
            <RequireAdmin>
              <AdminPage />
            </RequireAdmin>
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function Root() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  );
}
