/**
 * dsh-pet-android —— 悬浮窗里的宠物渲染端（纯 DOM，无框架、无打包）。
 *
 * 这是上游「桌面显示」分支的等价物：
 *   Electron 里「一个透明 BrowserWindow + 渲染端自己摆位置」，
 *   在 Android 上换成「宿主的一个透明悬浮窗 + 本页自己摆位置」。
 * 行为口径刻意与上游对齐：size=462 为基准宽、窗口高 = 宽 × 9/16、position.corner/marginX/marginY
 * 定角落、动画池 idle/turn/moves/clicks/categories 同名同义、素材走上游 /thumb 路由。
 *
 * 两件事**不在这里做**：
 *   · 权限：一律不检测不引导，宿主没给权限就是宿主不建窗；
 *   · 配置合并：直接读上游 /dsh-pet-7340/config 的成品，不复制上游的合并逻辑。
 *
 * 位置通道优先级：
 *   1) window.DshOverlayHost.moveTo(x, y)  —— 宿主注入的 JS 桥（同步、丝滑）
 *   2) POST /dsh-pet-android/pointer       —— 文件通道回退（宿主轮询，约 100ms 粒度）
 *   3) preview=1                            —— 普通浏览器验收：宠物在页面内用 transform 摆位
 */
(() => {
  'use strict';

  const ROUTE = '/dsh-pet-android';
  const PET_ROUTE = '/dsh-pet-7340';
  const SIZE_BASE = 462; // 上游基准宽：所有位移/字号都按 size/462 等比缩放

  const q = new URLSearchParams(location.search);
  const wantPet = q.get('pet') || 'auto';
  const preview = q.get('preview') === '1';
  const bridge = window.DshOverlayHost || null;

  const $ = (id) => document.getElementById(id);
  const petEl = $('pet');
  const bubbleEl = $('bubble');
  const bubbleText = $('bubble-text');
  const hintEl = $('hint');
  const va = $('va');
  const vb = $('vb');

  if (preview) document.body.classList.add('preview');

  const state = {
    screen: { w: 0, h: 0, top: 0, bottom: 0 },
    box: { w: 0, h: 0, bodyH: 0 },
    pos: { x: 0, y: 0 },
    vel: { x: 0, y: 0 },
    facing: 1,
    dragging: null,
    busy: false,
    petId: null,
    entry: null,
    pet: null,
    anims: null,
    physics: { gravity: 1400, restitution: 0.78, groundFriction: 2.5, throwPower: 1 },
  };

  // ---------- 小工具 ----------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => (Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null);

  function postJson(path, body) {
    return fetch(ROUTE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => null);
  }

  function hint(text) {
    hintEl.textContent = text;
    hintEl.hidden = !text;
  }

  // ---------- 位置：桥 → 文件 → preview ----------
  let fallbackTimer = 0;
  function queueFallback() {
    if (fallbackTimer) return;
    // 120ms：宿主按 syncMs 轮询文件，再快也只是白写盘
    fallbackTimer = setTimeout(() => {
      fallbackTimer = 0;
      postJson('/pointer', { win: wantPet, x: Math.round(state.pos.x), y: Math.round(state.pos.y), w: state.box.w, h: state.box.h });
    }, 120);
  }

  function place(x, y) {
    const { w, h } = state.box;
    x = clamp(x, 0, Math.max(0, state.screen.w - w));
    y = clamp(y, state.screen.top, Math.max(state.screen.top, state.screen.h - state.screen.bottom - h));
    state.pos.x = x;
    state.pos.y = y;
    if (preview) {
      petEl.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
      return;
    }
    if (bridge && typeof bridge.moveTo === 'function') bridge.moveTo(Math.round(x), Math.round(y));
    else queueFallback();
  }

  // ---------- 配置 ----------
  async function fetchUpstreamConfig() {
    const res = await fetch(PET_ROUTE + '/config', { cache: 'no-store' });
    if (!res.ok) throw new Error(`上游 /dsh-pet-7340/config 返回 HTTP ${res.status}`);
    return res.json();
  }

  /** 把上游的成品聚合拍平成 [{entryKey, entry, pet}] —— 只在聚合外层不同，宠物字段完全一致 */
  function flatten(agg) {
    const out = [];
    for (const [entryKey, entry] of Object.entries(agg || {})) {
      if (!entry || !Array.isArray(entry.pets)) continue;
      for (const pet of entry.pets) out.push({ entryKey, entry, pet });
    }
    return out;
  }

  const DEFAULT_ANIMS = {
    idle: ['待机呼吸休闲'],
    turn: ['东张西望'],
    drag: ['被鼠标拖拽悬空反馈'],
    clicks: ['点击回应-元气挥手'],
    moves: { default: { minDist: 60, maxDist: 240, margin: 20, leadSec: 2, tailSec: 2 }, actions: [{ name: '原地漂浮踏步' }] },
    categories: [],
  };

  function resolvePet(flat) {
    if (wantPet !== 'auto') {
      const hit = flat.find((x) => String(x.pet.id) === wantPet);
      if (hit) return hit;
    }
    // 只有 display 含 desktop/both 的宠物才归"桌面（Android 上层）"这一端显示 —— 与上游 isDesktopVisible 同义
    return flat.find((x) => ['desktop', 'both'].includes(String(x.pet.display ?? 'both'))) || null;
  }

  // ---------- 素材与动画 ----------
  const blobCache = new Map();
  async function blobFor(name) {
    if (blobCache.has(name)) return blobCache.get(name);
    const assetRoot = state.pet?.assetRoot ?? state.pet?.id ?? 'main';
    const url = `${PET_ROUTE}/thumb/${encodeURIComponent(assetRoot)}/${encodeURIComponent(name)}.webm`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000); // 上游同款 10s 超时：慢网络下宁可跳过动画也不要挂死
    try {
      const res = await fetch(url, { signal: ac.signal });
      if (!res.ok) throw new Error(`素材 ${name} HTTP ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      // 小缓存：一个素材 0.3~0.9MB，留 8 个足够覆盖常用池，避免无限涨
      if (blobCache.size > 8) {
        const [oldKey, oldUrl] = blobCache.entries().next().value;
        blobCache.delete(oldKey);
        URL.revokeObjectURL(oldUrl);
      }
      blobCache.set(name, objectUrl);
      return objectUrl;
    } finally {
      clearTimeout(timer);
    }
  }

  let front = 0; // 0 = A 在前
  let onEndedCb = null;

  function bindEnded(el) {
    el.addEventListener('ended', () => {
      if (el.classList.contains('on') && onEndedCb) onEndedCb();
    });
  }
  bindEnded(va);
  bindEnded(vb);

  async function play(name, opts = {}) {
    if (!name) return false;
    let url;
    try {
      url = await blobFor(name);
    } catch (e) {
      console.warn('[dsh-pet-android] 动画加载失败', name, e);
      return false;
    }
    const incoming = front === 0 ? vb : va;
    const outgoing = front === 0 ? va : vb;
    onEndedCb = opts.once ? opts.onEnded || null : null;
    incoming.classList.toggle('mirror', opts.mirror === true);
    incoming.loop = opts.once !== true;
    incoming.muted = true;
    incoming.src = url;
    try {
      incoming.currentTime = 0;
      await incoming.play();
    } catch {
      /* 自动播放被拦（理论不会：muted + autoplay）；保持旧视频可见 */
      return false;
    }
    incoming.classList.add('on');
    outgoing.classList.remove('on');
    front = 1 - front;
    return true;
  }

  // ---------- 行为链（对应上游的随机动画链：待机 / 随机动作 / 转向 / 移动） ----------
  let chainTimer = 0;
  function schedule(delay) {
    clearTimeout(chainTimer);
    chainTimer = setTimeout(nextAct, delay ?? rand(1500, 3600));
  }

  function animsPool(key) {
    const a = state.anims || {};
    return Array.isArray(a[key]) && a[key].length ? a[key] : DEFAULT_ANIMS[key] || [];
  }

  async function idle() {
    state.busy = false;
    const name = pick(animsPool('idle'));
    await play(name, { mirror: state.facing < 0 });
    schedule(rand(4000, 9000));
  }

  async function doCategory() {
    const cats = Array.isArray(state.anims?.categories) ? state.anims.categories : [];
    const usable = cats.filter((c) => Array.isArray(c.actions) && c.actions.length && !(c.noMirror && state.facing < 0));
    if (!usable.length) return idle();
    const total = usable.reduce((s, c) => s + (Number(c.weight) || 1), 0);
    let r = Math.random() * total;
    let cat = usable[0];
    for (const c of usable) {
      r -= Number(c.weight) || 1;
      if (r <= 0) {
        cat = c;
        break;
      }
    }
    const name = pick(cat.actions);
    state.busy = true;
    const ok = await play(name, {
      once: true,
      mirror: state.facing < 0,
      onEnded: () => {
        state.busy = false;
        idle();
      },
    });
    if (!ok) return idle();
  }

  async function turn() {
    const name = pick(animsPool('turn'));
    state.busy = true;
    // 上游语义：转向类动画播完后翻转朝向
    const ok = await play(name, {
      once: true,
      onEnded: () => {
        state.facing = -state.facing;
        state.busy = false;
        idle();
      },
    });
    if (!ok) return idle();
  }

  function animateX(fromX, toX, durationMs) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const step = (now) => {
        const k = clamp((now - t0) / durationMs, 0, 1);
        // easeInOutQuad：起步收尾都软，和上游 move 的观感一致
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        place(fromX + (toX - fromX) * e, state.pos.y);
        if (k < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  async function doMove() {
    const moves = state.anims?.moves || DEFAULT_ANIMS.moves;
    const def = moves.default || DEFAULT_ANIMS.moves.default;
    const actions = Array.isArray(moves.actions) && moves.actions.length ? moves.actions : DEFAULT_ANIMS.moves.actions;
    const act = pick(actions);
    const params = { ...def, ...(act.params || {}) };
    const scale = (state.pet?.size || SIZE_BASE) / SIZE_BASE;
    const dist = rand(Number(params.minDist) || 60, Number(params.maxDist) || 240) * scale;
    const dir = Math.random() < 0.5 ? -1 : 1;
    state.facing = dir > 0 ? 1 : -1;
    const from = state.pos.x;
    const to = clamp(from + dist * dir, 0, Math.max(0, state.screen.w - state.box.w));
    const lead = (Number(params.leadSec) || 0) * 1000;
    const tail = (Number(params.tailSec) || 0) * 1000;
    state.busy = true;
    const ok = await play(act.name, {
      once: true,
      mirror: state.facing < 0,
      onEnded: () => {
        state.busy = false;
        idle();
      },
    });
    if (!ok) return idle();
    // 视频真实时长拿不到也没关系：位移按 lead/tail 之外的固定窗口推进，观感差别很小
    const duration = Math.max(600, 2400 - lead - tail);
    setTimeout(() => {
      animateX(from, to, duration).then(() => {
        schedule(600);
      });
    }, lead);
  }

  function nextAct() {
    if (state.dragging || state.busy) return schedule(800);
    const r = Math.random();
    if (r < 0.55) return void idle();
    if (r < 0.78) return void doCategory();
    if (r < 0.9) return void turn();
    return void doMove();
  }

  // ---------- 拖拽 + 抛掷 ----------
  async function playDrag() {
    const name = pick(animsPool('drag'));
    await play(name, { mirror: state.facing < 0 });
  }

  function onDown(e) {
    if (!e.isPrimary || state.dragging) return;
    state.dragging = {
      sx: e.screenX,
      sy: e.screenY,
      wx: state.pos.x,
      wy: state.pos.y,
      lx: e.screenX,
      ly: e.screenY,
      lt: performance.now(),
      vx: 0,
      vy: 0,
      moved: false,
      id: e.pointerId,
    };
    try {
      petEl.setPointerCapture(e.pointerId);
    } catch {
      /* 老内核没有指针捕获也无妨 */
    }
    clearTimeout(chainTimer);
    playDrag();
  }

  function onMove(e) {
    const d = state.dragging;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.screenX - d.sx;
    const dy = e.screenY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 6) d.moved = true;
    const now = performance.now();
    const dt = Math.max(1, now - d.lt);
    // 速度取最近一段位移（px/s），松手后直接当抛掷初速
    d.vx = ((e.screenX - d.lx) / dt) * 1000;
    d.vy = ((e.screenY - d.ly) / dt) * 1000;
    d.lx = e.screenX;
    d.ly = e.screenY;
    d.lt = now;
    place(d.wx + dx, d.wy + dy);
  }

  function onUp(e) {
    const d = state.dragging;
    if (!d || e.pointerId !== d.id) return;
    state.dragging = null;
    if (!d.moved) {
      // 轻点 = 点击回应（上游 clicks 池）
      state.busy = true;
      play(pick(animsPool('clicks')), {
        once: true,
        mirror: state.facing < 0,
        onEnded: () => {
          state.busy = false;
          idle();
        },
      }).then((ok) => {
        if (!ok) idle();
      });
      return;
    }
    const power = state.physics.throwPower ?? 1;
    state.vel.x = clamp(d.vx * power, -4000, 4000);
    state.vel.y = clamp(d.vy * power, -4000, 4000);
    physics();
  }

  function physics() {
    state.busy = true;
    let last = performance.now();
    let raf = 0;
    const { gravity, restitution, groundFriction } = state.physics;
    const step = (now) => {
      const dt = Math.min(0.045, (now - last) / 1000);
      last = now;
      const floor = state.screen.h - state.screen.bottom - state.box.h;
      state.vel.y += (Number(gravity) || 1400) * dt;
      let nx = state.pos.x + state.vel.x * dt;
      let ny = state.pos.y + state.vel.y * dt;
      if (nx <= 0) {
        nx = 0;
        state.vel.x = -state.vel.x * (Number(restitution) || 0.78);
      } else if (nx >= state.screen.w - state.box.w) {
        nx = Math.max(0, state.screen.w - state.box.w);
        state.vel.x = -state.vel.x * (Number(restitution) || 0.78);
      }
      if (ny <= state.screen.top) {
        ny = state.screen.top;
        state.vel.y = -state.vel.y * (Number(restitution) || 0.78);
      } else if (ny >= floor) {
        ny = floor;
        state.vel.y = -state.vel.y * (Number(restitution) || 0.78);
        // 落地摩擦：按 groundFriction（1/s）指数衰减水平速度
        state.vel.x *= Math.max(0, 1 - (Number(groundFriction) || 2.5) * dt);
      }
      place(nx, ny);
      const settled =
        ny >= floor - 0.5 && Math.abs(state.vel.y) < 40 && Math.abs(state.vel.x) < 26;
      if (settled) {
        state.busy = false;
        idle();
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    // 页面被宿主销毁/隐藏时清掉回调，别在后台空转
    window.addEventListener(
      'pagehide',
      () => {
        cancelAnimationFrame(raf);
      },
      { once: true },
    );
  }

  petEl.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);

  // ---------- 气泡（读上游 S 的 pets.<id>.say） ----------
  let bubbleTimer = 0;
  function say(text) {
    if (!text) return;
    bubbleText.textContent = text;
    bubbleEl.hidden = false;
    requestAnimationFrame(() => bubbleEl.classList.add('on'));
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => {
      bubbleEl.classList.remove('on');
      setTimeout(() => {
        bubbleEl.hidden = true;
      }, 200);
    }, 6000);
  }

  // ---------- 与上游同步：配置版本 / 气泡 / 点播动画 ----------
  let lastSay = -1;
  let lastAnim = -1;
  let cfgVersion = null;
  let upstreamOk = null;

  function reportUpstream(ok, error) {
    if (ok === upstreamOk && !error) return;
    upstreamOk = ok;
    postJson('/report', { upstreamOk: ok, error: error || null });
  }

  async function pollUpstream() {
    try {
      const res = await fetch(PET_ROUTE + '/state', { cache: 'no-store' });
      if (!res.ok) throw new Error(`上游 /state HTTP ${res.status}`);
      const s = await res.json();
      reportUpstream(true);
      const mine = state.petId ? s.pets?.[state.petId] : null;
      if (mine?.say && mine.say.counter !== lastSay) {
        lastSay = mine.say.counter;
        const text = mine.say.data && typeof mine.say.data.text === 'string' ? mine.say.data.text : '';
        if (text) say(text);
      }
      if (mine?.anim && mine.anim.counter !== lastAnim) {
        lastAnim = mine.anim.counter;
        if (typeof mine.anim.data === 'string') {
          state.busy = true;
          play(mine.anim.data, {
            once: true,
            mirror: state.facing < 0,
            onEnded: () => {
              state.busy = false;
              idle();
            },
          });
        }
      }
      if (s.configVersion !== undefined && cfgVersion !== null && s.configVersion !== cfgVersion) {
        cfgVersion = s.configVersion;
        await reload(); // 用户改了配置（大小/位置/素材）：就地重排，不刷新页面
      }
      if (cfgVersion === null && s.configVersion !== undefined) cfgVersion = s.configVersion;
    } catch (e) {
      reportUpstream(false, e instanceof Error ? e.message : String(e));
      hint('未连上 dsh-pet：请先安装并启用上游 dsh-pet 插件（本插件只负责 Android 上层窗口）');
    }
  }

  // ---------- 启动 ----------
  function pickScreen(status) {
    const fromBridge = bridge && typeof bridge.screenSize === 'function' ? bridge.screenSize() : null;
    if (fromBridge && Number.isFinite(fromBridge.w) && Number.isFinite(fromBridge.h) && fromBridge.w > 0) {
      return { w: fromBridge.w, h: fromBridge.h, top: Number(fromBridge.top) || 0, bottom: Number(fromBridge.bottom) || 0 };
    }
    const fromHost = status?.host?.screen;
    if (fromHost && Number.isFinite(fromHost.w) && Number.isFinite(fromHost.h) && fromHost.w > 0) {
      return { w: fromHost.w, h: fromHost.h, top: Number(fromHost.top) || 0, bottom: Number(fromHost.bottom) || 0 };
    }
    // preview：整页就是"屏幕"
    return { w: window.innerWidth, h: window.innerHeight, top: 0, bottom: 0 };
  }

  function applyBox(size) {
    const w = Math.round(size);
    const bodyH = Math.round((size * 9) / 16);
    const bubbleSpace = Math.round(size * 0.36);
    state.box = { w, h: bodyH + bubbleSpace, bodyH };
    petEl.style.width = w + 'px';
    petEl.style.height = state.box.h + 'px';
    petEl.style.setProperty('--pet-body-h', bodyH + 'px');
    if (!preview && bridge && typeof bridge.resize === 'function') bridge.resize(w, state.box.h);
  }

  function cornerPosition() {
    const p = state.pet?.position || {};
    const corner = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(p.corner) ? p.corner : 'top-right';
    const mx = Number.isFinite(p.marginX) ? p.marginX : 24;
    const my = Number.isFinite(p.marginY) ? p.marginY : 100;
    const x = corner.endsWith('left') ? mx : state.screen.w - state.box.w - mx;
    const y = corner.startsWith('top') ? state.screen.top + my : state.screen.h - state.screen.bottom - state.box.h - my;
    return { x, y, corner, marginX: mx, marginY: my };
  }

  async function hello(flat) {
    const pos = cornerPosition();
    const pets = flat
      .filter((x) => ['desktop', 'both'].includes(String(x.pet.display ?? 'both')))
      .map((x) => ({
        id: x.pet.id,
        anchor: x.pet.position?.corner || 'top-right',
        marginX: Number.isFinite(x.pet.position?.marginX) ? x.pet.position.marginX : 24,
        marginY: Number.isFinite(x.pet.position?.marginY) ? x.pet.position.marginY : 100,
      }));
    await postJson('/hello', {
      win: wantPet,
      pet: state.petId,
      size: state.pet?.size ?? SIZE_BASE,
      anchor: pos.corner,
      marginX: pos.marginX,
      marginY: pos.marginY,
      pets,
    });
  }

  async function reload() {
    const status = await fetch(ROUTE + '/status')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    state.screen = pickScreen(status);

    let agg;
    try {
      agg = await fetchUpstreamConfig();
    } catch (e) {
      hint('未找到 dsh-pet 上游插件：' + (e instanceof Error ? e.message : String(e)));
      reportUpstream(false, e instanceof Error ? e.message : String(e));
      return;
    }
    reportUpstream(true);

    const flat = flatten(agg);
    const found = resolvePet(flat);
    if (!found) {
      hint('没有 display 为 desktop/both 的宠物。到 dsh-pet 设置页把显示方式改成「桌面」或「两者」。');
      return;
    }
    hint('');

    state.entry = found.entry;
    state.pet = found.pet;
    state.petId = String(found.pet.id);
    state.anims = found.pet.animations || found.entry.animations || DEFAULT_ANIMS;
    state.physics = {
      ...state.physics,
      ...(found.entry.physics || {}),
      ...(found.pet.physics || {}),
    };

    applyBox(Number(found.pet.size) || SIZE_BASE);
    const pos = cornerPosition();
    // 首次进来按配置角落定位；之后只在屏幕/尺寸变化时钳回边界，不打断用户摆放
    if (!state.pos.x && !state.pos.y) place(pos.x, pos.y);
    else place(state.pos.x, state.pos.y);

    await hello(flat);
    state.busy = false;
    idle();
  }

  function boot() {
    reload().catch((e) => {
      hint('初始化失败：' + (e instanceof Error ? e.message : String(e)));
      reportUpstream(false, e instanceof Error ? e.message : String(e));
    });
    setInterval(pollUpstream, 1000);
    window.addEventListener('pagehide', () => clearTimeout(chainTimer), { once: true });
  }

  boot();
})();
