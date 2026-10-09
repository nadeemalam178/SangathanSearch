const https = require('https');

// Token can be passed as CLI argument or env variable
const TOKEN = process.env.VERCEL_TOKEN || process.argv[2];

if (!TOKEN) {
  console.error('\n❌ Error: Vercel Token is required!');
  console.log('\nUsage:');
  console.log('  node scripts/prune_vercel_deployments.js <YOUR_VERCEL_TOKEN>\n');
  console.log('Get a free token here in 20 seconds: https://vercel.com/account/tokens\n');
  process.exit(1);
}

function request(method, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.vercel.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'VercelPruner/1.0'
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
  console.log('  🧹 VERCEL AUTOMATED DEPLOYMENT PRUNER (FREE STORAGE)  ');
  console.log('========================================================\n');

  // 1. Get user profile and team ID
  console.log('Connecting to Vercel account...');
  const userRes = await request('GET', '/v2/user');
  if (userRes.status !== 200 || !userRes.body || !userRes.body.user) {
    console.error('❌ Failed to authenticate with Vercel API. Response:', userRes.body);
    process.exit(1);
  }

  const username = userRes.body.user.username;
  const teamId = userRes.body.user.defaultTeamId;
  console.log(`✅ Authenticated as: ${username} (Team: ${teamId || 'Personal'})\n`);

  // 2. Fetch deployments for the project
  const queryParam = teamId ? `&teamId=${teamId}` : '';
  console.log('Fetching existing deployments...');
  const dplRes = await request('GET', `/v6/deployments?limit=100${queryParam}`);
  
  if (!dplRes.body || !dplRes.body.deployments) {
    console.error('❌ Could not retrieve deployments:', dplRes.body);
    process.exit(1);
  }

  const deployments = dplRes.body.deployments;
  console.log(`Found ${deployments.length} total deployments in your account.\n`);

  if (deployments.length === 0) {
    console.log('No deployments found to delete.');
    return;
  }

  // Find latest production deployment (to KEEP it safe!)
  let activeProdId = null;
  for (const d of deployments) {
    if (d.target === 'production' && d.state === 'READY') {
      activeProdId = d.uid;
      console.log(`🔒 Keeping Active Production Deployment Safe: ${d.name} (${d.url}) - ID: ${d.uid}`);
      break;
    }
  }

  // Filter deployments to delete (all older ones)
  const toDelete = deployments.filter(d => d.uid !== activeProdId);

  if (toDelete.length === 0) {
    console.log('\n✨ Only the active production deployment exists. Nothing to delete!');
    return;
  }

  console.log(`\n🚀 Preparing to delete ${toDelete.length} old/inactive deployments to free up ~8 GB storage...\n`);

  let deletedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < toDelete.length; i++) {
    const d = toDelete[i];
    const createdDate = new Date(d.created).toLocaleDateString('en-IN');
    process.stdout.write(`[${i + 1}/${toDelete.length}] Deleting ${d.name} (${createdDate} - ${d.uid})... `);

    try {
      const delRes = await request('DELETE', `/v13/deployments/${d.uid}${teamId ? `?teamId=${teamId}` : ''}`);
      if (delRes.status === 200 || delRes.status === 204) {
        process.stdout.write('✅ DELETED\n');
        deletedCount++;
      } else {
        process.stdout.write(`⚠️ Skipped (${delRes.body?.error?.message || delRes.status})\n`);
        failedCount++;
      }
    } catch (err) {
      process.stdout.write(`❌ Error: ${err.message}\n`);
      failedCount++;
    }

    // Small delay to prevent API rate limits
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('\n========================================================');
  console.log(`🎉 PRUNING COMPLETED!`);
  console.log(`   Deleted: ${deletedCount} deployments`);
  if (failedCount > 0) console.log(`   Skipped/Failed: ${failedCount}`);
  console.log(`   Estimated Storage Recovered: ~${((deletedCount * 250) / 1024).toFixed(1)} GB!`);
  console.log('========================================================\n');
}

main().catch(console.error);
