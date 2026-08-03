import { FormEvent, ReactNode, createContext, useContext, useEffect, useState } from "react";
import { User, browserLocalPersistence, onAuthStateChanged, setPersistence, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { doc, getDoc, serverTimestamp, updateDoc } from "firebase/firestore";
import { auth, db } from "./firebase";
import worthHigginsLogo from "./assets/WHALogo_Horizontal.png";

export type UserRole = "super_admin" | "admin" | "standard" | "manager" | "viewer";
export type UserProfile = {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  enabled: boolean;
  createdAt?: unknown;
  lastSignInAt?: unknown;
  removed?: boolean;
};

type AuthContextValue = {
  user: User;
  profile: UserProfile;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const productionSessionKey = "plantflow-production-last-active-v1";
const productionSessionWindow = 12 * 60 * 60 * 1000;

export function productionEmailForName(name: string) {
  const key = name.trim().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "").slice(0, 50);
  return key ? `${key}@floor.plantflow.invalid` : "";
}

export function usePlantFlowAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("usePlantFlowAuth must be used inside AuthGate");
  return value;
}

function friendlyAuthError(error: unknown, access: "main" | "production") {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) return access === "production" ? "That employee name, administrator email, or passcode was not recognized." : "That email or password was not recognized.";
  if (code.includes("too-many-requests")) return "Too many attempts. Wait a few minutes and try again.";
  if (code.includes("network-request-failed")) return "PlantFlow could not reach Firebase. Check your internet connection.";
  if (error instanceof Error && error.message === "Enter your employee name.") return error.message;
  return "PlantFlow could not sign you in. Please try again.";
}

export function AuthGate({ children, access = "main" }: { children: ReactNode; access?: "main" | "production" }) {
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
      if (!["super_admin", "admin", "standard", "manager", "viewer"].includes(data.role)) throw new Error("This account does not have a valid PlantFlow role.");
      const effectiveRole = nextUser.uid === "TOXwE0xXDlgoL4YqBbrTOGjxCyk1" ? "super_admin" : data.role;
      if (access === "main" && !["super_admin", "admin"].includes(effectiveRole)) throw new Error("This account is limited to the Production Floor Portal.");
      if (access === "production" && !["super_admin", "admin", "standard"].includes(effectiveRole)) throw new Error("This account does not have Production Floor Portal access.");
      if (access === "production" && effectiveRole === "standard") {
        const lastActive = Number(window.localStorage.getItem(productionSessionKey) || 0);
        if (lastActive && Date.now() - lastActive > productionSessionWindow) {
          window.localStorage.removeItem(productionSessionKey);
          throw new Error("Your production session expired. Sign in again to continue.");
        }
        window.localStorage.setItem(productionSessionKey, String(Date.now()));
      }
      setProfile({ ...data, role: effectiveRole, uid: nextUser.uid });
      void updateDoc(doc(db, "users", nextUser.uid), { lastSignInAt: serverTimestamp() }).catch(() => undefined);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "PlantFlow could not load your access profile.");
      await signOut(auth);
    } finally {
      setLoading(false);
    }
  }), [access]);

  useEffect(() => {
    if (access !== "production" || profile?.role !== "standard") return;
    let lastWrite = 0;
    const touch = () => {
      const now = Date.now();
      if (now - lastWrite < 60_000) return;
      lastWrite = now;
      window.localStorage.setItem(productionSessionKey, String(now));
    };
    const verify = () => {
      const lastActive = Number(window.localStorage.getItem(productionSessionKey) || 0);
      if (lastActive && Date.now() - lastActive > productionSessionWindow) {
        window.localStorage.removeItem(productionSessionKey);
        void signOut(auth);
      }
    };
    touch();
    window.addEventListener("pointerdown", touch);
    window.addEventListener("keydown", touch);
    window.addEventListener("touchstart", touch);
    window.addEventListener("focus", verify);
    const timer = window.setInterval(verify, 60_000);
    return () => {
      window.removeEventListener("pointerdown", touch);
      window.removeEventListener("keydown", touch);
      window.removeEventListener("touchstart", touch);
      window.removeEventListener("focus", verify);
      window.clearInterval(timer);
    };
  }, [access, profile?.role]);

  if (loading) return <div className="auth-screen"><div className="auth-loading"><span className="auth-spinner"/><b>Opening PlantFlow…</b><small>Checking your secure session</small></div></div>;
  if (!user || !profile) return <LoginScreen access={access} sessionError={sessionError}/>;

  return <AuthContext.Provider value={{ user, profile, logout: async () => { if (profile.role === "standard") window.localStorage.removeItem(productionSessionKey); await signOut(auth); } }}>{children}</AuthContext.Provider>;
}

function LoginScreen({ access, sessionError }: { access: "main" | "production"; sessionError: string }) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(sessionError);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const normalizedIdentifier = identifier.trim().toLowerCase();
      const email = access === "production" && !normalizedIdentifier.includes("@") ? productionEmailForName(identifier) : normalizedIdentifier;
      if (!email) throw new Error("Enter your employee name.");
      await setPersistence(auth, browserLocalPersistence);
      await signInWithEmailAndPassword(auth, email, password);
      if (access === "production") window.localStorage.setItem(productionSessionKey, String(Date.now()));
    } catch (signInError) {
      setError(friendlyAuthError(signInError, access));
      setSubmitting(false);
    }
  };

  return <div className="auth-screen">
    <main className="auth-card">
      <img src={worthHigginsLogo} alt="Worth Higgins & Associates"/>
      <p className="eyebrow">{access === "production" ? "PRODUCTION FLOOR ACCESS" : "SECURE ADMINISTRATIVE ACCESS"}</p>
      <h1>{access === "production" ? "Open the Production Floor Portal" : "Sign in to PlantFlow"}</h1>
      <p className="auth-intro">{access === "production" ? "Production employees enter their assigned name and passcode. Administrators can enter their admin email and PlantFlow password." : "Administrator accounts provide access to the full PlantFlow production workspace."}</p>
      <form onSubmit={submit}>
        <label><span>{access === "production" ? "Employee name or admin email" : "Email address"}</span><input autoComplete="username" type={access === "production" ? "text" : "email"} required value={identifier} onChange={event => setIdentifier(event.target.value)} placeholder={access === "production" ? "Employee name or admin email" : "name@worthhiggins.com"}/></label>
        <label><span>{access === "production" ? "Passcode" : "Password"}</span><input autoComplete="current-password" type="password" required value={password} onChange={event => setPassword(event.target.value)} placeholder={access === "production" ? "Enter your passcode" : "Enter your password"}/></label>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="primary" disabled={submitting}>{submitting ? "Signing in…" : access === "production" ? "Open production portal" : "Sign in"}</button>
      </form>
      <small className="auth-help">{access === "production" ? "Production employee sessions expire after 12 hours without activity. Administrator access uses the administrator’s existing PlantFlow credentials." : "Accounts are managed by a PlantFlow Super Admin."}</small>
    </main>
  </div>;
}
