"use client";
import { useEffect, useState } from "react";
import { authClient } from "../../services/authClient";
import Link from "next/link";
export default function ResetPassword() {
  const [token, setToken] = useState(""),
    [password, setPassword] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token") || "");
  }, []);
  return (
    <main className="auth-screen">
      <section className="auth-card">
        <h1>Choose a new password</h1>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const result = await authClient.resetPassword({
                newPassword: password,
                token,
              });
              if (result.error) throw new Error(result.error.message);
              setDone(true);
              setMessage("Password updated. Sign in with your new password.");
            } catch (error) {
              setMessage(
                error instanceof Error
                  ? error.message
                  : "Please request a new reset link.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            New password
            <input
              required
              type="password"
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button disabled={!token || busy || done}>Update password</button>
        </form>
        {message && <p role="status">{message}</p>}
        <Link href="/">Back to sign in</Link>
      </section>
    </main>
  );
}
