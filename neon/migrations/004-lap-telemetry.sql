-- =========================================================================
-- APEXWALL // NEON POSTGRES MIGRATION 004
-- Tables: sessions, lap_telemetry
-- Purpose: Per-lap telemetry storage (P-006). One row per lap with channels
-- as REAL[] arrays — NOT per-sample rows. Powers delta traces (F-001),
-- theoretical best laps (F-003), and re-analysis without re-upload.
-- Sectors stored as cheap columns: 3 floats per lap.
-- Auth: user_id is TEXT (Neon Auth user IDs). No RLS — enforced in API routes.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    game TEXT,
    car TEXT,
    track TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    lap_count INT NOT NULL DEFAULT 0,
    best_lap_time REAL,
    source TEXT NOT NULL DEFAULT 'upload',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user
    ON public.sessions (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_track
    ON public.sessions (user_id, track, car);

CREATE TABLE IF NOT EXISTS public.lap_telemetry (
    id SERIAL PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    lap_number INT NOT NULL,
    lap_time REAL,
    is_valid BOOLEAN NOT NULL DEFAULT true,
    is_out_lap BOOLEAN NOT NULL DEFAULT false,
    is_in_lap BOOLEAN NOT NULL DEFAULT false,
    -- Sectors: null entries mean unknown (not invalid)
    sector_times REAL[3],
    sector_valid BOOLEAN[3] NOT NULL DEFAULT '{t,t,t}',
    -- Core channels as REAL[] (one array per channel, aligned by index)
    ch_speed REAL[],
    ch_throttle REAL[],
    ch_brake REAL[],
    ch_steer REAL[],
    ch_gear REAL[],
    ch_rpm REAL[],
    ch_lat_g REAL[],
    ch_long_g REAL[],
    ch_dist REAL[],
    sample_rate REAL,
    sample_count INT,
    -- Game-specific extras (tyre temps, damper, etc.) as JSONB arrays
    extra_channels JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, lap_number)
);

CREATE INDEX IF NOT EXISTS idx_lap_telemetry_session
    ON public.lap_telemetry (session_id, lap_number);
CREATE INDEX IF NOT EXISTS idx_lap_telemetry_user_track
    ON public.lap_telemetry (user_id, session_id);
