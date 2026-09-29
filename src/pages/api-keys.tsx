import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface ApiKeyRecord {
  id: string;
  key_prefix: string;
  name: string;
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
}

export function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [revealed, setRevealed] = useState<string | null>(
    () => localStorage.getItem("shipit.initial_api_key")
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ api_keys: ApiKeyRecord[] }>("/api/v1/account/api-keys");
      setKeys(result.api_keys);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load API keys");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ api_key: string }>("/api/v1/account/api-keys", {});
      setRevealed(result.api_key);
      localStorage.setItem("shipit.initial_api_key", result.api_key);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create key");
    } finally {
      setBusy(false);
    }
  }

  async function rotate(id: string) {
    setError(null);
    try {
      const result = await api.post<{ api_key: string }>(
        `/api/v1/account/api-keys/${id}/rotate`
      );
      setRevealed(result.api_key);
      localStorage.setItem("shipit.initial_api_key", result.api_key);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rotate key");
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      await api.post(`/api/v1/account/api-keys/${id}/revoke`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke key");
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">API keys</h1>
          <p className="text-sm text-muted-foreground">
            The plugin authenticates with one of these keys
          </p>
        </div>
        <Button onClick={create} disabled={busy}>
          Create key
        </Button>
      </header>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {error}
        </p>
      )}

      {revealed && (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle>Copy this key now</CardTitle>
            <CardDescription>
              It is only ever shown in full at creation. It cannot be retrieved later.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <code className="block break-all rounded-md bg-muted p-3 font-mono text-sm">
              {revealed}
            </code>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => navigator.clipboard?.writeText(revealed)}
              >
                Copy
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  localStorage.removeItem("shipit.initial_api_key");
                  setRevealed(null);
                }}
              >
                Dismiss
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Keys</CardTitle>
        </CardHeader>
        <CardContent>
          {keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No keys yet.</p>
          ) : (
            <ul className="divide-y">
              {keys.map((k) => (
                <li key={k.id} className="flex items-center justify-between py-3">
                  <div>
                    <p className="font-medium">{k.name}</p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {k.key_prefix}... {k.is_active ? "" : "(revoked)"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      created {new Date(k.created_at).toLocaleString()} · last used{" "}
                      {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "never"}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => rotate(k.id)}>
                      Rotate
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={!k.is_active}
                      onClick={() => revoke(k.id)}
                    >
                      Revoke
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
