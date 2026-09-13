const MODULE_ID = "mausritter_wdip";
const WDIP_ACTOR_TYPES = ["character", "creature", "hireling"];

Hooks.once("init", () => {
  applyTranslationOverrides();
});

Hooks.once("ready", async () => {
  await cleanupBrokenSheetAssignments();
  patchFirearmAutomation();
});

Hooks.on("renderActorSheet", (app, html) => {
  const actor = app?.actor ?? app?.object;
  if (!actor || !WDIP_ACTOR_TYPES.includes(actor.type)) return;

  const $html = html instanceof jQuery ? html : $(html);
  applyActorPosterLook($html, actor);
  applyActorLabels($html, actor);
  applyCharacterHeaderTweaks($html, actor);
  applyActorExtras($html, actor);
  applyFirearmLabelsOnActorSheet($html, actor);
  activateSheetDescriptions($html, actor);
  fixInventoryCardStacking($html);
  fixResizeHandle(app);
  ensureNpcTabStructure($html, actor);
  fixNotesTabScroll($html);
});

Hooks.on("renderItemSheet", (app, html) => {
  const item = app?.item ?? app?.object;
  if (!item) return;

  const $html = html instanceof jQuery ? html : $(html);
  applyGenericItemSheetLook($html);
  if (item.type === "weapon") applyWeaponSheetEnhancements(app, $html, item);
});

Hooks.on("renderDialog", (app, html) => {
  const $html = html instanceof jQuery ? html : $(html);
  localizeDialog(app, $html);
});

Hooks.on("closeActorSheet", () => {
  if (!WDIP_HELP_STATE.source?.isConnected) hideSheetDescription(true);
});

function applyTranslationOverrides() {
  const overrides = {
    "Maus.ActorDex": "AGI",
    "Maus.Pips": "PLOMO",
    "Maus.ActorBackground": "Trasfondo",
    "Maus.ActorCoat": "Ropa"
  };

  const targets = [game?.i18n?.translations, game?.i18n?._fallback];
  for (const t of targets) {
    if (!t) continue;
    for (const [key, value] of Object.entries(overrides)) t[key] = value;
  }
}

async function cleanupBrokenSheetAssignments() {
  const brokenPattern = /mausritter_wdip|wdip/i;
  let changed = 0;

  const actorUpdates = [];
  for (const actor of game.actors.contents) {
    const sheetClass = actor.getFlag("core", "sheetClass");
    if (sheetClass && brokenPattern.test(String(sheetClass))) {
      actorUpdates.push({ _id: actor.id, "flags.core.-=sheetClass": null });
      changed++;
    }
  }
  if (actorUpdates.length) await Actor.updateDocuments(actorUpdates);

  const worldItemUpdates = [];
  for (const item of game.items?.contents ?? []) {
    const sheetClass = item.getFlag("core", "sheetClass");
    if (sheetClass && brokenPattern.test(String(sheetClass))) {
      worldItemUpdates.push({ _id: item.id, "flags.core.-=sheetClass": null });
      changed++;
    }
  }
  if (worldItemUpdates.length) await Item.updateDocuments(worldItemUpdates);

  for (const actor of game.actors.contents) {
    const embeddedUpdates = [];
    for (const item of actor.items.contents) {
      const sheetClass = item.getFlag("core", "sheetClass");
      if (sheetClass && brokenPattern.test(String(sheetClass))) {
        embeddedUpdates.push({ _id: item.id, "flags.core.-=sheetClass": null });
        changed++;
      }
    }
    if (embeddedUpdates.length) await actor.updateEmbeddedDocuments("Item", embeddedUpdates);
  }

  if (changed > 0) {
    ui.notifications.info(`We Deal in Pips: se han reparado ${changed} asignaciones de hoja antiguas.`);
  }
}

