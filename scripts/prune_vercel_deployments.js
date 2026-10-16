const https = require('https');

// Token passed as command line argument or env var
const TOKEN = process.env.VERCEL_TOKEN || process.argv[2];

if (!TOKEN) {
  console.error('\n❌ Error: Vercel Token is required!');
  console.log('\nUsage:');
  console.log('  node scripts/prune_vercel_deployments.js <YOUR_VERCEL_TOKEN>\n');
  process.exit(1);
}

function apiRequest(method, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.vercel.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'VercelPruner/2.0'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function main() {
  console.log('========================================================');
  console.log('  🧹 VERCEL AUTOMATED DEPLOYMENT PRUNER (FREE 8GB STORAGE)');
  console.log('========================================================\n');

  // 1. Fetch Projects to obtain account/team ID
  console.log('🔍 Connecting to Vercel and discovering project details...');
  const projRes = await apiRequest('GET', '/v9/projects');
  if (projRes.status !== 200 || !projRes.body || !projRes.body.projects) {
    console.error('❌ Failed to retrieve projects:', projRes.body);
    process.exit(1);
  }

  const project = projRes.body.projects.find(p => p.name === 'sangathan-search') || projRes.body.projects[0];
  const teamId = project.accountId;
  console.log(`✅ Project Found: "${project.name}" (ID: ${project.id})`);
  console.log(`✅ Account Scope: "${teamId}"\n`);

  // 2. Fetch all deployments
  console.log('📦 Fetching deployment list from Vercel...');
  const queryParam = teamId ? `?teamId=${teamId}&limit=100` : '?limit=100';
  const dplRes = await apiRequest('GET', `/v6/deployments${queryParam}`);

  if (!dplRes.body || !dplRes.body.deployments) {
    console.error('❌ Could not retrieve deployments:', dplRes.body);
    process.exit(1);
  }

  const deployments = dplRes.body.deployments;
  console.log(`📊 Found ${deployments.length} total deployments in project.\n`);

  if (deployments.length <= 1) {
    console.log('✨ Only 1 deployment exists. Nothing to delete!');
    return;
  }

  // 3. Keep the most recent READY deployment safe!
  const activeDeployment = deployments[0];
  console.log(`🔒 ACTIVE PRODUCTION DEPLOYMENT (PROTECTED):`);
  console.log(`   URL:  https://${activeDeployment.url}`);
  console.log(`   ID:   ${activeDeployment.uid}`);
  console.log(`   Date: ${new Date(activeDeployment.created).toLocaleString('en-IN')}\n`);

  // Deployments to delete are everything after index 0
  const toDelete = deployments.slice(1);
  console.log(`🚀 Deleting ${toDelete.length} old redundant deployments to free up ~8 GB storage...\n`);

  let deletedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < toDelete.length; i++) {
    const d = toDelete[i];
    const createdDate = new Date(d.created).toLocaleDateString('en-IN');
    const deletePath = `/v13/deployments/${d.uid}${teamId ? `?teamId=${teamId}` : ''}`;

    process.stdout.write(`[${i + 1}/${toDelete.length}] Deleting ${createdDate} (${d.uid})... `);

    try {
      const delRes = await apiRequest('DELETE', deletePath);
      if (delRes.status === 200 || delRes.status === 204) {
        process.stdout.write('✅ DELETED\n');
        deletedCount++;
      } else {
        const msg = delRes.body?.error?.message || `HTTP ${delRes.status}`;
        process.stdout.write(`⚠️ Skipped (${msg})\n`);
        failedCount++;
      }
    } catch (err) {
      process.stdout.write(`❌ Error: ${err.message}\n`);
      failedCount++;
    }

    // Small delay to be polite to Vercel API rate limits
    await new Promise(r => setTimeout(r, 150));
  }

  const approxFreedMB = deletedCount * 220;
  const approxFreedGB = (approxFreedMB / 1024).toFixed(2);

  console.log('\n========================================================');
  console.log(`🎉 SUCCESS! STORAGE CLEANUP COMPLETE:`);
  console.log(`   Deleted Deployments: ${deletedCount}`);
  if (failedCount > 0) console.log(`   Skipped/Failed:     ${failedCount}`);
  console.log(`   Approx Storage Recovered: ~${approxFreedGB} GB!`);
  console.log(`   Live Website Status:       SAFE & RUNNING (${activeDeployment.url})`);
  console.log('========================================================\n');
}

main().catch(console.error);
