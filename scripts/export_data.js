const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');
const https = require('https');

const ROOT_DIR = path.resolve(__dirname, '..');
const CSV_FILE = path.join(ROOT_DIR, 'data.csv');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DISTRICTS_DIR = path.join(DATA_DIR, 'districts');

const GOOGLE_SHEETS_URL = 'https://docs.google.com/spreadsheets/d/194ei4yzOTUMrnMLe1fseis__QQnRGk6rwA6U_WSVEUA/export?format=csv&gid=1400833008';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DISTRICTS_DIR)) fs.mkdirSync(DISTRICTS_DIR, { recursive: true });

function downloadFromGoogleSheets(url, destPath) {
  return new Promise((resolve, reject) => {
    console.log('Downloading live dataset from Google Sheets...');
    function makeReq(curUrl) {
      https.get(curUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return makeReq(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Failed to download from Google Sheets, HTTP status: ${res.statusCode}`));
        }
        const tempPath = destPath + '.tmp';
        const file = fs.createWriteStream(tempPath);
        let downloadedBytes = 0;
        res.on('data', chunk => {
          downloadedBytes += chunk.length;
          if (downloadedBytes % (4 * 1024 * 1024) < chunk.length) {
            process.stdout.write(`Downloaded ${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB...\r`);
          }
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            if (fs.existsSync(destPath)) {
              try { fs.unlinkSync(destPath); } catch (_) {}
            }
            fs.renameSync(tempPath, destPath);
            console.log(`\nGoogle Sheets download complete: ${(fs.statSync(destPath).size / (1024 * 1024)).toFixed(2)} MB saved to data.csv`);
            resolve();
          });
        });
      }).on('error', reject);
    }
    makeReq(url);
  });
}

function parseLine(text) {
  const res = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQ && text[i+1] === '"') { cur += '"'; i++; }
      else { inQ = !inQ; }
    } else if (c === ',' && !inQ) {
      res.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  res.push(cur.trim());
  return res;
}

function toSlug(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

async function runExport() {
  const shouldSyncFromSheets = process.argv.includes('--from-sheets') || 
                               process.argv.includes('-s') || 
                               !fs.existsSync(CSV_FILE);
  if (shouldSyncFromSheets) {
    try {
      await downloadFromGoogleSheets(GOOGLE_SHEETS_URL, CSV_FILE);
    } catch (err) {
      console.warn('Google Sheets live download warning:', err.message);
      if (!fs.existsSync(CSV_FILE)) {
        throw new Error('data.csv does not exist and Google Sheets download failed: ' + err.message);
      }
      console.log('Falling back to local data.csv...');
    }
  }

  console.log('Starting export on Sangathan dataset...');
  console.log('Reading from:', CSV_FILE);

  const fileStream = fs.createReadStream(CSV_FILE);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let header = null;
  let inQuotes = false;
  let currentRecord = '';

  const records = [];
  const seen = new Set();
  let totalRawRows = 0;
  let dupesRemoved = 0;

  for await (const line of rl) {
    let quoteCount = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') quoteCount++;
    }

    if (currentRecord) currentRecord += '\n' + line;
    else currentRecord = line;

    if (!inQuotes) {
      if (quoteCount % 2 !== 0) inQuotes = true;
      else {
        processRow(currentRecord);
        currentRecord = '';
      }
    } else {
      if (quoteCount % 2 !== 0) {
        inQuotes = false;
        processRow(currentRecord);
        currentRecord = '';
      }
    }
  }

  function processRow(recText) {
    if (!recText.trim()) return;
    if (!header) {
      header = parseLine(recText);
      console.log('Headers detected:', header);
      return;
    }

    totalRawRows++;
    const vals = parseLine(recText);
    const row = {};
    header.forEach((h, idx) => {
      row[h] = (vals[idx] || '').trim();
    });

    const name = row['Name'] || '';
    const father = row["Father/Husband's Name"] || '';
    let contact = (row['Contact No.'] || '').replace(/\D/g, '');
    if (contact.length === 12 && contact.startsWith('91')) contact = contact.slice(2);
    if (contact.length === 11 && contact.startsWith('0')) contact = contact.slice(1);
    if (contact.length !== 10) contact = (row['Contact No.'] || '').trim();

    const dist = row['District'] || 'Unknown';
    const block = row['Block'] || '';
    const pan = row['Panchayat'] || '';
    const des = row['Current JS Designation Final'] || '';

    // Smart deduplication: keeps unique position per person (approx 122,000 records)
    const dedupKey = contact && contact.length === 10
      ? `${contact}_${name}_${des}`.toLowerCase()
      : `${name}_${father}_${dist}_${block}_${pan}_${des}`.toLowerCase();

    if (seen.has(dedupKey)) {
      dupesRemoved++;
      return;
    }
    seen.add(dedupKey);

    records.push({
      'District': dist,
      'Name': name,
      "Father/Husband's Name": father,
      'Contact No.': row['Contact No.'] || '',
      'Anumandal': row['Anumandal'] || '',
      'Block': block,
      'Panchayat': pan,
      'Age': row['Age'] || '',
      'Category': row['Category'] || '',
      'Caste': row['Caste'] || '',
      'Gender': row['Gender'] || '',
      'Current JS Designation Final': des,
      'Profile': row['Profile'] || '',
      'Calling Status': row['Calling Status'] || '',
      'Meeting Status (Baithak)': row['Meeting Status (Baithak)'] || '',
      'Current  Status': row['Current  Status'] || '',
      'Remarks': row['Remarks'] || '',
      'Reason For Inactive': row['Reason For Inactive'] || ''
    });

    if (records.length % 25000 === 0) {
      console.log(`Accumulated ${records.length} unique records (raw: ${totalRawRows})...`);
    }
  }

  console.log(`\nParsing complete!`);
  console.log(`Total raw rows: ${totalRawRows}`);
  console.log(`Duplicates removed: ${dupesRemoved}`);
  console.log(`Unique records: ${records.length}`);

  // 1. Group by District
  const districtMap = {};
  const districtCounts = {};
  const blocksByDistrict = {};
  const categoriesSet = new Set();
  const castesSet = new Set();
  const gendersSet = new Set();
  const designationsSet = new Set();
  const statusesSet = new Set();
  const anumandalsSet = new Set();

  let femaleCount = 0;
  let missingContact = 0;
  let missingGender = 0;
  let completeCount = 0;

  const ageBuckets = { '18-25': 0, '26-35': 0, '36-45': 0, '46-55': 0, '56-65': 0, '65+': 0, 'Unknown': 0 };
  const catCounts = {};
  const genderCounts = { male: 0, female: 0, other: 0 };
  const desigCounts = {};

  const DQ_KEYS = ['Name', 'Contact No.', 'District', 'Block', 'Panchayat', 'Category', 'Caste', 'Gender', 'Current JS Designation Final', 'Age'];
  const fieldFilledCounts = {};
  DQ_KEYS.forEach(k => fieldFilledCounts[k] = 0);

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const dist = r['District'] || 'Unknown';
    const slug = toSlug(dist);

    if (!districtMap[slug]) districtMap[slug] = [];
    districtMap[slug].push(r);
    districtCounts[dist] = (districtCounts[dist] || 0) + 1;

    if (!blocksByDistrict[dist]) blocksByDistrict[dist] = new Set();
    if (r['Block']) blocksByDistrict[dist].add(r['Block']);

    if (r['Category']) categoriesSet.add(r['Category']);
    if (r['Caste']) castesSet.add(r['Caste']);
    if (r['Gender']) gendersSet.add(r['Gender']);
    if (r['Current JS Designation Final']) designationsSet.add(r['Current JS Designation Final']);
    if (r['Current  Status']) statusesSet.add(r['Current  Status']);
    if (r['Anumandal']) anumandalsSet.add(r['Anumandal']);

    // Analytics
    if (r['Category']) catCounts[r['Category']] = (catCounts[r['Category']] || 0) + 1;
    const g = (r['Gender'] || '').toLowerCase();
    if (g === 'female') { genderCounts.female++; femaleCount++; }
    else if (g === 'male') { genderCounts.male++; }
    else { genderCounts.other++; }

    if (r['Current JS Designation Final']) {
      desigCounts[r['Current JS Designation Final']] = (desigCounts[r['Current JS Designation Final']] || 0) + 1;
    }

    const age = parseInt(r['Age'], 10);
    if (isNaN(age)) ageBuckets['Unknown']++;
    else if (age <= 25) ageBuckets['18-25']++;
    else if (age <= 35) ageBuckets['26-35']++;
    else if (age <= 45) ageBuckets['36-45']++;
    else if (age <= 55) ageBuckets['46-55']++;
    else if (age <= 65) ageBuckets['56-65']++;
    else ageBuckets['65+']++;

    // Data Quality
    let isComplete = true;
    for (const k of ['Name', 'Contact No.', 'Gender', 'District', 'Block', 'Category']) {
      if (!r[k]) { isComplete = false; break; }
    }
    if (isComplete) completeCount++;
    if (!r['Contact No.']) missingContact++;
    if (!r['Gender']) missingGender++;

    for (const k of DQ_KEYS) {
      if (r[k]) fieldFilledCounts[k]++;
    }
  }

  // Write district files
  const districtSlugs = {};
  for (const [slug, distRecords] of Object.entries(districtMap)) {
    const distPath = path.join(DISTRICTS_DIR, `${slug}.json`);
    fs.writeFileSync(distPath, JSON.stringify(distRecords), 'utf8');
    const dName = distRecords[0]['District'];
    districtSlugs[slug] = dName;
  }
  console.log(`Generated ${Object.keys(districtMap).length} district files in ${DISTRICTS_DIR}`);

  // 2. Initial view: first 200 records
  const initialRecords = records.slice(0, 200);
  const initialPath = path.join(DATA_DIR, 'initial.json');
  fs.writeFileSync(initialPath, JSON.stringify(initialRecords), 'utf8');
  console.log(`Generated initial.json with ${initialRecords.length} records`);

  // 3. Compact search index for serverless search
  const compactIndex = records.map(r => ({
    d: r['District'] || '',
    n: r['Name'] || '',
    f: r["Father/Husband's Name"] || '',
    c: r['Contact No.'] || '',
    b: r['Block'] || '',
    p: r['Panchayat'] || '',
    a: r['Age'] || '',
    cat: r['Category'] || '',
    cst: r['Caste'] || '',
    g: r['Gender'] || '',
    des: r['Current JS Designation Final'] || '',
    s: r['Current  Status'] || '',
    pr: r['Profile'] || ''
  }));
  const searchIndexPath = path.join(DATA_DIR, 'search_index.json');
  fs.writeFileSync(searchIndexPath, JSON.stringify(compactIndex), 'utf8');
  console.log(`Generated search_index.json (${(fs.statSync(searchIndexPath).size / (1024*1024)).toFixed(2)} MB)`);

  // 4. Summary JSON
  const blocksObj = {};
  for (const [dist, set] of Object.entries(blocksByDistrict)) {
    blocksObj[dist] = Array.from(set).sort((a,b) => a.localeCompare(b));
  }

  const topDist = Object.entries(districtCounts)
    .sort((a,b) => b[1] - a[1])
    .map(([dist, count]) => ({ district: dist, slug: toSlug(dist), count }));

  const topDesig = Object.entries(desigCounts)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 20);

  const topCats = Object.entries(catCounts)
    .sort((a,b) => b[1] - a[1]);

  const summary = {
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    totalContacts: records.length,
    totalRawRows: totalRawRows,
    totalDistricts: Object.keys(districtCounts).length,
    totalBlocks: Object.values(blocksByDistrict).reduce((acc, s) => acc + s.size, 0),
    totalDesignations: designationsSet.size,
    femaleCount: femaleCount,
    filterOptions: {
      districts: Object.keys(districtCounts).sort((a,b) => a.localeCompare(b)),
      blocksByDistrict: blocksObj,
      categories: Array.from(categoriesSet).sort((a,b) => a.localeCompare(b)),
      castes: Array.from(castesSet).sort((a,b) => a.localeCompare(b)),
      genders: Array.from(gendersSet).sort((a,b) => a.localeCompare(b)),
      designations: Array.from(designationsSet).sort((a,b) => a.localeCompare(b)),
      statuses: Array.from(statusesSet).sort((a,b) => a.localeCompare(b)),
      anumandals: Array.from(anumandalsSet).sort((a,b) => a.localeCompare(b))
    },
    analytics: {
      topDistricts: topDist,
      categories: topCats,
      gender: genderCounts,
      topDesignations: topDesig,
      age: ageBuckets
    },
    dataQuality: {
      total: records.length,
      completeCount: completeCount,
      partialCount: records.length - completeCount,
      missingContact: missingContact,
      missingGender: missingGender,
      fieldStats: DQ_KEYS.map(k => ({
        key: k,
        filled: fieldFilledCounts[k],
        missing: records.length - fieldFilledCounts[k],
        pct: (fieldFilledCounts[k] / records.length * 100).toFixed(1)
      }))
    }
  };

  const summaryPath = path.join(DATA_DIR, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`Generated summary.json (${(fs.statSync(summaryPath).size / 1024).toFixed(1)} KB)`);

  // 5. Ensure public directory exists for deployment platforms expecting "public" output
  const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
  if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  const filesToCopy = ['index.html', 'style.css', 'app.js', 'data.csv', '_headers'];
  for (const f of filesToCopy) {
    const src = path.join(ROOT_DIR, f);
    if (fs.existsSync(src)) {
      try { fs.copyFileSync(src, path.join(PUBLIC_DIR, f)); } catch (_) {}
    }
  }
  const publicDataDir = path.join(PUBLIC_DIR, 'data');
  if (!fs.existsSync(publicDataDir)) {
    try {
      fs.cpSync(DATA_DIR, publicDataDir, { recursive: true });
    } catch (_) {}
  }
  console.log(`Synchronized static assets into public directory (${PUBLIC_DIR})`);

  console.log('=== EXPORT PIPELINE SUCCESSFUL ===');
}

if (require.main === module) {
  runExport().catch(err => {
    console.error('Export failed:', err);
    process.exit(1);
  });
}

module.exports = { runExport, GOOGLE_SHEETS_URL };
