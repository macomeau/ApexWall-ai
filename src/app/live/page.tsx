import dynamic from "next/dynamic";
import Link from "next/link";

const LivePitwall = dynamic(() => import("@/components/live/LivePitwall"), {
  ssr: false,
  loading: () => (
    <div className="text-slate-300 text-sm">Connecting to the live timing feed…</div>
  ),
});

export default function LivePage() {
  return (
    <main className="min-h-screen bg-[#0c0e12] text-slate-100 px-4 py-6 md:px-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <Link href="/" className="text-xs text-slate-400 hover:text-[#d4a373]">
            ← ApexWall
          </Link>
          <span className="text-[10px] tracking-[0.3em] text-slate-500 font-mono">
            LIVE PITWALL
          </span>
        </div>
        <LivePitwall />
      </div>
    </main>
  );
}
