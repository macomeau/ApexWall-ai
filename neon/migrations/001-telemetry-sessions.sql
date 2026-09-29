-- =========================================================================
-- APEXWALL // NEON POSTGRES MIGRATION 001
-- Table: telemetry_sessions
-- Purpose: Cloud-synced telemetry analysis sessions. The raw uploaded file
-- is parsed in the browser; we store the parsed digest (downsampled points,
-- summary metrics, anomalies, comparisons) plus the AI analysis result, so a
-- session analyzed on one device can be reopened on another.
-- Auth: user_id is TEXT (Neon Auth user IDs). No RLS — enforced in API routes.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.telemetry_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    filename TEXT,
    game TEXT,
    car TEXT,
    track TEXT,
    lap_time TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    analysis JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_sessions_user
    ON public.telemetry_sessions (user_id, created_at DESC);
