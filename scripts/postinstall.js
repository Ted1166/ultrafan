// Auto-patches @noble packages that use npm-style semver ranges
// which Bare's strict semver parser can't handle.
// Runs automatically after every `npm install`.

const fs = require('fs')
const path = require('path')

const targets = [
  'node_modules/@noble/hashes/package.json',
  'node_modules/@noble/curves/package.json',
  'node_modules/ethers/node_modules/@noble/hashes/package.json',
  'node_modules/bip39/package.json'
]

let patched = 0
for (const rel of targets) {
  const full = path.join(__dirname, '..', rel)
  if (!fs.existsSync(full)) continue
  try {
    const pkg = JSON.parse(fs.readFileSync(full, 'utf8'))
    if (pkg.engines) {
      delete pkg.engines
      fs.writeFileSync(full, JSON.stringify(pkg, null, 2))
      console.log(`[postinstall] patched ${rel}`)
      patched++
    }
  } catch (e) {
    console.warn(`[postinstall] skipped ${rel}: ${e.message}`)
  }
}
console.log(`[postinstall] done — ${patched} file(s) patched`)
