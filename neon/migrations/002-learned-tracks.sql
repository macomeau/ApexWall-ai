-- =========================================================================
-- APEXWALL // NEON POSTGRES MIGRATION 002
-- Table: learned_tracks
-- Purpose: Auto-learned circuit geometries. When telemetry is analyzed for
-- a track that is neither in the built-in REAL_CIRCUITS database nor in the
-- user's learned set, the client persists the physics-reconstructed shape
-- (downsampled {dist,x,y} points), curvature-detected corners (named T1..Tn)
-- and equal-third sectors — so the next analysis of that track is recognized
-- with named corners instead of falling back to anonymous reconstruction.
-- Auth: user_id is TEXT (Neon Auth user IDs). No RLS — enforced in API routes.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.learned_tracks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    match_key TEXT NOT NULL,
    distance_m DOUBLE PRECISION,
    country TEXT,
    points JSONB NOT NULL DEFAULT '[]'::jsonb,
    corners JSONB NOT NULL DEFAULT '[]'::jsonb,
    sectors JSONB NOT NULL DEFAULT '[]'::jsonb,
    source TEXT NOT NULL DEFAULT 'telemetry',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_learned_tracks_user
    ON public.learned_tracks (user_id, created_at DESC);
