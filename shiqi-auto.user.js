// ==UserScript==
// @name         石器倖存者自動躲避
// @name:zh-CN   石器幸存者助手
// @namespace    sa-survivors-local-helper
// @version      0.5.0
// @description  副本内自动闪避、处理事件，支持收尾磁石、按成功率捕捉和重复战斗。
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
  const sampleInterval = 55;
  const maxDodgeTime = 1100;
  const directionRetryTime = 260;
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
  const eventScanInterval = 160;
  const eventStopRadius = 32;
  // 事件按此顺序处理。地面标记和场外指示箭头分别使用游戏原有的配色。
  const eventTypes = [
    { name: '挑衅战旗', action: '正在踩战旗', ring: [255, 90, 74] },
    { name: '受伤的小宠物', action: '正在守护小宠物', ring: [143, 255, 160] },
    { name: '流浪商人', action: '等待商人交易', ring: [255, 212, 92], arrow: [255, 211, 107] },
    { name: '赌博石像', action: '等待石像触发', ring: [255, 154, 213], dashed: true },
  ];
  const ringAngles = Array.from({ length: 24 }, (_, i) => {
    const angle = i * Math.PI / 12;
    return [Math.cos(angle), Math.sin(angle)];
  });

  const settingsKey = 'sa-survivors-local-helper.settings';
  const slotKeys = ['z', 'x', 'c'];
  const options = { magnet: false, magnetSlot: '', capture: false, rate: 60, repeat: false };
  let position = { x: 12, y: 86 };
  function validRate(value) {
    return Number.isInteger(value) && value >= 0 && value <= 100;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey) || '{}');
    for (const name of ['magnet', 'capture', 'repeat']) options[name] = saved?.[name] === true;
    if (slotKeys.includes(saved?.magnetSlot)) options.magnetSlot = saved.magnetSlot;
    if (validRate(saved?.rate)) options.rate = saved.rate;
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
        <label class="row" for="magnet"><span>打完首领后使用磁石</span><input class="switch" id="magnet" type="checkbox"></label>
        <label class="row subrow" id="magnet-details" for="magnetSlot">
          <span>磁石所在快捷栏</span>
          <select class="control" id="magnetSlot">
            <option value="">请选择</option><option value="z">Z</option><option value="x">X</option><option value="c">C</option>
          </select>
        </label>
      </div>
      <div class="section">
        <label class="row" for="capture"><span>自动捕捉宠物</span><input class="switch" id="capture" type="checkbox"></label>
        <label class="row subrow" id="capture-details" for="rate">
          <span>捕捉率高于此数值才捕捉</span>
          <span class="unit"><input class="control" id="rate" type="number" min="0" max="100" step="1">%</span>
        </label>
      </div>
      <div class="section">
        <label class="row" for="repeat"><span>结算后再来一局</span><input class="switch" id="repeat" type="checkbox"></label>
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
  }

  for (const field of ['magnet', 'magnetSlot', 'capture', 'rate', 'repeat']) {
    const input = shadow.getElementById(field);
    if (input.type === 'checkbox') input.checked = options[field];
    else input.value = options[field];
    input.addEventListener('change', () => {
      if (input.type === 'checkbox') options[field] = input.checked;
      else if (field === 'rate') {
        if (validRate(input.valueAsNumber)) options.rate = input.valueAsNumber;
        input.value = String(options.rate);
      } else options[field] = input.value;
      refreshSettings();
      persistOptions();
    });
  }
  refreshSettings();
  document.body.append(panel);
  placePanel(position.x, position.y);
  window.addEventListener('resize', () => placePanel(position.x, position.y));
  for (const type of ['keydown', 'keyup', 'pointerdown', 'click']) {
    panel.addEventListener(type, event => event.stopPropagation());
  }
  shadow.querySelector('#rate').addEventListener('keydown', event => {
    if (event.key === 'Enter') event.currentTarget.blur();
  });

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

  function observeHudText(hud, canvas, gameContext, text, x, y) {
    if (text === '結算' || text === '結算 Enter') {
      if (y >= 65 && y <= 92) hud.loot = true;
    } else if (text === '再來一局' && y >= 537 && y <= 546) {
      hud.repeat = /^(#fff|#ffffff)$/.test(gameContext.fillStyle);
    } else if (text === '回到村莊' && y >= 537 && y <= 546) {
      hud.result = true;
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

  function readHud(now) {
    if (!options.magnet && !options.capture && !options.repeat) {
      stopHudObserver();
      return null;
    }
    const canvas = document.querySelector('canvas#overlay');
    if (hudObserver?.canvas !== canvas) stopHudObserver();
    if (!canvas) return null;
    if (!hudObserver) {
      const gameContext = canvas.getContext('2d');
      if (!gameContext) return null;
      const original = Object.fromEntries(['fillText', 'clearRect'].map(key => [key, Object.getOwnPropertyDescriptor(gameContext, key)]));
      const drawText = gameContext.fillText, clear = gameContext.clearRect;
      let hud = null;
      // 读取本帧的游戏界面文字，绘图仍交给原有的 Canvas 方法。
      const fillText = function (text, x, y) {
        const result = drawText.apply(this, arguments);
        if (hud && typeof text === 'string' && text.length <= 32) {
          try { observeHudText(hud, canvas, this, text.trim(), x, y); } catch { hud = null; }
        }
        return result;
      };
      const clearRect = function (x, y, width, height) {
        const result = clear.apply(this, arguments);
        if (x === 0 && y === 0 && width >= canvas.width && height >= canvas.height) {
          hud = { at: performance.now(), stock: [] };
        }
        return result;
      };
      hudObserver = { canvas, context: gameContext, original, fillText, clearRect, latest: () => hud };
      try {
        gameContext.fillText = fillText;
        gameContext.clearRect = clearRect;
      } catch {
        stopHudObserver();
        return null;
      }
    }
    const hud = hudObserver.latest();
    return hud && now - hud.at <= 220 ? hud : null;
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
    for (let y = -4; y <= 4; y += 4) {
      for (let x = -4; x <= 4; x += 4) {
        if (warningTint(data, x, y)) centerHits++;
      }
    }
    // 骷髅图标可能遮住圆心，同时采样周围地面，排除零散的红色数字。
    for (let i = 0; i < 12; i++) {
      const angle = i * Math.PI / 6;
      if (warningTint(data, Math.cos(angle) * 14, Math.sin(angle) * 14)) ringHits++;
    }
    return (centerHits >= 3 && ringHits >= 4) || ringHits >= 9;
  }

  function exitDistance(data, direction) {
    let clear = 0;
    for (let distance = 12; distance <= 180; distance += 6) {
      const x = direction.x * distance, y = direction.y * distance;
      const sideX = -direction.y * 5, sideY = direction.x * 5;
      const red = warningTint(data, x, y) || warningTint(data, x + sideX, y + sideY)
        || warningTint(data, x - sideX, y - sideY);
      // 连续四个点无红色才算离开，防止把圈内图标和细小缺口识别成出口。
      clear = red ? 0 : clear + 1;
      if (clear === 4) return distance;
    }
    return Infinity;
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

  function markerScore(mask, width, height, kind, x, y, rx, ry) {
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
    return [7, 11, 13, 14, 15].includes(sectors) ? hits : 0;
  }

  function findGroundMarkers(mask, width, height) {
    // 由颜色匹配的像素找候选位置，再确认是否存在对应的椭圆轮廓。
    const rx = 30, ry = 22.5, bin = 2;
    const gridWidth = Math.ceil(width / bin), gridHeight = Math.ceil(height / bin);
    const votes = eventTypes.map(() => new Uint16Array(gridWidth * gridHeight));
    const offsets = ringAngles.map(([x, y]) => [Math.round(x * rx), Math.round(y * ry)]);
    for (let point = 0; point < mask.length; point++) {
      if (!mask[point]) continue;
      const x = point % width, y = Math.floor(point / width), bucket = votes[mask[point] - 1];
      for (const [dx, dy] of offsets) {
        const bx = Math.floor((x - dx) / bin), by = Math.floor((y - dy) / bin);
        if (bx >= 0 && bx < gridWidth && by >= 0 && by < gridHeight) bucket[by * gridWidth + bx]++;
      }
    }
    return votes.map((bucket, type) => {
      const peaks = [];
      for (let point = 0; point < bucket.length; point++) {
        if (bucket[point] >= (eventTypes[type].dashed ? 5 : 8)) peaks.push(point);
      }
      peaks.sort((a, b) => bucket[b] - bucket[a]);
      let best = null, bestScore = eventTypes[type].dashed ? 9 : 15;
      for (const point of peaks.slice(0, 24)) {
        const x = point % gridWidth * bin, y = Math.floor(point / gridWidth) * bin;
        for (let oy = -1; oy <= bin; oy++) {
          for (let ox = -1; ox <= bin; ox++) {
            const score = markerScore(mask, width, height, type + 1, x + ox, y + oy, rx, ry);
            if (score < bestScore || (best && score === bestScore)) continue;
            best = { x: x + ox, y: y + oy, arrow: false };
            bestScore = score;
          }
        }
        if (bestScore === ringAngles.length) break;
      }
      return best;
    });
  }

  function findEventArrows(mask, width, height, markers) {
    const candidates = [];
    // 游戏将场外事件箭头放在左右 50 或上下 80 单位的边界上。
    for (let x = 25; x <= width - 25; x += 2) candidates.push([x, 40], [x, height - 40]);
    for (let y = 40; y <= height - 40; y += 2) candidates.push([25, y], [width - 25, y]);
    return markers.map((marker, type) => {
      if (marker) return marker;
      let best = null, bestScore = 16;
      for (const [x, y] of candidates) {
        const score = markerScore(mask, width, height, type + 1, x, y, 10.35, 10.35);
        if (score < bestScore || (best && score === bestScore)) continue;
        best = { x, y, arrow: true };
        bestScore = score;
      }
      return best;
    });
  }

  function scanEvents() {
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
      if (!mark) return [];
      const x = (mark.x - width / 2 + 0.5) * 2, y = (mark.y - height / 2 + 0.5) * 2;
      return [{ type, x, y, arrow: mark.arrow, distance: Math.hypot(x, y / 0.75) }];
    });
  }

  let enabled = false, dodge = null, heldKeys = [], releaseTimer = null, lastSample = -Infinity;
  let lastStatus = '';
  let eventPlan = null, eventTimer = null, eventList = [], nextEventScan = 0, retryMerchantAt = 0;
  let magnetUsed = false, captureCandidate = null, nextCaptureAt = 0;
  let resultSince = null, repeatSent = false;

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

  function stopDodge() {
    if (dodge) move([]);
    if (releaseTimer !== null) window.clearTimeout(releaseTimer);
    releaseTimer = null;
    dodge = null;
  }

  function stopEvent() {
    if (eventPlan) move([]);
    if (eventTimer !== null) window.clearTimeout(eventTimer);
    eventTimer = null;
    eventPlan = null;
  }

  function resetEvents() {
    stopEvent();
    eventList = [];
    nextEventScan = 0;
  }

  function stepLoot(hud) {
    if (!hud?.loot) return false;
    stopDodge();
    resetEvents();
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
    if (!validRate(rate) || rate <= options.rate || (hud.ropeBadge && !(hud.ropes > 0)) || now < nextCaptureAt) {
      captureCandidate = null;
      return false;
    }
    if (captureCandidate?.rate !== rate) {
      captureCandidate = { rate, at: hud.at };
      return false;
    }
    if (hud.at === captureCandidate.at) return false;
    captureCandidate = null;
    resetEvents();
    nextCaptureAt = now + 1600;
    tap(' ');
    show('自动捕捉 · ' + rate + '%');
    return true;
  }

  function stepRepeat(hud, now) {
    if (!options.repeat || !hud?.result || !hud.repeat) {
      resultSince = null;
      return false;
    }
    stopDodge();
    resetEvents();
    resultSince ??= now;
    if (!repeatSent && now - resultSince >= 900) {
      repeatSent = true;
      tap('Enter');
    }
    show(repeatSent ? '已请求再来一局' : '等待再来一局');
    return true;
  }

  function eventHeading(data, target, skipped) {
    const length = Math.hypot(target.x, target.y);
    let best = null, bestAlignment = 0.1;
    for (const direction of directions) {
      if (skipped.has(direction)) continue;
      const alignment = (target.x * direction.x + target.y * direction.y) / (length * Math.hypot(direction.x, direction.y));
      if (alignment <= bestAlignment) continue;
      const reach = Math.min(36, Math.max(12, length - 20));
      const redAhead = [0.4, 0.7, 1].some(fraction => warningTint(data, direction.x * reach * fraction, direction.y * reach * fraction));
      if (redAhead) continue;
      bestAlignment = alignment;
      best = direction;
    }
    return best;
  }

  function stepEvent(data, now) {
    if (now >= nextEventScan) {
      eventList = scanEvents();
      nextEventScan = now + eventScanInterval;
    }
    const target = eventList.find(event => event.type !== 2 || now >= retryMerchantAt);
    if (!target) {
      stopEvent();
      show('监测红圈和事件');
      return;
    }
    if (eventPlan?.type !== target.type) {
      stopEvent();
      eventPlan = { type: target.type, direction: null, checkedAt: now, distance: target.distance, arrivedAt: null, skipped: new Set() };
    }
    const eventType = eventTypes[target.type];
    if (!target.arrow && target.distance < eventStopRadius) {
      move([]);
      eventPlan.arrivedAt ??= now;
      show(eventType.action);
      // 石币不足时交易进度会归零，稍后再尝试。
      if (target.type === 2 && now - eventPlan.arrivedAt > 3800) {
        retryMerchantAt = now + 5000;
        stopEvent();
        show('商人稍后再试');
      }
      return;
    }
    eventPlan.arrivedAt = null;
    if (now - eventPlan.checkedAt >= 540) {
      if (target.arrow || target.distance <= eventPlan.distance - 7) eventPlan.skipped.clear();
      else if (eventPlan.direction) eventPlan.skipped.add(eventPlan.direction);
      else eventPlan.skipped.clear();
      eventPlan.checkedAt = now;
      eventPlan.distance = target.distance;
    }
    const direction = eventHeading(data, target, eventPlan.skipped);
    eventPlan.direction = direction;
    move(direction?.keys || []);
    if (eventTimer !== null) window.clearTimeout(eventTimer);
    eventTimer = direction ? window.setTimeout(() => { eventTimer = null; move([]); }, 220) : null;
    show(direction ? '前往' + eventType.name + ' ' + direction.label : '暂缓接近' + eventType.name);
  }

  function stepDodge(data, now) {
    if (!dodge) {
      dodge = { direction: null, tried: new Set(), distance: Infinity, checkAt: now, clear: 0 };
      const current = dodge;
      // 即使渲染循环卡住，移动键也会释放。
      releaseTimer = window.setTimeout(() => {
        if (dodge !== current) return;
        releaseTimer = null;
        move([]);
        dodge = null;
      }, maxDodgeTime);
    }
    dodge.clear = 0;
    if (dodge.direction && now >= dodge.checkAt) {
      const distance = exitDistance(data, dodge.direction);
      if (distance < dodge.distance - 6) {
        dodge.distance = distance;
        dodge.checkAt = now + directionRetryTime;
      } else {
        dodge.tried.add(dodge.direction);
        dodge.direction = null;
      }
    }
    if (!dodge.direction) {
      let distance = Infinity;
      let fallback = null, fallbackRisk = Infinity;
      for (const direction of directions) {
        if (dodge.tried.has(direction)) continue;
        const candidate = exitDistance(data, direction);
        if (!Number.isFinite(candidate)) {
          let risk = 0;
          for (let reach = 24; reach <= 180; reach += 12) {
            if (warningTint(data, direction.x * reach, direction.y * reach)) risk++;
          }
          if (risk < fallbackRisk) {
            fallback = direction;
            fallbackRisk = risk;
          }
        }
        if (candidate >= distance) continue;
        dodge.direction = direction;
        distance = candidate;
      }
      dodge.direction ??= fallback;
      dodge.distance = distance;
      dodge.checkAt = now + directionRetryTime;
    }
    if (dodge.direction) {
      move(dodge.direction.keys);
      show('闪避 ' + dodge.direction.label);
    } else {
      move([]);
      show('重新判断闪避方向');
    }
  }

  function frame(now) {
    window.requestAnimationFrame(frame);
    if (!enabled || now - lastSample < sampleInterval || document.hidden || !document.hasFocus()) return;
    lastSample = now;
    if (document.activeElement?.closest('input, textarea, select, [contenteditable="true"]')) {
      stopDodge();
      resetEvents();
      show('等待游戏输入框关闭');
      return;
    }
    try {
      const hud = readHud(now);
      if (stepRepeat(hud, now)) return;
      if (stepLoot(hud)) {
        captureCandidate = null;
        return;
      }
      const data = readBattlePixels();
      if (!data || !hasBattleBar(data)) {
        stopDodge();
        resetEvents();
        captureCandidate = null;
        show('等待战斗画面');
        return;
      }
      repeatSent = false;
      // 看见下一轮正常战斗后，才允许再次使用磁石。
      if (hud) magnetUsed = false;
      if (isDangerUnderfoot(data)) {
        captureCandidate = null;
        resetEvents();
        stepDodge(data, now);
      } else if (!dodge || ++dodge.clear >= 2) {
        stopDodge();
        if (!stepCapture(hud, now)) stepEvent(data, now);
      }
    } catch (error) {
      enabled = false;
      stopDodge();
      resetEvents();
      stopHudObserver();
      show('读取画面失败');
      console.warn('[石器幸存者助手] 无法读取战斗画布', error);
    }
  }

  function toggle() {
    enabled = !enabled;
    stopDodge();
    resetEvents();
    captureCandidate = null;
    resultSince = null;
    if (!enabled) stopHudObserver();
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
    stopDodge();
    resetEvents();
    stopHudObserver();
    captureCandidate = null;
    resultSince = null;
  }
  window.addEventListener('blur', leavePage);
  window.addEventListener('pagehide', leavePage);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) leavePage();
  });

  show('已暂停');
  window.requestAnimationFrame(frame);
})();
