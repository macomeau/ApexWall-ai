"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { authClient } from "@/lib/auth/client";

export interface NeonAuthUser {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
}

interface AuthContextType {
  user: NeonAuthUser | null;
  session: any | null;
  loading: boolean;
  isConfigured: boolean;
  signInWithGoogle: () => Promise<{ error: any }>;
  signInWithEmail: (email: string, password: string) => Promise<{ error: any }>;
  signUpWithEmail: (email: string, password: string) => Promise<{ error: any }>;
  signOut: () => Promise<void>;
  /** Re-probe /api/auth/get-session and sync user/session state (clears
   *  stale logged-in UI after the browser drops the session cookie). */
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<NeonAuthUser | null>(null);
  const [session, setSession] = useState<any | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [isConfigured, setIsConfigured] = useState<boolean>(false);

  // Probe the /api/auth proxy: if Neon Auth is wired up server-side this
  // succeeds; otherwise we degrade to local-only mode (same as before).
  useEffect(() => {
    let cancelled = false;
    authClient
      .getSession()
      .then(({ data, error }: any) => {
        if (cancelled) return;
        if (error) {
          setIsConfigured(false);
        } else {
          setIsConfigured(true);
          setSession(data ?? null);
          setUser(data?.user ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) setIsConfigured(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signInWithGoogle = async () => {
    if (!isConfigured) {
      return { error: { message: "Neon Auth is not configured in environment variables." } };
    }
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const { error } = await authClient.signIn.social({
      provider: "google",
      callbackURL: `${origin}/`,
    });
    if (!error) {
      const { data } = await authClient.getSession();
      setSession(data ?? null);
      setUser(data?.user ?? null);
    }
    return { error };
  };

  const signInWithEmail = async (email: string, password: string) => {
    if (!isConfigured) {
      return { error: { message: "Neon Auth is not configured in environment variables." } };
    }
    const { error } = await authClient.signIn.email({ email, password });
    if (!error) {
      const { data } = await authClient.getSession();
      setSession(data ?? null);
      setUser(data?.user ?? null);
    }
    return { error };
  };

  const signUpWithEmail = async (email: string, password: string) => {
    if (!isConfigured) {
      return { error: { message: "Neon Auth is not configured in environment variables." } };
    }
    const { error } = await authClient.signUp.email({ email, password, name: email });
    if (!error) {
      const { data } = await authClient.getSession();
      setSession(data ?? null);
      setUser(data?.user ?? null);
    }
    return { error };
  };

  const signOut = async () => {
    if (isConfigured) {
      await authClient.signOut();
    }
    setUser(null);
    setSession(null);
  };

  const refreshSession = async () => {
    try {
      const { data, error } = await authClient.getSession();
      if (error) {
        setIsConfigured(false);
        setUser(null);
        setSession(null);
      } else {
        setIsConfigured(true);
        setSession(data ?? null);
        setUser(data?.user ?? null);
      }
    } catch {
      setUser(null);
      setSession(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        loading,
        isConfigured,
        signInWithGoogle,
        signInWithEmail,
        signUpWithEmail,
        signOut,
        refreshSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
