import { SavedSetupRecord, getSavedSetups, saveSetupToVault, deleteSetupFromVault } from "./setup-vault";

async function readJsonSafe(res: Response): Promise<any | null> {
  try {
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Fetch all setups:
 * If authenticated with Neon Auth, fetches cloud setups and merges with local storage.
 * If unauthenticated or offline, falls back to local storage.
 */
export async function getUnifiedSetups(): Promise<SavedSetupRecord[]> {
  const localSetups = getSavedSetups();
  if (typeof window === "undefined") return localSetups;

  try {
    const res = await fetch("/api/vault", { credentials: "same-origin" });
    const data = await readJsonSafe(res);
    if (!data || !Array.isArray(data)) {
      return localSetups; // 401 / not configured / offline -> local only
    }

    const cloudSetups = data as SavedSetupRecord[];

    // Merge: cloud setups take priority for matching IDs, then unique local ones
    const cloudIds = new Set(cloudSetups.map((s) => s.id));
    const uniqueLocal = localSetups.filter((s) => !cloudIds.has(s.id));
    return [...cloudSetups, ...uniqueLocal];
  } catch (err) {
    console.error("Cloud vault sync error:", err);
    return localSetups;
  }
}

/**
 * Save setup to both local storage and the Neon cloud vault (if authenticated)
 */
export async function saveUnifiedSetup(
  record: Omit<SavedSetupRecord, "id" | "createdAt"> & { id?: string }
): Promise<SavedSetupRecord> {
  // 1. Always save to local storage first for instant zero-latency UX
  const localSaved = saveSetupToVault(record);

  // 2. If authenticated, persist to the cloud vault API
  if (typeof window !== "undefined") {
    try {
      const res = await fetch("/api/vault", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(localSaved),
      });
      const saved = await readJsonSafe(res);
      if (saved && saved.id) {
        localSaved.userId = saved.userId;
        localSaved.isPublic = saved.isPublic ?? true;
      }
    } catch (err) {
      console.warn("Cloud vault sync skipped:", err);
    }
  }

  return localSaved;
}

/**
 * Delete a setup from both local storage and the cloud vault
 */
export async function deleteUnifiedSetup(id: string): Promise<void> {
  deleteSetupFromVault(id);

  if (typeof window !== "undefined") {
    try {
      await fetch(`/api/vault?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
    } catch (err) {
      console.warn("Failed to delete setup from cloud:", err);
    }
  }
}

/**
 * Fetch a single setup by ID from public cloud records or local storage
 */
export async function getSetupById(id: string): Promise<SavedSetupRecord | null> {
  // Check local first
  const locals = getSavedSetups();
  const match = locals.find((s) => s.id === id);
  if (match) return match;

  // Try the cloud vault public query
  try {
    const res = await fetch(`/api/vault/${encodeURIComponent(id)}`, {
      credentials: "same-origin",
    });
    const data = await readJsonSafe(res);
    if (data && data.id) {
      return data as SavedSetupRecord;
    }
  } catch (err) {
    console.warn("Could not query setup from cloud vault:", err);
  }

  return null;
}
