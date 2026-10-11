"use client";

import React from "react";
import dynamic from "next/dynamic";

const PitwallConsole = dynamic(
  () => import("@/components/console/PitwallConsole").then((m) => m.PitwallConsole),
  { ssr: false, loading: () => <div className="min-h-screen bg-black text-white flex items-center justify-center">Loading pitwall console…</div> }
);

export default function ConsolePage() {
  return <PitwallConsole />;
}
