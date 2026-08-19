/* ══════════════════════════════════════════════════════
   Sangathan Search — Application Logic
   ══════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── CONFIG ───────────────────────────────────────
  const SHEET_ID = '194ei4yzOTUMrnMLe1fseis__QQnRGk6rwA6U_WSVEUA';
  const GID = '1400833008';
  const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;

  const COLUMNS = [
    'District', 'Name', "Father/Husband's Name", 'Contact No.', 'Anumandal',
    'Block', 'Panchayat', 'Age', 'Category', 'Caste', 'Gender',
    'Current JS Designation Final', 'Profile', 'Calling Status',
    'Meeting Status (Baithak)', 'Current  Status', 'Remarks',
    'Reason For Inactive'
  ];

  // ─── STATE ────────────────────────────────────────
  let allData = [];
  let filteredData = [];
  let duplicatesData = []; // Array of duplicates
  let currentPage = 1;
  let perPage = 50;
  let sortCol = null;
  let sortDir = 'asc';
  let searchField = 'all'; // which column to search in ('all' = everywhere)
  let chartInstances = {};

  // ─── DOM REFS ─────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const loader        = $('#loader');
  const searchInput   = $('#search-input');
  const filterToggle  = $('#filter-toggle');
  const filtersPanel  = $('#filters-panel');
  const tableBody     = $('#table-body');
  const pagination    = $('#pagination');
  const resultsCount  = $('#results-count');
  const activeBadges  = $('#active-filters');
  const detailModal   = $('#detail-modal');
  const perPageSelect = $('#per-page-select');

  const bulkModal       = $('#bulk-modal');
  const bulkSearchText  = $('#bulk-search-text');
  const panelDirectory  = $('#panel-directory');
  const panelAnalytics  = $('#panel-analytics');
  const panelDuplicates = $('#panel-duplicates');
  const duplicatesBody  = $('#duplicates-body');
  
  let totalRawRows = 0;

  // ─── CSV PARSER ───────────────────────────────────
  function parseCSV(text) {
    const rows = [];
    let current = '';
    let inQuotes = false;
    const chars = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === '"') {
        if (inQuotes && chars[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        rows.push(current);
        current = '';
      } else if (ch === '\n' && !inQuotes) {
        rows.push(current);
        current = '';
        // Emit row
        if (rows.length > 0) {
          yield_row(rows);
        }
        rows.length = 0;
      } else {
        current += ch;
      }
    }
    // Last field
    rows.push(current);
    if (rows.length > 0) {
      yield_row(rows);
    }

    function yield_row(fields) {
      parsedRows.push([...fields]);
    }

    return;
  }

  function csvToObjects(text) {
    const parsedRows = [];
    let current = '';
    let inQuotes = false;
    let fields = [];
    const chars = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === '"') {
        if (inQuotes && chars[i + 1] === '"') {
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
        fields = [];
        current = '';
      } else {
        current += ch;
      }
    }
    // Last row
    fields.push(current.trim());
    if (fields.some(f => f.length > 0)) {
      parsedRows.push([...fields]);
    }

    // First row is header
    if (parsedRows.length === 0) return [];
    const headers = parsedRows[0];
    const objects = [];

    for (let r = 1; r < parsedRows.length; r++) {
      const row = parsedRows[r];
      // Skip rows that are clearly empty
      if (row.length < 2 || (row[0] === '' && row[1] === '')) continue;

      const obj = {};
      for (let c = 0; c < COLUMNS.length; c++) {
        obj[COLUMNS[c]] = (row[c] || '').trim();
      }
      // Clean up age
      if (obj['Age']) {
        const ageNum = parseInt(obj['Age'], 10);
        obj['Age'] = isNaN(ageNum) ? '' : String(ageNum);
      }
      // Clean contact number
      if (obj['Contact No.']) {
        obj['Contact No.'] = obj['Contact No.'].replace(/[^0-9+]/g, '');
      }
      objects.push(obj);
    }

    return objects;
  }

  // ─── DATA LOADING ─────────────────────────────────
  async function loadData() {
    try {
      const resp = await fetch(CSV_URL);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      allData = csvToObjects(text);

      // De-duplicate by Contact+Name (keep first occurrence for allData)
      // Collect duplicates for the Duplicates tab
      const seen = new Map();
      const deduped = [];
      duplicatesData = [];
      totalRawRows = allData.length;
      
      for (const row of allData) {
        const key = `${row['Contact No.']}_${row['Name']}`.toLowerCase();
        if (!seen.has(key)) {
          seen.set(key, [row]);
        } else {
          seen.get(key).push(row);
        }
      }
      
      for (const [key, rows] of seen.entries()) {
        deduped.push(rows[0]);
        if (rows.length > 1) {
          duplicatesData.push(...rows); // Push all copies of this duplicated entry
        }
      }
      
      allData = deduped;

      // Render duplicates tab initially
      renderDuplicates();

      filteredData = [...allData];
      populateFilters();
      updateStats();
      renderTable();
      hideLoader();
      showToast('✅ Loaded ' + allData.length + ' contacts', 'success');
    } catch (err) {
      console.error('Failed to load data:', err);
      loader.querySelector('.loader-text').textContent = 'Failed to load data';
      loader.querySelector('.loader-sub').textContent = err.message + ' — Please refresh';
      showToast('❌ Failed to load data: ' + err.message, 'error');
    }
  }

  function hideLoader() {
    loader.classList.add('hidden');
    setTimeout(() => { loader.style.display = 'none'; }, 600);
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
      const values = [...new Set(allData.map(d => d[cfg.col]).filter(v => v && v !== '#N/A' && v !== '#REF!'))].sort();
      const firstOption = select.options[0].outerHTML;
      select.innerHTML = firstOption;
      for (const val of values) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val;
        select.appendChild(opt);
      }
    }
  }

  // ─── STATS ────────────────────────────────────────
  function updateStats() {
    const data = filteredData;
    $('#stat-total').textContent = data.length.toLocaleString();
    $('#stat-districts').textContent = new Set(data.map(d => d['District']).filter(Boolean)).size;
    $('#stat-blocks').textContent = new Set(data.map(d => d['Block']).filter(Boolean)).size;
    $('#stat-designations').textContent = new Set(data.map(d => d['Current JS Designation Final']).filter(Boolean)).size;
    $('#stat-female').textContent = data.filter(d => d['Gender'] && d['Gender'].toLowerCase() === 'female').length;
    
    // Update duplicates stat
    $('#stat-duplicates').textContent = duplicatesData.length > 0 ? duplicatesData.length.toLocaleString() : '0';
  }

  // ─── SEARCH & FILTER ─────────────────────────────
  function applySearchAndFilters() {
    const query = searchInput.value.toLowerCase();
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

    filteredData = allData.filter(row => {
      // Text search — supports partial match, single letter, any fragment
      if (query) {
        let matched = false;
        
        // Handle Bulk Search logic
        if (query.includes('\n') || query.includes(',')) {
          const bulkQueries = query.split(/[\n,]+/).map(q => q.trim()).filter(Boolean);
          if (bulkQueries.length > 0) {
            matched = bulkQueries.some(bq => {
              if (searchField === 'all') {
                return COLUMNS.map(c => row[c] || '').join(' ').toLowerCase().includes(bq);
              } else {
                return (row[searchField] || '').toLowerCase().includes(bq);
              }
            });
          } else {
             matched = true; // empty bulk search
          }
        } else {
          // Standard single query search
          if (searchField === 'all') {
            // Search across ALL columns
            const searchableText = COLUMNS.map(c => row[c] || '').join(' ').toLowerCase();
            matched = searchableText.includes(query);
          } else {
            // Search in specific field only
            const fieldVal = (row[searchField] || '').toLowerCase();
            matched = fieldVal.includes(query);
          }
        }
        
        if (!matched) return false;
      }
      // Dropdown filters
      for (const [col, val] of Object.entries(filters)) {
        if (val && row[col] !== val) return false;
      }
      return true;
    });

    currentPage = 1;
    updateStats();
    renderTable();
    renderActiveBadges(filters);

    // Update placeholder text based on selected field
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
      'all': 'Type anything — name, number, district, caste, even a single letter…',
      'Name': 'Search by name — type full name, partial name, or even one letter…',
      'Contact No.': 'Search by mobile number — type full or partial number…',
      'District': 'Search by district name…',
      'Block': 'Search by block name…',
      'Panchayat': 'Search by panchayat name…',
      'Category': 'Search by category — General, OBC, EBC, SC, ST, Minority…',
      'Caste': 'Search by caste name…',
      'Gender': 'Search by gender — Male or Female…',
      'Current JS Designation Final': 'Search by designation…',
      "Father/Husband's Name": 'Search by father or husband name…',
      'Profile': 'Search within profile details…',
      'Anumandal': 'Search by anumandal name…',
    };
    searchInput.placeholder = placeholders[searchField] || placeholders['all'];
  }

  // Exposed for inline onclick
  window._applyFilters = applySearchAndFilters;
  window._clearSingleFilter = function (col) {
    const map = {
      'District': 'filter-district',
      'Block': 'filter-block',
      'Category': 'filter-category',
      'Caste': 'filter-caste',
      'Gender': 'filter-gender',
      'Current JS Designation Final': 'filter-designation',
      'Current  Status': 'filter-status',
      'Anumandal': 'filter-anumandal',
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
      // Numeric sort for Age, Contact
      if (col === 'Age' || col === 'Contact No.') {
        av = parseInt(av, 10) || 0;
        bv = parseInt(bv, 10) || 0;
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      // String sort
      av = av.toLowerCase();
      bv = bv.toLowerCase();
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    // Update header UI
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
    const start = (currentPage - 1) * perPage;
    const end = start + perPage;
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
      `;pagination.innerHTML = '';
      return;
    }

    tableBody.innerHTML = pageData.map((row, i) => {
      const catClass = getCategoryClass(row['Category']);
      const genderClass = row['Gender']?.toLowerCase() === 'female' ? 'cell-gender-female' : 'cell-gender-male';
      return `
        <tr data-index="${start + i}">
          <td class="cell-name">${esc(row['Name'])}</td>
          <td class="cell-district">${esc(row['District'])}</td>
          <td>${esc(row['Block'])}</td>
          <td>${esc(row['Contact No.'])}</td>
          <td>${esc(row['Age'])}</td>
          <td><span class="cell-category ${catClass}">${esc(row['Category'])}</span></td>
          <td class="${genderClass}">${esc(row['Gender'])}</td>
          <td>${row['Current JS Designation Final'] ? `<span class="cell-designation">${esc(row['Current JS Designation Final'])}</span>` : ''}</td>
        </tr>`;
    }).join('');

    renderPagination();
  }

  function getCategoryClass(cat) {
    if (!cat) return '';
    const c = cat.toLowerCase().trim();
    if (c.includes('general') || c === 'gen') return 'cat-general';
    if (c === 'obc') return 'cat-obc';
    if (c === 'ebc') return 'cat-ebc';
    if (c === 'sc') return 'cat-sc';
    if (c === 'st') return 'cat-st';
    if (c.includes('minority')) return 'cat-minority';
    return 'cat-general';
  }

  function esc(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── PAGINATION ───────────────────────────────────
  function renderPagination() {
    const totalPages = Math.ceil(filteredData.length / perPage);
    if (totalPages <= 1) {
      pagination.innerHTML = '';
      return;
    }

    let html = '';
    html += `<button class="page-btn" ${currentPage === 1 ? 'disabled' : ''} data-page="${currentPage - 1}">◀</button>`;

    const range = getPageRange(currentPage, totalPages);
    for (const p of range) {
      if (p === '...') {
        html += `<span class="page-info">…</span>`;
      } else {
        html += `<button class="page-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
      }
    }

    html += `<button class="page-btn" ${currentPage === totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">▶</button>`;
    pagination.innerHTML = html;
  }

  function getPageRange(current, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages = [];
    pages.push(1);
    if (current > 3) pages.push('...');
    for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) {
      pages.push(i);
    }
    if (current < total - 2) pages.push('...');
    pages.push(total);
    return pages;
  }

  // ─── DETAIL MODAL ─────────────────────────────────
  function openDetail(index) {
    const row = filteredData[index];
    if (!row) return;

    $('#modal-name').textContent = row['Name'] || 'Unknown';
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
      return `
        <div class="detail-field ${f.full ? 'full-width' : ''}">
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

    // Color palette
    const palette = [
      '#6366f1', '#8b5cf6', '#a78bfa', '#c084fc',
      '#ec4899', '#f472b6', '#fb7185', '#f87171',
      '#f59e0b', '#fbbf24', '#facc15', '#a3e635',
      '#4ade80', '#34d399', '#2dd4bf', '#22d3ee',
      '#38bdf8', '#60a5fa', '#818cf8', '#a5b4fc'
    ];

    // Helper
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

    // Destroy previous charts
    Object.values(chartInstances).forEach(c => c.destroy());
    chartInstances = {};

    // 1. District bar chart (top 20)
    const districtData = countByField('District', 20);
    chartInstances.districts = new Chart($('#chart-districts'), {
      type: 'bar',
      data: {
        labels: districtData.map(d => d[0]),
        datasets: [{
          label: 'Contacts',
          data: districtData.map(d => d[1]),
          backgroundColor: palette.slice(0, districtData.length),
          borderRadius: 6,
          borderSkipped: false,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
        },
        scales: {
          x: { grid: { color: 'rgba(148,163,184,0.06)' }, ticks: { color: '#94a3b8' } },
          y: { grid: { display: false }, ticks: { color: '#e2e8f0', font: { size: 11 } } }
        }
      }
    });
    $('#chart-districts').parentElement.style.height = Math.max(400, districtData.length * 28) + 'px';

    // 2. Category pie
    const catData = countByField('Category');
    chartInstances.categories = new Chart($('#chart-categories'), {
      type: 'doughnut',
      data: {
        labels: catData.map(d => d[0]),
        datasets: [{
          data: catData.map(d => d[1]),
          backgroundColor: palette.slice(0, catData.length),
          borderWidth: 0,
          hoverOffset: 8,
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#94a3b8', padding: 16, font: { size: 11 } } },
        }
      }
    });

    // 3. Gender pie
    const genderData = countByField('Gender');
    chartInstances.gender = new Chart($('#chart-gender'), {
      type: 'doughnut',
      data: {
        labels: genderData.map(d => d[0]),
        datasets: [{
          data: genderData.map(d => d[1]),
          backgroundColor: ['#60a5fa', '#f472b6', '#94a3b8'],
          borderWidth: 0,
          hoverOffset: 8,
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#94a3b8', padding: 16, font: { size: 11 } } },
        }
      }
    });

    // 4. Top designations
    const desData = countByField('Current JS Designation Final', 12);
    chartInstances.designations = new Chart($('#chart-designations'), {
      type: 'bar',
      data: {
        labels: desData.map(d => d[0].length > 25 ? d[0].slice(0, 25) + '…' : d[0]),
        datasets: [{
          label: 'Count',
          data: desData.map(d => d[1]),
          backgroundColor: '#6366f1',
          borderRadius: 4,
          borderSkipped: false,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: 'rgba(148,163,184,0.06)' }, ticks: { color: '#94a3b8' } },
          y: { grid: { display: false }, ticks: { color: '#e2e8f0', font: { size: 10 } } }
        }
      }
    });

    // 5. Age distribution histogram
    const ageBuckets = { '18-25': 0, '26-35': 0, '36-45': 0, '46-55': 0, '56-65': 0, '65+': 0, 'Unknown': 0 };
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
    chartInstances.age = new Chart($('#chart-age'), {
      type: 'bar',
      data: {
        labels: Object.keys(ageBuckets),
        datasets: [{
          label: 'Contacts',
          data: Object.values(ageBuckets),
          backgroundColor: ['#818cf8', '#a78bfa', '#c084fc', '#e879f9', '#f472b6', '#fb7185', '#94a3b8'],
          borderRadius: 6,
          borderSkipped: false,
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#e2e8f0' } },
          y: { grid: { color: 'rgba(148,163,184,0.06)' }, ticks: { color: '#94a3b8' } }
        }
      }
    });
  }

  // ─── DUPLICATES TAB ───────────────────────────────
  function renderDuplicates() {
    const counts = {};
    const duplicates = [];
    
    // Group by contact number
    rawTableData.forEach((row, index) => {
      const phone = (row['Contact No.'] || '').trim();
      if (!phone || phone.length < 10) return;
      if (!counts[phone]) counts[phone] = [];
      counts[phone].push({ ...row, originalIndex: index });
    });

    Object.entries(counts).forEach(([phone, items]) => {
      if (items.length > 1) {
        duplicates.push(...items);
      }
    });

    const tbody = $('#duplicates-table-body');
    if (duplicates.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center">No duplicates found.</td></tr>';
      return;
    }

    tbody.innerHTML = duplicates.map((row, i) => `
      <tr class="${i % 2 !== 0 ? 'duplicate-group-separator' : ''}">
        <td>${row['Name']}</td>
        <td>${row['Contact No.']}</td>
        <td>${row['District']}</td>
        <td>${row['Block']}</td>
        <td>${row['Current JS Designation Final']}</td>
      </tr>
    `).join('');
  }

  // ─── EXPORT ───────────────────────────────────────
  function exportCSV(dataArray = filteredData, filename = 'sangathan_contacts.csv') {
    const exportCols = COLUMNS.filter(c => c);
    let csv = exportCols.join(',') + '\n';
    for (const row of dataArray) {
      csv += exportCols.map(c => {
        let val = (row[c] || '').replace(/"/g, '""');
        if (val.includes(',') || val.includes('\n') || val.includes('"')) {
          val = `"${val}"`;
        }
        return val;
      }).join(',') + '\n';
    }

    downloadFile(csv, filename, 'text/csv');
    showToast('📄 CSV exported (' + dataArray.length + ' rows)', 'success');
  }

  function exportExcel(dataArray = filteredData, filename = 'sangathan_contacts.xlsx') {
    if (typeof XLSX === 'undefined') {
      showToast('❌ Excel library not loaded', 'error');
      return;
    }
    const exportCols = COLUMNS.filter(c => c);
    const wsData = [exportCols];
    for (const row of dataArray) {
      wsData.push(exportCols.map(c => row[c] || ''));
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(wb, ws, 'Contacts');
    XLSX.writeFile(wb, filename);
    showToast('📗 Excel exported (' + dataArray.length + ' rows)', 'success');
  }

  function exportPDF(dataArray = filteredData, filename = 'sangathan_contacts.pdf') {
    if (typeof jspdf === 'undefined' && typeof window.jspdf === 'undefined') {
      showToast('❌ PDF library not loaded', 'error');
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFontSize(16);
    doc.text('Sangathan Contact Directory', 14, 15);
    doc.setFontSize(9);
    doc.text(`Generated: ${new Date().toLocaleString()} | Total: ${dataArray.length} contacts`, 14, 22);

    const cols = ['Name', 'District', 'Block', 'Contact No.', 'Age', 'Category', 'Gender', 'Current JS Designation Final'];
    const rows = dataArray.map(r => cols.map(c => r[c] || ''));

    doc.autoTable({
      head: [cols.map(c => c === 'Current JS Designation Final' ? 'Designation' : c)],
      body: rows,
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
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── TOAST ────────────────────────────────────────
  function showToast(message, type = 'success') {
    const container = $('#toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(20px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  // ─── EVENT LISTENERS ──────────────────────────────
  function initEvents() {
    // Search (debounced — fast 150ms for instant feel)
    let searchTimer;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(applySearchAndFilters, 150);
    });

    // Search field chip selectors
    $$('.search-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        // Set active chip
        $$('.search-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        searchField = chip.dataset.field;
        updateSearchPlaceholder();
        // Re-run search with new field scope
        if (searchInput.value.trim()) {
          applySearchAndFilters();
        }
        // Focus the search input for convenience
        searchInput.focus();
      });
    });

    // Filter toggle
    filterToggle.addEventListener('click', () => {
      filtersPanel.classList.toggle('open');
      filterToggle.classList.toggle('active');
    });

    // Apply / Clear filters
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

    // Table row click → detail modal
    tableBody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (tr && tr.dataset.index !== undefined) {
        openDetail(parseInt(tr.dataset.index, 10));
      }
    });

    // Modal close
    $('#modal-close').addEventListener('click', closeDetail);
    detailModal.addEventListener('click', (e) => {
      if (e.target === detailModal) closeDetail();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDetail();
    });

    // Pagination (delegated)
    pagination.addEventListener('click', (e) => {
      const btn = e.target.closest('.page-btn');
      if (!btn || btn.disabled) return;
      currentPage = parseInt(btn.dataset.page, 10);
      renderTable();
      // Scroll to table top
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

        if (tab === 'analytics') {
          renderCharts();
        }
      });
    });
    
    // Jump to duplicates tab from stat card
    $('#stat-card-duplicates').addEventListener('click', () => {
      $('#nav-duplicates').click();
    });

    // Bulk Search Modal
    $('#bulk-search-toggle').addEventListener('click', () => {
      bulkModal.classList.add('active');
    });
    
    $('#bulk-modal-close').addEventListener('click', () => {
      bulkModal.classList.remove('active');
    });
    
    $('#bulk-search-clear').addEventListener('click', () => {
      bulkSearchText.value = '';
    });
    
    $('#bulk-search-apply').addEventListener('click', () => {
      const text = bulkSearchText.value.trim();
      if (text) {
        searchInput.value = text;
        applySearchAndFilters();
        bulkModal.classList.remove('active');
        $('#nav-directory').click(); // Make sure we are on the directory tab
      }
    });

    // Export buttons
    $('#export-csv').addEventListener('click', () => exportCSV(filteredData, 'sangathan_contacts.csv'));
    $('#export-excel').addEventListener('click', () => exportExcel(filteredData, 'sangathan_contacts.xlsx'));
    $('#export-pdf').addEventListener('click', () => exportPDF(filteredData, 'sangathan_contacts.pdf'));
    
    // Duplicates Export buttons
    $('#export-dup-csv').addEventListener('click', () => exportCSV(duplicatesData, 'sangathan_duplicates.csv'));
    $('#export-dup-xlsx').addEventListener('click', () => exportExcel(duplicatesData, 'sangathan_duplicates.xlsx'));
  }
  
  // ─── RENDER DUPLICATES ────────────────────────────
  function renderDuplicates() {
    duplicatesBody.innerHTML = '';
    $('#duplicates-count').textContent = `Found ${duplicatesData.length} duplicates`;
    
    if (duplicatesData.length === 0) {
      duplicatesBody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 3rem; color: var(--text-muted);">No duplicates found! 🎉</td></tr>`;
      return;
    }
    
    let lastKey = null;
    let isOddGroup = false;

    duplicatesData.forEach(row => {
      const currentKey = `${row['Contact No.']}_${row['Name']}`.toLowerCase();
      if (currentKey !== lastKey) {
        isOddGroup = !isOddGroup;
        lastKey = currentKey;
      }
      
      const tr = document.createElement('tr');
      // Style alternate groups to visually separate them
      if (isOddGroup) {
        tr.classList.add('duplicate-group');
      }
      
      tr.innerHTML = `
        <td style="font-weight: 500; color: var(--text-primary);">${esc(row['Name'])}</td>
        <td style="font-family: monospace;">${esc(row['Contact No.'])}</td>
        <td>${esc(row['District'])}</td>
        <td>${esc(row['Block'])}</td>
        <td><span class="badge" style="background: rgba(99, 102, 241, 0.1); color: var(--primary-400);">${esc(row['Current JS Designation Final'])}</span></td>
        <td>${esc(row['Category'])}</td>
      `;
      duplicatesBody.appendChild(tr);
    });
  }

  // ─── INIT ─────────────────────────────────────────
  initEvents();
  loadData();

})();