function patchFirearmAutomation() {
  const classes = new Set([
    CONFIG?.Actor?.documentClass,
    game?.mausritter?.MausritterActor
  ].filter(Boolean));

  for (const cls of classes) {
    const proto = cls?.prototype;
    if (!proto || proto.__wdipFirearmPatched) continue;

    if (typeof proto.rollItem === "function") {
      const originalRollItem = proto.rollItem;
      proto.rollItem = function(itemId, options = { event: null }) {
        const itemDoc = typeof itemId === "string" ? this.items?.get(itemId) : itemId;
        if (isFirearmItem(this, itemDoc) && getActorLead(this) <= 0) {
          warnNoLead();
          return;
        }
        return originalRollItem.call(this, itemId, options);
      };
    }

    if (typeof proto.rollWeapon === "function") {
      const originalRollWeapon = proto.rollWeapon;
      proto.rollWeapon = async function(item = "", state = "") {
        const itemDoc = resolveOwnedWeapon(this, item);
        if (isFirearmItem(this, itemDoc || item) && getActorLead(this) <= 0) {
          warnNoLead();
          return;
        }

        const previousLead = getActorLead(this);
        const result = await originalRollWeapon.call(this, item, state);

        if (isFirearmItem(this, itemDoc || item)) {
          const nextLead = Math.max(previousLead - 1, 0);
          if (nextLead !== previousLead) {
            await this.update({ "system.pips.value": nextLead });
          }
          if (nextLead <= 0) {
            ui.notifications.warn("Te has quedado sin plomo.");
          }
        }

        return result;
      };
    }

    proto.__wdipFirearmPatched = true;
  }
}

function getActorLead(actor) {
  return Number(actor?.system?.pips?.value ?? 0);
}

function warnNoLead() {
  ui.notifications.warn("No te queda plomo. Recarga antes de disparar.");
}

function resolveOwnedWeapon(actor, itemLike) {
  if (!actor || !itemLike) return null;
  const id = itemLike.id ?? itemLike._id ?? null;
  if (id && actor.items?.get) {
    const owned = actor.items.get(id);
    if (owned) return owned;
  }
  if (itemLike.uuid && actor.items?.contents) {
    const owned = actor.items.contents.find(i => i.uuid === itemLike.uuid);
    if (owned) return owned;
  }
  if (itemLike.name && actor.items?.contents) {
    return actor.items.contents.find(i => i.type === "weapon" && i.name === itemLike.name) ?? null;
  }
  return null;
}

function isFirearmItem(actor, itemLike) {
  const itemDoc = resolveOwnedWeapon(actor, itemLike) ?? itemLike;
  return Boolean(
    foundry.utils.getProperty(itemDoc, `flags.${MODULE_ID}.firearm`) ||
    itemDoc?.getFlag?.(MODULE_ID, "firearm")
  );
}

/* ── Fix 1: icono de redimensionado siempre en primer plano ── */
/* Solo z-index: el handle tiene position:absolute, cambiarlo rompería su posición */
function fixResizeHandle(app) {
  const windowEl = app.element instanceof jQuery ? app.element[0] : (app.element ?? null);
  if (!windowEl) return;
  const handle = windowEl.querySelector?.('.window-resizable-handle');
  if (handle) handle.style.zIndex = '99999';
}

/* ── Fix 2 & 3b: scroll en el contenido del editor de notas ── */
/* Se apunta a .editor-content (el div de texto) dentro del tab de notas,
   no al tab completo, para que la barra de scroll sea interna al texto. */
function fixNotesTabScroll($html) {
  const editorContent = $html.find('[data-tab="notes"] .editor-content');
  if (!editorContent.length) return;
  editorContent.css({
    'overflow-y': 'auto',
    'max-height': 'calc(100vh - 520px)',
    'min-height': '80px'
  });
}

