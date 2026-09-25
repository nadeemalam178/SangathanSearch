const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Load .env file automatically
try {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim();
        if (!process.env[k]) process.env[k] = v;
      }
    }
  }
} catch (_) {}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
function getSupabase() {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    supabase = createClient(url, key);
  }
  return supabase;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    if (res.status) res.status(204).end();
    else { res.statusCode = 204; res.end(); }
    return;
  }

  const client = getSupabase();
  if (!client) {
    const err = { error: 'Supabase credentials not configured. Please set SUPABASE_URL and SUPABASE_ANON_KEY.' };
    if (res.status) res.status(500).json(err);
    else { res.statusCode = 500; res.end(JSON.stringify(err)); }
    return;
  }

  const queryParams = req.query || {};
  const q = (queryParams.q || '').trim();
  const district = (queryParams.district || '').trim();
  const block = (queryParams.block || '').trim();
  const category = (queryParams.category || '').trim();
  const caste = (queryParams.caste || '').trim();
  const gender = (queryParams.gender || '').trim();
  const designation = (queryParams.designation || '').trim();
  const page = Math.max(1, parseInt(queryParams.page || '1', 10));
  const perPage = Math.min(500, Math.max(10, parseInt(queryParams.perPage || '50', 10)));
  const offset = (page - 1) * perPage;

  try {
    let query = client.from('members').select('*', { count: 'exact' });

    if (district) query = query.ilike('district', district);
    if (block) query = query.ilike('block', block);
    if (category) query = query.ilike('category', category);
    if (caste) query = query.ilike('caste', caste);
    if (gender) query = query.ilike('gender', gender);
    if (designation) query = query.ilike('designation', designation);

    if (q) {
      query = query.or(`name.ilike.%${q}%,contact_no.ilike.%${q}%,block.ilike.%${q}%,panchayat.ilike.%${q}%,caste.ilike.%${q}%`);
    }

    const { data, count, error } = await query
      .range(offset, offset + perPage - 1)
      .order('id', { ascending: true });

    if (error) throw error;

    // Map to frontend expected schema
    const results = (data || []).map(r => ({
      'District': r.district,
      'Name': r.name,
      "Father/Husband's Name": r.father_name,
      'Contact No.': r.contact_no,
      'Anumandal': r.anumandal,
      'Block': r.block,
      'Panchayat': r.panchayat,
      'Age': r.age,
      'Category': r.category,
      'Caste': r.caste,
      'Gender': r.gender,
      'Current JS Designation Final': r.designation,
      'Profile': r.profile,
      'Calling Status': r.calling_status,
      'Meeting Status (Baithak)': r.meeting_status,
      'Current  Status': r.status,
      'Remarks': r.remarks,
      'Reason For Inactive': r.reason_for_inactive
    }));

    const responsePayload = {
      total: count || results.length,
      page,
      perPage,
      totalPages: Math.ceil((count || results.length) / perPage),
      results
    };

    if (res.status) res.status(200).json(responsePayload);
    else { res.statusCode = 200; res.end(JSON.stringify(responsePayload)); }
  } catch (err) {
    console.error('Supabase search query error:', err);
    if (res.status) res.status(500).json({ error: err.message });
    else { res.statusCode = 500; res.end(JSON.stringify({ error: err.message })); }
  }
};
