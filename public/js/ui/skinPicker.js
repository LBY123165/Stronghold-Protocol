// 皮肤选择器 (docs/SKINS.md) — the 皮肤 section of the 干员调配 screen's detail panel (screens/loadout.js).
//
// One entry per skin of the operator's catalogue (data/skins.json), plus the 默认 entry that clears the choice. A skin
// whose art this server does not have (data/assets.json → chars[charId].skins) is shown greyed out and cannot be picked
// — that is how a build with only part of the art still lists the rest honestly.
//
// The choice is stored per BASE chess id (ui/skins.js), so it survives the elite form and is what the server keeps; the
// art is looked up per OPERATOR id, because both data files group it that way.

import { html, MicroLabel } from './components.js';
import { useStore, shallowEqual } from '../store.js';
import { data, useData } from '../data.js';
import { t } from '../../../shared/i18n.js';
import { skinsStore, availableSkins, skinAvatarUrl, setSkin, clearSkin } from './skins.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/**
 * 皮肤 section for one operator. Renders nothing for an operator whose catalogue has no skin at all (most of the low
 * rarities), and a loading note until data/skins.json arrives.
 * @param {{ chess: any }} props `chess` is the chess record of the detail panel (`chessId` / `charId`)
 */
export function SkinSection({ chess }) {
  const s = useStore((v) => v, shallowEqual, skinsStore);
  const ready = useData('skins', 'assets');

  const chessId = chess && (chess.baseId || chess.chessId);
  const charId = chess && chess.charId;
  if (!chessId || !charId) return null;

  if (!ready) {
    return html`<section class="lo-sec lo-sec--skin" data-testid="skin-section">
      <header class="lo-sec__head">
        <h3>${t('皮肤')}<${MicroLabel}>SKIN<//></h3>
        <span class="lo-sec__note">${t('正在载入皮肤清单…')}</span>
      </header>
    </section>`;
  }

  const list = availableSkins(charId);
  if (!list.length) return null;

  const chosen = s.entries[chessId] || null;
  // the operator's own art, worn by the 默认 entry and used as the fallback of a skin whose avatar file is missing
  const baseArt = data.get('assets')?.chars?.[charId]?.avatar || null;
  // The count that matters is the models, not the avatars: quoting "已安装 271" here promised a battlefield change that 99
  // of them cannot deliver (a skin without its own Spine model keeps the operator's). Show both, models first.
  const battleCount = list.filter((x) => x.battle).length;

  return html`<section class="lo-sec lo-sec--skin" data-testid="skin-section">
    <header class="lo-sec__head">
      <h3>${t('皮肤')}<${MicroLabel}>SKIN<//></h3>
      <span class="lo-sec__note">${t('{n} 款可选 · {k} 款含战斗模型', { n: list.length, k: battleCount })}</span>
    </header>
    <div class="lo-skins" role="radiogroup" aria-label=${t('选择皮肤')}>
      <button type="button" role="radio" aria-checked=${chosen ? 'false' : 'true'} data-skin=""
        class=${cx('lo-skin', 'lo-skin--default', !chosen && 'is-on')} onClick=${() => clearSkin(chessId)}>
        <span class="lo-skin__art">
          ${baseArt ? html`<img src=${baseArt} alt="" loading="lazy" />` : html`<span class="lo-skin__art lo-skin__art--none"></span>`}
        </span>
        <span class="lo-skin__text">
          <b class="lo-skin__name">${t('默认')}</b>
          <span class="lo-skin__group">DEFAULT</span>
        </span>
        ${!chosen ? html`<span class="lo-skin__badge">${t('已装备')}</span>` : null}
      </button>
      ${list.map((x) => {
        const art = skinAvatarUrl(charId, x.id) || baseArt;
        const equipped = chosen === x.id;
        const off = !x.installed;
        // An avatar-only skin is still worth picking (it changes the portrait and the detail card), so it stays enabled —
        // it just says so, instead of leaving the player wondering why the battlefield ignored it.
        const label = off ? t('本服务器未安装该皮肤')
          : x.battle ? (x.name || x.id)
            : `${x.name || x.id} · ${t('无战斗模型，战场沿用原干员模型')}`;
        return html`<button key=${x.id} type="button" role="radio" aria-checked=${equipped ? 'true' : 'false'}
            data-skin=${x.id} disabled=${off} title=${label}
            class=${cx('lo-skin', equipped && 'is-on', off && 'is-off', !off && !x.battle && 'lo-skin--no-model')}
            onClick=${() => { if (!off) setSkin(chessId, x.id); }}>
          <span class="lo-skin__art">
            ${art
              ? html`<img src=${art} alt="" loading="lazy" onError=${(e) => { if (baseArt && e.currentTarget.src !== baseArt) e.currentTarget.src = baseArt; }} />`
              : html`<span class="lo-skin__art lo-skin__art--none"></span>`}
          </span>
          <span class="lo-skin__text">
            <b class="lo-skin__name">${x.name || x.id}</b>
            <span class="lo-skin__group">${x.group || 'SPECIAL'}</span>
          </span>
          ${equipped ? html`<span class="lo-skin__badge">${t('已装备')}</span>` : null}
          ${!off && !x.battle ? html`<span class="lo-skin__mark">${t('仅头像')}</span>` : null}
        </button>`;
      })}
    </div>
  </section>`;
}
