// tools/skins-plugin.mjs — build a cosmetic plugin that carries the installed 干员皮肤 (docs/SKINS.md).
//
// The skin catalogue lives in data/assets.json (`chars[charId].skins[skinId]`, written by tools/skins-inject.mjs).
// A cosmetic plugin (docs/PLUGINS.md §9) may only use files inside its own folder, a Spine model, or a `{ref}` to an
// installation entry — so the art has to be copied into plugins/<id>/media/. Art never enters git (AGENTS.md): the
// media folder is ignored, the generated plugin.json is not.
//
//   node tools/skins-plugin.mjs [--id stronghold-skins] [--mode avatars|models|full] [--limit-mb 180] [--dry]
//
//   avatars  copy each skin's own avatar only (≈16 MB); the picker marks them art-only, the operator keeps its model
//   models   copy the spine models too (≈357 MB) — larger than one plugin may be, so it is split into <id>-1, -2 …
//   full     avatars + models
//
// Exit codes: 0 = written (or nothing to do), 1 = nothing to build or the source data is unusable.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'public');

function parseArgs(argv) {
  const out = { id: 'stronghold-skins', mode: 'avatars', limitMb: 180, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') out.dry = true;
    else if (a === '--id') out.id = argv[++i];
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '--limit-mb') out.limitMb = Number(argv[++i]);
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  if (!['avatars', 'models', 'full'].includes(out.mode)) { console.error('--mode must be avatars|models|full'); process.exit(2); }
  return out;
}

const withAvatars = (mode) => mode === 'avatars' || mode === 'full';
const withModels = (mode) => mode === 'models' || mode === 'full';

/** A manifest URL (/assets/…) → the file under public/. */
const fileOf = (url) => (typeof url === 'string' && url.startsWith('/assets/') ? path.join(ASSETS, url.slice(1)) : null);

/**
 * A file name the plugin checker accepts: skin ids carry `@` and `#` (char_002_amiya@winter#1), which a plugin path
 * must not. The skin id stays the record key; only the copied file's name is escaped.
 */
const slug = (name) => String(name).replace(/@/g, '_at_').replace(/#/g, '_n_');

/**
 * A plugin-relative copy of one manifest file. `rel` is the destination under the plugin folder.
 * @returns {{ ok: boolean, rel: string }}
 */
function planCopy(url, relBase, copies) {
  const src = fileOf(url);
  if (!src || !fs.existsSync(src)) return { ok: false, rel: null };
  const rel = path.posix.join('media', relBase);
  copies.push({ src, rel });
  return { ok: true, rel };
}

function spinePaths(spine, relBase, copies) {
  const one = (side) => {
    const skel = planCopy(side.skel, `${relBase}/${slug(path.basename(side.skel))}`, copies);
    const atlas = planCopy(side.atlas, `${relBase}/${slug(path.basename(side.atlas))}`, copies);
    const textures = [];
    for (const t of side.textures || []) {
      const c = planCopy(t, `${relBase}/${slug(path.basename(t))}`, copies);
      if (c.ok) textures.push(c.rel);
    }
    if (!skel.ok || !atlas.ok || !textures.length) return null;
    return { skel: skel.rel, atlas: atlas.rel, textures, ...(side.pma === true ? { pma: true } : {}) };
  };
  if (spine && (spine.skel || spine.textures)) return one(spine);
  const out = {};
  if (spine?.front) { const f = one(spine.front); if (f) out.front = f; }
  if (spine?.back) { const b = one(spine.back); if (b) out.back = b; }
  return Object.keys(out).length ? out : null;
}

/** Build one plugin's worth of records, stopping before `limitBytes`. */
function build(assets, { mode, limitBytes }) {
  const chunks = [];
  let current = { assets: {}, copies: [], bytes: 0 };
  const flush = () => { if (Object.keys(current.assets).length) chunks.push(current); current = { assets: {}, copies: [], bytes: 0 }; };

  for (const [charId, rec] of Object.entries(assets.chars || {})) {
    const skins = rec.skins;
    if (!skins || !Object.keys(skins).length) continue;
    for (const [skinId, skin] of Object.entries(skins)) {
      const copies = [];
      const entry = { name: skin.name, group: skin.group };
      let bytes = 0;
      if (withAvatars(mode) && skin.avatar) {
        const base = `${charId}/${slug(skinId)}`;
        const c = planCopy(skin.avatar, `${base}/${slug(path.basename(skin.avatar))}`, copies);
        if (c.ok) { entry.avatar = c.rel; bytes += fs.statSync(fileOf(skin.avatar)).size; }
      }
      if (withModels(mode) && skin.spine) {
        const base = `${charId}/${slug(skinId)}`;
        const spine = spinePaths(skin.spine, base, copies);
        if (spine) {
          entry.spine = spine;
          for (const c of copies) bytes += fs.statSync(c.src).size;
        }
      }
      if (!entry.avatar && !entry.spine) continue; // nothing of this skin is installed
      if (current.bytes + bytes > limitBytes && current.bytes > 0) flush();
      if (!current.assets[charId]) current.assets[charId] = { skins: {} };
      current.assets[charId].skins[skinId] = entry;
      current.copies.push(...copies);
      current.bytes += bytes;
    }
  }
  flush();
  return chunks;
}

function manifestFor(id, index, total, chunk) {
  const suffix = total > 1 ? ` ${index + 1}/${total}` : '';
  return {
    manifest: 2,
    id: total > 1 ? `${id}-${index + 1}` : id,
    name: { zh: `干员皮肤${suffix}`, en: `Operator skins${suffix}` },
    description: {
      zh: '本机安装的《明日方舟》干员皮肤外观（头像与战场模型）。素材版权归原权利人，仅供本项目内使用。',
      en: 'Operator skins installed on this machine (avatars and battle models). Art is © its rights holders.',
    },
    version: '1.0.0',
    app: '>=0.3.0 <0.4.0',
    api: 1,
    class: 'cosmetic',
    scope: ['room', 'personal'],
    license: 'LicenseRef-Arknights-Assets',
    permissions: ['assets.override'],
    assets: chunk.assets,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(ROOT, 'data', 'assets.json');
  let assets;
  try { assets = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { console.error(`✘ ${manifestPath}: ${e.message}`); process.exit(1); }

  const chunks = build(assets, { mode: args.mode, limitBytes: args.limitMb * 1024 * 1024 });
  if (!chunks.length) {
    console.error('✘ no installed skin art found: run tools/skins-inject.mjs first (data/assets.json has no chars[].skins)');
    process.exit(1);
  }
  let written = 0, bytes = 0;
  chunks.forEach((chunk, i) => {
    const manifest = manifestFor(args.id, i, chunks.length, chunk);
    const dir = path.join(ROOT, 'plugins', manifest.id);
    console.log(`${manifest.id}: ${Object.keys(chunk.assets).length} 干员, ${chunk.copies.length} 个文件, ${(chunk.bytes / 1048576).toFixed(1)} MB`);
    if (args.dry) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    for (const c of chunk.copies) {
      const dest = path.join(dir, c.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(c.src, dest);
    }
    written++; bytes += chunk.bytes;
  });
  if (args.dry) { console.log('(dry run: nothing written)'); return; }
  console.log(`✔ ${written} plugin(s), ${(bytes / 1048576).toFixed(1)} MB — 校验: node tools/plugin.mjs check plugins/<id>`);
}

main();