/* ── Fix 3a: fichas de PNJ con dos pestañas (inventario + notas) ── */
function ensureNpcTabStructure($html, actor) {
  if (actor.type === 'character') return;

  const sheetBody = $html.find('.sheet-body');
  if (!sheetBody.length || sheetBody.data('wdipNpcTabbed')) return;

  // Si el sistema ya proporciona pestañas con data-tab, nada que hacer
  if (sheetBody.find('[data-tab="drag"], [data-tab="notes"]').length) {
    sheetBody.data('wdipNpcTabbed', true);
    return;
  }

  // Buscar el contenedor de inventario
  const itemContainer = sheetBody.find('.item-container').first();
  if (!itemContainer.length) {
    sheetBody.data('wdipNpcTabbed', true);
    return;
  }

  // Elemento hijo directo de sheetBody que contiene el inventario
  const parentsToBody = itemContainer.parentsUntil(sheetBody);
  const inventoryEl = parentsToBody.length ? parentsToBody.last() : itemContainer;

  // Buscar el área de descripción/notas del PNJ
  const descEl = sheetBody.find('.creaturedescription, [data-edit="system.biography"], [name="system.biography"]').first();
  const parentsDescToBody = descEl.length ? descEl.parentsUntil(sheetBody) : $();
  const notesEl = parentsDescToBody.length ? parentsDescToBody.last() : descEl;

  // Inyectar nav de pestañas
  const tabNav = $(`
    <nav class="mausritter sheet-tabs tabs wdip-tabs" data-group="npc-wdip">
      <a class="tab-select" data-tab="npc-drag">INVENTARIO</a>
      <a class="tab-select" data-tab="npc-notes">NOTAS</a>
    </nav>
  `);
  sheetBody.prepend(tabNav);

  // Marcar las secciones para show/hide
  inventoryEl.addClass('wdip-npc-drag-tab');
  if (notesEl.length) {
    notesEl.addClass('wdip-npc-notes-tab').css('display', 'none');
  }

  // Click handlers
  tabNav.find('[data-tab="npc-drag"]').addClass('active').on('click.wdipNpc', () => {
    tabNav.find('[data-tab]').removeClass('active');
    tabNav.find('[data-tab="npc-drag"]').addClass('active');
    sheetBody.find('.wdip-npc-drag-tab').show();
    sheetBody.find('.wdip-npc-notes-tab').hide();
  });

  tabNav.find('[data-tab="npc-notes"]').on('click.wdipNpc', () => {
    tabNav.find('[data-tab]').removeClass('active');
    tabNav.find('[data-tab="npc-notes"]').addClass('active');
    sheetBody.find('.wdip-npc-drag-tab').hide();
    sheetBody.find('.wdip-npc-notes-tab').show();
  });

  sheetBody.data('wdipNpcTabbed', true);
}

function applyActorPosterLook($html, actor) {
  $html.addClass("wdip-sheet");
  $html.attr("data-wdip-type", actor.type);

  if (!$html.find(".wdip-banner").length) {
    const banner = $(`
      <div class="wdip-banner">
        <div class="wdip-banner-title">SE BUSCA</div>
        <div class="wdip-banner-subtitle">VIVO O MUERTO</div>
      </div>
    `);
    $html.find("header.char-header").before(banner);
  }
}

function applyActorLabels($html, actor) {
  relabel($html, 'label[for="system.stat.dexterity.value"], label[data-key="dexterity"]', 'AGI');
  relabel($html, 'label[for="system.pips.value"]', 'PLOMO');
  relabel($html, '.mausritter.sheet-tabs [data-tab="drag"]', 'INVENTARIO');
  relabel($html, '.mausritter.sheet-tabs [data-tab="notes"]', 'NOTAS');

  if (actor.type === 'creature' || actor.type === 'hireling') {
    relabel($html, '.item-slot-header:contains("Ataque 1")', 'ARMADO');
    relabel($html, '.item-slot-header:contains("Ataque 2")', 'ARMADO');
  }
}

function applyCharacterHeaderTweaks($html, actor) {
  if (actor.type !== "character") return;

  relabel($html, '.headernamegrid .headerinputtext:contains("Transfondo")', 'Trasfondo');
  relabel($html, '.headernamegrid .headerinputtext:contains("Trasfondo")', 'Trasfondo');
  relabel($html, '.headernamegrid .headerinputtext:contains("Pelaje")', 'Ropa');
  relabel($html, '.headernamegrid .headerinputtext:contains("Abrigo")', 'Ropa');
  relabel($html, '.headernamegrid .headerinputtext:contains("Coat")', 'Ropa');

  const headerBoxes = $html.find('header.char-header .header > .header-border');
  const detailsBox = headerBoxes.eq(1);
  if (!detailsBox.length || detailsBox.data('wdipSignRemoved')) return;

  const rows = detailsBox.children('.headernamegrid');
  const signRow = rows.first();
  if (signRow.length) {
    const nextSeparator = signRow.next('.seperatorLine');
    signRow.remove();
    if (nextSeparator.length) nextSeparator.remove();
  }

  detailsBox.data('wdipSignRemoved', true);
}

