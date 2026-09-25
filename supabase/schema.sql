-- ════════════════════════════════════════════════════════
-- Sangathan Search — Supabase PostgreSQL Database Schema
-- ════════════════════════════════════════════════════════

-- 1. Create table for members / contacts
CREATE TABLE IF NOT EXISTS public.members (
    id BIGSERIAL PRIMARY KEY,
    district TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    father_name TEXT DEFAULT '',
    contact_no TEXT DEFAULT '',
    anumandal TEXT DEFAULT '',
    block TEXT DEFAULT '',
    panchayat TEXT DEFAULT '',
    age TEXT DEFAULT '',
    category TEXT DEFAULT '',
    caste TEXT DEFAULT '',
    gender TEXT DEFAULT '',
    designation TEXT DEFAULT '',
    profile TEXT DEFAULT '',
    calling_status TEXT DEFAULT '',
    meeting_status TEXT DEFAULT '',
    status TEXT DEFAULT '',
    remarks TEXT DEFAULT '',
    reason_for_inactive TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Indexes for high-speed filtering and analytics
CREATE INDEX IF NOT EXISTS idx_members_district ON public.members (district);
CREATE INDEX IF NOT EXISTS idx_members_block ON public.members (block);
CREATE INDEX IF NOT EXISTS idx_members_panchayat ON public.members (panchayat);
CREATE INDEX IF NOT EXISTS idx_members_category ON public.members (category);
CREATE INDEX IF NOT EXISTS idx_members_caste ON public.members (caste);
CREATE INDEX IF NOT EXISTS idx_members_gender ON public.members (gender);
CREATE INDEX IF NOT EXISTS idx_members_contact ON public.members (contact_no);
CREATE INDEX IF NOT EXISTS idx_members_designation ON public.members (designation);

-- 3. Full-Text Search Index (GIN) for instant multi-field searching
CREATE INDEX IF NOT EXISTS idx_members_fts ON public.members USING gin(
    to_tsvector('english', 
        coalesce(name, '') || ' ' || 
        coalesce(district, '') || ' ' || 
        coalesce(block, '') || ' ' || 
        coalesce(panchayat, '') || ' ' || 
        coalesce(caste, '') || ' ' || 
        coalesce(designation, '') || ' ' || 
        coalesce(contact_no, '') || ' ' ||
        coalesce(profile, '')
    )
);

-- 4. Enable Row Level Security (RLS)
ALTER TABLE public.members ENABLE ROW LEVEL SECURITY;

-- Allow public read access to all members (for website directory search)
CREATE POLICY "Allow public read access" 
ON public.members FOR SELECT 
TO anon, authenticated 
USING (true);

-- Allow service role full access (for backend scripts and Google Sheets sync)
CREATE POLICY "Allow service role full access" 
ON public.members FOR ALL 
TO service_role 
USING (true) 
WITH CHECK (true);

-- 5. Stored Procedure for lightning-fast paginated search
CREATE OR REPLACE FUNCTION public.search_members(
    query_text TEXT DEFAULT '',
    filter_district TEXT DEFAULT '',
    filter_block TEXT DEFAULT '',
    filter_category TEXT DEFAULT '',
    filter_caste TEXT DEFAULT '',
    filter_gender TEXT DEFAULT '',
    filter_designation TEXT DEFAULT '',
    limit_count INT DEFAULT 50,
    offset_count INT DEFAULT 0
)
RETURNS TABLE (
    id BIGINT,
    district TEXT,
    name TEXT,
    father_name TEXT,
    contact_no TEXT,
    anumandal TEXT,
    block TEXT,
    panchayat TEXT,
    age TEXT,
    category TEXT,
    caste TEXT,
    gender TEXT,
    designation TEXT,
    profile TEXT,
    status TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        m.id, m.district, m.name, m.father_name, m.contact_no,
        m.anumandal, m.block, m.panchayat, m.age, m.category,
        m.caste, m.gender, m.designation, m.profile, m.status
    FROM public.members m
    WHERE 
        (filter_district = '' OR m.district ILIKE filter_district)
        AND (filter_block = '' OR m.block ILIKE filter_block)
        AND (filter_category = '' OR m.category ILIKE filter_category)
        AND (filter_caste = '' OR m.caste ILIKE filter_caste)
        AND (filter_gender = '' OR m.gender ILIKE filter_gender)
        AND (filter_designation = '' OR m.designation ILIKE filter_designation)
        AND (
            query_text = '' OR 
            m.name ILIKE '%' || query_text || '%' OR
            m.contact_no ILIKE '%' || query_text || '%' OR
            m.block ILIKE '%' || query_text || '%' OR
            m.panchayat ILIKE '%' || query_text || '%' OR
            m.caste ILIKE '%' || query_text || '%' OR
            m.profile ILIKE '%' || query_text || '%'
        )
    ORDER BY m.id ASC
    LIMIT limit_count OFFSET offset_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
