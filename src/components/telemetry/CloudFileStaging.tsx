import React, { useState, useEffect, useRef, useCallback } from "react";

interface StagedFile {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  status: string;
  game?: string;
  car?: string;
  track?: string;
  lap_count?: number;
  created_at: string;
  uploaded_at?: string;
  downloadUrl?: string | null;
}

interface CloudFileStagingProps {
  onLoadFile: (file: StagedFile) => void;
  loadingFileId: string | null;
}

function fmtSize(bytes: number): string {
  if (!bytes) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/**
 * Cloud file staging: upload raw telemetry CSVs directly to Neon Object
 * Storage (via presigned URLs — bytes never pass through the function),
 * then load them on any device for analysis.
 */
export const CloudFileStaging: React.FC<CloudFileStagingProps> = ({ onLoadFile, loadingFileId }) => {
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState<{ name: string; pct: number } | null>(null);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/telemetry-files", { credentials: "include" });
      if (!res.ok) throw new Error(res.status === 401 ? "Sign in to use cloud staging." : "Failed to list files.");
      const data = await res.json();
      setFiles(data.files ?? []);
    } catch (e: any) {
      setError(e?.message || "Failed to load staged files.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleUpload = async (file: File) => {
    setError("");
    setUploading({ name: file.name, pct: 0 });
    try {
      // 1. Mint presigned PUT URL
      const presign = await fetch("/api/telemetry-files/presign", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || "text/csv",
          sizeBytes: file.size,
        }),
      });
      if (!presign.ok) {
        const d = await presign.json().catch(() => ({}));
        throw new Error(d.error || "Could not prepare upload.");
      }
      const { fileId, uploadUrl } = await presign.json();

      // 2. PUT directly to object storage with progress
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", uploadUrl);
        xhr.setRequestHeader("Content-Type", file.type || "text/csv");
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setUploading({ name: file.name, pct: Math.round((e.loaded / e.total) * 100) });
        };
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
        xhr.onerror = () => reject(new Error("Upload failed — network error."));
        xhr.send(file);
      });

      // 3. Confirm with the API
      const confirm = await fetch(`/api/telemetry-files/${fileId}/confirm`, {
        method: "POST",
        credentials: "include",
      });
      if (!confirm.ok) throw new Error("Upload completed but confirmation failed.");
      setUploading(null);
      refresh();
    } catch (e: any) {
      setUploading(null);
      setError(e?.message || "Upload failed.");
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this staged file from cloud storage?")) return;
    try {
      await fetch(`/api/telemetry-files/${id}`, { method: "DELETE", credentials: "include" });
      refresh();
    } catch {
      setError("Delete failed.");
    }
  };

  return (
    <div className="telemetry-library" style={{ marginTop: 16 }}>
      <div className="form-section-title" style={{ marginBottom: 0 }}>
        <svg className="section-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.5 1.5A4 4 0 0 0 6 19h11.5z" />
        </svg>
        Cloud File Staging
        <span className="library-sync-note">raw CSVs in object storage</span>
      </div>

      <div style={{ margin: "10px 0" }}>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.txt"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleUpload(f);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="library-load"
          style={{ width: "100%", justifyContent: "center", padding: "10px" }}
          onClick={() => inputRef.current?.click()}
          disabled={!!uploading}
        >
          {uploading ? `Uploading ${uploading.name} — ${uploading.pct}%` : "＋ Stage a telemetry file to cloud"}
        </button>
        {uploading && (
          <div style={{ height: 6, background: "rgba(255,255,255,0.08)", borderRadius: 3, marginTop: 8 }}>
            <div style={{ height: "100%", width: `${uploading.pct}%`, background: "#38bdf8", borderRadius: 3, transition: "width 0.2s" }} />
          </div>
        )}
      </div>

      {error && <div className="library-status err">{error}</div>}

      {loading ? (
        <div className="library-status">Loading staged files…</div>
      ) : files.length === 0 ? (
        <div className="library-empty">
          No staged files — upload a raw CSV once, then analyze it from any device without re-uploading.
        </div>
      ) : (
        <ul className="library-list">
          {files.map((f) => (
            <li key={f.id} className="library-item">
              <button
                type="button"
                className="library-load"
                onClick={() => onLoadFile(f)}
                disabled={loadingFileId === f.id || f.status !== "ready"}
                title={f.status === "ready" ? `Analyze ${f.filename}` : `Status: ${f.status}`}
              >
                <span className="library-name">
                  {loadingFileId === f.id ? "Loading…" : f.filename}
                </span>
                <span className="library-meta">
                  {fmtSize(f.size_bytes)} · {f.status}
                  {f.uploaded_at ? ` · ${new Date(f.uploaded_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
                </span>
              </button>
              <button
                type="button"
                className="library-delete"
                onClick={() => handleDelete(f.id)}
                title="Delete staged file"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