function fixInventoryCardStacking($html) {
  const container = $html.find('.item-container').first();
  if (!container.length || container.data('wdipStackingFixed')) return;

  container.css({ overflow: 'visible', isolation: 'isolate' });
  $html.find('.sheet-body, .sheet-body .tab, .sheet-body .tab.items').css('overflow', 'visible');
  $html.find('.item-slot-dashed, .item-bag-container').css('z-index', 1);

  let maxZ = 10000;
  $html.find('.item-card.dragItems').each((_, el) => {
    const current = Number.parseInt(el.style.zIndex || '0', 10);
    const next = (Number.isFinite(current) ? current : 0) + 10000;
    el.style.zIndex = String(next);
    maxZ = Math.max(maxZ, next);
  });

  $html.find('.item-card.dragItems').off('mousedown.wdip').on('mousedown.wdip', function () {
    maxZ += 1;
    this.style.zIndex = String(maxZ);
  });

  container.data('wdipStackingFixed', true);
}

function applyActorExtras($html, actor) {
  const edad = foundry.utils.getProperty(actor, `flags.${MODULE_ID}.edad`) ?? "";
  const ataques = foundry.utils.getProperty(actor, `flags.${MODULE_ID}.ataquesEspeciales`) ?? "";

  if (actor.type === "character") {
    ensureCharacterMetaFields($html, edad, ataques);
  } else {
    ensureNpcMetaFields($html, edad, ataques);
  }
}

function ensureCharacterMetaFields($html, edad, ataques) {
  const topGrid = $html.find('.centercol > .grid').first();
  if (topGrid.length && !topGrid.hasClass('wdip-meta-grid')) {
    topGrid.replaceWith(`
      <div class="grid wdip-meta-grid">
        <div class="verticalFlex blockborder">
          <div class="statblock wdip-meta-field">
            <label class="statName littleLabel">EDAD</label>
            <input class="minmax-input darkGreyText" type="text" name="flags.${MODULE_ID}.edad" value="${escapeAttr(edad)}" data-dtype="String" />
          </div>
        </div>
        <div class="verticalFlex blockborder">
          <div class="statblock wdip-meta-field wdip-textarea-wrap">
            <label class="statName littleLabel">ATAQUES ESPECIALES</label>
            <input class="minmax-input darkGreyText" type="text" name="flags.${MODULE_ID}.ataquesEspeciales" value="${escapeAttr(ataques)}" data-dtype="String" />
          </div>
        </div>
      </div>
    `);
  }
}


function ensureNpcMetaFields($html, edad, ataques) {
  const headerBorder = $html.find('.creature-header-border').first();
  if (!headerBorder.length || headerBorder.find('.wdip-inline-meta').length) return;

  headerBorder.append(`
    <div class="seperatorLine"></div>
    <div class="wdip-inline-meta">
      <div class="headernamegrid">
        <div class="headerinputtext">Edad</div>
        <div class="headerinputfield charname" style="flex:3;"><input name="flags.${MODULE_ID}.edad" class="noborder" type="text" value="${escapeAttr(edad)}" data-dtype="String" /></div>
      </div>
      <div class="seperatorLine"></div>
      <div class="headernamegrid">
        <div class="headerinputtext">Ataques especiales</div>
        <div class="headerinputfield charname" style="flex:3;"><input name="flags.${MODULE_ID}.ataquesEspeciales" class="noborder" type="text" value="${escapeAttr(ataques)}" data-dtype="String" /></div>
      </div>
    </div>
  `);
}



function applyGenericItemSheetLook($html) {
  $html.addClass('wdip-item-sheet');
}

function applyWeaponSheetEnhancements(app, $html, item) {
  $html.addClass('wdip-item-sheet');

  const firearm = Boolean(foundry.utils.getProperty(item, `flags.${MODULE_ID}.firearm`));
  const usageResource = $html.find('input[name="system.pips.value"]').closest('.resource');
  if (usageResource.length && !$html.find('.wdip-firearm-resource').length) {
    const firearmField = $(`
      <div class="resource wdip-firearm-resource">
        <label class="resource-label">Arma de fuego</label>
        <div class="wdip-checkbox-row">
          <input type="checkbox" name="flags.${MODULE_ID}.firearm" ${firearm ? 'checked' : ''} />
          <span>Consume 1 punto de Plomo al disparar</span>
        </div>
      </div>
    `);
    usageResource.after(firearmField);

    firearmField.find('input[type="checkbox"]').on('change', async (event) => {
      await app.item.setFlag(MODULE_ID, 'firearm', event.currentTarget.checked);
      app.render(false);
    });
  }
}

