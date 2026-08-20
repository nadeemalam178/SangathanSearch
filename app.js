/* ══════════════════════════════════════════════════════
   Sangathan Search — Application Logic
   Optimisations:
     • IndexedDB caching (30-min TTL) — no re-download on reload
     • Chunked async CSV parse — keeps UI responsive, shows progress
     • Pre-built _searchText index per row — instant search
     • Lazy-load xlsx / jsPDF only when user hits Export
   ══════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── CONFIG ───────────────────────────────────────
  const SHEET_ID  = '194ei4yzOTUMrnMLe1fseis__QQnRGk6rwA6U_WSVEUA';
  const GID       = '1400833008';
  const CSV_URL   = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;

  const CACHE_DB_NAME    = 'SangathanCache';
  const CACHE_STORE_NAME = 'csvCache';
  const CACHE_TTL_MS     = 30 * 60 * 1000; // 30 minutes
  const CACHE_KEY        = 'sangathan_data_v2'; // bumped: contact numbers re-parsed

  const COLUMNS = [
    'District', 'Name', "Father/Husband's Name", 'Contact No.', 'Anumandal',
    'Block', 'Panchayat', 'Age', 'Category', 'Caste', 'Gender',
    'Current JS Designation Final', 'Profile', 'Calling Status',
    'Meeting Status (Baithak)', 'Current  Status', 'Remarks',
    'Reason For Inactive'
  ];

  // ─── STATE ────────────────────────────────────────
  let allData       = [];
  let filteredData  = [];
  let currentPage   = 1;
  let perPage       = 50;
  let sortCol       = null;
  let sortDir       = 'asc';
  let searchField   = 'all';
  let chartInstances = {};
  let totalRawRows  = 0;

  // Lazy-loaded lib references
  let _xlsxLoaded  = false;
  let _jspdfLoaded = false;

  // ─── DOM REFS ─────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const loader        = $('#loader');
  const loaderText    = $('#loader-text');
  const loaderSub     = $('#loader-sub');
  const loaderProgWrap= $('#loader-progress-wrap');
  const loaderProgBar = $('#loader-progress-bar');
  const loaderProgLbl = $('#loader-progress-label');
  const searchInput   = $('#search-input');
  const filterToggle  = $('#filter-toggle');
  const filtersPanel  = $('#filters-panel');
  const tableBody     = $('#table-body');
  const pagination    = $('#pagination');
  const resultsCount  = $('#results-count');
  const activeBadges  = $('#active-filters');
  const detailModal   = $('#detail-modal');
  const perPageSelect = $('#per-page-select');
  const bulkModal     = $('#bulk-modal');
  const bulkSearchText= $('#bulk-search-text');

  // ─── LOADER HELPERS ───────────────────────────────
  function setLoaderStatus(text, sub) {
    if (loaderText) loaderText.textContent = text;
    if (loaderSub)  loaderSub.textContent  = sub;
  }

  function setLoaderProgress(pct) {
    if (!loaderProgWrap) return;
    loaderProgWrap.style.display = 'block';
    loaderProgBar.style.width    = pct + '%';
    loaderProgLbl.textContent    = Math.round(pct) + '%';
  }

  function hideLoader() {
    loader.classList.add('hidden');
    setTimeout(() => { loader.style.display = 'none'; }, 600);
  }

  // ─── IndexedDB CACHE ──────────────────────────────
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CACHE_DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        e.target.result.createObjectStore(CACHE_STORE_NAME);
      };
      req.onsuccess  = (e) => resolve(e.target.result);
      req.onerror    = ()  => reject(req.error);
    });
  }

  async function getCached() {
    try {
      const db = await openDB();
      return new Promise((resolve) => {
        const tx  = db.transaction(CACHE_STORE_NAME, 'readonly');
        const req = tx.objectStore(CACHE_STORE_NAME).get(CACHE_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror   = () => resolve(null);
      });
    } catch { return null; }
  }

  async function setCached(payload) {
    try {
      const db = await openDB();
      return new Promise((resolve) => {
        const tx  = db.transaction(CACHE_STORE_NAME, 'readwrite');
        tx.objectStore(CACHE_STORE_NAME).put(payload, CACHE_KEY);
        tx.oncomplete = resolve;
        tx.onerror    = resolve; // fail silently
      });
    } catch { /* ignore */ }
  }

  // ─── CONTACT NUMBER PARSER ────────────────────────
  /**
   * Splits a raw contact field that may contain multiple phone numbers
   * separated by /, comma, newline, or space.
   * Normalises each to a 10-digit Indian mobile and returns them
   * joined as "XXXXXXXXXX / XXXXXXXXXX".
   */
  function parseContactNumbers(raw) {
    if (!raw) return '';

    // Split on common separators: / , newline  and plain space
    const parts = raw.split(/[\/,\n\r|&]+/).flatMap(p => p.trim().split(/\s+/));

    const valid = [];
    for (let part of parts) {
      // Keep only digits and leading +
      let digits = part.replace(/[^0-9]/g, '');

      // Strip country code prefix: +91 / 91 (12 digits) or leading 0 (11 digits)
      if (digits.length === 12 && digits.startsWith('91')) {
        digits = digits.slice(2);
      } else if (digits.length === 11 && digits.startsWith('0')) {
        digits = digits.slice(1);
      }

      // Accept valid 10-digit Indian mobile (starts with 6-9)
      if (digits.length === 10 && /^[6-9]/.test(digits)) {
        if (!valid.includes(digits)) valid.push(digits);
      } else if (digits.length > 0 && digits.length !== 10) {
        // Non-standard length — keep as-is so we don't lose data
        if (!valid.includes(digits)) valid.push(digits);
      }
    }

    return valid.length > 0 ? valid.join(' / ') : raw.replace(/[^0-9+\/,\s]/g, '').trim();
  }

  // ─── CSV PARSER ───────────────────────────────────

  /**
   * Fast CSV → array-of-objects in async chunks.
   * Calls onProgress(pct 0-100) while parsing.
   */
  function csvToObjectsAsync(text, onProgress) {
    return new Promise((resolve) => {
      const CHUNK = 1000; // rows per chunk
      const parsedRows = [];
      let current   = '';
      let inQuotes  = false;
      let fields    = [];
      const chars   = text; // already normalized below
      const len     = chars.length;
      let i         = 0;

      // Normalise line endings up-front (fast replace)
      const normalised = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const src        = normalised;
      const srcLen     = src.length;

      // Re-use same vars
      current  = '';
      inQuotes = false;
      fields   = [];

      let chunkRowCount = 0;

      function processChunk() {
        const chunkStart = i;
        let rowsInThisChunk = 0;

        while (i < srcLen && rowsInThisChunk < CHUNK) {
          const ch = src[i];
          if (ch === '"') {
            if (inQuotes && src[i + 1] === '"') {
              current += '"';
              i++;
            } else {
              inQuotes = !inQuotes;
            }
          } else if (ch === ',' && !inQuotes) {
            fields.push(current.trim());
            current = '';
          } else if (ch === '\n' && !inQuotes) {
            fields.push(current.trim());
            parsedRows.push([...fields]);
            fields   = [];
            current  = '';
            rowsInThisChunk++;
          } else {
            current += ch;
          }
          i++;
        }

        // Report progress
        onProgress && onProgress((i / srcLen) * 100);

        if (i < srcLen) {
          // Schedule next chunk so browser can breathe
          setTimeout(processChunk, 0);
        } else {
          // Last field / row
          fields.push(current.trim());
          if (fields.some(f => f.length > 0)) parsedRows.push([...fields]);

          // Convert rows → objects
          if (parsedRows.length === 0) return resolve([]);
          const headers = parsedRows[0];
          const objects = [];

          for (let r = 1; r < parsedRows.length; r++) {
            const row = parsedRows[r];
            if (row.length < 2 || (row[0] === '' && row[1] === '')) continue;

            const obj = {};
            for (let c = 0; c < COLUMNS.length; c++) {
              obj[COLUMNS[c]] = (row[c] || '').trim();
            }
            // Clean age
            if (obj['Age']) {
              const n = parseInt(obj['Age'], 10);
              obj['Age'] = isNaN(n) ? '' : String(n);
            }
            // Clean contact — split multiple numbers, normalise each to 10 digits
            if (obj['Contact No.']) {
              obj['Contact No.'] = parseContactNumbers(obj['Contact No.']);
            }
            // ── PRE-BUILD SEARCH INDEX (key optimisation) ──
            obj._searchText = COLUMNS.map(c => obj[c] || '').join(' ').toLowerCase();

            objects.push(obj);
          }
          resolve(objects);
        }
      }

      processChunk();
    });
  }

  // ─── DATA LOADING ─────────────────────────────────
  async function loadData() {
    setLoaderStatus('Loading Sangathan Data', 'Checking local cache…');

    // 1. Try IndexedDB cache first
    const cached = await getCached();
    if (cached && cached.ts && (Date.now() - cached.ts < CACHE_TTL_MS)) {
      setLoaderStatus('Loading Sangathan Data', 'Loading from cache…');
      setLoaderProgress(90);
      await processData(cached.data);
      setLoaderProgress(100);
      hideLoader();
      showToast('✅ Loaded ' + allData.length + ' contacts (from cache)', 'success');
      return;    }

    // 2. Fetch fresh CSV
    try {
      setLoaderStatus('Fetching Data', 'Downloading from Google Sheets…');
      const resp = await fetch(CSV_URL);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const text = await resp.text();
      setLoaderStatus('Parsing Data', 'Processing records…');
      setLoaderProgress(10);

      // 3. Parse in async chunks with progress
      const raw = await csvToObjectsAsync(text, (pct) => {
        setLoaderProgress(10 + pct * 0.7); // 10-80%
      });

      setLoaderProgress(85);
      setLoaderStatus('Processing', 'Indexing contacts…');

      await processData(raw);

      // 4. Cache result
      await setCached({ ts: Date.now(), data: allData });

      setLoaderProgress(100);
      hideLoader();
      showToast('✅ Loaded ' + allData.length + ' contacts', 'success');

    } catch (err) {
      console.error('Failed to load data:', err);
      loaderText.textContent = 'Failed to load data';
      loaderSub.textContent  = err.message + ' — Please refresh';
      showToast('❌ Failed to load data: ' + err.message, 'error');
    }
  }

  async function processData(raw) {
    // De-duplicate: keep only the first occurrence, silently discard duplicates
    const seen   = new Set();
    const deduped = [];
    totalRawRows  = raw.length;

    for (const row of raw) {
      // Ensure search index exists
      if (!row._searchText) {
        row._searchText = COLUMNS.map(c => row[c] || '').join(' ').toLowerCase();
      }

      const contact = (row['Contact No.'] || '').trim();
      const name    = (row['Name']        || '').trim();

      if (!contact && !name) { deduped.push(row); continue; }

      const key = `${contact}_${name}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(row);
      }
    }

    allData      = deduped;
    filteredData = [...allData];

    populateFilters();
    updateStats();
    renderTable();
  }

  // ─── POPULATE FILTER DROPDOWNS ────────────────────
  function populateFilters() {
    const filterConfigs = [
      { id: 'filter-district',    col: 'District' },
      { id: 'filter-block',       col: 'Block' },
      { id: 'filter-category',    col: 'Category' },
      { id: 'filter-caste',       col: 'Caste' },
      { id: 'filter-designation', col: 'Current JS Designation Final' },
      { id: 'filter-status',      col: 'Current  Status' },
      { id: 'filter-anumandal',   col: 'Anumandal' },
    ];

    for (const cfg of filterConfigs) {
      const select = $(`#${cfg.id}`);
      if (!select) continue;
      const values = [...new Set(allData.map(d => d[cfg.col]).filter(v => v && v !== '#N/A' && v !== '#REF!'))].sort();
      const firstOpt = select.options[0].outerHTML;
      select.innerHTML = firstOpt;
      // Use DocumentFragment for performance
      const frag = document.createDocumentFragment();
      for (const val of values) {
        const opt = document.createElement('option');
        opt.value = opt.textContent = val;
        frag.appendChild(opt);
      }
      select.appendChild(frag);
    }
  }

  // ─── STATS ────────────────────────────────────────
  function updateStats() {
    const data = filteredData;
    $('#stat-total').textContent        = data.length.toLocaleString();
    $('#stat-districts').textContent    = new Set(data.map(d => d['District']).filter(Boolean)).size;
    $('#stat-blocks').textContent       = new Set(data.map(d => d['Block']).filter(Boolean)).size;
    $('#stat-designations').textContent = new Set(data.map(d => d['Current JS Designation Final']).filter(Boolean)).size;
    $('#stat-female').textContent       = data.filter(d => d['Gender'] && d['Gender'].toLowerCase() === 'female').length;
  }

  // ─── SEARCH & FILTER ─────────────────────────────
  function applySearchAndFilters() {
    const query = searchInput.value.toLowerCase().trim();
    const filters = {
      'District':                     $('#filter-district').value,
      'Block':                        $('#filter-block').value,
      'Category':                     $('#filter-category').value,
      'Caste':                        $('#filter-caste').value,
      'Gender':                       $('#filter-gender').value,
      'Current JS Designation Final': $('#filter-designation').value,
      'Current  Status':              $('#filter-status').value,
      'Anumandal':                    $('#filter-anumandal').value,
    };

    const hasDropdownFilter = Object.values(filters).some(Boolean);

    filteredData = allData.filter(row => {
      // ── Text search uses pre-built _searchText ──
      if (query) {
        let matched = false;

        if (query.includes('\n') || query.includes(',')) {
          // Bulk search
          const bulkQueries = query.split(/[\n,]+/).map(q => q.trim()).filter(Boolean);
          if (bulkQueries.length > 0) {
            matched = bulkQueries.some(bq => {
              if (searchField === 'all') return row._searchText.includes(bq);
              return (row[searchField] || '').toLowerCase().includes(bq);
            });
          } else {
            matched = true;
          }
        } else {
          // Single query — use pre-built index for "all" searches
          if (searchField === 'all') {
            matched = row._searchText.includes(query);
          } else {
            matched = (row[searchField] || '').toLowerCase().includes(query);
          }
        }

        if (!matched) return false;
      }

      // Dropdown filters
      if (hasDropdownFilter) {
        for (const [col, val] of Object.entries(filters)) {
          if (val && row[col] !== val) return false;
        }
      }
      return true;
    });

    currentPage = 1;
    updateStats();
    renderTable();
    renderActiveBadges(filters);
    updateSearchPlaceholder();
  }

  function renderActiveBadges(filters) {
    activeBadges.innerHTML = '';
    const query = searchInput.value.trim();
    if (query) {
      const fieldLabel = searchField === 'all' ? 'All Fields' : getFieldLabel(searchField);
      activeBadges.innerHTML += `<span class="filter-badge">🔎 ${fieldLabel}: "${esc(query)}" <button onclick="document.getElementById('search-input').value='';window._applyFilters();">×</button></span>`;
    }
    for (const [col, val] of Object.entries(filters)) {
      if (val) {
        const shortCol = col.replace('Current JS Designation Final', 'Designation').replace('Current  Status', 'Status');
        activeBadges.innerHTML += `<span class="filter-badge">${shortCol}: ${val} <button data-filter-col="${col}" onclick="window._clearSingleFilter(this.dataset.filterCol);">×</button></span>`;
      }
    }
  }

  function getFieldLabel(field) {
    const labels = {
      'Name': 'Name', 'Contact No.': 'Contact No.', 'District': 'District',
      'Block': 'Block', 'Panchayat': 'Panchayat', 'Category': 'Category',
      'Caste': 'Caste', 'Gender': 'Gender', 'Anumandal': 'Anumandal',
      'Current JS Designation Final': 'Designation',
      "Father/Husband's Name": 'Father/Husband', 'Profile': 'Profile',
    };
    return labels[field] || field;
  }

  function updateSearchPlaceholder() {
    const placeholders = {
      'all': 'Type anything — name, number, district, caste…',
      'Name': 'Search by name…',
      'Contact No.': 'Search by mobile number…',
      'District': 'Search by district name…',
      'Block': 'Search by block name…',
      'Panchayat': 'Search by panchayat name…',
      'Category': 'Search by category…',
      'Caste': 'Search by caste name…',
      'Gender': 'Male or Female…',
      'Current JS Designation Final': 'Search by designation…',
      "Father/Husband's Name": 'Search by father or husband name…',
      'Profile': 'Search within profile…',
      'Anumandal': 'Search by anumandal…',
    };
    searchInput.placeholder = placeholders[searchField] || placeholders['all'];
  }

  // Exposed for inline onclick
  window._applyFilters = applySearchAndFilters;
  window._clearSingleFilter = function (col) {
    const map = {
      'District': 'filter-district', 'Block': 'filter-block',
      'Category': 'filter-category', 'Caste': 'filter-caste',
      'Gender': 'filter-gender',
      'Current JS Designation Final': 'filter-designation',
      'Current  Status': 'filter-status', 'Anumandal': 'filter-anumandal',
    };
    const id = map[col];
    if (id) $(`#${id}`).value = '';
    applySearchAndFilters();
  };

  // ─── SORTING ──────────────────────────────────────
  function sortData(col) {
    if (sortCol === col) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortCol = col;
      sortDir = 'asc';
    }

    filteredData.sort((a, b) => {
      let av = a[col] || '';
      let bv = b[col] || '';
      if (col === 'Age' || col === 'Contact No.') {
        av = parseInt(av, 10) || 0;
        bv = parseInt(bv, 10) || 0;
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      av = av.toLowerCase();
      bv = bv.toLowerCase();
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ?  1 : -1;
      return 0;
    });

    $$('thead th').forEach(th => {
      th.classList.remove('sorted');
      th.querySelector('.sort-arrow').textContent = '▲';
    });
    const activeTh = $(`thead th[data-col="${col}"]`);
    if (activeTh) {
      activeTh.classList.add('sorted');
      activeTh.querySelector('.sort-arrow').textContent = sortDir === 'asc' ? '▲' : '▼';
    }

    renderTable();
  }

  // ─── TABLE RENDERING ──────────────────────────────
  function renderTable() {
    const start    = (currentPage - 1) * perPage;
    const end      = start + perPage;
    const pageData = filteredData.slice(start, end);

    resultsCount.innerHTML = `Showing <strong>${Math.min(start + 1, filteredData.length)}–${Math.min(end, filteredData.length)}</strong> of <strong>${filteredData.length.toLocaleString()}</strong> contacts`;

    if (pageData.length === 0) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="8">
            <div class="empty-state">
              <div class="empty-icon">🔍</div>
              <h3>No results found</h3>
              <p>Try adjusting your search or filters</p>
            </div>
          </td>
        </tr>
      `;
      pagination.innerHTML = '';
      return;
    }

    // Build HTML with array join (fastest DOM update)
    const rows = new Array(pageData.length);
    for (let k = 0; k < pageData.length; k++) {
      const row = pageData[k];
      const catClass    = getCategoryClass(row['Category']);
      const genderClass = row['Gender']?.toLowerCase() === 'female' ? 'cell-gender-female' : 'cell-gender-male';
      rows[k] = `<tr data-index="${start + k}">
        <td class="cell-name">${esc(row['Name'])}</td>
        <td class="cell-district">${esc(row['District'])}</td>
        <td>${esc(row['Block'])}</td>
        <td>${esc(row['Contact No.'])}</td>
        <td>${esc(row['Age'])}</td>
        <td><span class="cell-category ${catClass}">${esc(row['Category'])}</span></td>
        <td class="${genderClass}">${esc(row['Gender'])}</td>
        <td>${row['Current JS Designation Final'] ? `<span class="cell-designation">${esc(row['Current JS Designation Final'])}</span>` : ''}</td>
      </tr>`;
    }
    tableBody.innerHTML = rows.join('');

    renderPagination();
  }

  function getCategoryClass(cat) {
    if (!cat) return '';
    const c = cat.toLowerCase().trim();
    if (c.includes('general') || c === 'gen') return 'cat-general';
    if (c === 'obc')                           return 'cat-obc';
    if (c === 'ebc')                           return 'cat-ebc';
    if (c === 'sc')                            return 'cat-sc';
    if (c === 'st')                            return 'cat-st';
    if (c.includes('minority'))                return 'cat-minority';
    return 'cat-general';
  }

  function esc(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── PAGINATION ───────────────────────────────────
  function renderPagination() {
    const totalPages = Math.ceil(filteredData.length / perPage);
    if (totalPages <= 1) { pagination.innerHTML = ''; return; }

    const parts = [`<button class="page-btn" ${currentPage === 1 ? 'disabled' : ''} data-page="${currentPage - 1}">◀</button>`];
    for (const p of getPageRange(currentPage, totalPages)) {
      if (p === '...') {
        parts.push(`<span class="page-info">…</span>`);
      } else {
        parts.push(`<button class="page-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`);
      }
    }
    parts.push(`<button class="page-btn" ${currentPage === totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">▶</button>`);
    pagination.innerHTML = parts.join('');
  }

  function getPageRange(current, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages = [1];
    if (current > 3) pages.push('...');
    for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) pages.push(i);
    if (current < total - 2) pages.push('...');
    pages.push(total);
    return pages;
  }

  // ─── DETAIL MODAL ─────────────────────────────────
  function openDetail(index) {
    const row = filteredData[index];
    if (!row) return;

    $('#modal-name').textContent    = row['Name'] || 'Unknown';
    $('#modal-subtitle').textContent = [row['Current JS Designation Final'], row['District'], row['Block']].filter(Boolean).join(' · ');

    const fieldDefs = [
      { label: 'District',        key: 'District' },
      { label: 'Anumandal',       key: 'Anumandal' },
      { label: 'Block',           key: 'Block' },
      { label: 'Panchayat',       key: 'Panchayat' },
      { label: "Father/Husband",  key: "Father/Husband's Name" },
      { label: 'Contact No.',     key: 'Contact No.' },
      { label: 'Age',             key: 'Age' },
      { label: 'Gender',          key: 'Gender' },
      { label: 'Category',        key: 'Category' },
      { label: 'Caste',           key: 'Caste' },
      { label: 'Designation',     key: 'Current JS Designation Final' },
      { label: 'Calling Status',  key: 'Calling Status' },
      { label: 'Meeting Status',  key: 'Meeting Status (Baithak)' },
      { label: 'Current Status',  key: 'Current  Status' },
      { label: 'Remarks',         key: 'Remarks' },
      { label: 'Reason Inactive', key: 'Reason For Inactive' },
      { label: 'Profile',         key: 'Profile', full: true },
    ];

    const grid = $('#modal-details');
    grid.innerHTML = fieldDefs.map(f => {
      const val = row[f.key] || '';
      return `<div class="detail-field ${f.full ? 'full-width' : ''}">
        <div class="detail-field-label">${f.label}</div>
        <div class="detail-field-value ${val ? '' : 'empty'}">${val || '—'}</div>
      </div>`;
    }).join('');

    detailModal.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeDetail() {
    detailModal.classList.remove('open');
    document.body.style.overflow = '';
  }

  // ─── CHARTS ───────────────────────────────────────
  function renderCharts() {
    const data = filteredData;

    const palette = [
      '#6366f1','#8b5cf6','#a78bfa','#c084fc',
      '#ec4899','#f472b6','#fb7185','#f87171',
      '#f59e0b','#fbbf24','#facc15','#a3e635',
      '#4ade80','#34d399','#2dd4bf','#22d3ee',
      '#38bdf8','#60a5fa','#818cf8','#a5b4fc'
    ];

    function countByField(field, limit) {
      const counts = {};
      for (const d of data) {
        const val = (d[field] || '').trim();
        if (!val || val === '#N/A' || val === '#REF!') continue;
        counts[val] = (counts[val] || 0) + 1;
      }
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      return limit ? sorted.slice(0, limit) : sorted;
    }

    Object.values(chartInstances).forEach(c => c.destroy());
    chartInstances = {};

    const ChartLib = window.Chart;
    if (!ChartLib) { showToast('Chart library still loading…', 'error'); return; }

    // 1. District bar
    const districtData = countByField('District', 20);
    chartInstances.districts = new ChartLib($('#chart-districts'), {
      type: 'bar',
      data: {
        labels: districtData.map(d => d[0]),
        datasets: [{ label: 'Contacts', data: districtData.map(d => d[1]),
          backgroundColor: palette.slice(0, districtData.length), borderRadius: 6, borderSkipped: false }]
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: 'rgba(148,163,184,0.06)' }, ticks: { color: '#94a3b8' } },
          y: { grid: { display: false }, ticks: { color: '#e2e8f0', font: { size: 11 } } }
        }
      }
    });
    $('#chart-districts').parentElement.style.height = Math.max(400, districtData.length * 28) + 'px';

    // 2. Category doughnut
    const catData = countByField('Category');
    chartInstances.categories = new ChartLib($('#chart-categories'), {
      type: 'doughnut',
      data: { labels: catData.map(d => d[0]),
        datasets: [{ data: catData.map(d => d[1]),
          backgroundColor: palette.slice(0, catData.length), borderWidth: 0, hoverOffset: 8 }]
      },
      options: { responsive: true,
        plugins: { legend: { position: 'bottom', labels: { color: '#94a3b8', padding: 16, font: { size: 11 } } } }
      }
    });

    // 3. Gender doughnut
    const genderData = countByField('Gender');
    chartInstances.gender = new ChartLib($('#chart-gender'), {
      type: 'doughnut',
      data: { labels: genderData.map(d => d[0]),
        datasets: [{ data: genderData.map(d => d[1]),
          backgroundColor: ['#60a5fa','#f472b6','#94a3b8'], borderWidth: 0, hoverOffset: 8 }]
      },
      options: { responsive: true,
        plugins: { legend: { position: 'bottom', labels: { color: '#94a3b8', padding: 16, font: { size: 11 } } } }
      }
    });

    // 4. Designations bar
    const desData = countByField('Current JS Designation Final', 12);
    chartInstances.designations = new ChartLib($('#chart-designations'), {
      type: 'bar',
      data: {
        labels: desData.map(d => d[0].length > 25 ? d[0].slice(0, 25) + '…' : d[0]),
        datasets: [{ label: 'Count', data: desData.map(d => d[1]),
          backgroundColor: '#6366f1', borderRadius: 4, borderSkipped: false }]
      },
      options: {
        indexAxis: 'y', responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: 'rgba(148,163,184,0.06)' }, ticks: { color: '#94a3b8' } },
          y: { grid: { display: false }, ticks: { color: '#e2e8f0', font: { size: 10 } } }
        }
      }
    });

    // 5. Age distribution
    const ageBuckets = { '18-25': 0,'26-35': 0,'36-45': 0,'46-55': 0,'56-65': 0,'65+': 0,'Unknown': 0 };
    for (const d of data) {
      const age = parseInt(d['Age'], 10);
      if (isNaN(age))      ageBuckets['Unknown']++;
      else if (age <= 25)  ageBuckets['18-25']++;
      else if (age <= 35)  ageBuckets['26-35']++;
      else if (age <= 45)  ageBuckets['36-45']++;
      else if (age <= 55)  ageBuckets['46-55']++;
      else if (age <= 65)  ageBuckets['56-65']++;
      else                 ageBuckets['65+']++;
    }
    chartInstances.age = new ChartLib($('#chart-age'), {
      type: 'bar',
      data: {
        labels: Object.keys(ageBuckets),
        datasets: [{ label: 'Contacts', data: Object.values(ageBuckets),
          backgroundColor: ['#818cf8','#a78bfa','#c084fc','#e879f9','#f472b6','#fb7185','#94a3b8'],
          borderRadius: 6, borderSkipped: false }]
      },
      options: {
        responsive: true, plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#e2e8f0' } },
          y: { grid: { color: 'rgba(148,163,184,0.06)' }, ticks: { color: '#94a3b8' } }
        }
      }
    });
  }

  // ─── DUPLICATES TAB ───────────────────────────────
  function renderDuplicates() {
    duplicatesBody.innerHTML = '';
    $('#duplicates-count').textContent = `Found ${duplicatesData.length} duplicates`;

    if (duplicatesData.length === 0) {
      duplicatesBody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:3rem;color:var(--text-muted);">No duplicates found! 🎉</td></tr>`;
      return;
    }

    let lastKey    = null;
    let isOddGroup = false;
    const frag     = document.createDocumentFragment();

    duplicatesData.forEach(row => {
      const currentKey = `${row['Contact No.']}_${row['Name']}`.toLowerCase();
      if (currentKey !== lastKey) { isOddGroup = !isOddGroup; lastKey = currentKey; }

      const tr = document.createElement('tr');
      if (isOddGroup) tr.classList.add('duplicate-group');
      tr.innerHTML = `
        <td style="font-weight:500;color:var(--text-primary);">${esc(row['Name'])}</td>
        <td style="font-family:monospace;">${esc(row['Contact No.'])}</td>
        <td>${esc(row['District'])}</td>
        <td>${esc(row['Block'])}</td>
        <td><span class="badge" style="background:rgba(99,102,241,0.1);color:var(--primary-400);">${esc(row['Current JS Designation Final'])}</span></td>
        <td>${esc(row['Category'])}</td>
      `;
      frag.appendChild(tr);
    });
    duplicatesBody.appendChild(frag);
  }

  // ─── LAZY LIBRARY LOADER ──────────────────────────
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload  = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function ensureXLSX() {
    if (typeof XLSX !== 'undefined') return;
    if (_xlsxLoaded) return;
    _xlsxLoaded = true;
    showToast('⏳ Loading Excel library…', 'success');
    await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
  }

  async function ensureJsPDF() {
    if (typeof window.jspdf !== 'undefined') return;
    if (_jspdfLoaded) return;
    _jspdfLoaded = true;
    showToast('⏳ Loading PDF library…', 'success');
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js');
  }

  // ─── EXPORT ───────────────────────────────────────
  function exportCSV(dataArray = filteredData, filename = 'sangathan_contacts.csv') {
    const exportCols = COLUMNS.filter(c => c);
    let csv = exportCols.join(',') + '\n';
    for (const row of dataArray) {
      csv += exportCols.map(c => {
        let val = (row[c] || '').replace(/"/g, '""');
        if (val.includes(',') || val.includes('\n') || val.includes('"')) val = `"${val}"`;
        return val;
      }).join(',') + '\n';
    }
    downloadFile(csv, filename, 'text/csv');
    showToast('📄 CSV exported (' + dataArray.length + ' rows)', 'success');
  }

  async function exportExcel(dataArray = filteredData, filename = 'sangathan_contacts.xlsx') {
    await ensureXLSX();
    if (typeof XLSX === 'undefined') { showToast('❌ Excel library not loaded', 'error'); return; }
    const exportCols = COLUMNS.filter(c => c);
    const wsData = [exportCols];
    for (const row of dataArray) wsData.push(exportCols.map(c => row[c] || ''));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(wb, ws, 'Contacts');
    XLSX.writeFile(wb, filename);
    showToast('📗 Excel exported (' + dataArray.length + ' rows)', 'success');
  }

  async function exportPDF(dataArray = filteredData, filename = 'sangathan_contacts.pdf') {
    await ensureJsPDF();
    if (typeof window.jspdf === 'undefined') { showToast('❌ PDF library not loaded', 'error'); return; }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFontSize(16);
    doc.text('Sangathan Contact Directory', 14, 15);
    doc.setFontSize(9);
    doc.text(`Generated: ${new Date().toLocaleString()} | Total: ${dataArray.length} contacts`, 14, 22);
    const cols = ['Name','District','Block','Contact No.','Age','Category','Gender','Current JS Designation Final'];
    doc.autoTable({
      head: [cols.map(c => c === 'Current JS Designation Final' ? 'Designation' : c)],
      body: dataArray.map(r => cols.map(c => r[c] || '')),
      startY: 28,
      styles: { fontSize: 7, cellPadding: 2 },
      headStyles: { fillColor: [99, 102, 241] },
      alternateRowStyles: { fillColor: [245, 245, 250] },
    });
    doc.save(filename);
    showToast('📕 PDF exported (' + dataArray.length + ' rows)', 'success');
  }

  function downloadFile(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  // ─── TOAST ────────────────────────────────────────
  function showToast(message, type = 'success') {
    const container = $('#toast-container');
    const toast     = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity   = '0';
      toast.style.transform = 'translateX(20px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  // ─── EVENT LISTENERS ──────────────────────────────
  function initEvents() {
    // Search (debounced)
    let searchTimer;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(applySearchAndFilters, 200);
    });

    // Search chips
    $$('.search-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        $$('.search-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        searchField = chip.dataset.field;
        updateSearchPlaceholder();
        if (searchInput.value.trim()) applySearchAndFilters();
        searchInput.focus();
      });
    });

    // Filter toggle
    filterToggle.addEventListener('click', () => {
      filtersPanel.classList.toggle('open');
      filterToggle.classList.toggle('active');
    });

    $('#apply-filters').addEventListener('click', () => {
      applySearchAndFilters();
      filtersPanel.classList.remove('open');
      filterToggle.classList.remove('active');
    });

    $('#clear-filters').addEventListener('click', () => {
      $$('.filters-panel select').forEach(s => s.value = '');
      searchInput.value = '';
      applySearchAndFilters();
    });

    // Per page
    perPageSelect.addEventListener('change', () => {
      perPage = parseInt(perPageSelect.value, 10);
      currentPage = 1;
      renderTable();
    });

    // Table sort
    $$('thead th').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.col;
        if (col) sortData(col);
      });
    });

    // Row click → detail modal
    tableBody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (tr && tr.dataset.index !== undefined) openDetail(parseInt(tr.dataset.index, 10));
    });

    // Modal close
    $('#modal-close').addEventListener('click', closeDetail);
    detailModal.addEventListener('click', (e) => { if (e.target === detailModal) closeDetail(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

    // Pagination (delegated)
    pagination.addEventListener('click', (e) => {
      const btn = e.target.closest('.page-btn');
      if (!btn || btn.disabled) return;
      currentPage = parseInt(btn.dataset.page, 10);
      renderTable();
      $('.table-wrapper').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // Tab nav
    $$('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        $$('.nav-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        $$('.tab-panel').forEach(p => p.classList.remove('active'));
        $(`#panel-${tab}`).classList.add('active');
        if (tab === 'analytics') renderCharts();
      });
    });

    // Bulk search modal
    $('#bulk-search-toggle').addEventListener('click', () => { bulkModal.classList.add('active'); });
    $('#bulk-modal-close').addEventListener('click',   () => { bulkModal.classList.remove('active'); });
    $('#bulk-search-clear').addEventListener('click',  () => { bulkSearchText.value = ''; });
    bulkModal.addEventListener('click', (e) => { if (e.target === bulkModal) bulkModal.classList.remove('active'); });

    $('#bulk-search-apply').addEventListener('click', () => {
      const text = bulkSearchText.value.trim();
      if (text) {
        searchInput.value = text;
        applySearchAndFilters();
        bulkModal.classList.remove('active');
        $('#nav-directory').click();
      }
    });

    // Export buttons
    $('#export-csv').addEventListener('click',   () => exportCSV(filteredData, 'sangathan_contacts.csv'));
    $('#export-excel').addEventListener('click', () => exportExcel(filteredData, 'sangathan_contacts.xlsx'));
    $('#export-pdf').addEventListener('click',   () => exportPDF(filteredData, 'sangathan_contacts.pdf'));
  }

  // ─── INIT ─────────────────────────────────────────
  initEvents();
  loadData();

})();
