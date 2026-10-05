-- =========================================================================
-- APEXWALL // NEON POSTGRES MIGRATION 005
-- Table: telemetry_files
-- Purpose: Registry for raw telemetry files staged in Neon Object Storage
-- (bucket: telemetry-uploads). Stores the object key + metadata; the bytes
-- live in the bucket. Powers upload-once/analyze-anywhere and re-parsing
-- without re-upload.
-- Auth: user_id is TEXT (Neon Auth user IDs). No RLS — enforced in API routes.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.telemetry_files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    object_key TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'text/csv',
    size_bytes BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    -- status: pending (presigned, not yet uploaded), ready, failed
    game TEXT,
    car TEXT,
    track TEXT,
    lap_count INT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    uploaded_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_telemetry_files_user
    ON public.telemetry_files (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_files_key
    ON public.telemetry_files (object_key);