function updateWeaponUsageLabels($html, firearm) {
  return;
}

function applyFirearmLabelsOnActorSheet($html, actor) {
  for (const item of actor.items.contents) {
    if (item.type !== 'weapon') continue;
    const firearm = Boolean(foundry.utils.getProperty(item, `flags.${MODULE_ID}.firearm`));
    if (!firearm) continue;

    const card = $html.find(`.item-card[data-item-id="${item.id}"]`);
    if (!card.length) continue;

    card.addClass('wdip-firearm-card');
    const tag = card.find('.item-card-tag').first();
    if (tag.length) tag.text('Arma de fuego');
    if (!card.find('.wdip-plomo-badge').length) {
      card.append('<div class="wdip-plomo-badge">Usa plomo</div>');
    }
  }
}

/* ── Descripciones emergentes de ficha y objetos ────────────────────────── */
const WDIP_HELP_DELAY = 2000;
const WDIP_HELP_STATE = {
  timer: null,
  source: null,
  pinned: false,
  request: 0
};

function activateSheetDescriptions($html, actor) {
  const root = $html?.[0];
  if (!root) return;

  if (WDIP_HELP_STATE.source && !WDIP_HELP_STATE.source.isConnected) {
    hideSheetDescription(true);
  }

  markSheetHelpTargets($html);
  ensureHelpPopover();

  $html.off('.wdipHelp');
  $html.on('mouseenter.wdipHelp', '.item-card[data-item-id], [data-wdip-help]', event => {
    if (WDIP_HELP_STATE.pinned) return;
    scheduleSheetDescription(event.currentTarget, actor);
  });
  $html.on('mouseleave.wdipHelp', '.item-card[data-item-id], [data-wdip-help]', event => {
    if (WDIP_HELP_STATE.source !== event.currentTarget || WDIP_HELP_STATE.pinned) return;
    clearHelpTimer();
    hideSheetDescription();
  });
  $html.on('contextmenu.wdipHelp', '.item-card[data-item-id], [data-wdip-help]', event => {
    event.preventDefault();
    event.stopPropagation();
    clearHelpTimer();
    showSheetDescription(event.currentTarget, actor, true);
  });
}

function markSheetHelpTargets($html) {
  const targets = [
    ['[data-key="strength"], input[name="system.stats.strength.value"], input[name="system.stats.strength.max"]', 'strength'],
    ['[data-key="dexterity"], input[name="system.stats.dexterity.value"], input[name="system.stats.dexterity.max"]', 'dexterity'],
    ['[data-key="will"], input[name="system.stats.will.value"], input[name="system.stats.will.max"]', 'heart'],
    ['input[name="system.health.value"], input[name="system.health.max"]', 'lead'],
    ['input[name="system.grit.value"], input[name="system.grit.max"]', 'grit'],
    ['input[name="system.pips.value"], input[name="system.pips.max"]', 'pips'],
    ['.sheet-tabs [data-tab="drag"]', 'inventory'],
    ['.sheet-tabs [data-tab="notes"]', 'notes']
  ];

  for (const [selector, key] of targets) {
    $html.find(selector).attr('data-wdip-help', key);
  }
}

function scheduleSheetDescription(source, actor) {
  clearHelpTimer();
  WDIP_HELP_STATE.source = source;
  WDIP_HELP_STATE.timer = window.setTimeout(() => {
    if (source?.isConnected) showSheetDescription(source, actor, false);
  }, WDIP_HELP_DELAY);
}

