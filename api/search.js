const fs = require('fs');
const path = require('path');

// In-memory cache across serverless warm invocations
let cachedIndex = null;

function loadIndex() {
  if (cachedIndex) return cachedIndex;
  try {
    let filePath = path.join(__dirname, '..', 'data', 'search_index.json');
    if (!fs.existsSync(filePath)) filePath = path.join(process.cwd(), 'data', 'search_index.json');
    if (fs.existsSync(filePath)) {
      cachedIndex = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return cachedIndex;
    }
  } catch (e) {
    console.error('Failed to load search index:', e);
  }
  return null;
}

const DEVANAGARI_MAP = {
  'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo',
  'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au',
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ng',
  'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'ny',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh',
  'ष': 'sh', 'स': 's', 'ह': 'h', 'क्ष': 'ksh', 'त्र': 'tr', 'ज्ञ': 'gy',
  '़': '', 'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u',
  'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ं': 'n', 'ँ': 'n',
  'ः': 'h', '्': '', 'ृ': 'ri', 'ड़': 'd', 'ढ़': 'dh', 'फ़': 'f', 'ज़': 'z'
};

function transliterateHindi(text) {
  if (!text) return '';
  let str = String(text);
  if (!/[\u0900-\u097F]/.test(str)) return '';
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    out += DEVANAGARI_MAP[ch] !== undefined ? DEVANAGARI_MAP[ch] : ch;
  }
  return out.toLowerCase().replace(/[^a-z0-9\s_]/g, '');
}

function normalize(str) {
  if (!str) return '';
  return String(str).toLowerCase().trim().replace(/\s+/g, ' ');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600');

  let query = '';
  let field = 'all';
  let district = '';
  let block = '';
  let category = '';
  let caste = '';
  let gender = '';
  let designation = '';
  let status = '';
  let anumandal = '';
  let page = 1;
  let perPage = 50;

  if (req.query) {
    if (req.query.q) query = String(req.query.q).trim();
    if (req.query.field) field = String(req.query.field).trim();
    if (req.query.district) district = String(req.query.district).trim().toLowerCase();
    if (req.query.block) block = String(req.query.block).trim().toLowerCase();
    if (req.query.category) category = String(req.query.category).trim().toLowerCase();
    if (req.query.caste) caste = String(req.query.caste).trim().toLowerCase();
    if (req.query.gender) gender = String(req.query.gender).trim().toLowerCase();
    if (req.query.designation) designation = String(req.query.designation).trim().toLowerCase();
    if (req.query.status) status = String(req.query.status).trim().toLowerCase();
    if (req.query.anumandal) anumandal = String(req.query.anumandal).trim().toLowerCase();
    if (req.query.page) page = Math.max(1, parseInt(req.query.page, 10) || 1);
    if (req.query.perPage) perPage = Math.min(1000, Math.max(10, parseInt(req.query.perPage, 10) || 50));
  } else if (req.url && req.url.includes('?')) {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const params = parsedUrl.searchParams;
      query = (params.get('q') || '').trim();
      field = (params.get('field') || 'all').trim();
      district = (params.get('district') || '').trim().toLowerCase();
      block = (params.get('block') || '').trim().toLowerCase();
      category = (params.get('category') || '').trim().toLowerCase();
      caste = (params.get('caste') || '').trim().toLowerCase();
      gender = (params.get('gender') || '').trim().toLowerCase();
      designation = (params.get('designation') || '').trim().toLowerCase();
      status = (params.get('status') || '').trim().toLowerCase();
      anumandal = (params.get('anumandal') || '').trim().toLowerCase();
      page = Math.max(1, parseInt(params.get('page'), 10) || 1);
      perPage = Math.min(1000, Math.max(10, parseInt(params.get('perPage'), 10) || 50));
    } catch (e) {}
  }

  const index = loadIndex();
  if (!index) {
    try {
      const supabaseSearchHandler = require('./supabase_search.js');
      return await supabaseSearchHandler(req, res);
    } catch (_) {
      return res.status(500).json({ error: 'Search index not available' });
    }
  }

  const rawQ = normalize(query);
  const translitQ = transliterateHindi(query);
  const isBulk = rawQ.includes('\n') || rawQ.includes(',');
  const bulkQueries = isBulk ? rawQ.split(/[\n,]+/).map(q => q.trim()).filter(Boolean) : null;

  const matches = [];

  for (let i = 0; i < index.length; i++) {
    const row = index[i];

    // Filter checks
    if (district && !row.d.toLowerCase().includes(district)) continue;
    if (block && !row.b.toLowerCase().includes(block)) continue;
    if (category && row.cat.toLowerCase() !== category) continue;
    if (caste && row.cst.toLowerCase() !== caste) continue;
    if (gender && row.g.toLowerCase() !== gender) continue;
    if (designation && row.des.toLowerCase() !== designation) continue;
    if (status && row.s.toLowerCase() !== status) continue;

    // Query match
    if (rawQ) {
      let matched = false;
      const matchText = (val, q, tq) => {
        if (!val) return false;
        const normVal = val.toLowerCase();
        return normVal.includes(q) || (tq && normVal.includes(tq));
      };

      const checkRow = (q, tq) => {
        if (field === 'all') {
          return matchText(row.n, q, tq) || matchText(row.c, q, '') ||
                 matchText(row.d, q, tq) || matchText(row.b, q, tq) ||
                 matchText(row.p, q, tq) || matchText(row.cat, q, tq) ||
                 matchText(row.cst, q, tq) || matchText(row.des, q, tq) ||
                 matchText(row.f, q, tq) || matchText(row.pr, q, tq);
        } else if (field === 'Name') return matchText(row.n, q, tq);
        else if (field === 'Contact No.') return matchText(row.c, q, '');
        else if (field === 'District') return matchText(row.d, q, tq);
        else if (field === 'Block') return matchText(row.b, q, tq);
        else if (field === 'Panchayat') return matchText(row.p, q, tq);
        else if (field === 'Category') return matchText(row.cat, q, tq);
        else if (field === 'Caste') return matchText(row.cst, q, tq);
        else if (field === 'Gender') return matchText(row.g, q, '');
        else if (field === 'Current JS Designation Final') return matchText(row.des, q, tq);
        else if (field === "Father/Husband's Name") return matchText(row.f, q, tq);
        else if (field === 'Profile') return matchText(row.pr, q, tq);
        return false;
      };

      if (isBulk && bulkQueries && bulkQueries.length > 0) {
        matched = bulkQueries.some(bq => checkRow(bq, ''));
      } else {
        matched = checkRow(rawQ, translitQ);
      }

      if (!matched) continue;
    }

    // Convert compact row to full schema expected by app.js
    matches.push({
      'District': row.d,
      'Name': row.n,
      "Father/Husband's Name": row.f,
      'Contact No.': row.c,
      'Anumandal': '',
      'Block': row.b,
      'Panchayat': row.p,
      'Age': row.a,
      'Category': row.cat,
      'Caste': row.cst,
      'Gender': row.g,
      'Current JS Designation Final': row.des,
      'Profile': row.pr,
      'Calling Status': '',
      'Meeting Status (Baithak)': '',
      'Current  Status': row.s,
      'Remarks': '',
      'Reason For Inactive': ''
    });
  }

  const totalMatches = matches.length;
  const startIdx = (page - 1) * perPage;
  const paginated = matches.slice(startIdx, startIdx + perPage);

  return res.status(200).json({
    total: totalMatches,
    page: page,
    perPage: perPage,
    totalPages: Math.ceil(totalMatches / perPage) || 1,
    results: paginated
  });
};
