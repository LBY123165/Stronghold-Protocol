// tools/skins-inject.mjs — 干员皮肤数据注入 (docs/SKINS.md).
//
// data/assets.json is GENERATED (docs/DATA.md). This tool is the generator step for the 干员皮肤 blocks: it copies
// `chars[charId].skins` (the skins whose art is actually installed, `{ name, group, avatar, spine? }`) out of a source
// manifest into this tree's data/assets.json, leaving every other field untouched. Run it after regenerating the data
// with `npm run build-data`, or after adding skin art.
//
// The source manifest is the fusion build's data/assets.json (the origin of this feature's data: its skin catalogue
// data/skins.json plus the spine models under public/assets/spine/op/<charId>/<skinDir>/); the catalogue itself is
// copied to data/skins.json by hand. Keeping the injection in a tool (rather than editing the JSON) is what the
// repository's generated-data rule asks for.
//
//   node tools/skins-inject.mjs --from=<path/to/source/assets.json> [--dry]
//
// Exit codes: 0 = injected (or nothing to do), 1 = the source or the target is unusable.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(fileURLToPath(import.meta.url), '..', '..'));

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = { from: null, dry: false };
  for (const a of argv) {
    if (a === '--dry') out.dry = true;
    else if (a.startsWith('--from=')) out.from = a.slice('--from='.length);
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  return out;
}

export /**
 * Inject the skin blocks of `sourceAssets` into `targetAssets` (in place). Returns a summary.
 * @param {any} targetAssets parsed data/assets.json
 * @param {any} sourceAssets parsed source assets.json
 * @returns {{ chars: number, skins: number, withSpine: number, skipped: string[] }}
 */
function injectSkins(targetAssets, sourceAssets) {
  const skipped = [];
  let chars = 0, skins = 0, withSpine = 0;
  for (const [charId, rec] of Object.entries(sourceAssets.chars || {})) {
    if (!rec || !rec.skins || !Object.keys(rec.skins).length) continue;
    const target = targetAssets.chars[charId];
    // an operator this build's data does not know is dropped, never invented
    if (!target) { skipped.push(charId); continue; }
    target.skins = rec.skins;
    chars++;
    for (const v of Object.values(rec.skins)) { skins++; if (v && v.spine) withSpine++; }
  }
  return { chars, skins, withSpine, skipped };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.from) { console.error('usage: node tools/skins-inject.mjs --from=<source assets.json> [--dry]'); process.exit(1); }
  const targetPath = join(ROOT, 'data', 'assets.json');
  let target, source;
  try { target = JSON.parse(readFileSync(targetPath, 'utf8')); } catch (e) { console.error(`✘ ${targetPath}: ${e.message}`); process.exit(1); }
  try { source = JSON.parse(readFileSync(resolve(args.from), 'utf8')); } catch (e) { console.error(`✘ ${args.from}: ${e.message}`); process.exit(1); }
  if (!target.chars) { console.error('✘ data/assets.json has no `chars` — regenerate it with `npm run build-data`'); process.exit(1); }

  const res = injectSkins(target, source);
  if (res.skipped.length) console.warn(`  ! ${res.skipped.length} operators of the source are not in this data: ${res.skipped.slice(0, 8).join(', ')}${res.skipped.length > 8 ? ' …' : ''}`);
  if (!res.skins) { console.log('skins-inject: nothing to inject'); return; }
  if (args.dry) { console.log(`skins-inject (dry): would write ${res.chars} operators, ${res.skins} skins (${res.withSpine} with a Spine model)`); return; }
  // data/assets.json is compact JSON (the generator writes it that way)
  writeFileSync(targetPath, JSON.stringify(target));
  console.log(`skins-inject: ${res.chars} operators, ${res.skins} skins (${res.withSpine} with a Spine model) → data/assets.json`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