async function showSheetDescription(source, actor, pinned) {
  const request = ++WDIP_HELP_STATE.request;
  WDIP_HELP_STATE.source = source;
  WDIP_HELP_STATE.pinned = pinned;

  const data = await getSheetDescription(source, actor);
  if (request !== WDIP_HELP_STATE.request || !source?.isConnected) return;

  const popover = ensureHelpPopover();
  const image = data.image
    ? `<img class="wdip-help-image" src="${escapeAttr(data.image)}" alt="" />`
    : '';
  const pin = pinned ? '<i class="fas fa-thumbtack" aria-hidden="true"></i>' : '';
  const hint = pinned
    ? localizeHelp('WDIP.HelpPinnedHint', 'Fijado · Esc o clic fuera para cerrar')
    : localizeHelp('WDIP.HelpHoverHint', 'Clic derecho para fijar');

  popover.innerHTML = `
    <div class="wdip-help-heading">
      ${image}
      <div class="wdip-help-title">${escapeHtml(data.title)}</div>
      <div class="wdip-help-pin">${pin}</div>
    </div>
    <div class="wdip-help-description">${sanitizeHelpHtml(data.description)}</div>
    <div class="wdip-help-hint">${escapeHtml(hint)}</div>
  `;
  popover.classList.toggle('is-pinned', pinned);
  popover.hidden = false;
  popover.setAttribute('aria-hidden', 'false');
  positionHelpPopover(popover, source);
}

async function getSheetDescription(source, actor) {
  const itemId = source.closest?.('.item-card[data-item-id]')?.dataset?.itemId;
  if (itemId) {
    const item = actor.items?.get(itemId);
    if (item) {
      const rawDescription = firstDescriptionValue(item) || localizeHelp('WDIP.HelpNoDescription', 'Este objeto todavía no tiene descripción.');
      let description = rawDescription;
      try {
        description = await TextEditor.enrichHTML(rawDescription, {
          async: true,
          secrets: Boolean(item.isOwner),
          relativeTo: item
        });
      } catch (error) {
        console.warn(`${MODULE_ID} | No se pudo enriquecer la descripción de ${item.name}`, error);
      }

      return { title: item.name, description, image: item.img };
    }
  }

  const key = source.closest?.('[data-wdip-help]')?.dataset?.wdipHelp;
  return getStaticSheetHelp(key);
}

function firstDescriptionValue(item) {
  const candidates = [
    foundry.utils.getProperty(item, 'system.description.value'),
    foundry.utils.getProperty(item, 'system.description'),
    foundry.utils.getProperty(item, 'system.desc.value'),
    foundry.utils.getProperty(item, 'system.desc'),
    foundry.utils.getProperty(item, 'system.details.description'),
    foundry.utils.getProperty(item, 'system.clear')
  ];

  for (const value of candidates) {
    if (typeof value === 'string' && stripHtml(value).trim()) return value;
  }
  return '';
}

function getStaticSheetHelp(key) {
  const entries = {
    strength: ['WDIP.HelpStrengthTitle', 'FUE · Fuerza', 'WDIP.HelpStrength', 'Potencia física del ratón. Se usa para resistir, cargar, forcejear y superar peligros con el cuerpo.'],
    dexterity: ['WDIP.HelpDexterityTitle', 'AGI · Agilidad', 'WDIP.HelpDexterity', 'Rapidez, coordinación y precisión. Se usa para esquivar, moverse con sigilo y reaccionar a tiempo.'],
    heart: ['WDIP.HelpHeartTitle', 'HRT · Corazón', 'WDIP.HelpHeart', 'Temple, voluntad y coraje. Se usa para mantener la calma y resistir el miedo o la presión.'],
    lead: ['WDIP.HelpLeadTitle', 'LEAD', 'WDIP.HelpLead', 'Resistencia inmediata del personaje. El daño reduce primero este valor antes de poner en peligro sus atributos.'],
    grit: ['WDIP.HelpGritTitle', 'Agallas', 'WDIP.HelpGrit', 'La dureza necesaria para seguir adelante cuando la frontera enseña los dientes.'],
    pips: ['WDIP.HelpPipsTitle', 'PLOMO', 'WDIP.HelpPips', 'Reserva compartida de munición. Cada disparo de un arma de fuego marcada consume 1 punto.'],
    inventory: ['WDIP.HelpInventoryTitle', 'Inventario', 'WDIP.HelpInventory', 'Objetos que el ratón lleva armados, vestidos o guardados. Mantén el puntero sobre una tarjeta durante dos segundos para leerla.'],
    notes: ['WDIP.HelpNotesTitle', 'Notas', 'WDIP.HelpNotes', 'Espacio libre para registrar pistas, deudas, heridas, promesas y otros problemas de frontera.']
  };
  const entry = entries[key] ?? ['WDIP.HelpTitle', 'Información', 'WDIP.HelpNoDescription', 'No hay una descripción disponible.'];
  return {
    title: localizeHelp(entry[0], entry[1]),
    description: `<p>${escapeHtml(localizeHelp(entry[2], entry[3]))}</p>`,
    image: ''
  };
}

