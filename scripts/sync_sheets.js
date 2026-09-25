const { runExport } = require('./export_data.js');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

async function main() {
  const start = Date.now();
  console.log('====================================================');
  console.log('   🔄 SANGATHAN SEARCH — LIVE GOOGLE SHEETS SYNC   ');
  console.log('====================================================\n');

  // Force sync from sheets
  if (!process.argv.includes('--from-sheets')) {
    process.argv.push('--from-sheets');
  }

  try {
    await runExport();
    console.log('\nGenerating SQLite database for instant MCP & search queries...');
    const buildSqliteScript = path.join(__dirname, 'build_sqlite.py');
    if (fs.existsSync(buildSqliteScript)) {
      const pythonExe = process.platform === 'win32'
        ? (fs.existsSync('C:\\Users\\alamn\\AppData\\Local\\Programs\\Python\\Python314\\python.exe')
            ? 'C:\\Users\\alamn\\AppData\\Local\\Programs\\Python\\Python314\\python.exe'
            : 'python')
        : 'python3';

      const res = spawnSync(pythonExe, [buildSqliteScript], { stdio: 'inherit' });
      if (res.error) {
        console.warn('Note: Could not run Python SQLite builder:', res.error.message);
      }
    }

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n🎉 Full Sync completed successfully in ${duration}s!`);
  } catch (err) {
    console.error('\n❌ Sync failed:', err);
    process.exit(1);
  }
}

main();
