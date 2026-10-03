-- =========================================================================
-- APEXWALL // NEON POSTGRES MIGRATION 003
-- Table: setup_knowledge
-- Purpose: RAG knowledge base for the AI coach. Stores setup engineering
-- knowledge (handling fixes, parameter guidance) retrievable via hybrid
-- search: vector similarity (pgvector) + BM25-style full-text (tsvector).
--
-- NOTE ON LAKEBASE SEARCH: Databricks Lakebase ships native
-- `lakebase_vector` (ANN) and `lakebase_text` (BM25) extensions. On standard
-- Neon we use the equivalent open primitives: pgvector's HNSW for ANN and
-- Postgres tsvector/GIN for full-text. The SQL patterns are identical —
-- swap the index types when deploying to Lakebase.
-- =========================================================================

-- Vector extension (pgvector on Neon; lakebase_vector on Lakebase)
CREATE EXTENSION IF NOT EXISTS vector;

-- Knowledge base table
CREATE TABLE IF NOT EXISTS public.setup_knowledge (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    tags TEXT[] NOT NULL DEFAULT '{}',
    -- 1536 dims = OpenAI text-embedding-3-small (also matches many gateways).
    -- NULL until backfilled; text search works regardless.
    embedding vector(1536),
    search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(body, '')), 'B')
    ) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ANN index for vector similarity (IVFFlat is widely available; HNSW where supported)
CREATE INDEX IF NOT EXISTS idx_setup_knowledge_embedding
    ON public.setup_knowledge USING hnsw (embedding vector_cosine_ops);

-- GIN index for full-text search
CREATE INDEX IF NOT EXISTS idx_setup_knowledge_search
    ON public.setup_knowledge USING gin (search_vector);

-- Category filter index
CREATE INDEX IF NOT EXISTS idx_setup_knowledge_category
    ON public.setup_knowledge (category);