function ensureHelpPopover() {
  let popover = document.getElementById('wdip-sheet-help');
  if (popover) return popover;

  popover = document.createElement('aside');
  popover.id = 'wdip-sheet-help';
  popover.className = 'wdip-sheet-help';
  popover.hidden = true;
  popover.setAttribute('role', 'tooltip');
  popover.setAttribute('aria-hidden', 'true');
  document.body.appendChild(popover);

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') hideSheetDescription(true);
  });
  document.addEventListener('pointerdown', event => {
    if (!WDIP_HELP_STATE.pinned || popover.contains(event.target)) return;
    if (WDIP_HELP_STATE.source?.contains?.(event.target)) return;
    hideSheetDescription(true);
  }, true);
  window.addEventListener('resize', () => hideSheetDescription(true));
  document.addEventListener('scroll', () => {
    if (!WDIP_HELP_STATE.pinned) hideSheetDescription();
  }, true);

  return popover;
}

function positionHelpPopover(popover, source) {
  const rect = source.getBoundingClientRect();
  const gap = 12;
  const margin = 10;
  const width = Math.min(390, window.innerWidth - margin * 2);
  popover.style.width = `${width}px`;

  const height = popover.offsetHeight;
  let left = rect.right + gap;
  if (left + width > window.innerWidth - margin) left = rect.left - width - gap;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

  let top = rect.top + Math.min(18, rect.height / 3);
  if (top + height > window.innerHeight - margin) top = window.innerHeight - height - margin;
  top = Math.max(margin, top);

  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
}

function hideSheetDescription(force = false) {
  if (WDIP_HELP_STATE.pinned && !force) return;
  clearHelpTimer();
  WDIP_HELP_STATE.request += 1;
  WDIP_HELP_STATE.source = null;
  WDIP_HELP_STATE.pinned = false;
  const popover = document.getElementById('wdip-sheet-help');
  if (!popover) return;
  popover.hidden = true;
  popover.classList.remove('is-pinned');
  popover.setAttribute('aria-hidden', 'true');
}

function clearHelpTimer() {
  if (WDIP_HELP_STATE.timer) window.clearTimeout(WDIP_HELP_STATE.timer);
  WDIP_HELP_STATE.timer = null;
}

function sanitizeHelpHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html ?? '');
  template.content.querySelectorAll('script, style, iframe, object, embed').forEach(node => node.remove());
  template.content.querySelectorAll('*').forEach(node => {
    for (const attribute of [...node.attributes]) {
      if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
    }
  });
  return template.innerHTML || `<p>${escapeHtml(localizeHelp('WDIP.HelpNoDescription', 'Sin descripción.'))}</p>`;
}

function stripHtml(value) {
  const element = document.createElement('div');
  element.innerHTML = String(value ?? '');
  return element.textContent ?? '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function localizeHelp(key, fallback) {
  const localized = game?.i18n?.localize?.(key);
  return localized && localized !== key ? localized : fallback;
}

function localizeDialog(app, $html) {
  const selectType = $html.find('#type');
  if (selectType.length) {
    app.title = 'Seleccionar tipo';
    if (app.element) app.element.find('.window-title').text('Seleccionar tipo');
    $html.find('h2').first().text('Tipo de objeto');
    selectType.find('option[value="item"]').text('Objeto');
    selectType.find('option[value="weapon"]').text('Arma');
    selectType.find('option[value="spell"]').text('Hechizo');
    selectType.find('option[value="armor"]').text('Armadura');
    selectType.find('option[value="condition"]').text('Condición');
    selectType.find('option[value="storage"]').text('Almacenamiento');
    setDialogButtonText(app, 'roll', 'Crear');
    setDialogButtonText(app, 'cancel', 'Cancelar');
  }
}

function setDialogButtonText(app, key, label) {
  const button = app?.data?.buttons?.[key];
  if (button) button.label = label;
  const selector = `.dialog-buttons button[data-button="${key}"]`;
  app?.element?.find(selector)?.text(label);
}

function relabel($html, selector, text) {
  $html.find(selector).each((_, el) => {
    const $el = $(el);
    if ($el.is('input')) $el.val(text);
    else $el.text(text);
  });
}

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
