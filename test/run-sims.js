// Runs every browser simulation in test/sim/ against the userscript.
// Each simulation loads the script into a fake YouTube page (jsdom) and exits non-zero on failure.
const { execFileSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');

const script = path.join(__dirname, '..', 'youtube-shadow-queue.user.js');
const dir = path.join(__dirname, 'sim');
let failed = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.sim.js')).sort()) {
  try {
    const out = execFileSync(process.execPath, [path.join(dir, file), script], { encoding: 'utf8' }).trim();
    console.log(`ok   ${file}  ${out.split('\n').pop()}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${file}\n${(e.stdout || '') + (e.stderr || '')}`);
  }
}
if (failed) { console.log(`\n${failed} simulation(s) failed`); process.exit(1); }
console.log('\nAll simulations passed');
