/* ══════════════════════════════════════════════════════
   Sangathan Search — High-Performance Static Architecture
   Optimisations for Mobile & Desktop:
     • Static pre-computed metadata (<50ms initial boot)
     • On-demand district-level partitioning (<100KB per district)
     • Vercel Edge caching + Serverless search across 95,722+ records
     • Pre-computed Chart.js analytics & Data Quality stats (0ms render)
     • Full offline IndexedDB & local file fallback resilience
     • Query-side Hindi transliteration & bulk search support
     • Lazy-loaded export libraries (SheetJS / jsPDF)
   ══════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── CONFIG ───────────────────────────────────────
  const CACHE_DB_NAME    = 'SangathanCache';
  const CACHE_STORE_NAME = 'csvCache';
  const CACHE_TTL_MS     = 30 * 60 * 1000; // 30 minutes
  const CACHE_KEY        = 'sangathan_csv_v8';

  const COLUMNS = [
    'District', 'Name', "Father/Husband's Name", 'Contact No.', 'Anumandal',
    'Block', 'Panchayat', 'Age', 'Category', 'Caste', 'Gender',
    'Current JS Designation Final', 'Profile', 'Calling Status',
    'Meeting Status (Baithak)', 'Current  Status', 'Remarks',
    'Reason For Inactive'
  ];

  const DQ_KEY_FIELDS = [
    { key: 'Name', label: 'Name' },
    { key: 'Contact No.', label: 'Contact No.' },
    { key: 'District', label: 'District' },
    { key: 'Block', label: 'Block' },
    { key: 'Panchayat', label: 'Panchayat' },
    { key: 'Category', label: 'Category' },
    { key: 'Caste', label: 'Caste' },
    { key: 'Gender', label: 'Gender' },
    { key: 'Current JS Designation Final', label: 'Designation' },
    { key: 'Age', label: 'Age' }
  ];

  // ─── STATE ────────────────────────────────────────
  let summaryData          = null;
  let initialData          = [];
  let districtCache        = {};
  let activeDistrict       = '';
  let allData              = [];
  let filteredData         = [];
  let currentPage          = 1;
  let perPage              = 50;
  let sortCol              = null;
  let sortDir              = 'asc';
  let searchField          = 'all';
  let chartInstances       = {};
  let totalRawRows         = 0;

  let isRemoteSearchActive = false;
  let remoteSearchTotal    = 0;
  let searchAbortCtrl      = null;
  let searchDebounceTimer  = null;

  // Lazy-loaded lib references
  let _xlsxLoaded  = false;
  let _jspdfLoaded = false;

  // ─── DOM REFS ─────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const loader          = $('#loader');
  const loaderText      = $('#loader-text');
  const loaderSub       = $('#loader-sub');
  const loaderSpinner   = $('#loader-spinner');
  const loaderProgWrap  = $('#loader-progress-wrap');
  const loaderProgBar   = $('#loader-progress-bar');
  const loaderProgLbl   = $('#loader-progress-label');
  const loaderFallback  = $('#loader-fallback');
  const csvFileInput    = $('#csv-file-input');
  const btnRetryLoad    = $('#btn-retry-load');
  const btnUseCached    = $('#btn-use-cached');
  const searchInput     = $('#search-input');
  const searchClearBtn  = $('#search-clear-btn');
  const filterToggle    = $('#filter-toggle');
  const filterCountBadge= $('#filter-count-badge');
  const filtersPanel    = $('#filters-panel');
  const tableBody       = $('#table-body');
  const cardsContainer  = $('#cards-container');
  const tableScroll     = $('#table-scroll');
  const btnViewCards    = $('#btn-view-cards');
  const btnViewTable    = $('#btn-view-table');
  const pagination      = $('#pagination');
  const resultsCount    = $('#results-count');
  const activeBadges    = $('#active-filters');
  const detailModal     = $('#detail-modal');
  const perPageSelect   = $('#per-page-select');
  const bulkModal       = $('#bulk-modal');
  const bulkSearchText  = $('#bulk-search-text');
  const mobileBottomNav = $('#mobile-bottom-nav');

  // View mode: default to 'cards' on mobile (<768px), 'table' on desktop
  let currentViewMode = window.innerWidth < 768 ? 'cards' : 'table';
  try {
    const saved = localStorage.getItem('sangathan_view_mode');
    if (saved === 'cards' || saved === 'table') currentViewMode = saved;
  } catch (e) {}

  function updateViewModeUI() {
    if (btnViewCards) btnViewCards.classList.toggle('active', currentViewMode === 'cards');
    if (btnViewTable) btnViewTable.classList.toggle('active', currentViewMode === 'table');
    if (cardsContainer) cardsContainer.style.display = currentViewMode === 'cards' ? 'grid' : 'none';
    if (tableScroll) tableScroll.style.display = currentViewMode === 'table' ? 'block' : 'none';
  }

  function setViewMode(mode) {
    currentViewMode = mode;
    try { localStorage.setItem('sangathan_view_mode', mode); } catch (e) {}
    updateViewModeUI();
  }

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

  function showLoaderFallback(title, message, allowCache = false) {
    if (loaderSpinner) loaderSpinner.style.display = 'none';
    if (loaderProgWrap) loaderProgWrap.style.display = 'none';
    setLoaderStatus(title || 'Data Load Action Needed', message || 'Please select data.csv from your folder');
    if (loaderFallback) loaderFallback.style.display = 'block';
    if (btnUseCached) btnUseCached.style.display = allowCache ? 'inline-block' : 'none';
  }

  function resetLoaderUI() {
    if (loaderSpinner) loaderSpinner.style.display = 'block';
    if (loaderProgWrap) loaderProgWrap.style.display = 'none';
    if (loaderProgBar)  loaderProgBar.style.width = '0%';
    if (loaderProgLbl)  loaderProgLbl.textContent = '0%';
    if (loaderFallback) loaderFallback.style.display = 'none';
    if (loader) loader.classList.remove('hidden');
  }

  function hideLoader() {
    if (loader) {
      loader.classList.add('fade-out');
      setTimeout(() => {
        loader.classList.add('hidden');
        loader.classList.remove('fade-out');
      }, 350);
    }
  }

  // ─── IndexedDB CACHE ──────────────────────────────
  function openDB() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB not supported')); return; }
      const req = indexedDB.open(CACHE_DB_NAME, 2);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
          db.createObjectStore(CACHE_STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getCached() {
    try {
      const db = await openDB();
      return new Promise((resolve) => {
        const tx = db.transaction(CACHE_STORE_NAME, 'readonly');
        const req = tx.objectStore(CACHE_STORE_NAME).get(CACHE_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  async function setCached(data) {
    try {
      const db = await openDB();
      return new Promise((resolve) => {
        const tx = db.transaction(CACHE_STORE_NAME, 'readwrite');
        tx.objectStore(CACHE_STORE_NAME).put(data, CACHE_KEY);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch {
      return false;
    }
  }

  // ─── CONTACT NUMBER PARSER ────────────────────────
  function parseContactNumbers(raw) {
    if (!raw) return [];
    const text = String(raw).trim();
    if (!text || text === '#N/A' || text === '#REF!') return [];

    const results = [];
    const seen = new Set();

    function addDigits(digits) {
      if (!digits) return;
      if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
      if (digits.length === 11 && digits.startsWith('0'))  digits = digits.slice(1);
      if (digits.length === 10 && /^[6-9]/.test(digits) && !seen.has(digits)) {
        seen.add(digits);
        results.push(digits);
      }
    }

    const segments = text.split(/[/,;|\n\\]+/);
    for (const seg of segments) {
      const allD = seg.replace(/\D/g, '');
      if (allD.length === 10 || allD.length === 11 || allD.length === 12) {
        addDigits(allD);
      } else if (allD.length > 12) {
        let cursor = 0;
        while (cursor <= allD.length - 10) {
          if (/[6-9]/.test(allD[cursor])) {
            const cand = allD.slice(cursor, cursor + 10);
            if (/^[6-9]\d{9}$/.test(cand)) {
              addDigits(cand);
              cursor += 10;
              continue;
            }
          }
          cursor++;
        }
      }
    }
    return results;
  }

  // ─── TRANSLITERATION ──────────────────────────────
  const DEVANAGARI_MAP = {
    'अ':'a','आ':'aa','इ':'i','ई':'ee','उ':'u','ऊ':'oo','ए':'e','ऐ':'ai','ओ':'o','औ':'au',
    'क':'k','ख':'kh','ग':'g','घ':'gh','ङ':'ng',
    'च':'ch','छ':'chh','ज':'j','झ':'jh','ञ':'ny',
    'ट':'t','ठ':'th','ड':'d','ढ':'dh','ण':'n',
    'त':'t','थ':'th','द':'d','ध':'dh','न':'n',
    'प':'p','फ':'ph','ब':'b','भ':'bh','म':'m',
    'य':'y','र':'r','ल':'l','व':'v','श':'sh',
    'ष':'sh','स':'s','ह':'h','क्ष':'ksh','त्र':'tr','ज्ञ':'gy',
    '़':'','ा':'a','ि':'i','ी':'i','ु':'u','ू':'u','े':'e','ै':'ai','ो':'o','ौ':'au','ं':'n','ँ':'n',
    'ः':'h','्':'','ृ':'ri','ड़':'d','ढ़':'dh','फ़':'f','ज़':'z'
  };

  const HINDI_REGEX = /[\u0900-\u097F]/;

  function transliterateHindi(text) {
    if (!text) return '';
    let out = '';
    const str = String(text);
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      out += DEVANAGARI_MAP[ch] !== undefined ? DEVANAGARI_MAP[ch] : ch;
    }
    return out.toLowerCase().replace(/[^a-z0-9\s_]/g, '');
  }

  function toSlug(str) {
    return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  // ─── DATA LOADING ─────────────────────────────────
  async function loadData(forceRefresh = false) {
    resetLoaderUI();
    setLoaderStatus('Loading Sangathan Data', 'Loading optimized data…');
    setLoaderProgress(20);

    // 1. Try static summary.json and initial.json first
    if (window.location.protocol.startsWith('http')) {
      try {
        const summaryUrl = forceRefresh ? `data/summary.json?_=${Date.now()}` : 'data/summary.json';
        const initialUrl = forceRefresh ? `data/initial.json?_=${Date.now()}` : 'data/initial.json';

        const [resSummary, resInitial] = await Promise.all([
          fetch(summaryUrl),
          fetch(initialUrl)
        ]);

        if (resSummary.ok && resInitial.ok) {
          setLoaderProgress(70);
          summaryData = await resSummary.json();
          initialData = await resInitial.json();

          allData          = initialData;
          filteredData     = allData;
          totalRawRows     = summaryData.totalRawRows || summaryData.totalContacts || 95722;

          populateFilters(summaryData.filterOptions);
          updateStats(true);
          renderTable();

          setLoaderProgress(100);
          hideLoader();
          showToast(`✅ Loaded ${summaryData.totalContacts.toLocaleString()} contacts across ${summaryData.totalDistricts} districts instantly`, 'success');
          return;
        }
      } catch (err) {
        console.warn('Static data load error, trying fallback:', err);
      }
    }

    // 2. Try IndexedDB cache fallback if available
    const cached = await getCached();
    if (cached && typeof cached.csv === 'string' && cached.csv.length > 100) {
      setLoaderStatus('Loading Sangathan Data', 'Loading cached data (offline mode)…');
      setLoaderProgress(30);
      await parseCsvAndProcess(cached.csv, (pct) => setLoaderProgress(30 + pct * 0.7));
      setLoaderProgress(100);
      hideLoader();
      showToast('⚠️ Loaded from offline cache', 'info');
      return;
    }

    // 3. Fallback to local file picker if opened via file:// or network failed
    const isFileProto = window.location.protocol === 'file:';
    showLoaderFallback(
      isFileProto ? 'Select Local CSV to Begin' : 'Unable to Download Online Data',
      isFileProto 
        ? 'Browser security prevents automatic network downloads when opened as a file. Click below to load data.csv.'
        : 'Network request failed. Please select your local data.csv file or retry.',
      Boolean(cached && typeof cached.csv === 'string' && cached.csv.length > 100)
    );
  }

  async function loadDistrictData(districtName) {
    const slug = toSlug(districtName);
    if (!slug) {
      allData = initialData;
      return allData;
    }

    if (districtCache[slug]) {
      allData = districtCache[slug];
      return allData;
    }

    try {
      setLoaderStatus('Loading District', `Loading ${districtName} contacts…`);
      const res = await fetch(`data/districts/${slug}.json`);
      if (res.ok) {
        const data = await res.json();
        districtCache[slug] = data;
        allData = data;
        return allData;
      }
    } catch (e) {
      console.warn(`Could not load district ${districtName}:`, e);
    }
    return allData;
  }

  // ─── SERVERLESS SEARCH ────────────────────────────
  async function searchViaApi(query, sField, filters) {
    if (searchAbortCtrl) {
      searchAbortCtrl.abort();
    }
    searchAbortCtrl = new AbortController();

    const params = new URLSearchParams();
    params.set('q', query);
    params.set('field', sField || 'all');
    params.set('perPage', '500');

    if (filters.district)    params.set('district', filters.district);
    if (filters.block)       params.set('block', filters.block);
    if (filters.category)    params.set('category', filters.category);
    if (filters.caste)       params.set('caste', filters.caste);
    if (filters.gender)      params.set('gender', filters.gender);
    if (filters.designation) params.set('designation', filters.designation);
    if (filters.status)      params.set('status', filters.status);

    try {
      const res = await fetch(`/api/search?${params.toString()}`, {
        signal: searchAbortCtrl.signal
      });
      if (res.ok) {
        return await res.json();
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('API search failed, falling back to local search:', err);
      }
    }
    return null;
  }

  // ─── POPULATE FILTER DROPDOWNS ────────────────────
  function populateFilters(filterOptions) {
    if (!filterOptions) return;
    
    const getArray = (val) => Array.isArray(val) ? val : (val instanceof Set ? Array.from(val) : []);
    
    fillSelectFromArray($('#filter-category'),    getArray(filterOptions.categories),   'All Categories');
    fillSelectFromArray($('#filter-caste'),       getArray(filterOptions.castes),       'All Castes');
    fillSelectFromArray($('#filter-designation'), getArray(filterOptions.designations), 'All Designations');
    fillSelectFromArray($('#filter-status'),      getArray(filterOptions.statuses),     'All Statuses');
    fillSelectFromArray($('#filter-anumandal'),   getArray(filterOptions.anumandals),   'All Anumandal');

    fillDatalistFromArray($('#district-options'), getArray(filterOptions.districts));
    updateBlockOptions();
  }

  function fillSelectFromArray(select, values, emptyLabel) {
    if (!select || !values) return;
    const currentValue = select.value;
    const sorted = [...values].sort((a, b) => a.localeCompare(b));
    select.innerHTML = '';
    const firstOption = document.createElement('option');
    firstOption.value = '';
    firstOption.textContent = emptyLabel;
    select.appendChild(firstOption);

    const fragment = document.createDocumentFragment();
    for (const value of sorted) {
      const option = document.createElement('option');
      option.value = option.textContent = value;
      fragment.appendChild(option);
    }
    select.appendChild(fragment);
    if (sorted.includes(currentValue)) select.value = currentValue;
  }

  function fillDatalistFromArray(list, values) {
    if (!list || !values) return;
    const sorted = [...values].sort((a, b) => a.localeCompare(b));
    list.innerHTML = sorted.map(value => `<option value="${esc(value)}"></option>`).join('');
  }

  function updateBlockOptions() {
    const district = ($('#filter-district').value || '').trim();
    const list = $('#block-options');
    if (!list) return;

    if (summaryData && summaryData.filterOptions && summaryData.filterOptions.blocksByDistrict) {
      const matchKey = Object.keys(summaryData.filterOptions.blocksByDistrict).find(
        k => k.toLowerCase() === district.toLowerCase()
      );
      if (matchKey && summaryData.filterOptions.blocksByDistrict[matchKey]) {
        fillDatalistFromArray(list, summaryData.filterOptions.blocksByDistrict[matchKey]);
        return;
      }
    }

    const allBlocks = new Set();
    if (summaryData && summaryData.filterOptions && summaryData.filterOptions.blocksByDistrict) {
      for (const bList of Object.values(summaryData.filterOptions.blocksByDistrict)) {
        bList.forEach(b => allBlocks.add(b));
      }
    } else {
      for (let i = 0; i < allData.length; i++) {
        if (allData[i]['Block']) allBlocks.add(allData[i]['Block']);
      }
    }
    fillDatalistFromArray(list, Array.from(allBlocks));
  }

  // ─── STATS ────────────────────────────────────────
  function updateStats(useSummary = false) {
    if (useSummary && summaryData) {
      $('#stat-total').textContent        = summaryData.totalContacts.toLocaleString();
      $('#stat-districts').textContent    = summaryData.totalDistricts.toLocaleString();
      $('#stat-blocks').textContent       = summaryData.totalBlocks.toLocaleString();
      $('#stat-designations').textContent = summaryData.totalDesignations.toLocaleString();
      $('#stat-female').textContent       = summaryData.femaleCount.toLocaleString();
      return;
    }

    const data = filteredData;
    const len = isRemoteSearchActive ? remoteSearchTotal : data.length;
    $('#stat-total').textContent = len.toLocaleString();

    if (len === 0) {
      $('#stat-districts').textContent    = '0';
      $('#stat-blocks').textContent       = '0';
      $('#stat-designations').textContent = '0';
      $('#stat-female').textContent       = '0';
      return;
    }

    const distSet = new Set();
    const blockSet = new Set();
    const desigSet = new Set();
    let femaleCount = 0;

    for (let i = 0; i < data.length; i++) {
      const r = data[i];
      if (r['District']) distSet.add(r['District']);
      if (r['Block']) blockSet.add(r['Block']);
      if (r['Current JS Designation Final']) desigSet.add(r['Current JS Designation Final']);
      if (r['Gender'] === 'Female') femaleCount++;
    }

    $('#stat-districts').textContent    = distSet.size.toLocaleString();
    $('#stat-blocks').textContent       = blockSet.size.toLocaleString();
    $('#stat-designations').textContent = desigSet.size.toLocaleString();
    $('#stat-female').textContent       = femaleCount.toLocaleString();
  }

  // ─── SEARCH & FILTER ─────────────────────────────
  function matchRow(row, q, field, hasHindiInQuery, queryEng) {
    if (field !== 'all') {
      const val = (row[field] || '').toLowerCase();
      if (val.includes(q)) return true;
      if (queryEng && val.includes(queryEng)) return true;
      if (hasHindiInQuery && row._trans && row._trans.includes(queryEng || q)) return true;
      return false;
    }

    const name = (row['Name'] || '').toLowerCase();
    if (name.includes(q)) return true;
    if (queryEng && name.includes(queryEng)) return true;

    const contact = row['Contact No.'] || '';
    if (contact && contact.includes(q)) return true;

    const dist = (row['District'] || '').toLowerCase();
    if (dist.includes(q)) return true;
    if (queryEng && dist.includes(queryEng)) return true;

    const block = (row['Block'] || '').toLowerCase();
    if (block.includes(q)) return true;
    if (queryEng && block.includes(queryEng)) return true;

    const desig = (row['Current JS Designation Final'] || '').toLowerCase();
    if (desig.includes(q)) return true;
    if (queryEng && desig.includes(queryEng)) return true;

    const cat = (row['Category'] || '').toLowerCase();
    if (cat.includes(q)) return true;

    const pan = (row['Panchayat'] || '').toLowerCase();
    if (pan.includes(q)) return true;
    if (queryEng && pan.includes(queryEng)) return true;

    const caste = (row['Caste'] || '').toLowerCase();
    if (caste.includes(q)) return true;
    if (queryEng && caste.includes(queryEng)) return true;

    const father = (row["Father/Husband's Name"] || '').toLowerCase();
    if (father.includes(q)) return true;
    if (queryEng && father.includes(queryEng)) return true;

    const anumandal = (row['Anumandal'] || '').toLowerCase();
    if (anumandal.includes(q)) return true;

    const profile = (row['Profile'] || '').toLowerCase();
    if (profile.includes(q)) return true;

    if (row._hasHindi && row._trans && row._trans.includes(q)) return true;

    return false;
  }

  async function applySearchAndFilters() {
    const rawQuery = searchInput.value.trim();
    const hasHindiInQuery = HINDI_REGEX.test(rawQuery);
    const query = rawQuery.toLowerCase();
    const queryEng = hasHindiInQuery ? transliterateHindi(rawQuery).toLowerCase() : '';

    const filterDistrict    = ($('#filter-district').value || '').trim();
    const filterBlock       = ($('#filter-block').value || '').toLowerCase().trim();
    const filterCategory    = ($('#filter-category').value || '').toLowerCase().trim();
    const filterCaste       = ($('#filter-caste').value || '').toLowerCase().trim();
    const filterGender      = ($('#filter-gender').value || '').toLowerCase().trim();
    const filterDesignation = ($('#filter-designation').value || '').toLowerCase().trim();
    const filterStatus      = ($('#filter-status').value || '').toLowerCase().trim();
    const filterAnumandal   = ($('#filter-anumandal').value || '').toLowerCase().trim();

    // If district selection changed, ensure district partition is loaded
    if (filterDistrict && filterDistrict.toLowerCase() !== activeDistrict.toLowerCase()) {
      activeDistrict = filterDistrict;
      await loadDistrictData(filterDistrict);
      updateBlockOptions();
    } else if (!filterDistrict && activeDistrict) {
      activeDistrict = '';
      allData = initialData;
      updateBlockOptions();
    }

    const hasFilters = Boolean(
      filterDistrict || filterBlock || filterCategory ||
      filterCaste || filterGender || filterDesignation ||
      filterStatus || filterAnumandal
    );

    // 1. Text search via Serverless API across entire 95k dataset
    if (rawQuery.length >= 2) {
      const apiResult = await searchViaApi(rawQuery, searchField, {
        district: filterDistrict,
        block: filterBlock,
        category: filterCategory,
        caste: filterCaste,
        gender: filterGender,
        designation: filterDesignation,
        status: filterStatus
      });

      if (apiResult && Array.isArray(apiResult.results)) {
        isRemoteSearchActive = true;
        remoteSearchTotal = apiResult.total;
        filteredData = apiResult.results;
        currentPage = 1;
        updateStats();
        renderTable();
        renderActiveBadges({
          'District': $('#filter-district').value,
          'Block': $('#filter-block').value,
          'Category': $('#filter-category').value,
          'Caste': $('#filter-caste').value,
          'Gender': $('#filter-gender').value,
          'Current JS Designation Final': $('#filter-designation').value,
          'Current  Status': $('#filter-status').value,
          'Anumandal': $('#filter-anumandal').value,
        });
        updateSearchPlaceholder();
        return;
      }
    }

    // 2. Local filtering (or fallback if API is unreachable)
    isRemoteSearchActive = false;

    if (!query && !hasFilters) {
      filteredData = allData;
      currentPage = 1;
      updateStats(!activeDistrict);
      renderTable();
      renderActiveBadges({});
      updateSearchPlaceholder();
      return;
    }

    const isBulk = query.includes('\n') || query.includes(',');
    const bulkQueries = isBulk ? query.split(/[\n,]+/).map(q => q.trim().toLowerCase()).filter(Boolean) : null;

    filteredData = allData.filter(row => {
      // 1. Text search
      if (query) {
        if (isBulk && bulkQueries.length > 0) {
          const matched = bulkQueries.some(bq => matchRow(row, bq, searchField, false, ''));
          if (!matched) return false;
        } else {
          if (!matchRow(row, query, searchField, hasHindiInQuery, queryEng)) return false;
        }
      }

      // 2. Dropdown filters
      if (hasFilters) {
        if (filterDistrict && !(row['District'] || '').toLowerCase().includes(filterDistrict.toLowerCase())) return false;
        if (filterBlock && !(row['Block'] || '').toLowerCase().includes(filterBlock)) return false;
        if (filterCategory && (row['Category'] || '').toLowerCase() !== filterCategory) return false;
        if (filterCaste && (row['Caste'] || '').toLowerCase() !== filterCaste) return false;
        if (filterGender && (row['Gender'] || '').toLowerCase() !== filterGender) return false;
        if (filterDesignation && (row['Current JS Designation Final'] || '').toLowerCase() !== filterDesignation) return false;
        if (filterStatus && (row['Current  Status'] || '').toLowerCase() !== filterStatus) return false;
        if (filterAnumandal && (row['Anumandal'] || '').toLowerCase() !== filterAnumandal) return false;
      }

      return true;
    });

    currentPage = 1;
    updateStats(false);
    renderTable();
    renderActiveBadges({
      'District': $('#filter-district').value,
      'Block': $('#filter-block').value,
      'Category': $('#filter-category').value,
      'Caste': $('#filter-caste').value,
      'Gender': $('#filter-gender').value,
      'Current JS Designation Final': $('#filter-designation').value,
      'Current  Status': $('#filter-status').value,
      'Anumandal': $('#filter-anumandal').value,
    });
    updateSearchPlaceholder();
  }

  function renderActiveBadges(filters) {
    activeBadges.innerHTML = '';
    const query = searchInput.value.trim();

    if (searchClearBtn) {
      searchClearBtn.style.display = query ? 'flex' : 'none';
    }

    if (query) {
      const fieldLabel = searchField === 'all' ? 'All Fields' : getFieldLabel(searchField);
      activeBadges.innerHTML += `<span class="filter-badge">🔎 ${fieldLabel}: "${esc(query)}" <button onclick="document.getElementById('search-input').value='';if(window._updateSearchClearBtn)window._updateSearchClearBtn();window._applyFilters();">×</button></span>`;
    }
    for (const [col, val] of Object.entries(filters)) {
      if (val) {
        const shortCol = col.replace('Current JS Designation Final', 'Designation').replace('Current  Status', 'Status');
        activeBadges.innerHTML += `<span class="filter-badge">${shortCol}: ${val} <button data-filter-col="${col}" onclick="window._clearSingleFilter(this.dataset.filterCol);">×</button></span>`;
      }
    }

    if (filterCountBadge) {
      const count = Object.values(filters).filter(Boolean).length;
      if (count > 0) {
        filterCountBadge.textContent = count;
        filterCountBadge.style.display = 'inline-flex';
      } else {
        filterCountBadge.style.display = 'none';
      }
    }
  }

  function getFieldLabel(field) {
    const map = {
      'Name': 'Name',
      'Contact No.': 'Contact',
      'District': 'District',
      'Block': 'Block',
      'Panchayat': 'Panchayat',
      'Category': 'Category',
      'Caste': 'Caste',
      'Current JS Designation Final': 'Designation'
    };
    return map[field] || field;
  }

  function updateSearchPlaceholder() {
    const activeFilters = [];
    const dist = $('#filter-district').value;
    const blk = $('#filter-block').value;
    const cat = $('#filter-category').value;
    if (dist) activeFilters.push(dist);
    if (blk) activeFilters.push(blk);
    if (cat) activeFilters.push(cat);

    let prefix = searchField === 'all' ? 'Search by name, contact, panchayat' : `Search by ${getFieldLabel(searchField)}`;
    if (activeFilters.length > 0) {
      prefix += ` in ${activeFilters.join(', ')}`;
    }
    prefix += '… (English or हिंदी)';
    searchInput.placeholder = prefix;
  }

  // ─── SORTING ──────────────────────────────────────
  function sortData(col) {
    if (sortCol === col) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortCol = col;
      sortDir = 'asc';
    }

    filteredData.sort((a, b) => {
      let va = a[col] || '';
      let vb = b[col] || '';

      if (col === 'Age') {
        const na = parseInt(va, 10) || 0;
        const nb = parseInt(vb, 10) || 0;
        return sortDir === 'asc' ? na - nb : nb - na;
      }

      va = va.toLowerCase();
      vb = vb.toLowerCase();
      return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    });

    $$('th[data-col]').forEach(th => {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.dataset.col === col) th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    });

    currentPage = 1;
    renderTable();
  }

  // ─── TABLE & CARDS RENDERING ─────────────────────
  function renderTable() {
    const start    = (currentPage - 1) * perPage;
    const end      = start + perPage;
    const pageData = filteredData.slice(start, end);

    if (isRemoteSearchActive) {
      resultsCount.innerHTML = `Showing <strong>${Math.min(start + 1, remoteSearchTotal)}–${Math.min(end, remoteSearchTotal)}</strong> of <strong>${remoteSearchTotal.toLocaleString()}</strong> matches for "<em>${esc(searchInput.value.trim())}</em>"`;
    } else if (filteredData === initialData && !searchInput.value.trim() && !activeDistrict) {
      resultsCount.innerHTML = `Showing <strong>${Math.min(start + 1, filteredData.length)}–${Math.min(end, filteredData.length)}</strong> of <strong>${(summaryData?.totalContacts || 95722).toLocaleString()}</strong> contacts <span style="opacity:0.75;font-size:0.85em;">(Search or select a district to view all)</span>`;
    } else {
      resultsCount.innerHTML = `Showing <strong>${Math.min(start + 1, filteredData.length)}–${Math.min(end, filteredData.length)}</strong> of <strong>${filteredData.length.toLocaleString()}</strong> contacts`;
    }

    if (pageData.length === 0) {
      const emptyHtml = `
        <div class="empty-state">
          <div class="empty-icon">🔍</div>
          <h3>No results found</h3>
          <p>Try adjusting your search or filters</p>
        </div>
      `;
      tableBody.innerHTML = `<tr><td colspan="8">${emptyHtml}</td></tr>`;
      if (cardsContainer) cardsContainer.innerHTML = emptyHtml;
      pagination.innerHTML = '';
      return;
    }

    // Build Table Rows and Mobile Cards
    const rows = new Array(pageData.length);
    const cards = new Array(pageData.length);

    for (let k = 0; k < pageData.length; k++) {
      const row = pageData[k];
      const catClass    = getCategoryClass(row['Category']);
      const isFemale    = row['Gender']?.toLowerCase() === 'female';
      const genderClass = isFemale ? 'cell-gender-female' : 'cell-gender-male';

      // 1. Table row HTML
      rows[k] = `<tr data-index="${start + k}">
        <td class="cell-name">${esc(row['Name'])}</td>
        <td class="cell-contact">${renderContactCell(row['Contact No.'])}</td>
        <td>${esc(row['District'])}</td>
        <td>${esc(row['Block'])}</td>
        <td>${esc(row['Panchayat'])}</td>
        <td><span class="badge badge-category ${catClass}">${esc(row['Category'] || '—')}</span></td>
        <td>${esc(row['Caste'] || '—')}</td>
        <td class="${genderClass}">${esc(row['Gender'] || '—')}</td>
        <td class="cell-designation" title="${esc(row['Current JS Designation Final'])}">${esc(row['Current JS Designation Final'])}</td>
      </tr>`;

      // 2. Mobile Card HTML
      const rawContact = (row['Contact No.'] || '').trim();
      const validPhone = parseContactNumbers(rawContact)[0] || '';
      const initials = (row['Name'] || 'JS').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'JS';

      const waBtn = validPhone
        ? `<a href="https://wa.me/91${validPhone}" target="_blank" rel="noopener" class="card-action-btn card-wa-btn" title="WhatsApp" onclick="event.stopPropagation()">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981z"/></svg>
            <span>WA</span>
          </a>`
        : '';

      const callBtn = validPhone
        ? `<a href="tel:${validPhone}" class="card-action-btn card-call-btn" title="Call" onclick="event.stopPropagation()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79a15.053 15.053 0 006.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>
            <span>Call</span>
          </a>`
        : '';

      cards[k] = `<div class="mobile-card" data-index="${start + k}">
        <div class="card-top">
          <div class="card-avatar">${esc(initials)}</div>
          <div class="card-header-info">
            <div class="card-name">${esc(row['Name'] || 'Unknown')}</div>
            <div class="card-desig">${esc(row['Current JS Designation Final'] || '—')}</div>
          </div>
          <span class="badge badge-category ${catClass}">${esc(row['Category'] || '—')}</span>
        </div>
        <div class="card-meta-grid">
          <div class="card-meta-item">
            <span class="card-meta-lbl">District</span>
            <span class="card-meta-val">${esc(row['District'] || '—')}</span>
          </div>
          <div class="card-meta-item">
            <span class="card-meta-lbl">Block</span>
            <span class="card-meta-val">${esc(row['Block'] || '—')}</span>
          </div>
          <div class="card-meta-item">
            <span class="card-meta-lbl">Panchayat</span>
            <span class="card-meta-val">${esc(row['Panchayat'] || '—')}</span>
          </div>
          <div class="card-meta-item">
            <span class="card-meta-lbl">Caste / Gender</span>
            <span class="card-meta-val">${esc(row['Caste'] || '—')} · ${esc(row['Gender'] || '—')}</span>
          </div>
        </div>
        <div class="card-footer">
          <div class="card-phone">${validPhone ? '📞 ' + validPhone : '<span class="cell-no-contact">No Phone</span>'}</div>
          <div class="card-actions">${callBtn}${waBtn}</div>
        </div>
      </div>`;
    }

    tableBody.innerHTML = rows.join('');
    if (cardsContainer) cardsContainer.innerHTML = cards.join('');

    renderPagination();
  }

  function renderContactCell(raw) {
    const phones = parseContactNumbers(raw);
    if (phones.length === 0) {
      return '<span class="cell-no-contact">—</span>';
    }
    return phones.map(p =>
      `<a href="tel:${p}" class="phone-link" onclick="event.stopPropagation()">${p}</a>`
    ).join(', ');
  }

  function getCategoryClass(cat) {
    if (!cat) return 'cat-other';
    const c = cat.toLowerCase();
    if (c.includes('general') || c.includes('gen')) return 'cat-general';
    if (c.includes('ebc')) return 'cat-ebc';
    if (c.includes('obc') || c.includes('bc')) return 'cat-obc';
    if (c.includes('sc')) return 'cat-sc';
    if (c.includes('st')) return 'cat-st';
    if (c.includes('minority')) return 'cat-minority';
    return 'cat-other';
  }

  function esc(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ─── PAGINATION ───────────────────────────────────
  function renderPagination() {
    const totalCount = isRemoteSearchActive ? remoteSearchTotal : filteredData.length;
    const totalPages = Math.ceil(totalCount / perPage);
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
    $('#modal-desig').textContent   = row['Current JS Designation Final'] || 'Jan Suraaj Member';
    $('#modal-category').textContent= row['Category'] || '—';
    $('#modal-category').className  = `badge badge-category ${getCategoryClass(row['Category'])}`;

    const phones = parseContactNumbers(row['Contact No.']);
    const primaryPhone = phones[0] || '';

    const waBtn = $('#modal-btn-wa');
    if (waBtn) {
      if (primaryPhone) {
        waBtn.href = `https://wa.me/91${primaryPhone}`;
        waBtn.style.display = 'inline-flex';
      } else {
        waBtn.style.display = 'none';
      }
    }

    const callBtn = $('#modal-btn-call');
    if (callBtn) {
      if (primaryPhone) {
        callBtn.href = `tel:${primaryPhone}`;
        callBtn.style.display = 'inline-flex';
      } else {
        callBtn.style.display = 'none';
      }
    }

    const fieldsGrid = $('#modal-fields-grid');
    if (fieldsGrid) {
      fieldsGrid.innerHTML = COLUMNS.map(col => {
        let val = row[col] || '—';
        if (col === 'Contact No.') {
          val = phones.length > 0
            ? phones.map(p => `<a href="tel:${p}" class="phone-link">${p}</a>`).join(', ')
            : '<span class="cell-no-contact">Not Available</span>';
        } else {
          val = esc(val);
        }
        return `
          <div class="modal-field-item">
            <div class="modal-field-label">${esc(col)}</div>
            <div class="modal-field-value">${val}</div>
          </div>
        `;
      }).join('');
    }

    detailModal.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeDetail() {
    detailModal.classList.remove('open');
    document.body.style.overflow = '';
  }

  // ─── CHARTS ───────────────────────────────────────
  function renderCharts() {
    const ChartLib = window.Chart;
    if (!ChartLib) { showToast('Chart library still loading…', 'error'); return; }

    Object.values(chartInstances).forEach(c => c.destroy());
    chartInstances = {};

    const palette = [
      '#6366f1','#8b5cf6','#a78bfa','#c084fc',
      '#ec4899','#f472b6','#fb7185','#f87171',
      '#f59e0b','#fbbf24','#facc15','#a3e635',
      '#4ade80','#34d399','#2dd4bf','#22d3ee',
      '#38bdf8','#60a5fa','#818cf8','#a5b4fc'
    ];

    const hasFilter = Boolean(
      $('#filter-district').value || $('#filter-block').value ||
      $('#filter-category').value || $('#filter-caste').value ||
      $('#filter-gender').value || $('#filter-designation').value ||
      $('#filter-status').value || $('#filter-anumandal').value ||
      searchInput.value.trim()
    );

    // Instant render via pre-computed summaryData.analytics
    if (!hasFilter && summaryData && summaryData.analytics) {
      const a = summaryData.analytics;

      // 1. District bar
      chartInstances.districts = new ChartLib($('#chart-districts'), {
        type: 'bar',
        data: {
          labels: a.topDistricts.slice(0, 20).map(d => d.district),
          datasets: [{ label: 'Contacts', data: a.topDistricts.slice(0, 20).map(d => d.count),
            backgroundColor: palette.slice(0, 20), borderRadius: 6, borderSkipped: false }]
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
      $('#chart-districts').parentElement.style.height = Math.max(400, Math.min(20, a.topDistricts.length) * 28) + 'px';

      // 2. Categories doughnut
      chartInstances.categories = new ChartLib($('#chart-categories'), {
        type: 'doughnut',
        data: {
          labels: a.categories.map(c => c[0]),
          datasets: [{ data: a.categories.map(c => c[1]),
            backgroundColor: palette.slice(0, a.categories.length), borderWidth: 0, hoverOffset: 8 }]
        },
        options: { responsive: true,
          plugins: { legend: { position: 'bottom', labels: { color: '#94a3b8', padding: 16, font: { size: 11 } } } }
        }
      });

      // 3. Gender doughnut
      chartInstances.gender = new ChartLib($('#chart-gender'), {
        type: 'doughnut',
        data: {
          labels: ['Male', 'Female', 'Other / Unknown'],
          datasets: [{ data: [a.gender.male, a.gender.female, a.gender.other],
            backgroundColor: ['#60a5fa','#f472b6','#94a3b8'], borderWidth: 0, hoverOffset: 8 }]
        },
        options: { responsive: true,
          plugins: { legend: { position: 'bottom', labels: { color: '#94a3b8', padding: 16, font: { size: 11 } } } }
        }
      });

      // 4. Designations bar
      chartInstances.designations = new ChartLib($('#chart-designations'), {
        type: 'bar',
        data: {
          labels: a.topDesignations.slice(0, 12).map(d => d[0].length > 25 ? d[0].slice(0, 25) + '…' : d[0]),
          datasets: [{ label: 'Count', data: a.topDesignations.slice(0, 12).map(d => d[1]),
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

      // 5. Age bar
      chartInstances.age = new ChartLib($('#chart-age'), {
        type: 'bar',
        data: {
          labels: Object.keys(a.age),
          datasets: [{ label: 'Contacts', data: Object.values(a.age),
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
      return;
    }

    // Dynamic fallback when filtered
    const data = filteredData;
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
    const list = $('#duplicates-list');
    if (!list) return;

    const data = filteredData.length > 0 ? filteredData : allData;
    const phoneMap = {};

    for (let i = 0; i < data.length; i++) {
      const r = data[i];
      const phones = parseContactNumbers(r['Contact No.']);
      for (const p of phones) {
        if (!phoneMap[p]) phoneMap[p] = [];
        phoneMap[p].push(r);
      }
    }

    const dupes = Object.entries(phoneMap)
      .filter(([, rows]) => rows.length > 1)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 100);

    $('#duplicate-count').textContent = dupes.length.toLocaleString();

    if (dupes.length === 0) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon">✓</div><h3>No duplicates found</h3><p>Every contact number is unique in this view</p></div>';
      return;
    }

    list.innerHTML = dupes.map(([phone, rows]) => `
      <div class="duplicate-group">
        <div class="duplicate-group-header">
          <span class="duplicate-phone">📞 ${phone}</span>
          <span class="duplicate-badge">${rows.length} contacts</span>
        </div>
        <div class="duplicate-cards">
          ${rows.map(r => `
            <div class="duplicate-card">
              <div class="dup-name">${esc(r['Name'])}</div>
              <div class="dup-detail">${esc(r['District'])} · ${esc(r['Block'])} · ${esc(r['Panchayat'])}</div>
              <div class="dup-desig">${esc(r['Current JS Designation Final'])}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');
  }

  // ─── LAZY LIBRARY LOADER ──────────────────────────
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load: ' + src));
      document.head.appendChild(s);
    });
  }

  async function ensureXLSX() {
    if (_xlsxLoaded || window.XLSX) return true;
    showToast('Loading Excel export engine…', 'info');
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
      _xlsxLoaded = true;
      return true;
    } catch {
      showToast('Failed to load Excel library. Falling back to CSV.', 'error');
      return false;
    }
  }

  async function ensureJSPDF() {
    if (_jspdfLoaded || (window.jspdf && window.jspdf.jsPDF)) return true;
    showToast('Loading PDF export engine…', 'info');
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
      await loadScript('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js');
      _jspdfLoaded = true;
      return true;
    } catch {
      showToast('Failed to load PDF library', 'error');
      return false;
    }
  }

  // ─── EXPORT ───────────────────────────────────────
  function exportCSV(dataArray = filteredData, filename = 'sangathan_contacts.csv') {
    if (!dataArray || dataArray.length === 0) { showToast('No data to export', 'error'); return; }

    const cols = COLUMNS;
    const lines = [cols.map(c => `"${c.replace(/"/g, '""')}"`).join(',')];

    for (let i = 0; i < dataArray.length; i++) {
      const r = dataArray[i];
      const row = cols.map(c => {
        const val = r[c] || '';
        return `"${String(val).replace(/"/g, '""')}"`;
      });
      lines.push(row.join(','));
    }

    downloadFile(lines.join('\r\n'), filename, 'text/csv;charset=utf-8;');
    showToast(`Exported ${dataArray.length.toLocaleString()} contacts to CSV`, 'success');
  }

  async function exportExcel(dataArray = filteredData, filename = 'sangathan_contacts.xlsx') {
    if (!dataArray || dataArray.length === 0) { showToast('No data to export', 'error'); return; }

    const ok = await ensureXLSX();
    if (!ok) { exportCSV(dataArray); return; }

    const XLSX = window.XLSX;
    const wsData = [COLUMNS];

    for (let i = 0; i < dataArray.length; i++) {
      const r = dataArray[i];
      wsData.push(COLUMNS.map(c => r[c] || ''));
    }

    const ws = XLSX.utils.aoa_to_sheet(wsData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Contacts');
    XLSX.writeFile(wb, filename);
    showToast(`Exported ${dataArray.length.toLocaleString()} contacts to Excel`, 'success');
  }

  async function exportPDF(dataArray = filteredData, filename = 'sangathan_contacts.pdf') {
    if (!dataArray || dataArray.length === 0) { showToast('No data to export', 'error'); return; }

    const ok = await ensureJSPDF();
    if (!ok) return;

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

    doc.setFontSize(14);
    doc.text('Jan Suraaj — Sangathan Contact Directory', 40, 30);
    doc.setFontSize(9);
    doc.text(`Exported: ${new Date().toLocaleDateString('en-IN')} | Total: ${dataArray.length.toLocaleString()} contacts`, 40, 46);

    const exportCols = ['Name', 'Contact No.', 'District', 'Block', 'Panchayat', 'Category', 'Current JS Designation Final'];
    const tableData = dataArray.slice(0, 1000).map(r => exportCols.map(c => r[c] || ''));

    doc.autoTable({
      head: [exportCols],
      body: tableData,
      startY: 55,
      styles: { fontSize: 7, cellPadding: 3 },
      headStyles: { fillColor: [99, 102, 241], textColor: 255 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      margin: { left: 40, right: 40 }
    });

    if (dataArray.length > 1000) {
      doc.setFontSize(8);
      doc.text('* Limited to first 1,000 records for PDF size constraints. Use Excel for full export.', 40, doc.lastAutoTable.finalY + 15);
    }

    doc.save(filename);
    showToast(`Exported PDF (${Math.min(dataArray.length, 1000).toLocaleString()} contacts)`, 'success');
  }

  function downloadFile(content, filename, mime) {
    const blob = new Blob(['\ufeff' + content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ─── TOAST ────────────────────────────────────────
  function showToast(message, type = 'success') {
    let container = $('#toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  // ─── DATA QUALITY ─────────────────────────────────
  let dqPage        = 1;
  const DQ_PER_PAGE = 50;
  let dqFiltered    = [];
  let dqFilterType  = 'all';

  function renderDataQuality() {
    const hasFilter = Boolean(
      $('#filter-district').value || $('#filter-block').value ||
      $('#filter-category').value || $('#filter-caste').value ||
      $('#filter-gender').value || $('#filter-designation').value ||
      $('#filter-status').value || $('#filter-anumandal').value ||
      searchInput.value.trim()
    );

    // Instant pre-computed data quality view
    if (!hasFilter && summaryData && summaryData.dataQuality) {
      const dq = summaryData.dataQuality;
      $('#dq-total').textContent           = dq.total.toLocaleString();
      $('#dq-complete').textContent        = dq.completeCount.toLocaleString();
      $('#dq-partial').textContent         = dq.partialCount.toLocaleString();
      $('#dq-missing-contact').textContent = dq.missingContact.toLocaleString();
      $('#dq-missing-gender').textContent  = dq.missingGender.toLocaleString();

      const grid = $('#dq-fields-grid');
      if (grid) {
        grid.innerHTML = dq.fieldStats.map(stat => {
          const pct = parseFloat(stat.pct);
          const cls = pct >= 90 ? 'dq-good' : (pct >= 70 ? 'dq-warn' : 'dq-poor');
          return `
            <div class="dq-field-card ${cls}">
              <div class="dq-field-top">
                <span class="dq-field-name">${esc(stat.key)}</span>
                <span class="dq-field-pct">${stat.pct}%</span>
              </div>
              <div class="dq-progress-bg">
                <div class="dq-progress-bar" style="width:${stat.pct}%"></div>
              </div>
              <div class="dq-field-sub">
                <span>Filled: ${stat.filled.toLocaleString()}</span>
                <span>Missing: ${stat.missing.toLocaleString()}</span>
              </div>
            </div>
          `;
        }).join('');
      }

      dqFiltered = allData;
      renderDQBrowser();
      return;
    }

    // Dynamic fallback when filters active
    const data  = allData;
    const total = data.length;
    if (!total) return;

    const CORE = ['Name','Contact No.','Gender','District','Block','Category'];
    let completeCount = 0;
    let missingContact = 0;
    let missingGender  = 0;

    const fieldFilledCounts = Object.create(null);
    for (let f = 0; f < DQ_KEY_FIELDS.length; f++) {
      fieldFilledCounts[DQ_KEY_FIELDS[f].key] = 0;
    }

    for (let i = 0; i < total; i++) {
      const row = data[i];
      let isCoreComplete = true;

      for (let c = 0; c < CORE.length; c++) {
        if (!(row[CORE[c]] || '').trim()) {
          isCoreComplete = false;
          break;
        }
      }
      if (isCoreComplete) completeCount++;

      if (!(row['Contact No.'] || '').trim()) missingContact++;
      if (!(row['Gender']      || '').trim()) missingGender++;

      for (let f = 0; f < DQ_KEY_FIELDS.length; f++) {
        const k = DQ_KEY_FIELDS[f].key;
        if ((row[k] || '').trim()) {
          fieldFilledCounts[k]++;
        }
      }
    }

    $('#dq-total').textContent           = total.toLocaleString();
    $('#dq-complete').textContent        = completeCount.toLocaleString();
    $('#dq-partial').textContent         = (total - completeCount).toLocaleString();
    $('#dq-missing-contact').textContent = missingContact.toLocaleString();
    $('#dq-missing-gender').textContent  = missingGender.toLocaleString();

    const grid = $('#dq-fields-grid');
    if (grid) {
      grid.innerHTML = DQ_KEY_FIELDS.map(f => {
        const filled  = fieldFilledCounts[f.key] || 0;
        const missing = total - filled;
        const pct     = (filled / total * 100).toFixed(1);
        const cls     = pct >= 90 ? 'dq-good' : (pct >= 70 ? 'dq-warn' : 'dq-poor');
        return `
          <div class="dq-field-card ${cls}">
            <div class="dq-field-top">
              <span class="dq-field-name">${f.label}</span>
              <span class="dq-field-pct">${pct}%</span>
            </div>
            <div class="dq-progress-bg">
              <div class="dq-progress-bar" style="width:${pct}%"></div>
            </div>
            <div class="dq-field-sub">
              <span>Filled: ${filled.toLocaleString()}</span>
              <span>Missing: ${missing.toLocaleString()}</span>
            </div>
          </div>
        `;
      }).join('');
    }

    dqFiltered = allData;
    renderDQBrowser();
  }

  function filterDQData(type) {
    dqFilterType = type;
    dqPage = 1;
    $$('.dq-btn').forEach(b => b.classList.toggle('active', b.dataset.dqFilter === type));

    if (type === 'all') {
      dqFiltered = allData;
    } else if (type === 'missing-contact') {
      dqFiltered = allData.filter(r => !(r['Contact No.'] || '').trim());
    } else if (type === 'missing-gender') {
      dqFiltered = allData.filter(r => !(r['Gender'] || '').trim());
    } else if (type === 'missing-panchayat') {
      dqFiltered = allData.filter(r => !(r['Panchayat'] || '').trim());
    } else if (type === 'missing-category') {
      dqFiltered = allData.filter(r => !(r['Category'] || '').trim());
    } else if (type === 'incomplete') {
      const CORE = ['Name','Contact No.','Gender','District','Block','Category'];
      dqFiltered = allData.filter(r => CORE.some(f => !(r[f] || '').trim()));
    }

    renderDQBrowser();
  }

  function renderDQBrowser() {
    const total      = dqFiltered.length;
    const totalPages = Math.ceil(total / DQ_PER_PAGE) || 1;
    const start      = (dqPage - 1) * DQ_PER_PAGE;
    const pageData   = dqFiltered.slice(start, start + DQ_PER_PAGE);

    $('#dq-browser-count').textContent = `Showing ${Math.min(start + 1, total)}–${Math.min(start + pageData.length, total)} of ${total.toLocaleString()} records`;

    const body = $('#dq-table-body');
    if (!body) return;

    if (pageData.length === 0) {
      body.innerHTML = '<tr><td colspan="7" class="empty-state"><div class="empty-icon">✓</div><h3>No records in this view</h3></td></tr>';
      $('#dq-pagination').innerHTML = '';
      return;
    }

    const c = (key, row) => {
      const v = (row[key] || '').trim();
      return v ? esc(v) : '<span class="dq-tag-missing">Missing</span>';
    };

    body.innerHTML = pageData.map((r, i) => `
      <tr data-dq-idx="${start + i}">
        <td>${c('Name', r)}</td>
        <td>${c('Contact No.', r)}</td>
        <td>${c('District', r)}</td>
        <td>${c('Block', r)}</td>
        <td>${c('Panchayat', r)}</td>
        <td>${c('Category', r)}</td>
        <td>${c('Gender', r)}</td>
      </tr>
    `).join('');

    renderDQPagination(totalPages);
  }

  function renderDQPagination(totalPages) {
    const container = $('#dq-pagination');
    if (!container || totalPages <= 1) { if (container) container.innerHTML = ''; return; }

    const parts = [`<button class="page-btn" ${dqPage === 1 ? 'disabled' : ''} data-dq-page="${dqPage - 1}">◀</button>`];
    for (const p of getPageRange(dqPage, totalPages)) {
      if (p === '...') parts.push('<span class="page-info">…</span>');
      else parts.push(`<button class="page-btn ${p === dqPage ? 'active' : ''}" data-dq-page="${p}">${p}</button>`);
    }
    parts.push(`<button class="page-btn" ${dqPage === totalPages ? 'disabled' : ''} data-dq-page="${dqPage + 1}">▶</button>`);
    container.innerHTML = parts.join('');
  }

  // ─── EVENT LISTENERS ──────────────────────────────
  function initEvents() {
    window._clearSingleFilter = (col) => {
      const map = {
        'District': '#filter-district',
        'Block': '#filter-block',
        'Category': '#filter-category',
        'Caste': '#filter-caste',
        'Gender': '#filter-gender',
        'Current JS Designation Final': '#filter-designation',
        'Current  Status': '#filter-status',
        'Anumandal': '#filter-anumandal',
      };
      const sel = map[col];
      if (sel) {
        const el = $(sel);
        if (el) el.value = '';
      }
      applySearchAndFilters();
    };

    window._applyFilters = () => applySearchAndFilters();

    const updateClearBtn = () => {
      if (searchClearBtn) {
        searchClearBtn.style.display = searchInput.value.trim() ? 'flex' : 'none';
      }
    };
    window._updateSearchClearBtn = updateClearBtn;

    // Search input (debounced by 250ms)
    searchInput.addEventListener('input', () => {
      updateClearBtn();
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        applySearchAndFilters();
      }, 250);
    });

    if (searchClearBtn) {
      searchClearBtn.addEventListener('click', () => {
        searchInput.value = '';
        updateClearBtn();
        applySearchAndFilters();
        searchInput.focus();
      });
    }

    // Search field scope dropdown
    const searchFieldSelect = $('#search-field-select');
    if (searchFieldSelect) {
      searchFieldSelect.addEventListener('change', () => {
        searchField = searchFieldSelect.value;
        applySearchAndFilters();
      });
    }

    // Filter controls
    const filterSelectors = [
      '#filter-district', '#filter-block', '#filter-category',
      '#filter-caste', '#filter-gender', '#filter-designation',
      '#filter-status', '#filter-anumandal'
    ];

    filterSelectors.forEach(sel => {
      const el = $(sel);
      if (!el) return;
      el.addEventListener('change', () => {
        if (sel === '#filter-district') updateBlockOptions();
        applySearchAndFilters();
      });
      if (el.tagName === 'INPUT') {
        el.addEventListener('input', () => {
          if (sel === '#filter-district') updateBlockOptions();
          clearTimeout(searchDebounceTimer);
          searchDebounceTimer = setTimeout(() => applySearchAndFilters(), 300);
        });
      }
    });

    // Clear filters button
    const btnClear = $('#clear-filters') || $('#btn-clear-filters');
    if (btnClear) btnClear.addEventListener('click', () => {
      filterSelectors.forEach(sel => {
        const el = $(sel);
        if (el) el.value = '';
      });
      searchInput.value = '';
      updateClearBtn();
      activeDistrict = '';
      allData = initialData;
      updateBlockOptions();
      applySearchAndFilters();
    });

    // Toggle filter panel (mobile)
    if (filterToggle) {
      filterToggle.addEventListener('click', () => {
        filtersPanel.classList.toggle('open');
        filterToggle.classList.toggle('active');
      });
    }

    // View mode toggle
    if (btnViewCards) btnViewCards.addEventListener('click', () => setViewMode('cards'));
    if (btnViewTable) btnViewTable.addEventListener('click', () => setViewMode('table'));

    // Per-page select
    if (perPageSelect) {
      perPageSelect.addEventListener('change', () => {
        perPage = parseInt(perPageSelect.value, 10);
        currentPage = 1;
        renderTable();
      });
    }

    // Table header sort
    $$('th[data-col]').forEach(th => {
      th.addEventListener('click', () => sortData(th.dataset.col));
    });

    // Table row / card click -> detail modal
    tableBody.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      const tr = e.target.closest('tr[data-index]');
      if (tr) openDetail(parseInt(tr.dataset.index, 10));
    });

    if (cardsContainer) {
      cardsContainer.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        const card = e.target.closest('.mobile-card[data-index]');
        if (card) openDetail(parseInt(card.dataset.index, 10));
      });
    }

    // Detail modal close
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

    // Tab navigation (synced with mobile bottom nav)
    const switchTab = (tab) => {
      $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      $$('.bottom-nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      $$('.tab-panel').forEach(p => p.classList.remove('active'));
      const targetPanel = $(`#panel-${tab}`);
      if (targetPanel) targetPanel.classList.add('active');
      if (tab === 'analytics') renderCharts();
      if (tab === 'quality')   renderDataQuality();
      if (tab === 'duplicates') renderDuplicates();
    };

    $$('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    if (mobileBottomNav) {
      mobileBottomNav.addEventListener('click', (e) => {
        const item = e.target.closest('.bottom-nav-item');
        if (!item || !item.dataset.tab) return;
        switchTab(item.dataset.tab);
      });
    }

    // Export buttons
    const btnCsv = $('#export-csv') || $('#btn-export-csv');
    if (btnCsv) btnCsv.addEventListener('click', () => exportCSV());
    const btnXlsx = $('#export-excel') || $('#btn-export-excel');
    if (btnXlsx) btnXlsx.addEventListener('click', () => exportExcel());
    const pdfBtn = $('#export-pdf') || $('#btn-export-pdf');
    if (pdfBtn) pdfBtn.addEventListener('click', () => exportPDF());

    // Refresh button
    const btnRefresh = $('#btn-refresh-data') || $('#btn-refresh');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', () => {
        districtCache = {};
        loadData(true);
      });
    }

    // Bulk search modal
    $('#bulk-search-toggle').addEventListener('click', () => { bulkModal.classList.add('open'); });
    $('#bulk-modal-close').addEventListener('click',   () => { bulkModal.classList.remove('open'); });
    $('#bulk-search-clear').addEventListener('click',  () => { bulkSearchText.value = ''; });
    bulkModal.addEventListener('click', (e) => { if (e.target === bulkModal) bulkModal.classList.remove('open'); });

    $('#bulk-search-apply').addEventListener('click', () => {
      const text = bulkSearchText.value.trim();
      if (!text) return;

      const normalized = text
        .replace(/\r/g, '\n')
        .split(/\n+/)
        .map(v => v.trim())
        .filter(Boolean)
        .join(', ');

      if (normalized) {
        searchInput.value = normalized;
        updateClearBtn();
        applySearchAndFilters();
        bulkModal.classList.remove('open');
        switchTab('directory');
      }
    });

    // Fallback UI events
    if (csvFileInput) {
      csvFileInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) {
          showToast('Reading local CSV…', 'info');
          const reader = new FileReader();
          reader.onload = async () => {
            const lines = reader.result.split(/\r?\n/).filter(Boolean);
            const headers = lines[0].split(',');
            const rows = [];
            for (let i = 1; i < lines.length; i++) {
              const vals = lines[i].split(',');
              const obj = {};
              headers.forEach((h, idx) => { obj[h.trim()] = (vals[idx] || '').trim(); });
              rows.push(obj);
            }
            allData = rows;
            filteredData = allData;
            renderTable();
            hideLoader();
            showToast(`Loaded ${rows.length} records`, 'success');
          };
          reader.readAsText(file);
        }
      });
    }

    if (btnRetryLoad) {
      btnRetryLoad.addEventListener('click', () => loadData(true));
    }
  }

  // ─── INIT ─────────────────────────────────────────
  function boot() {
    updateViewModeUI();
    initEvents();
    loadData();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
