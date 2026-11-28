// ==UserScript==
// @name         石器倖存者自動躲避
// @name:zh-CN   石器幸存者助手
// @namespace    sa-survivors-local-helper
// @version      0.11.0
// @description  副本内自动闪避、拾取、抓宠及处理事件，支持指定地图重复战斗和自动开荒。
// @match        https://sa-survivors.com/survivors/*
// @homepageURL  https://github.com/rzj0506/shiqi-auto
// @supportURL   https://github.com/rzj0506/shiqi-auto/issues
// @updateURL    https://raw.githubusercontent.com/rzj0506/shiqi-auto/main/shiqi-auto.user.js
// @downloadURL  https://raw.githubusercontent.com/rzj0506/shiqi-auto/main/shiqi-auto.user.js
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const sampleSize = 193;
  const center = (sampleSize - 1) / 2;
  const step = 2;
  const sampleInterval = 29;
  const movementTimeout = 170;
  const directions = [
    [0, -1, '↑', ['ArrowUp']],
    [1, -1, '↗', ['ArrowUp', 'ArrowRight']],
    [1, 0, '→', ['ArrowRight']],
    [1, 1, '↘', ['ArrowDown', 'ArrowRight']],
    [0, 1, '↓', ['ArrowDown']],
    [-1, 1, '↙', ['ArrowDown', 'ArrowLeft']],
    [-1, 0, '←', ['ArrowLeft']],
    [-1, -1, '↖', ['ArrowUp', 'ArrowLeft']],
  ].map(([x, y, label, keys]) => {
    const length = Math.hypot(x, y);
    // 游戏的垂直移动速度是水平速度的 0.85 倍。
    return { x: x / length, y: y * 0.85 / length, label, keys };
  });

  const sample = document.createElement('canvas');
  sample.width = sample.height = sampleSize;
  const context = sample.getContext('2d', { willReadFrequently: true });
  if (!context) return;
  context.imageSmoothingEnabled = false;

  const eventSample = document.createElement('canvas');
  const eventContext = eventSample.getContext('2d', { willReadFrequently: true });
  const mapSample = document.createElement('canvas');
  const mapContext = mapSample.getContext('2d', { willReadFrequently: true });
  mapSample.width = 162;
  mapSample.height = 132;
  const mapWorldScale = 3200 / 150;
  const eventScanInterval = 100;
  const eventTrackTimeout = 220;
  // 事件按此顺序处理。地面标记和场外指示箭头分别使用游戏原有的配色。
  const eventTypes = [
    { name: '挑衅战旗', action: '正在踩战旗', ring: [255, 90, 74], stop: 48 },
    { name: '受伤的小宠物', action: '正在守护小宠物', ring: [143, 255, 160], stop: 38 },
    { name: '祝福石碑', action: '等待石碑祝福', ring: [190, 240, 255], arrow: [143, 216, 255], radius: 95, stop: 55, shrine: true },
    { name: '流浪商人', action: '等待商人交易', ring: [255, 212, 92], arrow: [255, 211, 107], stop: 38, merchant: true },
    { name: '赌博石像', action: '等待石像触发', ring: [255, 154, 213], dashed: true, stop: 38 },
  ];
  const shrineType = eventTypes.findIndex(type => type.shrine);
  const ringAngles = Array.from({ length: 24 }, (_, i) => {
    const angle = i * Math.PI / 12;
    return [Math.cos(angle), Math.sin(angle)];
  });
  const eventRings = eventTypes.map(type => {
    const rx = (type.radius ?? 60) / 2, ry = rx * 0.75;
    return { rx, ry, offsets: ringAngles.map(([x, y]) => [Math.round(x * rx), Math.round(y * ry)]) };
  });

  const settingsKey = 'sa-survivors-local-helper.settings';
  const slotKeys = ['z', 'x', 'c'];
  const maps = [
    ['sainasu', '薩村內', '萨村内'], ['turtle', '龜洞', '龟洞'], ['sea', '海洞'], ['elephant', '大象區', '大象区'],
    ['ruri', '琉璃'], ['hekisei', '碧青'], ['shinku', '深紅', '深红'], ['genou', '玄黃', '玄黄'], ['shikkoku', '漆黑'],
    ['sajif', '沙己夫'], ['stonel', '史東爾', '史东尔'], ['wreck', '沉船'], ['deepsea', '深海通道'], ['icesea', '流冰'],
  ].map(([id, nativeName, label], index) => ({ id, nativeName, label: label ?? nativeName, number: index + 1, chapter: index < 9 ? 0 : 1 }));
  const difficultyLevels = Array.from({ length: 19 }, (_, index) => 100 + 50 * index);
  const difficultyPageSize = 9;
  const highestDifficulty = 'highest';
  const options = {
    magnet: false, magnetSlot: '', capture: false, rate: 60, pickupBefore: 0, avoidMonsters: true,
    battleMode: 'off', battleMap: '', battleDifficulty: '',
  };
  let position = { x: 12, y: 86 };
  function validNumber(value, maximum) {
    return Number.isInteger(value) && value >= 0 && value <= maximum;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey) || '{}');
    for (const name of ['magnet', 'capture']) options[name] = saved?.[name] === true;
    options.battleMode = ['off', 'repeat', 'frontier'].includes(saved?.battleMode)
      ? saved.battleMode : saved?.repeat === true ? 'repeat' : 'off';
    if (maps.some(map => map.id === saved?.battleMap)) options.battleMap = saved.battleMap;
    if (saved?.battleDifficulty === highestDifficulty || difficultyLevels.includes(Number(saved?.battleDifficulty))) {
      options.battleDifficulty = String(saved.battleDifficulty);
    }
    options.avoidMonsters = saved?.avoidMonsters !== false;
    if (slotKeys.includes(saved?.magnetSlot)) options.magnetSlot = saved.magnetSlot;
    if (validNumber(saved?.rate, 100)) options.rate = saved.rate;
    if (validNumber(saved?.pickupBefore, 999)) options.pickupBefore = saved.pickupBefore;
    if (Number.isFinite(saved?.position?.x) && Number.isFinite(saved?.position?.y)) position = saved.position;
  } catch { /* 使用默认设置。 */ }

  function persistOptions() {
    try { localStorage.setItem(settingsKey, JSON.stringify({ ...options, position })); } catch { /* 本页仍保留设置。 */ }
  }

  if (document.getElementById('shiqi-auto-panel')) return;
  const panel = document.createElement('div');
  panel.id = 'shiqi-auto-panel';
  const shadow = panel.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial; position: fixed; z-index: 2147483647;
        color: #f7f2e8; font: 14px/1.4 system-ui, "Microsoft YaHei", sans-serif;
        color-scheme: dark;
      }
      * { box-sizing: border-box; }
      button, input, select { font: inherit; color: inherit; }
      [hidden] { display: none !important; }
      button:focus-visible, input:focus-visible, select:focus-visible {
        outline: 2px solid #f7c776; outline-offset: 2px;
      }
      .handle {
        display: flex; align-items: center; gap: 8px; width: min(222px, calc(100vw - 16px));
        height: 40px; padding: 0 10px; border: 1px solid #65543b; border-radius: 10px;
        background: #251f17; box-shadow: 0 2px 12px #0007;
        cursor: grab; touch-action: none; user-select: none;
      }
      .handle:active { cursor: grabbing; }
      .grip { color: #bdb29e; font-size: 17px; }
      .state {
        flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        text-align: left; color: #d7ccba; font-size: 12px;
      }
      .handle[data-active="true"] .state { color: #b5e6bd; }
      .caret { color: #d7ccba; font-size: 12px; }
      .handle[aria-expanded="true"] .caret { transform: rotate(180deg); }
      .settings {
        position: absolute; top: calc(100% + 6px); width: min(302px, calc(100vw - 16px));
        max-height: var(--settings-space, 420px); overflow: auto; overscroll-behavior: contain;
        border: 1px solid #65543b; border-radius: 12px; padding: 6px 12px;
        background: #251f17; box-shadow: 0 6px 20px #0008;
      }
      :host([data-up]) .settings { top: auto; bottom: calc(100% + 6px); }
      :host([data-end]) .settings { right: 0; }
      .section { padding: 9px 0; }
      .section + .section { border-top: 1px solid #514434; }
      .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      label.row { cursor: pointer; }
      .subrow { margin-top: 8px; color: #e0d4c0; font-size: 13px; }
      .hint { display: block; margin-top: 3px; color: #c5b8a3; font-size: 11px; }
      .switch { width: 18px; height: 18px; flex: 0 0 auto; margin: 2px; accent-color: #f2bc66; cursor: pointer; }
      .control { min-height: 29px; border: 1px solid #78684f; border-radius: 5px; background: #18150f; padding: 3px 6px; }
      .run-config .control { max-width: 150px; }
      input[type="number"] { width: 63px; }
      .unit { display: flex; align-items: center; gap: 4px; }
      #toggle {
        min-width: 62px; padding: 5px 9px; border: 1px solid #edbf77; border-radius: 6px;
        background: #f2bc66; color: #292014; font-weight: 700; cursor: pointer;
      }
      #toggle[aria-pressed="true"] { background: #34271a; color: #ffe3ae; }
    </style>
    <button class="handle" type="button" aria-expanded="false" aria-controls="settings" title="单击展开，拖动调整位置">
      <span class="grip" aria-hidden="true">⠿</span><strong>石器助手</strong>
      <span class="state"></span><span class="caret" aria-hidden="true">▾</span>
    </button>
    <div class="settings" id="settings" hidden>
      <div class="section row">
        <div><strong>副本助手</strong><small class="hint">闪避红圈和处理事件 · F8 开关</small></div>
        <button id="toggle" type="button" aria-pressed="false">启动</button>
      </div>
      <div class="section">
        <label class="row" for="avoidMonsters"><span>自动躲避首领和怪物</span><input class="switch" id="avoidMonsters" type="checkbox"></label>
        <small class="hint">需开启战斗小地图（N）</small>
      </div>
      <div class="section">
        <label class="row" for="magnet"><span>打完首领后使用磁石</span><input class="switch" id="magnet" type="checkbox"></label>
        <label class="row subrow" id="magnet-details" for="magnetSlot">
          <span>磁石所在快捷栏</span>
          <select class="control" id="magnetSlot">
            <option value="">请选择</option><option value="z">Z</option><option value="x">X</option><option value="c">C</option>
          </select>
        </label>
      </div>
      <div class="section">
        <label class="row" for="pickupBefore">
          <span>本局等级低于此值时拾取</span>
          <input class="control" id="pickupBefore" type="number" min="0" max="999" step="1">
        </label>
        <small class="hint">0 关闭 · 拾取需开启战斗小地图（N）</small>
      </div>
      <div class="section">
        <label class="row" for="capture"><span>追踪并自动捕捉宠物</span><input class="switch" id="capture" type="checkbox"></label>
        <label class="row subrow" id="capture-details" for="rate">
          <span>捕捉率高于此数值才捕捉</span>
          <span class="unit"><input class="control" id="rate" type="number" min="0" max="100" step="1">%</span>
        </label>
      </div>
      <div class="section run-config">
        <label class="row" for="battleMode">
          <span>战斗模式</span>
          <select class="control" id="battleMode">
            <option value="off">手动出发</option><option value="repeat">重复战斗</option><option value="frontier">自动开荒</option>
          </select>
        </label>
        <div id="battle-details" hidden>
          <label class="row subrow" for="battleMap"><span>地图</span><select class="control" id="battleMap"></select></label>
          <label class="row subrow" for="battleDifficulty"><span id="difficulty-label">难度</span><select class="control" id="battleDifficulty"></select></label>
          <small id="frontier-hint" class="hint" hidden>通关升一档，倒下退一档。</small>
        </div>
      </div>
    </div>
  `;
  const handle = shadow.querySelector('.handle');
  const statusView = shadow.querySelector('.state');
  const configuration = shadow.querySelector('#settings');
  const button = shadow.querySelector('#toggle');

  function placePanel(x, y) {
    const margin = 8;
    const bounds = handle.getBoundingClientRect();
    const right = innerWidth - margin;
    const bottom = innerHeight - margin;
    const settingsWidth = Math.min(302, innerWidth - margin * 2);
    x = Math.max(margin, Math.min(x, right - bounds.width));
    y = Math.max(margin, Math.min(y, bottom - bounds.height));
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
    const above = y - margin - 6;
    const below = bottom - y - bounds.height - 6;
    const openUp = below < 330 && above > below;
    panel.toggleAttribute('data-up', openUp);
    panel.toggleAttribute('data-end', x + settingsWidth > right && x + bounds.width - settingsWidth >= margin);
    if (x + settingsWidth > right && !panel.hasAttribute('data-end')) {
      configuration.style.left = (right - settingsWidth - x) + 'px';
    } else configuration.style.left = '';
    panel.style.setProperty('--settings-space', Math.max(0, openUp ? above : below) + 'px');
    return { x, y };
  }

  function refreshSettings() {
    shadow.querySelector('#magnet-details').hidden = !options.magnet;
    shadow.querySelector('#capture-details').hidden = !options.capture;
    shadow.querySelector('#battle-details').hidden = options.battleMode === 'off';
    shadow.querySelector('#frontier-hint').hidden = options.battleMode !== 'frontier';
    shadow.querySelector('#difficulty-label').textContent = options.battleMode === 'frontier' ? '起始难度' : '难度';
  }

  const mapSelect = shadow.querySelector('#battleMap');
  mapSelect.add(new Option('沿用当前地图', ''));
  for (const map of maps) mapSelect.add(new Option(map.number + '. ' + map.label, map.id));
  const difficultySelect = shadow.querySelector('#battleDifficulty');
  difficultySelect.add(new Option('沿用当前所选', ''));
  difficultySelect.add(new Option('当前可选的最高难度', highestDifficulty));
  for (const level of difficultyLevels) difficultySelect.add(new Option(level + '%', String(level)));

  for (const field of ['magnet', 'magnetSlot', 'capture', 'rate', 'pickupBefore', 'avoidMonsters', 'battleMode', 'battleMap', 'battleDifficulty']) {
    const input = shadow.getElementById(field);
    if (input.type === 'checkbox') input.checked = options[field];
    else input.value = options[field];
    input.addEventListener('change', () => {
      if (input.type === 'checkbox') options[field] = input.checked;
      else if (input.type === 'number') {
        if (validNumber(input.valueAsNumber, Number(input.max))) options[field] = input.valueAsNumber;
        input.value = String(options[field]);
      } else options[field] = input.value;
      if (field.startsWith('battle')) resetRunRouting();
      refreshSettings();
      persistOptions();
    });
    if (input.type === 'number') {
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') input.blur();
      });
    }
  }
  refreshSettings();
  document.body.append(panel);
  placePanel(position.x, position.y);
  window.addEventListener('resize', () => placePanel(position.x, position.y));
  for (const type of ['keydown', 'keyup', 'pointerdown', 'click']) {
    panel.addEventListener(type, event => event.stopPropagation());
  }

  let drag = null, suppressClick = false;
  handle.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    suppressClick = false;
    const { left, top } = handle.getBoundingClientRect();
    drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, left, top, moved: false };
    handle.setPointerCapture(event.pointerId);
  });
  window.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    position = placePanel(drag.left + dx, drag.top + dy);
  }, true);
  function finishDrag(event) {
    if (drag && (event.type === 'blur' || drag.id === event.pointerId)) {
      suppressClick = drag.moved;
      drag = null;
      if (suppressClick) persistOptions();
    }
  }
  window.addEventListener('pointerup', finishDrag, true);
  window.addEventListener('pointercancel', finishDrag, true);
  window.addEventListener('blur', finishDrag);
  handle.addEventListener('click', event => {
    if (suppressClick && event.detail > 0) return;
    placePanel(position.x, position.y);
    configuration.hidden = !configuration.hidden;
    handle.setAttribute('aria-expanded', String(!configuration.hidden));
  });

  let hudObserver = null;
  function stopHudObserver() {
    if (!hudObserver) return;
    const { context: gameContext, original } = hudObserver;
    for (const key of ['fillText', 'clearRect']) {
      if (gameContext[key] !== hudObserver[key]) continue;
      if (original[key]) Object.defineProperty(gameContext, key, original[key]);
      else delete gameContext[key];
    }
    hudObserver = null;
  }

  function textCenter(gameContext, text, x, missingPrefix = '') {
    if (gameContext.textAlign === 'center') return x;
    const half = gameContext.measureText(missingPrefix + text).width / 2;
    if (gameContext.textAlign === 'right' || gameContext.textAlign === 'end') return x - half;
    return x + half - gameContext.measureText(missingPrefix).width;
  }

  function menuPoint(gameContext, x, y) {
    const transform = gameContext.getTransform();
    return {
      x: transform.a * x + transform.c * y + transform.e,
      y: transform.b * x + transform.d * y + transform.f,
      scale: Math.hypot(transform.a, transform.b),
    };
  }

  function observeRouteHud(hud, gameContext, text, x, y) {
    const route = hud.route;
    const color = String(gameContext.fillStyle).toLowerCase();
    if (text.includes('要去哪裡練功') && x === 400 && y >= 46 && y <= 55) {
      route.list = true;
    } else if (text === '出發') {
      route.village = true;
    } else if (text === '出發！' && x >= 315 && x <= 335 && y >= 490 && y <= 515) {
      route.launch = menuPoint(gameContext, x, y);
    } else if (text === '取消' && x >= 465 && x <= 485 && y >= 490 && y <= 515) {
      route.cancel = menuPoint(gameContext, x, y);
    } else if ((text === '第一部' || text.startsWith('第二部')) && y >= 65 && y <= 76) {
      route.chapters[text === '第一部' ? 0 : 1] = { point: menuPoint(gameContext, x, y + 6), locked: text.includes('未開') };
    } else if (y >= 141 && y <= 159 && (text === '◀' || text === '▶') && x >= 636 && x <= 687) {
      route.pages[text] = menuPoint(gameContext, x, y);
    } else if (text === '✔自訂' && x >= 135 && x <= 185 && y >= 152 && y <= 174) {
      route.custom = true;
    } else if (text.startsWith('組隊出發：') || text.startsWith('組隊中：只有隊長') || text.startsWith('組隊：全隊用')) {
      route.party = true;
    } else if (x === 400 && y >= 46 && y <= 66 && (text === '勝利！' || text.startsWith('倒下了'))) {
      hud.outcome = text === '勝利！' ? 'win' : 'loss';
    } else if (x === 400 && y >= 85 && y <= 92) {
      const map = maps.find(entry => entry.nativeName === text);
      if (map) route.map = map.id;
    } else if (y >= 145 && y <= 154 && x >= 200 && x <= 615 && /^\d{3,4}%$/.test(text)) {
      const index = difficultyLevels.indexOf(Number(text.slice(0, -1)));
      if (index >= 0) route.difficulties.set(index, {
        point: menuPoint(gameContext, x, y),
        locked: color === '#777766' || color === '#776' || color === '#6e5236',
      });
    } else if (y >= 115 && y <= 411 && x >= 56 && x <= 595 && /\S/.test(text)) {
      const title = text.match(/^(?:(\d{1,2})[.．]\s*|[.．]\s*)(.+)$/);
      if (!title) return;
      const map = maps.find(entry => entry.nativeName === title[2] && (!title[1] || entry.number === Number(title[1])));
      if (map) route.cards.set(map.id, {
        point: menuPoint(gameContext, x + 36, y + 14),
        locked: color === '#888877' || color === '#887' || color === '#6e5236',
      });
    }
  }

  const merchantSubtitle = '站 2 秒：60 石幣換一次升級';
  function observeHudText(hud, canvas, gameContext, raw, x, y) {
    const text = raw.trim();
    if (options.battleMode !== 'off') observeRouteHud(hud, gameContext, text, x, y);
    if ((text === '暫停' || text === '暂停') && x >= 54 && x <= 72 && y >= 34 && y <= 62) {
      hud.paused = true;
    } else if (text.startsWith('打字中：遊戲暫停') && y >= 460 && y <= 480) {
      hud.paused = true;
    } else if (text === '升級！' && x === 400 && y >= 50 && y <= 74) {
      hud.paused = true;
    } else if (/^流浪商人(?:\s*\d{1,2}\s*秒)?$/.test(text)) {
      hud.merchantTitle = { x, y };
      if (/\d/.test(text) && gameContext.textAlign === 'center') hud.merchants.push({ x, y: y - 28 });
    } else if (hud.merchantTitle && Math.abs(y - hud.merchantTitle.y - 17) <= 2
      && Math.abs(x - hud.merchantTitle.x) < 150 && (text === '站' || text === merchantSubtitle)) {
      hud.merchants.push({ x: textCenter(gameContext, merchantSubtitle, x), y: y - 45 });
    } else if (options.capture && /^(?:1\s*)?等[寵宠][：:]\s*\S/.test(text)) {
      const prefix = /^\s*1/.test(raw) ? '' : '1';
      hud.petArrows.push({ x: textCenter(gameContext, raw, x, prefix), y });
    } else if (options.capture && /^(?:1\s*)?等[寵宠]$/.test(text)) {
      const prefix = /^\s*1/.test(raw) ? '' : '1';
      const width = gameContext.measureText(prefix + raw).width;
      hud.pets.push({ x: textCenter(gameContext, raw, x, prefix) + 14 - width / 2, y: y - 19.5 });
    } else if (Math.abs(x - 58) <= 1 && Math.abs(y - 59) <= 1 && /^[1-9]\d{0,2}$/.test(text)) {
      hud.levelBadge = Number(text);
    } else if (text === '本局' && Math.abs(x - 58) <= 1 && Math.abs(y - 78) <= 1) {
      hud.level = hud.levelBadge;
    } else if (text === '結算' || text === '結算 Enter') {
      if (y >= 65 && y <= 92) hud.loot = true;
    } else if (text === '再來一局' && y >= 537 && y <= 546) {
      hud.repeat = /^(#fff|#ffffff)$/.test(gameContext.fillStyle);
    } else if (text === '回到村莊' && y >= 537 && y <= 546) {
      hud.result = true;
      hud.returnToVillage = menuPoint(gameContext, x, y);
    } else if (text.startsWith('捕捉中') && y >= 223 && y <= 240) {
      hud.capturing = true;
    } else if (y >= 551 && y <= 559 && Math.abs(canvas.width / gameContext.getTransform().a - x - 62) < 70) {
      const match = text.match(/^捕捉(?:\s*(\d{1,3})\s*[%％])?$/);
      if (match) {
        hud.captureX = x;
        if (match[1] !== undefined) hud.rate = Number(match[1]);
      } else if (x > hud.captureX && x - hud.captureX < 65 && /^\d{1,3}\s*[%％]$/.test(text)) {
        hud.rate = parseInt(text, 10);
      }
    } else if (y >= 467 && y <= 473 && Math.abs(canvas.width / gameContext.getTransform().a - x - 92) < 65) {
      const match = text.match(/^(?:草繩|藤繩|獸筋繩|龍筋繩|黃金繩)(?:\s*(\d+))?$/);
      if (match) {
        hud.ropeBadge = true;
        hud.ropeX = x;
        if (match[1] !== undefined) hud.ropes = Number(match[1]);
      } else if (x > hud.ropeX && x - hud.ropeX < 70 && /^\d+$/.test(text)) {
        hud.ropes = Number(text);
      }
    } else if (gameContext.textAlign === 'right' && /^\d+$/.test(text)) {
      const slot = (y - 353) / 52;
      if (Number.isInteger(slot) && slot >= 0 && slot < slotKeys.length) {
        const scale = gameContext.getTransform().a;
        if (Math.abs(canvas.width / scale - x - 21) < 2) hud.stock[slot] = Number(text);
      }
    }
  }

  function watchGameCanvas() {
    const canvas = document.querySelector('canvas#overlay');
    if (hudObserver?.canvas !== canvas) stopHudObserver();
    if (!canvas) return false;
    if (!hudObserver) {
      const gameContext = canvas.getContext('2d');
      if (!gameContext) return false;
      const original = Object.fromEntries(['fillText', 'clearRect'].map(key => [key, Object.getOwnPropertyDescriptor(gameContext, key)]));
      const drawText = gameContext.fillText, clear = gameContext.clearRect;
      let hud = null;
      // 读取本帧的游戏界面文字，绘图仍交给原有的 Canvas 方法。
      const fillText = function (text, x, y) {
        const result = drawText.apply(this, arguments);
        if (hud && typeof text === 'string' && text.length <= 48) {
          try { observeHudText(hud, canvas, this, text, x, y); } catch { /* 略过无法识别的文字。 */ }
        }
        return result;
      };
      const clearRect = function (x, y, width, height) {
        const result = clear.apply(this, arguments);
        if (x === 0 && y === 0 && width >= canvas.width && height >= canvas.height) {
          const current = hud = {
            at: performance.now(), stock: [], merchants: [], petArrows: [], pets: [],
            route: { chapters: [], pages: {}, difficulties: new Map(), cards: new Map() },
          };
          // 等这轮画布绘制结束后再读图。游戏后台 Worker 绘制的帧同样会到这里。
          queueMicrotask(() => {
            if (enabled && hudObserver?.latest() === current) runBattleFrame(performance.now(), current);
          });
        }
        return result;
      };
      hudObserver = { canvas, context: gameContext, original, fillText, clearRect, latest: () => hud };
      try {
        gameContext.fillText = fillText;
        gameContext.clearRect = clearRect;
      } catch {
        stopHudObserver();
        return false;
      }
    }
    return true;
  }

  function at(x, y) {
    return ((center + Math.round(y / step)) * sampleSize + center + Math.round(x / step)) * 4;
  }

  function warningTint(data, x, y) {
    const offset = at(x, y);
    const red = data[offset], green = data[offset + 1], blue = data[offset + 2];
    // 半透明红底与斜线。伤害数字和血条的颜色不同。
    const stripe = Math.max(0, red - 200);
    return data[offset + 3] >= 24 && red >= 183
      && Math.abs(green - (40 + stripe * 0.55)) <= 12
      && Math.abs(blue - (20 + stripe * 0.36)) <= 12;
  }

  function hasBattleBar(data) {
    // 同时取血条内的两行，防止显示比例取整或警告特效盖住其中一行。
    for (const y of [18, 20]) {
      let hits = 0;
      for (let x = -16; x <= 16; x += 4) {
        const offset = at(x, y);
        if (data[offset + 3] < 245) continue;
        if (battleBarColors.some(color => eventColor(data, offset, color, 5))) hits++;
      }
      if (hits >= 6) return true;
    }
    return false;
  }
  const battleBarColors = [[229, 83, 61], [255, 138, 106], [74, 46, 20]];

  function isDangerUnderfoot(data) {
    let centerHits = 0, ringHits = 0;
    for (let y = -6; y <= 6; y += 6) {
      for (let x = -6; x <= 6; x += 6) {
        if (warningTint(data, x, y)) centerHits++;
      }
    }
    // 骷髅图标可能遮住圆心，同时采样周围地面，排除零散的红色数字。
    for (let i = 0; i < 12; i++) {
      const angle = i * Math.PI / 6;
      if (warningTint(data, Math.cos(angle) * 14, Math.sin(angle) * 14)) ringHits++;
    }
    return centerHits >= 5 || (centerHits >= 2 && ringHits >= 2) || ringHits >= 8;
  }

  function warningOnPath(data, direction, distance) {
    const x = direction.x * distance, y = direction.y * distance;
    const sideX = -direction.y * 6, sideY = direction.x * 6;
    return warningTint(data, x, y) || warningTint(data, x + sideX, y + sideY)
      || warningTint(data, x - sideX, y - sideY);
  }

  function assessEscape(data, direction) {
    let clear = 0, exit = Infinity, before = 0, after = 0;
    for (let distance = 6; distance <= 180 && distance <= exit + 42; distance += 6) {
      if (warningOnPath(data, direction, distance)) {
        clear = 0;
        if (exit === Infinity) before++;
        else after++;
      } else if (++clear === 4 && exit === Infinity) {
        exit = distance - 18;
      }
    }
    return { direction, exit, score: exit === Infinity ? 270 + before * 3 : exit + after * 12 };
  }

  function readBattlePixels() {
    const overlay = document.querySelector('canvas#overlay');
    if (!overlay?.width || !overlay.height) return null;
    const side = sampleSize * step * overlay.height / 600;
    if (side > overlay.width) return null;
    context.clearRect(0, 0, sampleSize, sampleSize);
    context.drawImage(overlay, (overlay.width - side) / 2, (overlay.height - side) / 2,
      side, side, 0, 0, sampleSize, sampleSize);
    return context.getImageData(0, 0, sampleSize, sampleSize).data;
  }

  function eventColor(data, offset, color, tolerance = 9) {
    return Math.abs(data[offset] - color[0]) <= tolerance
      && Math.abs(data[offset + 1] - color[1]) <= tolerance
      && Math.abs(data[offset + 2] - color[2]) <= tolerance;
  }

  function eventMasks(data, width, height) {
    const ground = new Uint8Array(width * height), arrows = new Uint8Array(ground.length);
    for (let point = 0; point < ground.length; point++) {
      const offset = point * 4;
      if (data[offset + 3] < 112) continue;
      for (let i = 0; i < eventTypes.length; i++) {
        const type = eventTypes[i];
        if (eventColor(data, offset, type.ring)) ground[point] = i + 1;
        if (eventColor(data, offset, type.arrow || type.ring, 7)) arrows[point] = i + 1;
      }
    }
    return { ground, arrows };
  }

  function markerScore(mask, width, height, kind, x, y, rx, ry, minSectors = 3) {
    let hits = 0, sectors = 0;
    for (const [i, [dx, dy]] of ringAngles.entries()) {
      const sx = Math.round(x + dx * rx), sy = Math.round(y + dy * ry);
      if (sx < 1 || sx >= width - 1 || sy < 1 || sy >= height - 1) continue;
      const p = sy * width + sx;
      if (mask[p] === kind || mask[p - 1] === kind || mask[p + 1] === kind
        || mask[p - width] === kind || mask[p + width] === kind) {
        hits++;
        sectors |= 1 << Math.floor(i / 6);
      }
    }
    const count = (sectors & 1) + (sectors >> 1 & 1) + (sectors >> 2 & 1) + (sectors >> 3 & 1);
    return count >= minSectors ? hits : 0;
  }

  function findGroundMarkers(mask, width, height) {
    // 由颜色匹配的像素找候选位置，再确认是否存在对应的椭圆轮廓。
    // 游戏在圆心刚移出画面时仍绘制光圈。把投票区延伸到画布边缘外。
    const bin = 2, margin = 11;
    const gridWidth = Math.ceil(width / bin) + margin * 2;
    const gridHeight = Math.ceil(height / bin) + margin * 2;
    const votes = eventTypes.map(() => new Uint16Array(gridWidth * gridHeight));
    for (let point = 0; point < mask.length; point++) {
      if (!mask[point]) continue;
      const type = mask[point] - 1;
      const x = point % width, y = Math.floor(point / width), bucket = votes[type];
      for (const [dx, dy] of eventRings[type].offsets) {
        const bx = margin + Math.floor((x - dx) / bin), by = margin + Math.floor((y - dy) / bin);
        if (bx >= 0 && bx < gridWidth && by >= 0 && by < gridHeight) bucket[by * gridWidth + bx]++;
      }
    }
    return votes.map((bucket, type) => {
      const { rx, ry } = eventRings[type];
      const peaks = [];
      for (let point = 0; point < bucket.length; point++) {
        if (bucket[point] >= (eventTypes[type].dashed ? 4 : 6)) peaks.push(point);
      }
      peaks.sort((a, b) => bucket[b] - bucket[a]);
      let best = null, bestScore = 0;
      for (const point of peaks.slice(0, 24)) {
        const x = (point % gridWidth - margin) * bin, y = (Math.floor(point / gridWidth) - margin) * bin;
        for (let oy = -1; oy <= bin; oy++) {
          for (let ox = -1; ox <= bin; ox++) {
            const cx = x + ox, cy = y + oy;
            const clipped = cx < 0 || cx >= width || cy < 0 || cy >= height;
            const score = markerScore(mask, width, height, type + 1, cx, cy, rx, ry, 2);
            const minimum = (eventTypes[type].dashed ? 8 : 11) - (clipped ? 3 : 0);
            const ranked = score - (clipped ? 2 : 0);
            if (score < minimum || ranked <= bestScore) continue;
            best = { x: cx, y: cy, arrow: false };
            bestScore = ranked;
          }
        }
        if (bestScore === ringAngles.length) break;
      }
      return best;
    });
  }

  let arrowCandidateWidth = 0, arrowCandidates = [];
  function findEventArrows(mask, width, height, markers) {
    if (arrowCandidateWidth !== width) {
      arrowCandidateWidth = width;
      const positions = new Set();
      // 斜向箭头沿椭圆分布，只有部分会贴着画布边缘。
      const halfW = width / 2, halfH = height / 2;
      for (let angle = 0; angle < 2 * Math.PI; angle += 1 / Math.max(halfW, halfH)) {
        const x = Math.cos(angle), y = Math.sin(angle);
        const radius = Math.min(halfW - 25, (halfH - 40) / Math.max(0.001, Math.abs(y)));
        positions.add(Math.round(halfH + y * radius) * width + Math.round(halfW + x * radius));
      }
      arrowCandidates = [...positions].map(point => [point % width, Math.floor(point / width)]);
    }
    return markers.map((marker, type) => {
      if (marker) return marker;
      if (!mask.includes(type + 1)) return null;
      let best = null, bestScore = 15;
      for (const [x, y] of arrowCandidates) {
        const score = markerScore(mask, width, height, type + 1, x, y, 10.35, 10.35);
        if (score < bestScore || (best && score === bestScore)) continue;
        best = { x, y, arrow: true };
        bestScore = score;
      }
      return best;
    });
  }

  const mapPlayerWhite = [255, 255, 255];
  const mapPlayerOutline = [59, 38, 20];
  const mapShrineColor = [159, 232, 255];
  const mapLootDots = [[124, 255, 124], [255, 154, 213], [255, 212, 92]];
  const mapItemColors = [[232, 220, 196], [124, 255, 124], [106, 184, 255], [201, 166, 255], [255, 176, 80], [255, 106, 74], mapPlayerWhite];
  const mapAxes = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const mapCorners = [[2, 2], [2, -2], [-2, 2], [-2, -2]];
  const mapItemOutline = [0, 0, 0];
  const mapVoid = [20, 14, 8];
  const bossMarkerColor = [255, 74, 58];
  const eliteMarkerColor = [255, 176, 80];
  const threatTypes = [
    { name: '躲避首领', near: 235, clear: 305, weight: 3.5 },
    { name: '躲避精英', near: 170, clear: 220, weight: 1.8 },
    { name: '躲避怪物', near: 145, clear: 185, weight: 1 },
  ];

  function isMapGear(data, width, x, y, color) {
    const match = (rgb, dx, dy, tolerance) => eventColor(data, ((y + dy) * width + x + dx) * 4, rgb, tolerance);
    return mapCorners.filter(([dx, dy]) => match(color, dx, dy, 35)).length >= 3
      && mapAxes.filter(([dx, dy]) => match(mapItemOutline, dx * 3, dy * 3, 76)
        || match(mapItemOutline, dx * 4, dy * 4, 76)).length >= 3;
  }

  function findMapThreats(data, width, playerX, playerY) {
    const reach = 23, side = reach * 2 + 1;
    const originX = playerX - reach, originY = playerY - reach;
    const mask = new Uint8Array(side * side);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const offset = ((originY + y) * width + originX + x) * 4;
        if (data[offset + 3] < 125) continue;
        const index = y * side + x;
        if (eventColor(data, offset, bossMarkerColor, 11)) mask[index] = 1;
        else if (eventColor(data, offset, eliteMarkerColor, 10)) mask[index] = 2;
        else {
          // 普通怪是半透明小红点，地形改变底色，但保留通道差。
          const red = data[offset], green = data[offset + 1], blue = data[offset + 2];
          if (red >= 151 && red - green >= 68 && red - green <= 135
            && green - blue >= 8 && green - blue <= 29) mask[index] = 3;
        }
      }
    }

    const threats = [];
    for (let point = 0; point < mask.length; point++) {
      const kind = mask[point] - 1;
      if (kind < 0) continue;
      const group = [point];
      mask[point] = 0;
      let sx = 0, sy = 0, left = side, right = 0, top = side, bottom = 0;
      for (let i = 0; i < group.length; i++) {
        const x = group[i] % side, y = Math.floor(group[i] / side);
        sx += x;
        sy += y;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        for (const [dx, dy] of mapAxes) {
          const nx = x + dx, ny = y + dy, next = ny * side + nx;
          if (nx < 0 || ny < 0 || nx >= side || ny >= side || mask[next] !== kind + 1) continue;
          mask[next] = 0;
          group.push(next);
        }
      }
      if (kind === 0 && group.length < 5) continue;
      const centerX = sx / group.length, centerY = sy / group.length;
      if (kind === 1) {
        // 精英是橙色圆点。排除同色装备方块和尺寸更大的任务星标。
        if (group.length < 7 || right - left > 5 || bottom - top > 5) continue;
        if (isMapGear(data, width, originX + Math.round(centerX), originY + Math.round(centerY), eliteMarkerColor)) continue;
        let outline = 0;
        for (let y = originY + top - 3; y <= originY + bottom + 3; y++) {
          for (let x = originX + left - 3; x <= originX + right + 3; x++) {
            if (Math.hypot(x + 0.5 - playerX, y + 0.5 - playerY) <= 5.6) continue;
            const offset = (y * width + x) * 4;
            if (data[offset + 3] < 225) continue;
            if (eventColor(data, offset, mapItemOutline, 14)
              || eventColor(data, offset, mapPlayerOutline, 18)) outline++;
          }
        }
        if (outline >= 3) continue;
      }
      const x = (centerX - reach + 0.5) * mapWorldScale, y = (centerY - reach + 0.5) * mapWorldScale;
      const distance = Math.hypot(x, y / 0.85);
      if (distance > 470) continue;
      const crowd = kind === 2 ? Math.min(2.5, Math.max(1, group.length / 4)) : 1;
      threats.push({ kind, x, y, distance, weight: threatTypes[kind].weight * crowd });
    }
    return threats.sort((a, b) => a.kind - b.kind || a.distance - b.distance).slice(0, 20);
  }

  function mapRouteBlocks(data, width, playerX, playerY) {
    return directions.map(direction => {
      let blocks = 0;
      for (const distance of [68, 112, 156]) {
        const x = Math.round(playerX + direction.x * distance / mapWorldScale);
        const y = Math.round(playerY + direction.y * distance / mapWorldScale);
        const dark = mapAxes.filter(([dx, dy]) => eventColor(data, ((y + dy) * width + x + dx) * 4, mapVoid, 13)).length;
        if (dark >= 3) blocks++;
      }
      return blocks;
    });
  }

  function findMapShrine(data, width, height, playerX, playerY) {
    const mask = new Uint8Array(width * height);
    const votes = new Uint8Array(mask.length);
    for (let y = playerY - 50; y <= playerY + 50; y++) {
      for (let x = 6; x < width - 6; x++) {
        const point = y * width + x;
        if (data[point * 4 + 3] < 160 || !eventColor(data, point * 4, mapShrineColor, 13)) continue;
        mask[point] = 1;
        for (let angle = 0; angle < 12; angle++) {
          const [cos, sin] = ringAngles[angle * 2];
          votes[(y + Math.round(sin * 4.5)) * width + x + Math.round(cos * 4.5)]++;
        }
      }
    }
    let best = null, bestScore = 0;
    for (let point = 0; point < votes.length; point++) {
      if (votes[point] < 4) continue;
      const x = point % width, y = Math.floor(point / width);
      const score = markerScore(mask, width, height, 1, x, y, 4.5, 4.5);
      if (score < 13) continue;
      const distance = Math.hypot(x - playerX, (y - playerY) / 0.75);
      const ranked = score - distance * 0.09;
      if (ranked <= bestScore) continue;
      bestScore = ranked;
      best = { x: (x - playerX) * mapWorldScale, y: (y - playerY) * mapWorldScale };
    }
    return best;
  }

  function readBattleMap(overlay, pickupAllowed) {
    if (!mapContext) return null;
    const scale = overlay.height / 600;
    const width = mapSample.width, height = mapSample.height;
    if (overlay.width < 170 * scale) return null;
    mapContext.imageSmoothingEnabled = false;
    mapContext.clearRect(0, 0, width, height);
    mapContext.drawImage(overlay, overlay.width - 170 * scale, 84 * scale, width * scale, height * scale, 0, 0, width, height);
    const data = mapContext.getImageData(0, 0, width, height).data;
    const pixel = (x, y) => (y * width + x) * 4;
    const playerX = 81;
    const playerY = [74, 58].find(y => eventColor(data, pixel(playerX, y), mapPlayerWhite, 7)
      && mapAxes.every(([dx, dy]) => eventColor(data, pixel(playerX + dx, y + dy), mapPlayerWhite, 7))
      && mapAxes.filter(([dx, dy]) => eventColor(data, pixel(playerX + dx * 4, y + dy * 4), mapPlayerOutline, 24)).length >= 3);
    if (playerY === undefined) return null;
    const shrine = findMapShrine(data, width, height, playerX, playerY);
    const pickups = [];
    const threats = options.avoidMonsters ? findMapThreats(data, width, playerX, playerY) : [];
    const blocked = threats.length ? mapRouteBlocks(data, width, playerX, playerY) : [];
    if (!pickupAllowed) return { shrine, pickups, threats, blocked };
    // 小地图用有黑边的方块画装备，用小圆点画素材、肉和石币。
    const reach = 24;
    for (let y = playerY - reach; y <= playerY + reach; y++) {
      for (let x = playerX - reach; x <= playerX + reach; x++) {
        const distance = Math.hypot(x - playerX, y - playerY);
        if (distance > reach || distance < 5) continue;
        const p = pixel(x, y);
        const square = mapItemColors.find(color => eventColor(data, p, color, 9));
        const match = (color, dx, dy) => eventColor(data, pixel(x + dx, y + dy), color, 9);
        const gear = square && isMapGear(data, width, x, y, square);
        const dot = mapLootDots.find(color => eventColor(data, p, color, 9));
        const smallDrop = dot && mapAxes.every(([dx, dy]) => match(dot, dx, dy))
          && mapAxes.filter(([dx, dy]) => match(dot, dx * 3, dy * 3)).length <= 1;
        if (!gear && !smallDrop) continue;
        pickups.push({ x: (x - playerX) * mapWorldScale, y: (y - playerY) * mapWorldScale, distance: distance * mapWorldScale });
      }
    }
    pickups.sort((a, b) => a.distance - b.distance);
    return { shrine, pickups, threats, blocked };
  }

  function scanBattleMap(overlay, now, level) {
    if (now < nextMapScan) return;
    const pickupAllowed = Number.isInteger(level) && level < options.pickupBefore;
    battleMap = overlay?.width && overlay.height ? readBattleMap(overlay, pickupAllowed) : null;
    if (battleMap) battleMap.at = now;
    try {
      const zoom = Number(localStorage.getItem('soda-sa-zoom'));
      eventZoom = zoom >= 0.8 && zoom <= 2 ? zoom : 1;
    } catch { /* 使用最近一次读到的缩放。 */ }
    nextMapScan = now + (options.avoidMonsters ? 65 : eventScanInterval);
  }

  function scanEvents(now, hud) {
    const overlay = document.querySelector('canvas#overlay');
    if (!eventContext || !overlay?.width || !overlay.height) return [];
    const width = Math.round(overlay.width / overlay.height * 300), height = 300;
    if (width < 100 || width > 1000) return [];
    if (eventSample.width !== width || eventSample.height !== height) {
      eventSample.width = width;
      eventSample.height = height;
    }
    eventContext.imageSmoothingEnabled = false;
    eventContext.clearRect(0, 0, width, height);
    eventContext.drawImage(overlay, 0, 0, width, height);
    const { ground, arrows } = eventMasks(eventContext.getImageData(0, 0, width, height).data, width, height);
    return findEventArrows(arrows, width, height, findGroundMarkers(ground, width, height)).flatMap((mark, type) => {
      if (eventTypes[type].merchant && hud?.merchants.length) {
        const markers = hud.merchants.map(label => {
          const x = label.x - overlay.width / overlay.height * 300, y = label.y - 300;
          return { type, x, y, arrow: false, distance: Math.hypot(x, y / 0.75), seenAt: now };
        });
        return [markers.reduce((best, marker) => marker.distance < best.distance ? marker : best)];
      }
      if (type === shrineType && (!mark || mark.arrow) && battleMap?.shrine) {
        const x = battleMap.shrine.x * eventZoom, y = battleMap.shrine.y * eventZoom;
        return [{ type, x, y, arrow: false, fromMap: true, distance: Math.hypot(x, y / 0.75), seenAt: now }];
      }
      if (!mark) return [];
      const x = (mark.x - width / 2 + 0.5) * 2, y = (mark.y - height / 2 + 0.5) * 2;
      return [{ type, x, y, arrow: mark.arrow, distance: Math.hypot(x, y / 0.75), seenAt: now }];
    });
  }

  let enabled = false, dodge = null, heldKeys = [], movementTimer = null, lastSample = -Infinity;
  let lastStatus = '';
  let eventPlan = null, eventList = [], nextEventScan = 0, retryMerchantAt = 0, eventZoom = 1;
  let battleMap = null, nextMapScan = 0, pickupPlan = null, pickupBlockedUntil = 0, monsterPlan = null;
  let magnetUsed = false, captureCandidate = null, nextCaptureAt = 0, petPlan = null;
  let resultSince = null, repeatSent = false, runRoute = null, menuAction = null, frontierStarted = false;
  let repeatHighest = null;

  function show(status) {
    if (status === lastStatus) return;
    lastStatus = status;
    statusView.textContent = status;
    statusView.title = status;
    handle.dataset.active = String(enabled);
    button.textContent = enabled ? '暂停' : '启动';
    button.setAttribute('aria-pressed', String(enabled));
  }

  function sendKey(type, key) {
    const code = key === ' ' ? 'Space' : key.length === 1 ? 'Key' + key.toUpperCase() : key;
    window.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true }));
  }

  function tap(key) {
    sendKey('keydown', key);
    sendKey('keyup', key);
  }

  function move(keys) {
    for (const key of heldKeys) {
      if (!keys.includes(key)) sendKey('keyup', key);
    }
    for (const key of keys) {
      if (!heldKeys.includes(key)) sendKey('keydown', key);
    }
    heldKeys = keys;
  }

  function releaseMovement() {
    if (movementTimer !== null) window.clearTimeout(movementTimer);
    movementTimer = null;
    move([]);
  }

  function drive(direction) {
    if (!direction) {
      releaseMovement();
      return;
    }
    move(direction.keys);
    // 画面停止更新时松开方向键。正常换帧会续住当前方向。
    if (movementTimer !== null) window.clearTimeout(movementTimer);
    movementTimer = window.setTimeout(releaseMovement, movementTimeout);
  }

  function stopDodge() {
    if (dodge) releaseMovement();
    dodge = null;
  }

  function stopMonsterAvoidance() {
    if (monsterPlan) releaseMovement();
    monsterPlan = null;
  }

  function stopEvent() {
    if (eventPlan) releaseMovement();
    eventPlan = null;
  }

  function stopPickup() {
    if (pickupPlan) releaseMovement();
    pickupPlan = null;
  }

  function stopPetApproach() {
    if (petPlan) releaseMovement();
    petPlan = null;
  }

  function resetEvents() {
    stopEvent();
    stopPickup();
    stopPetApproach();
    eventList = [];
    nextEventScan = 0;
    pickupBlockedUntil = 0;
  }

  function resetBattleTracking() {
    stopDodge();
    stopMonsterAvoidance();
    resetEvents();
    battleMap = null;
    nextMapScan = 0;
  }

  function stepLoot(hud) {
    if (!hud?.loot) return false;
    resetBattleTracking();
    const slot = slotKeys.indexOf(options.magnetSlot);
    if (options.magnet && !magnetUsed && hud.stock[slot] > 0) {
      magnetUsed = true;
      tap(options.magnetSlot);
    }
    show(magnetUsed ? '已使用磁石' : '拾取倒计时');
    return true;
  }

  function stepCapture(hud, now) {
    if (!options.capture || !hud) {
      captureCandidate = null;
      return false;
    }
    if (hud.capturing) {
      captureCandidate = null;
      resetEvents();
      show('捕捉中');
      return true;
    }
    const rate = hud.rate;
    if (!validNumber(rate, 100) || rate <= options.rate || (hud.ropeBadge && !(hud.ropes > 0)) || now < nextCaptureAt) {
      captureCandidate = null;
      return false;
    }
    if (captureCandidate?.rate !== rate) {
      captureCandidate = { rate, at: hud.at };
      resetEvents();
      show('确认捕捉率 · ' + rate + '%');
      return true;
    }
    if (hud.at === captureCandidate.at) return true;
    captureCandidate = null;
    resetEvents();
    nextCaptureAt = now + 1600;
    tap(' ');
    show('自动捕捉 · ' + rate + '%');
    return true;
  }

  function readLastDeparture() {
    try {
      const match = (localStorage.getItem('soda-sa-lastzone') ?? '').match(/^([a-z]+)\|(\d{1,2})$/);
      if (match && maps.some(map => map.id === match[1]) && Number(match[2]) < difficultyLevels.length) {
        return { map: match[1], index: Number(match[2]) };
      }
    } catch { /* 游戏未保存上次出发选择。 */ }
    return null;
  }

  function resetRunRouting() {
    resultSince = null;
    repeatSent = false;
    runRoute = null;
    menuAction = null;
    frontierStarted = false;
    repeatHighest = null;
  }

  function pressCanvasButton(point) {
    const canvas = hudObserver?.canvas, stage = canvas?.closest('.stage');
    if (!point || !stage || !canvas.width || !canvas.height) return;
    const bounds = stage.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const event = {
      clientX: bounds.left + point.x / canvas.width * bounds.width,
      clientY: bounds.top + point.y / canvas.height * bounds.height,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, bubbles: true, cancelable: true,
    };
    stage.dispatchEvent(new PointerEvent('pointerdown', { ...event, buttons: 1 }));
    stage.dispatchEvent(new PointerEvent('pointerup', { ...event, buttons: 0 }));
  }

  function selectMenu(key, now, status, action) {
    if (menuAction?.key !== key) menuAction = { key, count: 0, next: now + 180 };
    if (menuAction.count >= 4) {
      show('游戏菜单未响应 · ' + status);
      return;
    }
    show(status);
    if (now < menuAction.next) return;
    menuAction.count++;
    menuAction.next = now + 650;
    action();
  }

  function selectedDifficulty(point) {
    const gameContext = hudObserver?.context;
    if (!gameContext || !point.scale) return false;
    let orange = 0;
    for (const [dx, dy] of [[-17, -9], [-17, 8], [17, 8]]) {
      const [r, g, b] = gameContext.getImageData(Math.round(point.x + dx * point.scale),
        Math.round(point.y + dy * point.scale), 1, 1).data;
      if (r >= 128 && r - g >= 37 && g - b >= 25 && b < 105) orange++;
    }
    return orange >= 2;
  }

  function findHighestDifficulty(route, available, now) {
    const first = available[0];
    const last = available.at(-1);
    const count = Math.min(difficultyPageSize, difficultyLevels.length - first);
    if (first % difficultyPageSize || available.length !== count || last !== first + count - 1) return null;

    const highest = available.findLast(index => !route.difficulties.get(index).locked);
    if (highest != null) {
      if (highest < last || last === difficultyLevels.length - 1) return highest;
      // 整页都可选时继续往后看，下一页全锁就用这一页的最高档。
      runRoute.highestSeen = highest;
    } else if (runRoute.highestSeen != null) {
      return runRoute.highestSeen;
    }

    const arrow = highest == null ? '◀' : '▶';
    if (route.pages[arrow]) {
      selectMenu('highest:' + first + ':' + arrow, now, '查找当前可选的最高难度', () => pressCanvasButton(route.pages[arrow]));
    }
    return null;
  }

  function stepRunResult(hud, now) {
    resetBattleTracking();
    resultSince ??= now;
    if (repeatSent || now - resultSince < 900) {
      show(repeatSent ? '已请求再来一局' : '等待结算完成');
      return true;
    }
    if (runRoute?.returning) {
      selectMenu('return', now, '回村选择地图和难度', () => pressCanvasButton(hud.returnToVillage));
      return true;
    }
    const last = readLastDeparture();
    const fixed = difficultyLevels.indexOf(Number(options.battleDifficulty));
    const map = options.battleMap || last?.map;
    const frontier = options.battleMode === 'frontier';
    const highest = options.battleDifficulty === highestDifficulty;
    if (frontier && !hud.outcome) {
      show('等待确认通关结果');
      return true;
    }
    if (frontier && !map) {
      show('请先从地图界面出发一局');
      return true;
    }

    const sameMap = Boolean(last && last.map === map);
    const repeatIndex = repeatHighest && repeatHighest.map === map ? repeatHighest.index : null;
    const scanHighest = highest && (frontier ? !frontierStarted || !sameMap : repeatIndex == null);
    let index = fixed >= 0 ? fixed : (sameMap ? last.index : null);
    if (scanHighest) index = null;
    else if (highest && !frontier) index = repeatIndex;
    let fallback = null;
    if (frontier && sameMap && !scanHighest && (frontierStarted || fixed < 0 || last.index === fixed)) {
      const step = hud.outcome === 'win' ? 1 : -1;
      index = Math.min(difficultyLevels.length - 1, Math.max(0, last.index + step));
      if (step > 0 && index > last.index) fallback = last.index;
      frontierStarted = true;
    }

    if ((!frontier && !highest && !options.battleMap && fixed < 0) || (sameMap && last.index === index)) {
      repeatSent = true;
      tap('Enter');
      show('已请求再来一局');
      return true;
    }
    if (!map) {
      show('请先选择地图');
      return true;
    }
    runRoute = { map, index, fallback, scanHighest, returning: true };
    selectMenu('return', now, '回村选择地图和难度', () => pressCanvasButton(hud.returnToVillage));
    return true;
  }

  function stepDeparture(route, now) {
    if (route.party) {
      show('等待进入单人出发界面');
      return true;
    }
    if (!runRoute) {
      const last = readLastDeparture();
      const fixed = difficultyLevels.indexOf(Number(options.battleDifficulty));
      const highest = options.battleDifficulty === highestDifficulty;
      const repeat = options.battleMode === 'repeat';
      if (repeat && !highest && !options.battleMap && fixed < 0) return false;
      const map = options.battleMap || route.map || last?.map;
      if (!map) return false;
      const repeatIndex = repeat && repeatHighest?.map === map ? repeatHighest.index : null;
      const index = fixed >= 0 ? fixed : repeatIndex;
      runRoute = { map, index, fallback: null, scanHighest: highest && index == null };
    }
    runRoute.returning = false;
    if (!route.list && !route.launch) {
      selectMenu('depart', now, '打开地图列表', () => tap('g'));
      return true;
    }
    const wanted = maps.find(map => map.id === runRoute.map);
    if (route.launch && route.map !== wanted.id) {
      if (route.cancel) selectMenu('cancel', now, '切换地图 · ' + wanted.label, () => pressCanvasButton(route.cancel));
      return true;
    }
    if (!route.launch) {
      const card = route.cards.get(wanted.id);
      if (card?.locked || (!card && route.chapters[wanted.chapter]?.locked)) {
        show(wanted.label + '尚未开放');
      } else if (card) {
        selectMenu('map:' + wanted.id, now, '选择地图 · ' + wanted.label, () => pressCanvasButton(card.point));
      } else if (route.chapters[wanted.chapter]) {
        selectMenu('chapter:' + wanted.chapter, now, '切换地图章节', () => pressCanvasButton(route.chapters[wanted.chapter].point));
      }
      return true;
    }

    const available = [...route.difficulties.keys()].sort((a, b) => a - b);
    if (!available.length) return true;
    if (runRoute.index == null && runRoute.scanHighest) {
      runRoute.index = findHighestDifficulty(route, available, now);
      if (runRoute.index == null) return true;
    }
    if (runRoute.index == null) {
      const last = readLastDeparture();
      runRoute.index = available.find(index => selectedDifficulty(route.difficulties.get(index).point))
        ?? (last?.map === wanted.id ? last.index : available.find(index => !route.difficulties.get(index).locked));
    }
    const index = runRoute.index;
    if (index == null) {
      if (route.pages['◀']) selectMenu('lower-page', now, '查找已解锁的难度', () => pressCanvasButton(route.pages['◀']));
      return true;
    }
    const detail = route.difficulties.get(index);
    const label = wanted.label + ' ' + difficultyLevels[index] + '%';
    if (!detail) {
      const arrow = index < available[0] ? '◀' : '▶';
      if (route.pages[arrow]) selectMenu('page:' + available[0] + ':' + arrow, now, '查找难度 · ' + label, () => pressCanvasButton(route.pages[arrow]));
    } else if (detail.locked) {
      runRoute.lockedAt ??= now;
      if (runRoute.fallback != null && now - runRoute.lockedAt >= 2400) {
        runRoute.index = runRoute.fallback;
        runRoute.fallback = null;
        runRoute.lockedAt = null;
      }
      show('难度尚未解锁 · ' + label);
    } else if (route.custom || !selectedDifficulty(detail.point)) {
      selectMenu('difficulty:' + index, now, '选择难度 · ' + label, () => pressCanvasButton(detail.point));
    } else {
      selectMenu('launch:' + wanted.id + ':' + index, now, '出发 · ' + label, () => {
        if (options.battleMode === 'frontier') frontierStarted = true;
        else if (runRoute.scanHighest) repeatHighest = { map: wanted.id, index };
        pressCanvasButton(route.launch);
      });
    }
    return true;
  }

  function stepBattleMenu(hud, now) {
    if (options.battleMode === 'off' || !hud) return false;
    if (hud.result && hud.repeat) return stepRunResult(hud, now);
    resultSince = null;
    const route = hud.route;
    if (route.list || route.launch || (route.village && !hud.level)) {
      resetBattleTracking();
      return stepDeparture(route, now);
    }
    return false;
  }

  function monsterCrossingRisk(direction, stride, threats) {
    let risk = 0;
    for (const threat of threats) {
      const y = threat.y / 0.85;
      const vy = direction.y / 0.85;
      const along = Math.max(0, Math.min(stride, threat.x * direction.x + y * vy));
      const closest = Math.hypot(threat.x - direction.x * along, y - vy * along);
      risk += Math.max(0, Math.min(threat.distance, threatTypes[threat.kind].near) - closest) * threat.weight;
    }
    return risk;
  }

  function stepMonsterAvoidance(data, now) {
    if (!options.avoidMonsters || !battleMap) {
      stopMonsterAvoidance();
      return false;
    }
    const threats = battleMap.threats;
    const nearby = threats.find(threat => threat.distance <= threatTypes[threat.kind][monsterPlan ? 'clear' : 'near']);
    if (!nearby) {
      // 敌人标记可能短暂被角色白点盖住，继续走完当前这小段。
      const last = monsterPlan?.target;
      const obscured = last && last.distance < 155 && now - monsterPlan.seenAt < 260
        && !threats.some(threat => threat.kind === last.kind && Math.hypot(threat.x - last.x, threat.y - last.y) < 110);
      if (obscured && monsterPlan.direction && !warningOnPath(data, monsterPlan.direction, 24)) {
        drive(monsterPlan.direction);
        return true;
      }
      stopMonsterAvoidance();
      return false;
    }
    if (!monsterPlan) {
      resetEvents();
      monsterPlan = { direction: null, target: nearby, seenAt: battleMap.at, checkAt: now };
    }
    monsterPlan.target = nearby;
    monsterPlan.seenAt = battleMap.at;
    if (now >= monsterPlan.checkAt) {
      monsterPlan.checkAt = now + 85;
      let best = null, bestScore = -Infinity;
      for (const [index, direction] of directions.entries()) {
        let score = direction === monsterPlan.direction ? 17 : 0;
        const stride = 125;
        for (const threat of threats) {
          const x = threat.x - direction.x * stride, y = threat.y - direction.y * stride;
          const gain = Math.hypot(x, y / 0.85) - threat.distance;
          const significance = Math.max(0, 1 - threat.distance / (threatTypes[threat.kind].clear + 105));
          score += gain * significance * threat.weight;
        }
        score -= monsterCrossingRisk(direction, stride, threats) * 1.6;
        score -= (battleMap.blocked[index] ?? 0) * 92;
        const reach = Math.min(168, Math.max(66, stride * eventZoom));
        for (let look = 12; look <= reach; look += 12) {
          if (warningOnPath(data, direction, look)) score -= look <= 36 ? 180 : 55;
        }
        if (score <= bestScore) continue;
        best = direction;
        bestScore = score;
      }
      monsterPlan.direction = best;
    }
    drive(monsterPlan.direction);
    show(threatTypes[nearby.kind].name + ' ' + monsterPlan.direction.label);
    return true;
  }

  function eventHeading(data, target, plan, stopRadius) {
    const length = Math.hypot(target.x, target.y);
    const reach = Math.min(78, Math.max(18, target.distance - stopRadius * 0.5));
    let best = null, bestScore = 0;
    for (const direction of directions) {
      if (plan.skipped.has(direction)) continue;
      const alignment = (target.x * direction.x + target.y * direction.y) / (length * Math.hypot(direction.x, direction.y));
      if (alignment <= 0.1) continue;
      let score = alignment * 100 + (direction === plan.direction ? 10 : 0);
      if (options.avoidMonsters && battleMap?.threats.length) {
        score -= monsterCrossingRisk(direction, Math.max(95, reach / eventZoom), battleMap.threats) * 1.7;
      }
      for (let distance = 6; distance <= reach; distance += 6) {
        if (!warningOnPath(data, direction, distance)) continue;
        score -= distance <= 24 ? 120 : 24;
        if (score <= bestScore) break;
      }
      if (score <= bestScore) continue;
      bestScore = score;
      best = direction;
    }
    return best;
  }

  function petTarget(hud, width) {
    const visible = hud.pets.map(pet => {
      const x = pet.x - width / 2, y = pet.y + 80 * eventZoom - 300;
      return { x, y, distance: Math.hypot(x, y), visible: true };
    });
    if (visible.length) return visible.reduce((best, pet) => pet.distance < best.distance ? pet : best);
    if (!hud.petArrows.length) return null;

    // 等级 1 的宠物位于屏外时，游戏把箭头固定在屏幕安全区边缘，名称画在箭头的内侧。
    // 用名称的坐标反推出指向，避免把与它同屏显示的宝藏箭头当成宠物。
    let best = null, error = 32;
    const centerX = width / 2;
    for (let i = 0; i < 180; i++) {
      const angle = i * Math.PI / 90, dx = Math.cos(angle), dy = Math.sin(angle);
      const reach = Math.min((centerX - 80) / Math.max(0.001, Math.abs(dx)),
        (dy >= 0 ? 140 : 150) / Math.max(0.001, Math.abs(dy)));
      const arrowX = centerX + dx * reach;
      let arrowY = 300 + dy * reach;
      if (arrowX > width - 190 && arrowY < 240) arrowY = 240;
      const labelX = arrowX - dx * 74, labelY = arrowY - dy * 58 - 8;
      for (const arrow of hud.petArrows) {
        const distance = Math.hypot(labelX - arrow.x, labelY - arrow.y);
        if (distance >= error) continue;
        error = distance;
        best = { x: dx * 420, y: dy * 420, distance: 420, visible: false };
      }
    }
    return best;
  }

  function stepPetApproach(data, now, hud) {
    if (!options.capture || !hud || options.rate >= 100 || validNumber(hud.rate, 100)
      || (hud.ropeBadge && !(hud.ropes > 0))) {
      stopPetApproach();
      return false;
    }
    const overlay = hudObserver?.canvas;
    const target = overlay?.height ? petTarget(hud, overlay.width / overlay.height * 600) : null;
    if (!target) {
      if (petPlan?.direction && now - petPlan.seenAt <= 200
        && !warningOnPath(data, petPlan.direction, 24)) {
        drive(petPlan.direction);
        return true;
      }
      stopPetApproach();
      return false;
    }
    stopPickup();
    if (petPlan?.visible !== target.visible) {
      stopPetApproach();
      petPlan = { visible: target.visible, direction: null, seenAt: now, checkedAt: now, distance: target.distance, skipped: new Set() };
    }
    if (target.visible && now - petPlan.checkedAt >= 460) {
      if (target.distance < petPlan.distance - 12) petPlan.skipped.clear();
      else if (petPlan.direction) petPlan.skipped.add(petPlan.direction);
      else petPlan.skipped.clear();
      petPlan.checkedAt = now;
      petPlan.distance = target.distance;
    }
    petPlan.seenAt = now;
    petPlan.direction = target.distance > 30 ? eventHeading(data, target, petPlan, 30) : null;
    drive(petPlan.direction);
    show(petPlan.direction ? '追踪宠物 ' + petPlan.direction.label : '等待安全捕捉位置');
    return true;
  }

  function stepPickup(data, now, level) {
    if (!options.pickupBefore) {
      stopPickup();
      return false;
    }
    if (now < pickupBlockedUntil) return false;
    if (!Number.isInteger(level) || level >= options.pickupBefore) {
      stopPickup();
      if (Number.isInteger(level)) return false;
      show('等待读取本局等级');
      return true;
    }
    if (!battleMap) {
      stopPickup();
      show('拾取需要战斗小地图');
      return true;
    }
    let target = battleMap.pickups[0];
    if (pickupPlan) {
      const last = pickupPlan.target;
      const next = battleMap.pickups.find(drop => Math.hypot(drop.x - last.x, drop.y - last.y) < 84);
      if (next) {
        target = next;
        pickupPlan.finishAt = null;
      } else if (pickupPlan.direction) {
        // 掉落标记靠近时会被角色白点遮住，走完短距离就重新判断。
        const extra = last.distance <= 205 ? Math.min(680, Math.max(170, (last.distance - 55) * 5)) : 165;
        pickupPlan.finishAt ??= now + extra;
        const danger = [12, 24, 36, 48].some(distance => warningOnPath(data, pickupPlan.direction, distance))
          || (options.avoidMonsters && monsterCrossingRisk(pickupPlan.direction, 110, battleMap.threats) > 12);
        if (now < pickupPlan.finishAt && !danger) {
          drive(pickupPlan.direction);
          show('靠近掉落物 · 本局 ' + level + ' 级');
          return true;
        }
      }
      if (!next) stopPickup();
    }
    if (!target) return false;
    pickupPlan ??= { target, direction: null, skipped: new Set(), checkedAt: battleMap.at, distance: target.distance, finishAt: null };
    if (battleMap.at - pickupPlan.checkedAt >= 500) {
      if (target.distance <= pickupPlan.distance - 12) pickupPlan.skipped.clear();
      else if (pickupPlan.direction) pickupPlan.skipped.add(pickupPlan.direction);
      if (pickupPlan.skipped.size > 2) {
        stopPickup();
        pickupBlockedUntil = now + 800;
        return false;
      }
      pickupPlan.checkedAt = battleMap.at;
      pickupPlan.distance = target.distance;
    }
    pickupPlan.target = target;
    const heading = { x: target.x * eventZoom, y: target.y * eventZoom, distance: target.distance * eventZoom };
    pickupPlan.direction = eventHeading(data, heading, pickupPlan, 40 * eventZoom);
    drive(pickupPlan.direction);
    show(pickupPlan.direction ? '拾取掉落物 ' + pickupPlan.direction.label + ' · 本局 ' + level + ' 级' : '等待安全拾取路线');
    return true;
  }

  function stepEvent(data, now, hud) {
    const level = hud?.level;
    if (now >= nextEventScan) {
      eventList = scanEvents(now, hud);
      nextEventScan = now + eventScanInterval;
    }
    const fresh = eventList.find(event => !eventTypes[event.type].merchant || now >= retryMerchantAt);
    const tracked = eventPlan?.target;
    const mapShrineHold = tracked?.fromMap && !eventList.some(event => event.type === shrineType)
      && tracked.distance <= 77 * eventZoom && now - (eventPlan.arrivedAt ?? tracked.seenAt) < 3300;
    const keepTracking = tracked && eventPlan.arrivedAt === null && now - tracked.seenAt <= eventTrackTimeout
      && (tracked.arrow || tracked.distance > eventTypes[tracked.type].stop * eventZoom + 20);
    const target = (keepTracking || mapShrineHold) && (!fresh || tracked.type < fresh.type) ? tracked : fresh;
    if (!target) {
      stopEvent();
      if (!stepPetApproach(data, now, hud) && !stepPickup(data, now, level)) {
        const belowThreshold = options.capture && validNumber(hud?.rate, 100) && hud.rate <= options.rate;
        show(belowThreshold ? '捕捉率未达标 · ' + hud.rate + '%' : '监测红圈和事件');
      }
      return;
    }
    stopPetApproach();
    stopPickup();
    if (eventPlan?.target.type !== target.type || eventPlan.target.arrow !== target.arrow) {
      stopEvent();
      eventPlan = { target, direction: null, checkedAt: now, distance: target.distance, arrivedAt: null, skipped: new Set() };
    }
    eventPlan.target = target;
    const eventType = eventTypes[target.type];
    const stopRadius = eventType.stop * eventZoom;
    const arrivalLimit = stopRadius + (eventPlan.arrivedAt === null ? 0 : 7 * eventZoom);
    if (!target.arrow && (target.distance <= arrivalLimit || (target === tracked && mapShrineHold))) {
      releaseMovement();
      eventPlan.arrivedAt ??= now;
      show(eventType.action);
      // 石币不足时交易进度会归零，稍后再尝试。
      if (eventType.merchant && now - eventPlan.arrivedAt > 3800) {
        retryMerchantAt = now + 5000;
        stopEvent();
        show('商人稍后再试');
      }
      return;
    }
    if (eventPlan.arrivedAt !== null) {
      eventPlan.checkedAt = now;
      eventPlan.distance = target.distance;
      eventPlan.skipped.clear();
    }
    eventPlan.arrivedAt = null;
    if (target.seenAt - eventPlan.checkedAt >= 450) {
      if (target.arrow || target.distance <= eventPlan.distance - 7) eventPlan.skipped.clear();
      else if (eventPlan.direction) eventPlan.skipped.add(eventPlan.direction);
      else eventPlan.skipped.clear();
      eventPlan.checkedAt = target.seenAt;
      eventPlan.distance = target.distance;
    }
    const direction = eventHeading(data, target, eventPlan, stopRadius);
    eventPlan.direction = direction;
    drive(direction);
    show(direction ? '前往' + eventType.name + ' ' + direction.label : '暂缓接近' + eventType.name);
  }

  function stepDodge(data, now) {
    if (!dodge) {
      dodge = { direction: null, distance: Infinity, progressAt: now, checkAt: now, clear: 0, avoidUntil: new Map() };
    }
    dodge.clear = 0;
    if (now >= dodge.checkAt) {
      dodge.checkAt = now + 95;
      const routes = directions.map(direction => {
        const route = assessEscape(data, direction);
        if (options.avoidMonsters && battleMap?.threats.length) {
          const risk = monsterCrossingRisk(direction, 110, battleMap.threats);
          route.score += Math.min(52, risk * 0.5);
        }
        return route;
      });
      const current = routes.find(route => route.direction === dodge.direction);
      if (current && current.exit < dodge.distance) {
        dodge.distance = current.exit;
        dodge.progressAt = now;
      }
      const stalled = current && Number.isFinite(current.exit) && now - dodge.progressAt >= 380;
      let best = current;
      let bestScore = current ? current.score - 22 + (stalled ? 62 : 0) : Infinity;
      for (const route of routes) {
        if (route.direction === dodge.direction || (dodge.avoidUntil.get(route.direction) ?? 0) > now) continue;
        if (route.score >= bestScore) continue;
        best = route;
        bestScore = route.score;
      }
      if (best && best.direction !== dodge.direction) {
        if (stalled) dodge.avoidUntil.set(dodge.direction, now + 520);
        dodge.direction = best.direction;
        dodge.distance = best.exit;
        dodge.progressAt = now;
      }
    }
    drive(dodge.direction);
    show('闪避 ' + dodge.direction.label);
  }

  function runBattleFrame(now, hud) {
    if (!enabled || now - lastSample < sampleInterval) return;
    lastSample = now;
    if (hud?.paused) {
      resetBattleTracking();
      captureCandidate = null;
      show('游戏已暂停');
      return;
    }
    if (document.activeElement?.closest('input, textarea, select, [contenteditable="true"]')) {
      resetBattleTracking();
      show('等待游戏输入框关闭');
      return;
    }
    try {
      if (stepBattleMenu(hud, now)) return;
      if (stepLoot(hud)) {
        captureCandidate = null;
        return;
      }
      const data = readBattlePixels();
      if (!data || !hasBattleBar(data)) {
        resetBattleTracking();
        captureCandidate = null;
        show('等待战斗画面');
        return;
      }
      repeatSent = false;
      runRoute = null;
      menuAction = null;
      // 看见下一轮正常战斗后，才允许再次使用磁石。
      if (hud) magnetUsed = false;
      scanBattleMap(document.querySelector('canvas#overlay'), now, hud?.level);
      if (isDangerUnderfoot(data)) {
        captureCandidate = null;
        stopMonsterAvoidance();
        resetEvents();
        stepDodge(data, now);
      } else if (!dodge || ++dodge.clear >= 3) {
        stopDodge();
        if (stepMonsterAvoidance(data, now)) {
          captureCandidate = null;
        } else if (!stepCapture(hud, now)) stepEvent(data, now, hud);
      } else {
        drive(dodge.direction);
      }
    } catch (error) {
      enabled = false;
      resetBattleTracking();
      stopHudObserver();
      show('读取画面失败');
      console.warn('[石器幸存者助手] 无法读取战斗画布', error);
    }
  }

  function frame(now) {
    window.requestAnimationFrame(frame);
    // 前台刷新负责安装画布监听，在监听不可用时可继续识别画面。
    if (enabled && !watchGameCanvas() && !document.hidden) runBattleFrame(now, null);
  }

  function toggle() {
    enabled = !enabled;
    resetBattleTracking();
    captureCandidate = null;
    resultSince = null;
    menuAction = null;
    if (enabled) watchGameCanvas();
    else stopHudObserver();
    show(enabled ? '等待战斗画面' : '已暂停');
  }

  button.addEventListener('click', toggle);
  window.addEventListener('keydown', event => {
    if (!event.isTrusted) return;
    if (event.key === 'F8' && !event.repeat) {
      event.preventDefault();
      toggle();
    }
  }, true);
  function leavePage() {
    resetBattleTracking();
    stopHudObserver();
    captureCandidate = null;
    resultSince = null;
  }
  // 原游戏失焦时会清空按键，下一帧根据新画面重新发送按下状态。
  window.addEventListener('blur', releaseMovement);
  window.addEventListener('pagehide', leavePage);
  document.addEventListener('visibilitychange', () => {
    if (!enabled) return;
    resetBattleTracking();
    captureCandidate = null;
    lastSample = -Infinity;
    show(document.hidden ? '等待后台战斗画面' : '等待战斗画面');
  });

  show('已暂停');
  window.requestAnimationFrame(frame);
})();
