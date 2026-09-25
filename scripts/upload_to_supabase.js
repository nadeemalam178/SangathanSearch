const fs = require('fs');
const path = require('path');
const readline = require('readline');
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

// Load env or config
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('\n❌ Error: Missing Supabase credentials.');
  console.error('Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).');
  console.error('Example (PowerShell):');
  console.error('  $env:SUPABASE_URL="https://your-project.supabase.co"');
  console.error('  $env:SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"');
  console.error('  node scripts/upload_to_supabase.js\n');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

const CSV_FILE = path.resolve(__dirname, '..', 'data.csv');

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

async function upload() {
  if (!fs.existsSync(CSV_FILE)) {
    console.error('Error: data.csv not found at:', CSV_FILE);
    process.exit(1);
  }

  console.log('Connecting to Supabase at:', SUPABASE_URL);
  console.log('Reading data.csv from:', CSV_FILE);

  const fileStream = fs.createReadStream(CSV_FILE);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let header = null;
  let inQuotes = false;
  let currentRecord = '';

  let batch = [];
  let totalUploaded = 0;
  let totalRows = 0;
  const seen = new Set();
  const BATCH_SIZE = 500;

  async function insertBatchWithRetry(items, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const { error } = await supabase.from('members').insert(items);
        if (error) throw error;
        totalUploaded += items.length;
        process.stdout.write(`\rUploaded ${totalUploaded.toLocaleString()} unique records to Supabase...`);
        return;
      } catch (err) {
        if (attempt === retries) throw err;
        console.warn(`\n[Retry ${attempt}/${retries}] Batch insert paused, retrying in 2s... (${err.message})`);
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }

  for await (const line of rl) {
    let quoteCount = 0;
    for (let i = 0; i < line.length; i++) if (line[i] === '"') quoteCount++;
    if (currentRecord) currentRecord += '\n' + line;
    else currentRecord = line;

    if (!inQuotes) {
      if (quoteCount % 2 !== 0) inQuotes = true;
      else {
        await handleRecord(currentRecord);
        currentRecord = '';
      }
    } else {
      if (quoteCount % 2 !== 0) {
        inQuotes = false;
        await handleRecord(currentRecord);
        currentRecord = '';
      }
    }
  }

  if (currentRecord.trim()) {
    await handleRecord(currentRecord);
  }

  if (batch.length > 0) {
    await insertBatchWithRetry(batch);
  }

  console.log(`\n\n🎉 Supabase upload complete! Total records uploaded: ${totalUploaded.toLocaleString()}`);

  async function handleRecord(recText) {
    if (!recText.trim()) return;
    if (!header) {
      header = parseLine(recText);
      console.log('CSV Headers detected:', header);
      return;
    }

    totalRows++;
    const vals = parseLine(recText);
    const row = {};
    header.forEach((h, idx) => { row[h] = (vals[idx] || '').trim(); });

    const name = row['Name'] || '';
    const father = row["Father/Husband's Name"] || '';
    const dist = row['District'] || 'Unknown';
    const block = row['Block'] || '';
    const pan = row['Panchayat'] || '';
    const des = row['Current JS Designation Final'] || '';
    let contact = (row['Contact No.'] || '').replace(/\D/g, '');
    if (contact.length === 12 && contact.startsWith('91')) contact = contact.slice(2);
    if (contact.length === 11 && contact.startsWith('0')) contact = contact.slice(1);
    if (contact.length !== 10) contact = (row['Contact No.'] || '').trim();

    // Deduplication matching export_data.js
    const dedupKey = contact && contact.length === 10
      ? `${contact}_${name}_${des}`.toLowerCase()
      : `${name}_${father}_${dist}_${block}_${pan}_${des}`.toLowerCase();

    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);

    batch.push({
      district: dist,
      name: name,
      father_name: father,
      contact_no: contact,
      anumandal: row['Anumandal'] || '',
      block: block,
      panchayat: pan,
      age: row['Age'] || '',
      category: row['Category'] || '',
      caste: row['Caste'] || '',
      gender: row['Gender'] || '',
      designation: des,
      profile: row['Profile'] || '',
      calling_status: row['Calling Status'] || '',
      meeting_status: row['Meeting Status (Baithak)'] || '',
      status: row['Current  Status'] || '',
      remarks: row['Remarks'] || '',
      reason_for_inactive: row['Reason For Inactive'] || ''
    });

    if (batch.length >= BATCH_SIZE) {
      const toSend = batch;
      batch = [];
      await insertBatchWithRetry(toSend);
    }
  }
}

upload().catch(err => {
  console.error('\nUpload failed:', err);
  process.exit(1);
});
