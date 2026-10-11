"use client";

import React from "react";
import dynamic from "next/dynamic";

class ErrorBoundary extends React.Component<{children: React.ReactNode}, {error: Error | null}> {
  constructor(props: {children: React.ReactNode}) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-black text-white p-8 font-mono">
          <h1 className="text-red-400 text-xl mb-4">Console Error</h1>
          <pre className="text-sm text-slate-300 whitespace-pre-wrap">{this.state.error.message}</pre>
          <pre className="text-xs text-slate-500 mt-4 whitespace-pre-wrap">{this.state.error.stack?.slice(0, 2000)}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const PitwallConsole = dynamic(
  () => import("@/components/console/PitwallConsole").then((m) => m.PitwallConsole),
  { ssr: false, loading: () => <div className="min-h-screen bg-black text-white flex items-center justify-center">Loading pitwall console…</div> }
);

export default function ConsolePage() {
  return (
    <ErrorBoundary>
      <PitwallConsole />
    </ErrorBoundary>
  );
}
