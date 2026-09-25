const { runExport } = require('../scripts/export_data.js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    if (res.status) res.status(204).end();
    else { res.statusCode = 204; res.end(); }
    return;
  }

  try {
    // Run the export with --from-sheets flag enabled
    process.argv.push('--from-sheets');
    await runExport();
    const result = {
      success: true,
      message: 'Successfully synced live data from Google Sheets!',
      timestamp: new Date().toISOString()
    };
    if (res.status) res.status(200).json(result);
    else { res.statusCode = 200; res.end(JSON.stringify(result)); }
  } catch (err) {
    console.error('API sync error:', err);
    const errResult = { success: false, error: err.message };
    if (res.status) res.status(500).json(errResult);
    else { res.statusCode = 500; res.end(JSON.stringify(errResult)); }
  }
};
