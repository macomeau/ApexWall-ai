import type { SavedSetupRecord } from "@/lib/setup-vault";

/** Map a pitwall_setups row (snake_case) to a SavedSetupRecord (camelCase). */
export function toSetupRecord(row: any): SavedSetupRecord {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    game: row.game,
    car: row.car,
    track: row.track,
    sessionType: row.session_type,
    weather: row.weather,
    trackTemp: row.track_temp,
    airTemp: row.air_temp,
    tyreCompound: row.tyre_compound,
    fuelLoad: row.fuel_load,
    lapTime: row.lap_time,
    driverStyle: row.driver_style,
    summary: row.summary,
    engineerNotes: row.engineer_notes,
    sections: row.sections || [],
    userId: row.user_id,
    isPublic: row.is_public ?? true,
    shareSlug: row.share_slug,
  };
}

/** Columns for INSERT/UPSERT, in a fixed order. */
export const SETUP_COLUMNS = [
  "id",
  "user_id",
  "name",
  "game",
  "car",
  "track",
  "session_type",
  "weather",
  "track_temp",
  "air_temp",
  "tyre_compound",
  "fuel_load",
  "lap_time",
  "driver_style",
  "summary",
  "engineer_notes",
  "sections",
  "is_public",
  "share_slug",
  "updated_at",
] as const;
