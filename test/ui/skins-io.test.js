// 皮肤选择 导出 / 导入：文件格式、拒绝别的 kind、只保留本机能穿的外观。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serializeSkinsExport, parseSkinsImport, SKINS_EXPORT_KIND, SKINS_EXPORT_VERSION } from '../../public/js/ui/skins.js';

describe('皮肤选择 导出 / 导入', () => {
  test('a selection round-trips through the file', () => {
    const entries = { char_1012_skadi2: 'char_1012_skadi2@boc#4', char_102_texas: 'char_102_texas@winter#1' };
    const doc = serializeSkinsExport(entries, { app: '0.3.1', now: new Date(2026, 9, 19) });
    assert.equal(doc.kind, SKINS_EXPORT_KIND);
    assert.equal(doc.version, SKINS_EXPORT_VERSION);
    assert.equal(doc.app, '0.3.1');
    assert.equal(doc.exportedAt, '2026-10-19');
    assert.deepEqual(doc.skins, entries);
    const back = parseSkinsImport(JSON.stringify(doc));
    assert.deepEqual(back, { ok: true, skins: entries, skipped: 0 });
  });

  test('a file of another kind, bad JSON or a newer version is refused with a message', () => {
    assert.equal(parseSkinsImport('{').ok, false);
    assert.equal(parseSkinsImport(JSON.stringify({ kind: 'stronghold.loadout', skins: {} })).ok, false);
    assert.match(parseSkinsImport(JSON.stringify({ kind: 'stronghold.loadout' })).error, /皮肤选择/);
    assert.equal(parseSkinsImport(JSON.stringify({ kind: SKINS_EXPORT_KIND, version: 99, skins: {} })).ok, false);
    assert.equal(parseSkinsImport(JSON.stringify({ kind: SKINS_EXPORT_KIND, version: 1 })).ok, false);
    assert.equal(parseSkinsImport(null).ok, false);
  });

  test('only appearances this installation offers are kept, and the rest are counted', () => {
    const doc = { kind: SKINS_EXPORT_KIND, version: 1, skins: { char_a: 'a@x#1', char_b: 'b@y#2', char_c: '' } };
    const res = parseSkinsImport(doc, { offered: (charId) => charId === 'char_a' });
    assert.equal(res.ok, true);
    assert.deepEqual(res.skins, { char_a: 'a@x#1' });
    assert.equal(res.skipped, 2, 'char_b is not offered here, char_c has no skin id');
  });

  test('the wire cap bounds what a file can bring in', () => {
    const skins = {};
    for (let i = 0; i < 5; i++) skins[`char_${i}`] = `skin_${i}`;
    const res = parseSkinsImport({ kind: SKINS_EXPORT_KIND, version: 1, skins }, { limit: 2 });
    assert.equal(Object.keys(res.skins).length, 2);
    assert.equal(res.skipped, 3);
  });
});
