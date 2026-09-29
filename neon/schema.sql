-- =========================================================================
-- APEXWALL // NEON POSTGRES SCHEMA
-- Table: pitwall_setups
-- Purpose: Cloud-synced setups, public shareable setups, and team access.
-- Ported from Supabase: RLS dropped (enforced in API routes via user_id),
-- user_id is TEXT (Neon Auth user IDs, no auth.users FK).
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.pitwall_setups (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT NOT NULL,
    game TEXT NOT NULL,
    car TEXT NOT NULL,
    track TEXT NOT NULL,
    session_type TEXT,
    weather TEXT,
    track_temp TEXT,
    air_temp TEXT,
    tyre_compound TEXT,
    fuel_load TEXT,
    lap_time TEXT,
    driver_style TEXT,
    summary TEXT,
    engineer_notes TEXT,
    sections JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_public BOOLEAN NOT NULL DEFAULT true,
    share_slug TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexing for fast search and user querying
CREATE INDEX IF NOT EXISTS idx_pitwall_setups_user ON public.pitwall_setups(user_id);
CREATE INDEX IF NOT EXISTS idx_pitwall_setups_slug ON public.pitwall_setups(share_slug);
CREATE INDEX IF NOT EXISTS idx_pitwall_setups_public ON public.pitwall_setups(is_public);
