import { FormEvent, ReactNode, createContext, useContext, useEffect, useState } from "react";
import { User, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "./firebase";
import worthHigginsLogo from "./assets/WHALogo_Horizontal.png";

export type UserRole = "admin" | "manager" | "viewer";
export type UserProfile = {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  enabled: boolean;
};

type AuthContextValue = {
  user: User;
  profile: UserProfile;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function usePlantFlowAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("usePlantFlowAuth must be used inside AuthGate");
  return value;
}

function friendlyAuthError(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) return "That email or password was not recognized.";
  if (code.includes("too-many-requests")) return "Too many attempts. Wait a few minutes and try again.";
  if (code.includes("network-request-failed")) return "PlantFlow could not reach Firebase. Check your internet connection.";
  return "PlantFlow could not sign you in. Please try again.";
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState("");

  useEffect(() => onAuthStateChanged(auth, async nextUser => {
    setLoading(true);
    setSessionError("");
    setUser(nextUser);
    setProfile(null);
    if (!nextUser) {
      setLoading(false);
      return;
    }
    try {
      const snapshot = await getDoc(doc(db, "users", nextUser.uid));
      if (!snapshot.exists()) throw new Error("No PlantFlow access profile exists for this account.");
      const data = snapshot.data() as Omit<UserProfile, "uid">;
      if (!data.enabled) throw new Error("This PlantFlow account has been disabled.");
      if (!["admin", "manager", "viewer"].includes(data.role)) throw new Error("This account does not have a valid PlantFlow role.");
      setProfile({ ...data, uid: nextUser.uid });
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "PlantFlow could not load your access profile.");
      await signOut(auth);
    } finally {
      setLoading(false);
    }
  }), []);

  if (loading) return <div className="auth-screen"><div className="auth-loading"><span className="auth-spinner"/><b>Opening PlantFlow…</b><small>Checking your secure session</small></div></div>;
  if (!user || !profile) return <LoginScreen sessionError={sessionError}/>;

  return <AuthContext.Provider value={{ user, profile, logout: () => signOut(auth) }}>{children}</AuthContext.Provider>;
}

function LoginScreen({ sessionError }: { sessionError: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(sessionError);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (signInError) {
      setError(friendlyAuthError(signInError));
      setSubmitting(false);
    }
  };

  return <div className="auth-screen">
    <main className="auth-card">
      <img src={worthHigginsLogo} alt="Worth Higgins & Associates"/>
      <p className="eyebrow">SECURE PRODUCTION ACCESS</p>
      <h1>Sign in to PlantFlow</h1>
      <p className="auth-intro">Use your PlantFlow account to view the live production board and keep every workstation synchronized.</p>
      <form onSubmit={submit}>
        <label><span>Email address</span><input autoComplete="username" type="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="name@worthhiggins.com"/></label>
        <label><span>Password</span><input autoComplete="current-password" type="password" required value={password} onChange={event => setPassword(event.target.value)} placeholder="Enter your password"/></label>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="primary" disabled={submitting}>{submitting ? "Signing in…" : "Sign in"}</button>
      </form>
      <small className="auth-help">Accounts are managed by a PlantFlow administrator.</small>
    </main>
  </div>;
}
