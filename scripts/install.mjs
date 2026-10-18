/**
 * 跨移植安装器 —— DSHA / Tdsh / dsh-fusion / dsh-android / 其它 DSH 安卓移植通用。
 *
 * 为什么不用 `pnpm add`：各移植的 DSH_HOME、profile 名、pnpm 位置都不同，有的容器里
 * 连 pnpm 都没进 PATH。插件本身零依赖、无构建产物，所以"解包 + 写 bundles"就够了。
 *
 * 用法（在容器里跑，node 由 dsh 自带）：
 *   node scripts/install.mjs --tgz dsh-pet-android-0.2.0.tgz
 *   node scripts/install.mjs --source . --profile web
 *   node scripts/install.mjs --remove
 *   node scripts/install.mjs --list
 *
 * 它会做四件事：
 *   1. 找到 DSH_HOME（--home / $DSH_HOME / /root/.dsh / ~/.dsh）；
 *   2. 列出 $DSH_HOME/profiles/<name>/package.json；
 *   3. 把包解到 <profile>/node_modules/dsh-pet-android；
 *   4. 把 "dsh-pet-android" 写进该 package.json 的 dsh.profile.bundles（已存在则跳过）。
 * 不启动、不重启 dsh —— 装完由用户自己重启，失败可 --remove 原样退回。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const PKG = 'dsh-pet-android';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}

function log(msg) {
  console.log(`[install] ${msg}`);
}

/** DSH_HOME：显式 > 环境变量 > 常见位置（DSHA 是 /root/.dsh） */
function resolveHome() {
  const explicit = arg('home');
  if (explicit && explicit !== 'true') return resolve(explicit);
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const candidates = ['/root/.dsh', join(homedir(), '.dsh'), '/home/dsh/.dsh'];
  for (const c of candidates) {
    try {
      if (statSync(c).isDirectory()) return c;
    } catch {
      /* 下一个 */
    }
  }
  return join(homedir(), '.dsh');
}

/** 所有带 package.json 的 profile */
function listProfiles(home) {
  const root = join(home, 'profiles');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => ({ name, dir: join(root, name), file: join(root, name, 'package.json') }))
    .filter((p) => existsSync(p.file));
}

/** 把 "dsh-pet-android" 写进 profile 的 bundles（幂等） */
function ensureBundle(file, remove = false) {
  const raw = readFileSync(file, 'utf8');
  const doc = JSON.parse(raw);
  doc.dsh = doc.dsh || {};
  doc.dsh.profile = doc.dsh.profile || {};
  const list = Array.isArray(doc.dsh.profile.bundles) ? doc.dsh.profile.bundles : [];
  const has = list.includes(PKG);
  if (remove) {
    if (!has) return { changed: false, bundles: list };
    doc.dsh.profile.bundles = list.filter((x) => x !== PKG);
  } else {
    if (has) return { changed: false, bundles: list };
    doc.dsh.profile.bundles = [...list, PKG];
  }
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return { changed: true, bundles: doc.dsh.profile.bundles };
}

/**
 * 自己解 tgz —— 不调用系统 tar。
 * 理由：安卓容器里 tar 的版本五花八门，Windows 上 GNU tar 还会把 `C:\...` 当成远程主机名
 * （报 "Cannot connect to C"）；npm 包的 tgz 是标准 ustar，直接解 40 行就够，且零外部依赖。
 */
function extractTgz(tarball, target) {
  const raw = gunzipSync(readFileSync(tarball));
  let offset = 0;
  let files = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) break; // 两个全零块 = 结束
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const full = prefix ? `${prefix}/${name}` : name;
    const body = raw.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    // npm 包顶层是 package/：去掉第一段
    const rel = full.split('/').slice(1).join('/');
    if (!rel) continue;
    const dest = join(target, rel);
    if (type === '5') {
      mkdirSync(dest, { recursive: true });
      continue;
    }
    if (type !== '0' && type !== '\0') continue; // 链接/设备不处理（npm 包里没有）
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body);
    files += 1;
  }
  if (files === 0) throw new Error('tgz 里没有文件，包可能损坏');
  return files;
}

function installInto(target, { tgz, source }) {
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  if (source && source !== 'true') {
    // 源码目录：直接拷（排除 node_modules 与 .git）
    cpSync(resolve(source), target, {
      recursive: true,
      filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src),
    });
    return 'source';
  }
  const tarball = resolve(tgz && tgz !== 'true' ? tgz : `${PKG}-0.2.0.tgz`);
  if (!existsSync(tarball)) throw new Error(`找不到插件包：${tarball}（用 --tgz 指定，或 --source . 装源码目录）`);
  return `tgz(${extractTgz(tarball, target)} files)`;
}

const home = resolveHome();
log(`DSH_HOME = ${home}`);
const profiles = listProfiles(home);
if (profiles.length === 0) {
  console.error(`[install] 在 ${join(home, 'profiles')} 下没找到任何 profile；先启动一次 dsh 让它建好 profile 再装`);
  process.exit(1);
}

if (arg('list') === 'true' || (!arg('tgz') && !arg('source') && arg('remove') !== 'true')) {
  for (const p of profiles) {
    let bundles = [];
    try {
      bundles = JSON.parse(readFileSync(p.file, 'utf8'))?.dsh?.profile?.bundles ?? [];
    } catch {
      /* 读不出来就只报名字 */
    }
    log(`profile ${p.name}: ${p.dir}  bundles=${JSON.stringify(bundles)}${bundles.includes(PKG) ? '  ← 已装' : ''}`);
  }
  log('安装：node scripts/install.mjs --tgz <tgz> [--profile <name>]');
  process.exit(0);
}

const only = arg('profile');
const targets = only ? profiles.filter((p) => p.name === only) : profiles;
if (targets.length === 0) {
  console.error(`[install] 没有名为 ${only} 的 profile`);
  process.exit(1);
}

const remove = arg('remove') === 'true';
for (const p of targets) {
  const target = join(p.dir, 'node_modules', PKG);
  if (remove) {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    const r = ensureBundle(p.file, true);
    log(`profile ${p.name}: 已删除 ${target}${r.changed ? '，并从 bundles 移除' : ''}`);
  } else {
    const how = installInto(target, { tgz: arg('tgz'), source: arg('source') });
    const r = ensureBundle(p.file, false);
    log(`profile ${p.name}: 已安装（${how}）→ ${target}${r.changed ? '，已写入 bundles' : ''}`);
  }
}
log('完成。重启 dsh 后验证：指向 <dsh web 端口>/dsh-pet-android/status');
