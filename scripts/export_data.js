const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');

const targetProjectDir = path.resolve('C:/Users/alamn/Downloads/Sangathan Search Website');
const csvPath = path.join(targetProjectDir, 'data.csv');
const dataDir = path.join(targetProjectDir, 'data');
const districtsDir = path.join(dataDir, 'districts');
const scriptsDir = path.join(targetProjectDir, 'scripts');

[dataDir, districtsDir, scriptsDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

console.log('Starting export pipeline for Sangathan Search...');
console.log('Source CSV:', csvPath);
if (!fs.existsSync(csvPath)) {
  console.error('Error: data.csv not found at', csvPath);
  process.exit(1);
}

const districtAliases = {
  'bhagalpur': 'Bhagalpur', 'khagaria': 'Khagaria',
  'sarhasa': 'Saharsa', 'purnea': 'Purnia'
};
const blockAliases = {
  'farbeesganj': 'Forbesganj', 'jokiaat': 'Jokihat',
  'jokihat': 'Jokihat', 'narkatiyaganj': 'Narkatiaganj',
  'majhauliya': 'Majhaulia'
};

function normalizeRow(row) {
  const clean = val => String(val || '').trim().replace(/\s+/g, ' ');
  const d = clean(row['District']);
  const b = clean(row['Block']);
  row['District'] = districtAliases[d.toLowerCase()] || d;
  row['Block'] = blockAliases[b.toLowerCase()] || b;

  const gender = clean(row['Gender']).toLowerCase().replace(/[.\s_-]/g, '');
  if (gender && (/^female$|^f$|women|महिला/.test(gender))) row['Gender'] = 'Female';
  else if (gender && (/^male$|^m$|पुरुष|पुरूष/.test(gender))) row['Gender'] = 'Male';
  else row['Gender'] = '';

  const cat = clean(row['Category']).toLowerCase().replace(/[.\s_-]/g, '');
  if (!cat) row['Category'] = '';
  else if (/^(general|gen|gn|open)|genral|genaral|gneral|genereal|generaal|generl/.test(cat)) row['Category'] = 'General';
  else if (/^(obc|0bc)$/.test(cat)) row['Category'] = 'OBC';
  else if (/^ebc/.test(cat)) row['Category'] = 'EBC';
  else if (/^sc/.test(cat)) row['Category'] = 'SC';
  else if (/^st/.test(cat)) row['Category'] = 'ST';
  else if (/minor|muslim/.test(cat)) row['Category'] = 'Minority';
  else row['Category'] = 'Other / Unclear';

  if (row['Age']) {
    const n = parseInt(row['Age'], 10);
    row['Age'] = isNaN(n) ? '' : String(n);
  }
}

function parseContact(raw) {
  if (!raw) return '';
  const parts = String(raw).split(/[\/,\n\r|&]+/).flatMap(p => p.trim().split(/\s+/));
  const valid = [];
  parts.forEach(p => {
    let digits = p.replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    if (digits.length === 10 && /^[6-9]/.test(digits)) {
      if (!valid.includes(digits)) valid.push(digits);
    }
  });
  return valid.join(' / ');
}

const slugify = str => str.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';

async function processData() {
  const rl = readline.createInterface({
    input: fs.createReadStream(csvPath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  let headerFields = null;
  let rawRowCount = 0;
  const dedupedRows = [];
  const seenKeys = new Set();
  const districtMap = new Map();
  const blocksByDistrict = {};

  const filterSets = {
    districts: new Set(),
    categories: new Set(),
    castes: new Set(),
    designations: new Set(),
    statuses: new Set(),
    anumandals: new Set()
  };

  const CORE_DQ = ['Name', 'District', 'Block', 'Contact No.', 'Current JS Designation Final'];
  const DQ_KEY_FIELDS = ['District', 'Block', 'Contact No.', 'Gender', 'Category', 'Age', 'Current JS Designation Final', 'Profile', 'Caste'];
  const fieldFilledCounts = {};
  DQ_KEY_FIELDS.forEach(f => fieldFilledCounts[f] = 0);
  let dqCompleteCount = 0;
  let dqMissingContact = 0;
  let dqMissingGender = 0;
  const ageBuckets = { '18-25': 0, '26-35': 0, '36-45': 0, '46-55': 0, '56-65': 0, '65+': 0, 'Unknown': 0 };

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (!headerFields) {
      headerFields = line.split(',').map(f => f.trim().replace(/^"|"$/g, ''));
      continue;
    }
    rawRowCount++;

    // Split CSV line respecting quotes
    const rowFields = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else { inQ = !inQ; }
      } else if (c === ',' && !inQ) {
        rowFields.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
    rowFields.push(cur.trim());

    const name = rowFields[1] || '';
    let contact = parseContact(rowFields[3] || '');
    const dedupKey = (contact + '_' + name).toLowerCase();
    if (seenKeys.has(dedupKey)) continue;
    seenKeys.add(dedupKey);

    const obj = {
      'District': rowFields[0] || '',
      'Name': name,
      "Father/Husband's Name": rowFields[2] || '',
      'Contact No.': contact,
      'Anumandal': rowFields[4] || '',
      'Block': rowFields[5] || '',
      'Panchayat': rowFields[6] || '',
      'Age': rowFields[7] || '',
      'Category': rowFields[8] || '',
      'Caste': rowFields[9] || '',
      'Gender': rowFields[10] || '',
      'Current JS Designation Final': rowFields[11] || '',
      'Profile': rowFields[12] || '',
      'Calling Status': rowFields[13] || '',
      'Meeting Status (Baithak)': rowFields[14] || '',
      'Current  Status': rowFields[15] || '',
      'Remarks': rowFields[16] || '',
      'Reason For Inactive': rowFields[17] || ''
    };

    normalizeRow(obj);
    dedupedRows.push(obj);

    const dist = obj['District'] || 'Other';
    const block = obj['Block'];
    const distSlug = slugify(dist);
    if (!districtMap.has(distSlug)) districtMap.set(distSlug, { name: dist, rows: [] });
    districtMap.get(distSlug).rows.push(obj);

    if (dist && dist !== '#N/A' && dist !== '#REF!') {
      filterSets.districts.add(dist);
      if (block && block !== '#N/A' && block !== '#REF!') {
        if (!blocksByDistrict[dist]) blocksByDistrict[dist] = new Set();
        blocksByDistrict[dist].add(block);
      }
    }
    if (obj['Category']) filterSets.categories.add(obj['Category']);
    if (obj['Caste']) filterSets.castes.add(obj['Caste']);
    if (obj['Current JS Designation Final']) filterSets.designations.add(obj['Current JS Designation Final']);
    if (obj['Current  Status']) filterSets.statuses.add(obj['Current  Status']);
    if (obj['Anumandal']) filterSets.anumandals.add(obj['Anumandal']);

    const ageNum = parseInt(obj['Age'], 10);
    if (isNaN(ageNum)) ageBuckets['Unknown']++;
    else if (ageNum <= 25) ageBuckets['18-25']++;
    else if (ageNum <= 35) ageBuckets['26-35']++;
    else if (ageNum <= 45) ageBuckets['36-45']++;
    else if (ageNum <= 55) ageBuckets['46-55']++;
    else if (ageNum <= 65) ageBuckets['56-65']++;
    else ageBuckets['65+']++;

    let isCoreComplete = true;
    for (const c of CORE_DQ) {
      if (!(obj[c] || '').trim()) { isCoreComplete = false; break; }
    }
    if (isCoreComplete) dqCompleteCount++;
    if (!obj['Contact No.']) dqMissingContact++;
    if (!obj['Gender']) dqMissingGender++;

    DQ_KEY_FIELDS.forEach(f => {
      if ((obj[f] || '').trim()) fieldFilledCounts[f]++;
    });
  }

  const totalContacts = dedupedRows.length;
  console.log(`Raw rows: ${rawRowCount}, Unique contacts: ${totalContacts}`);

  // 1. Write Districts JSON in Sangathan Search Website/data/districts/
  let totalDistBytes = 0;
  const districtSummaries = [];
  districtMap.forEach((data, slug) => {
    const filePath = path.join(districtsDir, `${slug}.json`);
    const jsonStr = JSON.stringify(data.rows);
    fs.writeFileSync(filePath, jsonStr);
    const size = fs.statSync(filePath).size;
    totalDistBytes += size;
    districtSummaries.push({
      district: data.name,
      slug: slug,
      count: data.rows.length,
      sizeKb: (size / 1024).toFixed(1)
    });
  });
  districtSummaries.sort((a, b) => b.count - a.count);
  console.log(`Generated ${districtMap.size} district files (${(totalDistBytes / (1024 * 1024)).toFixed(1)} MB total).`);

  const blocksObj = {};
  Object.entries(blocksByDistrict).forEach(([d, s]) => {
    blocksObj[d] = Array.from(s).sort();
  });

  const catCounts = {};
  filterSets.categories.forEach(c => catCounts[c] = 0);
  dedupedRows.forEach(r => {
    if (r['Category']) catCounts[r['Category']] = (catCounts[r['Category']] || 0) + 1;
  });
  const sortedCategories = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);

  let maleCount = 0;
  let femaleCount = 0;
  dedupedRows.forEach(r => {
    if (r['Gender'] === 'Male') maleCount++;
    else if (r['Gender'] === 'Female') femaleCount++;
  });

  const desCounts = {};
  dedupedRows.forEach(r => {
    const d = r['Current JS Designation Final'];
    if (d) desCounts[d] = (desCounts[d] || 0) + 1;
  });
  const topDesignations = Object.entries(desCounts).sort((a, b) => b[1] - a[1]).slice(0, 12);

  const fieldStats = DQ_KEY_FIELDS.map(f => {
    const filled = fieldFilledCounts[f] || 0;
    return {
      key: f,
      filled: filled,
      missing: totalContacts - filled,
      pct: totalContacts > 0 ? ((filled / totalContacts) * 100).toFixed(1) : '0.0'
    };
  });

  // 2. Summary JSON
  const summary = {
    version: 'v8.0',
    timestamp: Date.now(),
    totalContacts: totalContacts,
    totalRawRows: rawRowCount,
    totalDistricts: filterSets.districts.size,
    totalBlocks: Object.values(blocksObj).reduce((acc, b) => acc + b.length, 0),
    totalDesignations: filterSets.designations.size,
    femaleCount: femaleCount,
    filterOptions: {
      districts: Array.from(filterSets.districts).sort(),
      blocksByDistrict: blocksObj,
      categories: Array.from(filterSets.categories).sort(),
      castes: Array.from(filterSets.castes).sort(),
      genders: ['Male', 'Female'],
      designations: Array.from(filterSets.designations).sort(),
      statuses: Array.from(filterSets.statuses).sort(),
      anumandals: Array.from(filterSets.anumandals).sort()
    },
    analytics: {
      topDistricts: districtSummaries.slice(0, 20),
      categories: sortedCategories,
      gender: { male: maleCount, female: femaleCount, other: totalContacts - maleCount - femaleCount },
      topDesignations: topDesignations,
      age: ageBuckets
    },
    dataQuality: {
      total: totalContacts,
      completeCount: dqCompleteCount,
      partialCount: totalContacts - dqCompleteCount,
      missingContact: dqMissingContact,
      missingGender: dqMissingGender,
      fieldStats: fieldStats
    }
  };

  const summaryPath = path.join(dataDir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary));
  const sumSize = fs.statSync(summaryPath).size;
  const sumGz = zlib.gzipSync(JSON.stringify(summary)).length;
  console.log(`[OK] Generated summary.json (${(sumSize / 1024).toFixed(1)} KB raw, ${(sumGz / 1024).toFixed(1)} KB gzipped)`);

  // 3. Initial Contacts Page (first 200 records)
  const initialContacts = dedupedRows.slice(0, 200);
  const initialPath = path.join(dataDir, 'initial.json');
  fs.writeFileSync(initialPath, JSON.stringify(initialContacts));
  const initSize = fs.statSync(initialPath).size;
  const initGz = zlib.gzipSync(JSON.stringify(initialContacts)).length;
  console.log(`[OK] Generated initial.json (${(initSize / 1024).toFixed(1)} KB raw, ${(initGz / 1024).toFixed(1)} KB gzipped)`);

  // 4. Compact Search Index for Serverless Search API
  const compactIndex = dedupedRows.map((r, id) => ({
    id: id,
    n: r['Name'] || '',
    f: r["Father/Husband's Name"] || '',
    c: r['Contact No.'] || '',
    d: r['District'] || '',
    b: r['Block'] || '',
    p: r['Panchayat'] || '',
    cat: r['Category'] || '',
    cst: r['Caste'] || '',
    g: r['Gender'] || '',
    des: r['Current JS Designation Final'] || '',
    s: r['Current  Status'] || '',
    a: r['Age'] || '',
    pr: (r['Profile'] || '').slice(0, 100)
  }));
  const indexPath = path.join(dataDir, 'search_index.json');
  fs.writeFileSync(indexPath, JSON.stringify(compactIndex));
  const idxSize = fs.statSync(indexPath).size;
  const idxGz = zlib.gzipSync(JSON.stringify(compactIndex)).length;
  console.log(`[OK] Generated search_index.json (${(idxSize / (1024 * 1024)).toFixed(1)} MB raw, ${(idxGz / (1024 * 1024)).toFixed(1)} MB gzipped)`);

  // Copy this script to Sangathan Search Website/scripts/export_data.js as well
  const scriptInSangathan = path.join(scriptsDir, 'export_data.js');
  fs.copyFileSync(__filename, scriptInSangathan);
  console.log('Saved export_data.js to:', scriptInSangathan);

  console.log('=== DATA EXPORT PIPELINE COMPLETE ===');
}

processData().catch(err => {
  console.error('Fatal export error:', err);
  process.exit(1);
});
