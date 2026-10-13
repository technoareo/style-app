"use client";
import { useState } from "react";
import { authClient } from "../services/authClient";
export function AuthScreen() {
  const [mode, setMode] = useState<"login" | "signup" | "reset">("login");
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [name, setName] = useState("");
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result =
        mode === "signup"
          ? await authClient.signUp.email({
              email,
              password,
              name,
              callbackURL: "/",
            })
          : mode === "reset"
            ? await authClient.requestPasswordReset({
                email,
                redirectTo: "/reset-password",
              })
            : await authClient.signIn.email({ email, password });
      if (result.error?.code === "EMAIL_NOT_VERIFIED")
        throw new Error(
          "Please verify your email. A fresh verification link is on its way; it can take a few minutes, so check your inbox and spam folder. To protect your inbox we send at most 4 verification emails an hour to one address, so if it does not arrive, wait and try signing in again later.",
        );
      if (result.error)
        throw new Error(
          result.error.message || "Please check your details and try again.",
        );
      if (mode === "signup")
        setMessage(
          "Check your email to verify your account, then sign in. It can take a few minutes; look in your spam folder too. If nothing arrives, signing in again sends a new link (at most 4 an hour).",
        );
      if (mode === "reset")
        setMessage(
          "If an account matches this email, a password reset link is on its way. It can take a few minutes; look in your spam folder too. We send at most 4 reset emails an hour to one address.",
        );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-screen">
      <section className="auth-card">
        <div className="mobile-brand">✦ style studio</div>
        <h1>Your wardrobe. More possibilities.</h1>
        <p>
          Save the clothes you own and discover everyday looks. Your wardrobe
          and photos belong to your private account.
        </p>
        <h2>
          {mode === "signup"
            ? "Create your account"
            : mode === "reset"
              ? "Reset your password"
              : "Welcome back"}
        </h2>
        <form onSubmit={submit}>
          {mode === "signup" && (
            <label>
              Your name
              <input
                required
                maxLength={100}
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          )}
          <label>
            Email
            <input
              type="email"
              required
              autoComplete="email"
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          {mode !== "reset" && (
            <label>
              Password
              <input
                type="password"
                aria-label="Password"
                required
                minLength={12}
                maxLength={128}
                autoComplete={
                  mode === "signup" ? "new-password" : "current-password"
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <small>At least 12 characters</small>
            </label>
          )}
          <button className="primary-button" disabled={busy}>
            {busy
              ? "Please wait…"
              : mode === "signup"
                ? "Create account"
                : mode === "reset"
                  ? "Send reset link"
                  : "Sign in"}
          </button>
        </form>
        {message && <p role="status">{message}</p>}
        <div className="auth-options">
          {(["login", "signup", "reset"] as const)
            .filter((x) => x !== mode)
            .map((x) => (
              <button
                key={x}
                className="text-link"
                disabled={busy}
                onClick={() => {
                  setMode(x);
                  setMessage("");
                  setPassword("");
                }}
              >
                {x === "login"
                  ? "Sign in"
                  : x === "signup"
                    ? "Create an account"
                    : "Forgot password?"}
              </button>
            ))}
        </div>
        {mode === "login" && (
          <small>
            After a service recovery your old password may no longer work. Use
            &ldquo;Forgot password?&rdquo; to get an email link and choose a new
            one; your wardrobe is kept.
          </small>
        )}
        <small>
          Photo analysis runs on our server using a local AI model. You review
          suggestions before adding items. No subscription is required for this
          version.
        </small>
      </section>
    </main>
  );
}
