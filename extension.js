const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let EXT_PATH = '';
let TPL_ROOT = '';   // user-editable template root: <globalStorage>/templates/<name>/{Dockerfile,init-firewall.sh}
const DEFAULT_TPL = 'default';
const TPL_FILES = ['Dockerfile', 'init-firewall.sh'];

const run = (file, args) => new Promise((res) =>
  cp.execFile(file, args, { timeout: 10000, windowsHide: true }, (e, out) =>
    res(e ? null : (out || '').trim())));

const PS_ARGS = ['ps', '-a', '--filter', 'label=cpt.project', '--format', 'json'];

// docker ps --format json (NDJSON) を { "project|env": {state,id} } に変換
function parsePs(out) {
  const map = {};
  if (!out) return map;
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    const labels = {};
    for (const kv of String(o.Labels || '').split(',')) {
      const i = kv.indexOf('='); if (i > 0) labels[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const proj = labels['cpt.project'], env = labels['cpt.env'];
    if (!proj || !env) continue;
    const running = String(o.State || '').toLowerCase().includes('run') || String(o.Status || '').startsWith('Up');
    map[`${proj}|${env}`] = { state: running ? 'running' : 'stopped', id: o.ID };
  }
  return map;
}

const getCfg = () => vscode.workspace.getConfiguration('cpt');
const getProjects = () => getCfg().get('projects') || [];
const volName = (s) => s.toLowerCase().replace(/[^a-z0-9_.-]/g, '-') + '-src';

// env のコンテナと関連 volume（source / memory / 履歴）を削除
async function deleteEnvVolumes(projectName, env) {
  const exe = env.engine === 'wsl' ? 'wsl.exe' : 'docker';
  const prefix = env.engine === 'wsl' ? ['-d', env.distro, 'docker'] : [];
  const nscEnv = env.envId || env.label;
  const vols = new Set([volName(`${projectName}-${env.label}`), volName(projectName)]);
  const id = ((await run(exe, [...prefix, 'ps', '-aq',
    '--filter', `label=cpt.project=${projectName}`, '--filter', `label=cpt.env=${nscEnv}`])) || '')
    .split(/\r?\n/)[0].trim();
  let image = '';
  if (id) {
    const m = await run(exe, [...prefix, 'inspect', id, '--format', '{{range .Mounts}}{{if .Name}}{{.Name}} {{end}}{{end}}']);
    if (m) for (const v of m.split(/\s+/)) if (v) vols.add(v);
    image = ((await run(exe, [...prefix, 'inspect', id, '--format', '{{.Config.Image}}'])) || '').trim();
    await run(exe, [...prefix, 'rm', '-f', id]);
  }
  for (const v of vols) await run(exe, [...prefix, 'volume', 'rm', v]);
  // このコンテナ専用イメージ（vsc-<env>-<hash> と -uid 版）を削除。共有レイヤーは他で使用中なら残る
  if (image) {
    await run(exe, [...prefix, 'rmi', '-f', image]);
    const sibling = image.endsWith('-uid') ? image.slice(0, -4) : image + '-uid';
    await run(exe, [...prefix, 'rmi', '-f', sibling]);
  }
}

// env 専用 volume の {name -> role} を返す（共有 volume は含めない／呼び出し側で分離）。
// 実在チェックはしない（呼び出し側でエンジンの volume 一覧と突き合わせる）。
// コンテナがあれば mounts から hash 名（履歴/設定）も復元する。
async function envVolumeRoles(project, env) {
  const { exe, prefix } = engineFor(env);
  const nscEnv = env.envId || env.label;
  const roleByDest = {
    '/workspace': 'workspace (data)',
    '/home/dev': 'home (config + history)',
    '/shared': 'shared (/shared)'
  };
  const map = new Map();
  map.set(volName(`${project}-${env.label}`), roleByDest['/workspace']);
  const id = ((await run(exe, [...prefix, 'ps', '-aq', '--filter', `label=cpt.project=${project}`, '--filter', `label=cpt.env=${nscEnv}`])) || '').split(/\r?\n/)[0].trim();
  if (id) {
    const m = await run(exe, [...prefix, 'inspect', id, '--format', '{{range .Mounts}}{{if .Name}}{{.Name}}={{.Destination}};{{end}}{{end}}']);
    if (m) for (const pair of m.split(';')) {
      const i = pair.indexOf('='); if (i <= 0) continue;
      const name = pair.slice(0, i);
      // `vscode` is Dev Containers' shared VS Code Server cache (external=true, mounted
      // into every dev container on this engine) — never attribute it to a specific env.
      if (name === 'vscode') continue;
      map.set(name, roleByDest[pair.slice(i + 1)] || pair.slice(i + 1) || '(volume)');
    }
  }
  return map;
}

// プロジェクト設定 → 正規化した環境配列。旧形式(wslPath/winPath)は後方互換で展開。
function resolveEnvs(p) {
  if (Array.isArray(p.environments) && p.environments.length) {
    return p.environments.map(e => ({ label: e.label, envId: e.envId || e.label, engine: e.engine || p.engine, distro: e.distro || p.distro, path: e.path, memory: e.memory, firewall: e.firewall, template: e.template, baseImage: e.baseImage }));
  }
  const out = [];
  if (p.wslPath && p.distro) out.push({ label: 'wsl', envId: 'wsl', engine: 'wsl', distro: p.distro, path: p.wslPath });
  if (p.winPath) out.push({ label: 'win', envId: 'win', engine: 'win', path: p.winPath });
  return out;
}
// 設定保存用に environments 形式へ（旧形式は移行）
function envsOf(proj) {
  if (Array.isArray(proj.environments) && proj.environments.length) return proj.environments.slice();
  return resolveEnvs(proj).map(e => ({ label: e.label, envId: e.envId, engine: e.engine, distro: e.distro, path: e.path }));
}

const openUriFor = (e) => e.engine === 'wsl'
  ? `vscode-remote://wsl+${e.distro}${e.path}`
  : 'file:///' + String(e.path).replace(/\\/g, '/').replace(/^\/+/, '');
const engineFor = (e) => e.engine === 'wsl'
  ? { exe: 'wsl.exe', prefix: ['-d', e.distro, 'docker'] }
  : { exe: 'docker', prefix: [] };

// Build the child detail rows shown when an env is expanded (WSL-Manager-like view).
function envDetailChildren(e, state) {
  const STATUS = { running: 'Running', stopped: 'Stopped', none: 'Not created', unknown: 'Unreachable' };
  const stateIcon = state === 'running' ? 'play-circle'
    : state === 'stopped' ? 'debug-stop'
    : state === 'unknown' ? 'warning' : 'circle-outline';
  const stateColor = state === 'running' ? new vscode.ThemeColor('testing.iconPassed') : undefined;
  const engineLabel = e.engine === 'wsl' ? `WSL: ${e.distro}` : 'Local (Docker Desktop)';
  const row = (icon, label, value, color) => {
    const it = new vscode.TreeItem(`${label}: ${value}`, vscode.TreeItemCollapsibleState.None);
    it.iconPath = color ? new vscode.ThemeIcon(icon, color) : new vscode.ThemeIcon(icon);
    it.contextValue = 'envdetail';
    return it;
  };
  return [
    row(stateIcon, 'State', STATUS[state], stateColor),
    row('terminal', 'Engine', engineLabel),
    row('folder-opened', 'Path', e.path),
    row('shield', 'firewall', e.firewall === 'off' ? 'off' : 'on'),
    row('file-code', 'Template', e.template || 'default')
  ];
}

function envTreeItem(e, state, id) {
  const it = new vscode.TreeItem(e.label, vscode.TreeItemCollapsibleState.Collapsed);
  const statusText = { running: 'Running', stopped: 'Stopped', none: 'Not created', unknown: 'Unreachable' }[state];
  it.description = statusText;
  const fwOn = e.firewall !== 'off';
  it.contextValue = `env state:${state} fw:${fwOn ? 'on' : 'off'}`;
  // Cube icon matching the activity-bar. Per-theme SVGs with baked-in colors so the
  // icon stays visible in both light and dark themes (tree-item file-URI icons don't
  // honor `currentColor`, so light/dark variants are required).
  const variant = state === 'running' ? 'env-running' : 'env-stopped';
  it.iconPath = {
    light: vscode.Uri.file(path.join(EXT_PATH, 'media', `${variant}-light.svg`)),
    dark:  vscode.Uri.file(path.join(EXT_PATH, 'media', `${variant}-dark.svg`))
  };
  it.tooltip = `${e.label}\n${e.engine === 'wsl' ? `WSL: ${e.distro}` : 'Local (Docker Desktop)'}\n${e.path}\nstatus: ${statusText}`;
  it.openUri = openUriFor(e);
  it.containerId = id || null;
  it.engine = engineFor(e);
  it.children = envDetailChildren(e, state);
  return it;
}

class Provider {
  constructor() { this._e = new vscode.EventEmitter(); this.onDidChangeTreeData = this._e.event; this.selectedKeys = new Set(); }
  refresh() { this._e.fire(); }
  getTreeItem(x) { return x; }
  async getChildren(el) {
    if (el) return el.children || [];
    const resolved = getProjects().map(p => ({ p, envs: resolveEnvs(p) }));

    const distros = [...new Set(resolved.flatMap(r => r.envs).filter(e => e.engine === 'wsl' && e.distro).map(e => e.distro))];
    const wsl = {};
    await Promise.all(distros.map(async (d) => {
      const out = await run('wsl.exe', ['-d', d, 'docker', ...PS_ARGS]);
      wsl[d] = out == null ? null : parsePs(out);
    }));
    let win;
    // 非 wsl（local=Docker Desktop / 旧 win）の env があれば docker を直接プローブ。
    // ※以前は `=== 'win'` 限定で、現行の engine='local' が一度も probe されず常に「未導入」だった。
    if (resolved.some(r => r.envs.some(e => e.engine !== 'wsl'))) {
      const out = await run('docker', PS_ARGS);
      win = out == null ? null : parsePs(out);
    }

    return resolved.map(({ p, envs }) => {
      const node = new vscode.TreeItem(p.name, vscode.TreeItemCollapsibleState.Expanded);
      node.contextValue = 'project';
      node.iconPath = new vscode.ThemeIcon('folder');
      node.projectName = p.name;
      node.children = envs.map((e) => {
        const map = e.engine === 'wsl' ? wsl[e.distro] : win;
        const reachable = map != null;
        const st = map ? map[`${p.name}|${e.envId}`] : null;
        const state = !reachable ? 'unknown' : (st ? st.state : 'none');
        const it = envTreeItem(e, state, st && st.id);
        it.projectName = p.name;
        it.envLabel = e.label;
        it.envObj = e;
        // When the env is currently selected, swap the dim cube for a bright one
        // (running envs keep their bright green icon regardless of selection).
        if (state !== 'running' && this.selectedKeys.has(`${p.name}:${e.label}`)) {
          it.iconPath = {
            light: vscode.Uri.file(path.join(EXT_PATH, 'media', 'env-stopped-active-light.svg')),
            dark:  vscode.Uri.file(path.join(EXT_PATH, 'media', 'env-stopped-active-dark.svg'))
          };
        }
        return it;
      });
      const parts = [];
      const peng = p.engine || (envs[0] && envs[0].engine);
      const pdistro = p.distro || (envs[0] && envs[0].distro);
      if (peng === 'wsl') parts.push(`WSL:${pdistro || ''}`);
      else if (peng) parts.push('Local (DD)');
      if (p.shared) parts.push('Shared: /shared');
      if (node.children.length === 0) parts.push('No containers');
      if (parts.length) node.description = parts.join(' · ');
      return node;
    });
  }
}

// ---- Volume パネル ----
// `docker system df -v` の Local Volumes セクションを name->size に解析（取得失敗時は空）
function parseVolumeSizes(out) {
  const sizes = {};
  if (!out) return sizes;
  let inVol = false;
  for (const line of out.split(/\r?\n/)) {
    if (/^VOLUME NAME\s+LINKS\s+SIZE/.test(line)) { inVol = true; continue; }
    if (!inVol) continue;
    if (!line.trim() || /usage:/i.test(line)) break;
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 3) sizes[parts[0]] = parts[parts.length - 1];
  }
  return sizes;
}
const engineKeyOf = (e) => e.engine === 'wsl' ? `wsl:${e.distro}` : 'local';
// docker のサイズ文字列("1.2GB"等)→ bytes、bytes → 表示用文字列(env 合算用)
function sizeToBytes(s) {
  const m = /^([\d.]+)\s*([kKmMgGtT]?i?)B?$/.exec(String(s || '').trim());
  if (!m) return 0;
  const mult = { '': 1, k: 1e3, ki: 1024, m: 1e6, mi: 1024 ** 2, g: 1e9, gi: 1024 ** 3, t: 1e12, ti: 1024 ** 4 }[m[2].toLowerCase()] || 1;
  return parseFloat(m[1]) * mult;
}
function fmtBytes(b) {
  if (!b) return '';
  const u = ['B', 'kB', 'MB', 'GB', 'TB']; let i = 0, v = b;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${i && v < 10 ? v.toFixed(1) : Math.round(v)}${u[i]}`;
}
function volumeLeaf(name, label, size, g, withName) {
  const it = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  it.description = withName ? (size ? `${size} · ${name}` : name) : (size || '');
  it.tooltip = name + (size ? `\nSize: ${size}` : '') + `\n(${g.label})`;
  it.iconPath = new vscode.ThemeIcon('database');
  it.contextValue = 'volume';
  it.volName = name; it.volNames = [name]; it.engineExe = g.exe; it.enginePrefix = g.prefix;
  return it;
}

class VolumeProvider {
  constructor() { this._e = new vscode.EventEmitter(); this.onDidChangeTreeData = this._e.event; }
  refresh() { this._e.fire(); }
  getTreeItem(x) { return x; }
  async getChildren(el) {
    if (el) return el.children || [];
    const projects = getProjects();
    // エンジン(wsl distro / local)ごとに volume 一覧＋サイズをまとめて取得
    const engines = new Map();
    for (const p of projects) for (const e of resolveEnvs(p)) {
      const key = engineKeyOf(e);
      if (!engines.has(key)) {
        const { exe, prefix } = engineFor(e);
        engines.set(key, { exe, prefix, label: e.engine === 'wsl' ? `WSL: ${e.distro}` : 'Local (Docker Desktop)', names: new Set(), sizes: {}, reachable: true });
      }
    }
    await Promise.all([...engines.values()].map(async (g) => {
      const ls = await run(g.exe, [...g.prefix, 'volume', 'ls', '--format', '{{.Name}}']);
      if (ls == null) { g.reachable = false; return; }
      for (const n of ls.split(/\r?\n/)) if (n.trim()) g.names.add(n.trim());
      g.sizes = parseVolumeSizes(await run(g.exe, [...g.prefix, 'system', 'df', '-v']));
    }));

    const claimed = new Set();
    const projNodes = [];
    for (const p of projects) {
      const e0 = resolveEnvs(p)[0];
      const key = engineKeyOf(e0 || { engine: p.engine, distro: p.distro });
      const g = engines.get(key);
      const projNode = new vscode.TreeItem(p.name, vscode.TreeItemCollapsibleState.Expanded);
      projNode.iconPath = new vscode.ThemeIcon('folder');
      projNode.contextValue = 'volproject';
      projNode.children = [];
      let envCount = 0;
      if (g && g.reachable) {
        const sharedName = sharedVolName(p.name);
        // each env collapsed into one node (its volumes are a set; useless to keep individually)
        for (const e of resolveEnvs(p)) {
          const roles = await envVolumeRoles(p.name, e);
          const vols = [];
          for (const [name, role] of roles) {
            if (name === sharedName || !g.names.has(name) || claimed.has(key + ' ' + name)) continue;
            claimed.add(key + ' ' + name);
            vols.push({ name, role, size: g.sizes[name] });
          }
          if (!vols.length) continue;
          const total = vols.reduce((s, v) => s + sizeToBytes(v.size), 0);
          const envNode = new vscode.TreeItem(e.label, vscode.TreeItemCollapsibleState.None);
          envNode.iconPath = new vscode.ThemeIcon('package');
          envNode.contextValue = 'volenv';
          envNode.description = `${fmtBytes(total)}${total ? ' · ' : ''}${vols.length} volumes`;
          envNode.tooltip = `${p.name} / ${e.label}\n${vols.length} volume(s) — deleting removes all data of this container`;
          envNode.volNames = vols.map(v => v.name);
          envNode.confirmName = e.label;
          envNode.engineExe = g.exe; envNode.enginePrefix = g.prefix;
          projNode.children.push(envNode);
          envCount++;
        }
        // shared volume belongs to this project -> show it under the project node (next to envs)
        if (g.names.has(sharedName) && !claimed.has(key + ' ' + sharedName)) {
          claimed.add(key + ' ' + sharedName);
          const sl = volumeLeaf(sharedName, 'Shared', g.sizes[sharedName], g, true);
          sl.iconPath = new vscode.ThemeIcon('folder-library');
          sl.tooltip = `${sharedName}\nProject shared volume (mounted at /shared)`;
          projNode.children.push(sl);
        }
      }
      if (projNode.children.length === 0) {
        const empty = new vscode.TreeItem(g && !g.reachable ? '(engine unreachable)' : '(no volumes)', vscode.TreeItemCollapsibleState.None);
        empty.contextValue = 'info';
        projNode.children.push(empty);
      } else projNode.description = `${envCount} container${envCount === 1 ? '' : 's'}`;
      projNodes.push(projNode);
    }
    const out = [...projNodes];
    // エンジンごとに、どの project にも紐づかない volume を「その他」へ
    for (const [key, g] of engines) {
      if (!g.reachable) continue;
      const others = [...g.names].filter(n => !claimed.has(key + ' ' + n)).sort();
      if (!others.length) continue;
      const node = new vscode.TreeItem(`Other (${g.label})`, vscode.TreeItemCollapsibleState.Collapsed);
      node.iconPath = new vscode.ThemeIcon('archive');
      node.contextValue = 'volother';
      node.description = `${others.length} volumes`;
      node.children = others.map(n => volumeLeaf(n, n, g.sizes[n], g, false));
      out.push(node);
    }
    // When empty, return [] so the view's viewsWelcome ("No volumes.") is shown.
    return out;
  }
}

// ---- scaffolding ----
const sharedVolName = (name) => name.toLowerCase().replace(/[^a-z0-9_.-]/g, '-') + '-shared';

function envDevDir(env) {
  if (env.engine === 'wsl') return `\\\\wsl.localhost\\${env.distro}${String(env.path).replace(/\//g, '\\')}\\.devcontainer`;
  return path.join(String(env.path), '.devcontainer');
}

// Bake the chosen base image directly into the Dockerfile's FROM line, dropping the
// `ARG BASE_IMAGE=…` indirection. The template keeps the ARG pattern for clarity, but
// each env's Dockerfile shows the literal `FROM <chosen>` so "Edit Dockerfile" is honest.
function applyBaseImageToDockerfile(content, baseImage) {
  const base = baseImage || 'node:20';
  return content
    .replace(/^ARG BASE_IMAGE=.*\r?\n/m, '')
    .replace(/^FROM .+$/m, `FROM ${base}`);
}
function devcontainerJson(project, env, volume, shared, firewall) {
  const mounts = [
    'source=home-${devcontainerId},target=/home/dev,type=volume'
  ];
  if (shared) mounts.push(`source=${sharedVolName(project)},target=/shared,type=volume`);
  const buildArgs = { TZ: '${localEnv:TZ:Asia/Tokyo}', GIT_DELTA_VERSION: '0.18.2' };
  const o = {
    name: `${project} / ${env}`,
    build: { dockerfile: 'Dockerfile', args: buildArgs },
    runArgs: ['--cap-add=NET_ADMIN', '--cap-add=NET_RAW', '--label', `cpt.project=${project}`, '--label', `cpt.env=${env}`],
    customizations: { vscode: {
      extensions: ['anthropic.claude-code', 'dbaeumer.vscode-eslint', 'esbenp.prettier-vscode', 'eamodio.gitlens'],
      settings: {
        // Terminal default shell is left to the container — set via the user's login shell
        // (the bundled "default" template uses bash; "sample" runs `chsh -s /bin/zsh node`).
        // Copilot: このリポの .github/copilot-instructions.md のみ使用し、
        // ユーザー/グローバルの設定ベース命令や親リポ参照は無視（ワークスペース設定で上書き）
        'github.copilot.chat.codeGeneration.useInstructionFiles': true,
        'chat.useCustomizationsInParentRepositories': false,
        'github.copilot.chat.codeGeneration.instructions': [],
        'github.copilot.chat.testGeneration.instructions': [],
        'github.copilot.chat.reviewSelection.instructions': [],
        'github.copilot.chat.commitMessageGeneration.instructions': [],
        'github.copilot.chat.pullRequestDescriptionGeneration.instructions': []
      }
    } },
    remoteUser: 'dev',
    mounts,
    containerEnv: {},
    workspaceMount: `source=${volume},target=/workspace,type=volume`,
    workspaceFolder: '/workspace'
  };
  // firewall は既定 OFF。ON のときだけ init-firewall を postStartCommand で実行する。
  // （NET_ADMIN/NET_RAW と init-firewall.sh は常に同梱されるので、後から右クリックで ON 可能）
  if (firewall) { o.postStartCommand = 'sudo /usr/local/bin/init-firewall.sh'; o.waitFor = 'postStartCommand'; }
  return JSON.stringify(o, null, 2) + '\n';
}
// User-editable templates live at <globalStorage>/templates/<tplName>/{Dockerfile,init-firewall.sh}
// Bundled templates (default + sample) live in <ext>/media/<dir> and auto-sync to the user copy
// on every activate; users can create additional templates via "New template…" which are
// untouched by the auto-sync.
const BUNDLED_TEMPLATES = [
  { name: 'default', dir: 'template',         desc: 'Debian / Ubuntu (apt-get)' },
  { name: 'alpine',  dir: 'template-alpine',  desc: 'Alpine (apk, musl)' },
  { name: 'rhel',    dir: 'template-rhel',    desc: 'RHEL / UBI / Rocky / Alma (dnf)' }
];
function bundledDesc(tplName) {
  const t = BUNDLED_TEMPLATES.find(b => b.name === tplName);
  return t && t.desc ? t.desc : '';
}
function bundledTemplateFile(tplName, fileName) {
  const t = BUNDLED_TEMPLATES.find(b => b.name === tplName);
  return t ? path.join(EXT_PATH, 'media', t.dir, fileName) : null;
}
function isBundledTemplate(tplName) { return BUNDLED_TEMPLATES.some(b => b.name === tplName); }
function templateDir(tplName) { return path.join(TPL_ROOT, tplName || DEFAULT_TPL); }
// Each bundled template mirrors its <ext>/media/<dir>/* on every activate (diff-then-copy so
// VS Code doesn't see noisy "file changed on disk" prompts). To keep customizations, copy a
// bundled template via "New template…" — that copy is NOT touched by this sync.
function syncBundledTemplates() {
  try {
    for (const t of BUNDLED_TEMPLATES) {
      const dst = templateDir(t.name);
      fs.mkdirSync(dst, { recursive: true });
      for (const f of TPL_FILES) {
        const src = bundledTemplateFile(t.name, f);
        if (!src || !fs.existsSync(src)) continue;
        const dstPath = path.join(dst, f);
        let same = false;
        if (fs.existsSync(dstPath)) {
          try { same = fs.readFileSync(src).equals(fs.readFileSync(dstPath)); } catch (_) { /* fall through to copy */ }
        }
        if (!same) fs.copyFileSync(src, dstPath);
      }
    }
  } catch (e) { /* noop */ }
}
// List template names under TPL_ROOT (always includes bundled names first).
function listTemplates() {
  syncBundledTemplates();
  let names = [];
  try {
    names = fs.readdirSync(TPL_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
  } catch (e) { /* noop */ }
  const bundled = BUNDLED_TEMPLATES.map(b => b.name).filter(n => names.includes(n) || true);
  const others = names.filter(n => !bundled.includes(n)).sort();
  return [...bundled, ...others];
}
// Read a template file. Falls back: <tplName>/<file> -> default/<file> -> bundled default.
function readTemplate(tplName, fileName) {
  const candidates = [
    path.join(templateDir(tplName), fileName),
    path.join(templateDir(DEFAULT_TPL), fileName),
    bundledTemplateFile(DEFAULT_TPL, fileName)
  ];
  for (const p of candidates) if (p && fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  return fs.readFileSync(bundledTemplateFile(DEFAULT_TPL, fileName), 'utf8');
}
function writeAnchor(devDir, project, env, volume, shared, firewall, tplName, baseImage) {
  fs.mkdirSync(devDir, { recursive: true });
  const dockerfile = applyBaseImageToDockerfile(readTemplate(tplName, 'Dockerfile'), baseImage);
  fs.writeFileSync(path.join(devDir, 'Dockerfile'), dockerfile, { encoding: 'utf8' });
  fs.writeFileSync(path.join(devDir, 'init-firewall.sh'), readTemplate(tplName, 'init-firewall.sh').replace(/\r\n/g, '\n'), { encoding: 'utf8' });
  fs.writeFileSync(path.join(devDir, 'devcontainer.json'), devcontainerJson(project, env, volume, shared, firewall), { encoding: 'utf8' });
}
// 既存 env の devcontainer.json で firewall(postStartCommand) を ON/OFF
function setFirewall(env, enable) {
  const file = path.join(envDevDir(env), 'devcontainer.json');
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return false; }
  if (enable) { obj.postStartCommand = 'sudo /usr/local/bin/init-firewall.sh'; obj.waitFor = 'postStartCommand'; }
  else { delete obj.postStartCommand; delete obj.waitFor; }
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  return true;
}
// 既存 env の devcontainer.json に shared マウントを追加/削除（workspaceMount 等は保持）
function setSharedMount(projectName, env, enable) {
  const file = path.join(envDevDir(env), 'devcontainer.json');
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return false; }
  const src = `source=${sharedVolName(projectName)},`;
  const mounts = (Array.isArray(obj.mounts) ? obj.mounts : []).filter(m => !String(m).startsWith(src));
  if (enable) mounts.push(`source=${sharedVolName(projectName)},target=/shared,type=volume`);
  obj.mounts = mounts;
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  return true;
}

function listDistros() {
  return new Promise((res) => {
    cp.execFile('wsl.exe', ['--list', '--quiet'], { windowsHide: true, encoding: 'buffer', timeout: 8000 }, (e, out) => {
      if (e || !out) return res([]);
      const text = out.toString('utf16le').replace(/﻿/g, '').replace(/\r/g, '');
      res(text.split('\n').map(s => s.trim()).filter(Boolean));
    });
  });
}
async function pickDistro() {
  const MANUAL = '$(edit) Enter manually…';
  const installed = await listDistros();
  const def = (getProjects().flatMap(resolveEnvs).find(e => e.distro) || {}).distro || '';
  const items = installed.map(d => ({ label: d }));
  items.push({ label: MANUAL });
  const sel = await vscode.window.showQuickPick(items, { placeHolder: 'Select WSL distribution' + (def ? ` (default: ${def})` : '') });
  if (!sel) return '';
  if (sel.label === MANUAL) return (await vscode.window.showInputBox({ prompt: 'WSL distro registration name', value: def })) || '';
  return sel.label;
}

// 実行基盤を選ぶ（OS 依存）。Windows のみ WSL を提示、Mac/Linux はローカル(Docker Desktop)固定。
async function pickEngineDistro() {
  let engine = 'local';
  if (process.platform === 'win32') {
    const eng = await vscode.window.showQuickPick(
      [{ label: 'WSL (docker-ce)', id: 'wsl' }, { label: 'Local (Docker Desktop)', id: 'local' }],
      { placeHolder: 'Select engine (fixed for the whole project)' });
    if (!eng) return null;
    engine = eng.id;
  }
  let distro;
  if (engine === 'wsl') { distro = await pickDistro(); if (!distro) return null; }
  return { engine, distro };
}

// 環境を 1 つ入力させ、アンカーを生成して env 設定オブジェクトを返す
async function promptEnvironment(projectName, existingLabels, shared, engine, distro) {
  const label = await vscode.window.showInputBox({
    title: `Add container to "${projectName}"`,
    prompt: 'Enter container name',
    placeHolder: 'Letters, digits and . _ - allowed',
    validateInput: (v) => {
      if (!v || !v.trim()) return 'Please enter a name';
      if (!/^[A-Za-z0-9._-]+$/.test(v)) return `"${v}" — only letters, digits and . _ - allowed`;
      if ((existingLabels || []).includes(v)) return `Container "${v}" already exists in "${projectName}"`;
      return { message: `"${v}" is available`, severity: vscode.InputBoxValidationSeverity.Info };
    }
  });
  if (!label) return null;
  // Pick which template (Dockerfile / firewall set) to use for this environment.
  const tplNames = listTemplates();
  let tplName = DEFAULT_TPL;
  if (tplNames.length > 1) {
    const tplPick = await vscode.window.showQuickPick(
      tplNames.map(n => ({ label: n, description: bundledDesc(n), n })),
      { placeHolder: `Pick a template for "${label}" (Dockerfile / firewall set)` });
    if (!tplPick) return null;
    tplName = tplPick.n;
  }
  // Optional base image override — written directly into the Dockerfile's FROM line.
  const baseInput = await vscode.window.showInputBox({
    prompt: `Base image for "${label}" — written into the Dockerfile's FROM line. Leave blank for node:20.`,
    placeHolder: 'ubuntu / debian / python:3.12 / node:22 … (blank = node:20)',
    validateInput: (v) => {
      const t = (v || '').trim();
      if (!t || t === 'node:20') return { message: 'Will use node:20 (default)', severity: vscode.InputBoxValidationSeverity.Info };
      return { message: `FROM ${t}`, severity: vscode.InputBoxValidationSeverity.Info };
    }
  });
  if (baseInput === undefined) return null;
  const baseImage = baseInput.trim();
  const volume = volName(`${projectName}-${label}`);
  // New envs default firewall=off; the chosen template is recorded so Re-apply uses the same one.
  const env = { label, engine, firewall: 'off', template: tplName };
  if (baseImage && baseImage !== 'node:20') env.baseImage = baseImage;  // only store non-default
  let devDir, openPath;
  if (engine === 'wsl') {
    openPath = `/home/dev/projects/${projectName}/${label}`;
    devDir = `\\\\wsl.localhost\\${distro}${openPath.replace(/\//g, '\\')}\\.devcontainer`;
    env.distro = distro;
  } else {
    openPath = path.join(os.homedir(), 'projects', projectName, label).replace(/\\/g, '/');
    devDir = path.join(os.homedir(), 'projects', projectName, label, '.devcontainer');
  }
  env.path = openPath;
  try { writeAnchor(devDir, projectName, label, volume, shared, false, tplName, env.baseImage); }  // scaffold with firewall=off + chosen template + base image
  catch (e) { vscode.window.showErrorMessage('Failed to create container: ' + e.message); return null; }
  return env;
}

async function createProject(provider) {
  const name = await vscode.window.showInputBox({
    prompt: 'Project name',
    validateInput: (v) => {
      if (!v || !v.trim()) return 'Please enter a name';
      if (!/^[A-Za-z0-9._-]+$/.test(v)) return `"${v}" — only letters, digits and . _ - allowed`;
      const existing = getProjects().find(p => p.name === v);
      if (existing) {
        const envCount = (existing.environments || []).length;
        return `Project "${v}" already exists (${envCount} container${envCount === 1 ? '' : 's'})`;
      }
      return { message: `"${v}" is available`, severity: vscode.InputBoxValidationSeverity.Info };
    }
  });
  if (!name) return;
  const ed = await pickEngineDistro();
  if (!ed) return;
  const proj = { name, engine: ed.engine, environments: [] };
  if (ed.distro) proj.distro = ed.distro;
  await getCfg().update('projects', [...getProjects(), proj], vscode.ConfigurationTarget.Global);
  provider.refresh();
  vscode.window.showInformationMessage(`Created project "${name}" (${ed.engine === 'wsl' ? 'WSL: ' + ed.distro : 'Local (Docker Desktop)'}). Right-click → "Add container" to create one.`);
}

function activate(context) {
  EXT_PATH = context.extensionPath;
  TPL_ROOT = path.join(context.globalStorageUri.fsPath, 'templates');
  // Migrate the old single-template layout (<globalStorage>/template/{Dockerfile,init-firewall.sh})
  // to <globalStorage>/templates/default/* the first time the multi-template build runs.
  try {
    const oldDir = path.join(context.globalStorageUri.fsPath, 'template');
    if (fs.existsSync(oldDir) && !fs.existsSync(TPL_ROOT)) {
      fs.mkdirSync(TPL_ROOT, { recursive: true });
      fs.renameSync(oldDir, path.join(TPL_ROOT, DEFAULT_TPL));
    }
  } catch (e) { /* fall back to seeding below */ }
  syncBundledTemplates();   // mirror the bundled default+sample templates into user storage
  const provider = new Provider();
  const volProvider = new VolumeProvider();
  const saveProjects = (arr) => getCfg().update('projects', arr, vscode.ConfigurationTarget.Global);

  // 「開く」: 新ウィンドウで対象 WSL/ローカルへ自動接続 → 接続後に自動 Reopen in Container。
  // ※ remote-containers.openFolder で直行する案は WSL で破綻した（wsl+<distro> URI を渡しても
  //   host チェック wslpath/ls を指定 distro で実行せず "No such file or directory" exit 2、
  //   かつ executeCommand は reject しないため catch フォールバックも効かない）。2段階方式に固定。
  const openProject = async (uriStr) => {
    await context.globalState.update('cpt.pendingReopen', uriStr);
    vscode.window.setStatusBarMessage('$(sync~spin) Starting container in a new window…', 5000);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(uriStr), true);
  };
  (async () => {
    try {
      const pending = context.globalState.get('cpt.pendingReopen');
      if (!pending) return;
      const remote = vscode.env.remoteName;
      if (remote === 'dev-container' || remote === 'attached-container') {
        await context.globalState.update('cpt.pendingReopen', undefined); return;
      }
      // Show the notification FIRST so it's visible during the WSL connection phase
      // (when workspaceFolders isn't populated yet). Poll for the workspace folder
      // inside the progress; if it never matches (wrong window), dismiss silently.
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Starting container…', cancellable: false },
        async (progress) => {
          progress.report({ message: 'connecting to WSL…' });
          const expectedPath = vscode.Uri.parse(pending).path.toLowerCase();
          const matchDeadline = Date.now() + 60000;
          while (Date.now() < matchDeadline) {
            const f = (vscode.workspace.workspaceFolders || [])[0];
            if (f && f.uri.path.toLowerCase() === expectedPath) break;
            await new Promise(r => setTimeout(r, 200));
          }
          const f = (vscode.workspace.workspaceFolders || [])[0];
          if (!f || f.uri.path.toLowerCase() !== expectedPath) return; // wrong window
          await context.globalState.update('cpt.pendingReopen', undefined);
          progress.report({ message: 'waiting for Dev Containers extension…' });
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const cmds = await vscode.commands.getCommands();
            if (cmds.includes('remote-containers.reopenInContainer')) {
              progress.report({ message: 'reopening in container…' });
              vscode.commands.executeCommand('remote-containers.reopenInContainer');
              return;
            }
            await new Promise(r => setTimeout(r, 100));
          }
          // Fallback after 5s: fire anyway (VS Code surfaces any error)
          vscode.commands.executeCommand('remote-containers.reopenInContainer');
        }
      );
    } catch (e) { /* noop */ }
  })();

  // 自動更新: 表示中 かつ ウィンドウがフォーカス中のときだけ取得（コスト抑制）。
  // envs は軽いので 5秒ポーリング。volume 一覧は重い（df -v 等）ので focus/表示時のみ更新。
  // view 作成は manifest 登録が前提。新 view 追加直後は完全再起動まで未登録のことがあるため、
  // 作成自体は subscriptions 登録の“後”に try/catch で行い、失敗してもコマンド等を壊さない。
  let treeView, volView, debounce;
  const autoRefresh = () => {
    if (!treeView || !treeView.visible || !vscode.window.state.focused) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => provider.refresh(), 250);
  };
  const refreshVolumes = () => { if (volView && volView.visible && vscode.window.state.focused) volProvider.refresh(); };
  const poll = setInterval(autoRefresh, 5000);

  // Direct-action toggle helpers — flip a single state, no QuickPick.
  const setFirewallState = async (item, enable) => {
    if (!item || !item.projectName || !item.envLabel) return;
    const projects = getProjects();
    const idx = projects.findIndex(p => p.name === item.projectName);
    if (idx < 0) return;
    const envs = envsOf(projects[idx]);
    const e = envs.find(x => x.label === item.envLabel);
    if (!e) return;
    if (!setFirewall(item.envObj || e, enable)) {
      vscode.window.showErrorMessage('Failed to change firewall (anchor devcontainer.json not found)'); return;
    }
    e.firewall = enable ? 'on' : 'off';
    const next = projects.slice(); next[idx] = { ...projects[idx], environments: envs };
    await saveProjects(next);
    provider.refresh();
    vscode.window.showInformationMessage(`firewall of "${item.envLabel}" set to ${enable ? 'ON (allowlist restricted)' : 'OFF (no egress restriction)'}. Rebuild to apply.`);
  };

  context.subscriptions.push(
    { dispose: () => { clearInterval(poll); clearTimeout(debounce); } },
    vscode.window.onDidChangeWindowState(() => { autoRefresh(); refreshVolumes(); }), // フォーカス復帰で即更新
    vscode.commands.registerCommand('cpt.refresh', () => { provider.refresh(); volProvider.refresh(); }),
    vscode.commands.registerCommand('cpt.editTemplates', async () => {
      syncBundledTemplates();
      const tplNames = listTemplates();
      const items = tplNames.map(n => ({
        label: `$(file-code) ${n}`,
        description: isBundledTemplate(n) ? bundledDesc(n) : '',
        n
      }));
      items.push({ label: '$(add) New template…', description: 'Copy an existing template to a new name', action: 'new' });
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Pick a template to edit / manage' });
      if (!pick) return;
      if (pick.action === 'new') {
        const name = await vscode.window.showInputBox({
          prompt: 'New template name',
          placeHolder: 'Letters, digits and . _ - allowed',
          validateInput: v => !v || !v.trim() ? 'Please enter a name'
            : !/^[A-Za-z0-9._-]+$/.test(v) ? `"${v}" — only letters, digits and . _ - allowed`
            : tplNames.includes(v) ? `Template "${v}" already exists`
            : { message: `"${v}" is available`, severity: vscode.InputBoxValidationSeverity.Info }
        });
        if (!name) return;
        const from = await vscode.window.showQuickPick(
          tplNames.map(n => ({ label: n, description: bundledDesc(n), n })),
          { placeHolder: 'Copy from which template?' });
        if (!from) return;
        try {
          const dst = templateDir(name);
          fs.mkdirSync(dst, { recursive: true });
          for (const f of TPL_FILES) fs.copyFileSync(path.join(templateDir(from.n), f), path.join(dst, f));
        } catch (e) { vscode.window.showErrorMessage('Failed to create template: ' + e.message); return; }
        vscode.window.showInformationMessage(`Template "${name}" created (copied from "${from.n}"). Open it again to edit.`);
        return;
      }
      const tplName = pick.n;
      const subItems = [
        { label: '$(file) Edit Dockerfile', f: 'Dockerfile' },
        { label: '$(shield) Edit init-firewall.sh', f: 'init-firewall.sh' }
      ];
      if (isBundledTemplate(tplName)) {
        subItems.push({ label: `$(discard) Reset "${tplName}" to bundled`, action: 'reset' });
      } else {
        subItems.push({ label: '$(symbol-string) Rename', action: 'rename' });
        subItems.push({ label: '$(trash) Delete', action: 'delete' });
      }
      const sub = await vscode.window.showQuickPick(subItems, { placeHolder: `Template "${tplName}"` });
      if (!sub) return;
      if (sub.action === 'reset') {
        const ok = await vscode.window.showWarningMessage(`Reset the "${tplName}" template to the bundled files? Your edits to it will be lost.`, { modal: true }, 'Reset');
        if (ok !== 'Reset') return;
        try {
          for (const f of TPL_FILES) {
            const src = bundledTemplateFile(tplName, f);
            if (src && fs.existsSync(src)) fs.copyFileSync(src, path.join(templateDir(tplName), f));
          }
        } catch (e) { vscode.window.showErrorMessage('Failed to reset: ' + e.message); return; }
        vscode.window.showInformationMessage(`Template "${tplName}" reset to bundled files.`);
        return;
      }
      if (sub.action === 'rename') {
        const name = await vscode.window.showInputBox({
          prompt: `Rename template "${tplName}" to`, value: tplName,
          validateInput: v => !v || !v.trim() ? 'Please enter a name'
            : !/^[A-Za-z0-9._-]+$/.test(v) ? `"${v}" — only letters, digits and . _ - allowed`
            : v === DEFAULT_TPL ? `"${DEFAULT_TPL}" is reserved`
            : v !== tplName && tplNames.includes(v) ? `Template "${v}" already exists`
            : v === tplName ? null
            : { message: `"${v}" is available`, severity: vscode.InputBoxValidationSeverity.Info }
        });
        if (!name || name === tplName) return;
        try { fs.renameSync(templateDir(tplName), templateDir(name)); }
        catch (e) { vscode.window.showErrorMessage('Failed to rename: ' + e.message); return; }
        // Update envs that referenced the old template name.
        const next = getProjects().map(p => ({ ...p, environments: (p.environments || []).map(e => e.template === tplName ? { ...e, template: name } : e) }));
        await getCfg().update('projects', next, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Renamed "${tplName}" -> "${name}".`);
        return;
      }
      if (sub.action === 'delete') {
        const ok = await vscode.window.showWarningMessage(`Delete template "${tplName}"? Envs using it will fall back to "default" on Re-apply.`, { modal: true }, 'Delete');
        if (ok !== 'Delete') return;
        try { fs.rmSync(templateDir(tplName), { recursive: true, force: true }); }
        catch (e) { vscode.window.showErrorMessage('Failed to delete: ' + e.message); return; }
        vscode.window.showInformationMessage(`Deleted template "${tplName}".`);
        return;
      }
      try { await vscode.window.showTextDocument(vscode.Uri.file(path.join(templateDir(tplName), sub.f))); }
      catch (e) { vscode.window.showErrorMessage('Failed to open: ' + e.message); }
    }),
    vscode.commands.registerCommand('cpt.createProject', () => createProject(provider)),
    vscode.commands.registerCommand('cpt.toggleShared', async (item) => {
      if (!item || !item.projectName) return;
      const projects = getProjects();
      const idx = projects.findIndex(p => p.name === item.projectName);
      if (idx < 0) return;
      const proj = projects[idx];
      const enable = !proj.shared;
      const envs = envsOf(proj);
      for (const e of envs) setSharedMount(item.projectName, e, enable);
      if (enable) {
        const seen = new Set();
        for (const e of envs) {
          const key = e.engine === 'wsl' ? `wsl:${e.distro}` : 'win';
          if (seen.has(key)) continue; seen.add(key);
          const exe = e.engine === 'wsl' ? 'wsl.exe' : 'docker';
          const prefix = e.engine === 'wsl' ? ['-d', e.distro, 'docker'] : [];
          await run(exe, [...prefix, 'run', '--rm', '-v', `${sharedVolName(item.projectName)}:/s`, 'alpine', 'chown', '-R', '1000:1000', '/s']);
        }
      }
      const next = projects.slice(); next[idx] = { ...proj, environments: envs, shared: enable };
      await saveProjects(next);
      provider.refresh();
      vscode.window.showInformationMessage(`Shared volume of "${item.projectName}" ${enable ? 'enabled (mounted at /shared in every container)' : 'disabled'}. Rebuild each container to apply.`);
    }),
    vscode.commands.registerCommand('cpt.addEnvironment', async (item) => {
      if (!item || !item.projectName) return;
      const projects = getProjects();
      const idx = projects.findIndex(p => p.name === item.projectName);
      if (idx < 0) return;
      const proj = projects[idx];
      const envs = envsOf(proj);
      let engine = proj.engine, distro = proj.distro;
      if (!engine && envs[0]) { engine = envs[0].engine; distro = envs[0].distro; }
      if (!engine) {
        const ed = await pickEngineDistro();
        if (!ed) return;
        engine = ed.engine; distro = ed.distro;
      }
      const env = await promptEnvironment(item.projectName, envs.map(e => e.label), proj.shared, engine, distro);
      if (!env) return;
      envs.push(env);
      const next = projects.slice();
      next[idx] = { ...proj, engine, environments: envs };
      if (engine === 'wsl') next[idx].distro = distro;
      await saveProjects(next); provider.refresh();
    }),
    vscode.commands.registerCommand('cpt.open', async (item) => {
      if (item && item.openUri) await openProject(item.openUri);
    }),
    vscode.commands.registerCommand('cpt.stop', async (item) => {
      if (!item || !item.containerId) { vscode.window.showInformationMessage('Nothing to stop'); return; }
      await run(item.engine.exe, [...item.engine.prefix, 'stop', item.containerId]);
      provider.refresh();
    }),
    vscode.commands.registerCommand('cpt.rebuild', async (item) => {
      if (!item || !item.openUri) return;
      // コンテナと“そのイメージ”を削除してから開き直す（devcontainer.json 変更を確実に反映）。
      // イメージの devcontainer.metadata ラベルに postStartCommand 等が焼き込まれるため、
      // イメージを残すと firewall OFF 等が効かず postStartCommand が再実行される。
      if (item.containerId) {
        const image = ((await run(item.engine.exe, [...item.engine.prefix, 'inspect', item.containerId, '--format', '{{.Config.Image}}'])) || '').trim();
        await run(item.engine.exe, [...item.engine.prefix, 'rm', '-f', item.containerId]);
        if (image) {
          await run(item.engine.exe, [...item.engine.prefix, 'rmi', '-f', image]);
          const sib = image.endsWith('-uid') ? image.slice(0, -4) : image + '-uid';
          await run(item.engine.exe, [...item.engine.prefix, 'rmi', '-f', sib]);
        }
      }
      await openProject(item.openUri);
    }),
    vscode.commands.registerCommand('cpt.firewallOn',  (item) => setFirewallState(item, true)),
    vscode.commands.registerCommand('cpt.firewallOff', (item) => setFirewallState(item, false)),
    vscode.commands.registerCommand('cpt.editDockerfile', async (item) => {
      if (!item || !item.envObj) return;
      const file = path.join(envDevDir(item.envObj), 'Dockerfile');
      if (!fs.existsSync(file)) { vscode.window.showErrorMessage(`Not found: ${file}`); return; }
      try { await vscode.window.showTextDocument(vscode.Uri.file(file)); }
      catch (e) { vscode.window.showErrorMessage('Failed to open Dockerfile: ' + e.message); }
    }),
    vscode.commands.registerCommand('cpt.editFirewall', async (item) => {
      if (!item || !item.envObj) return;
      const file = path.join(envDevDir(item.envObj), 'init-firewall.sh');
      if (!fs.existsSync(file)) { vscode.window.showErrorMessage(`Not found: ${file}`); return; }
      try { await vscode.window.showTextDocument(vscode.Uri.file(file)); }
      catch (e) { vscode.window.showErrorMessage('Failed to open init-firewall.sh: ' + e.message); }
    }),
    vscode.commands.registerCommand('cpt.resyncTemplate', async (item) => {
      if (!item || !item.envObj) return;
      const tplName = (item.envObj && item.envObj.template) || DEFAULT_TPL;
      // Pick which files to re-apply. Dockerfile & init-firewall come from the chosen template;
      // devcontainer.json is regenerated from the current env settings (shared/firewall/baseImage).
      const picks = await vscode.window.showQuickPick(
        [
          { label: '$(file) Dockerfile', f: 'Dockerfile', picked: true, description: `bakes in FROM ${(item.envObj && item.envObj.baseImage) || 'node:20'}` },
          { label: '$(shield) init-firewall.sh', f: 'init-firewall.sh', picked: true },
          { label: '$(json) devcontainer.json', f: 'devcontainer.json', picked: false, regen: true, description: 'regenerate mounts / firewall from current settings' }
        ],
        { canPickMany: true, placeHolder: `Re-apply for "${item.envLabel}" — template "${tplName}" (uncheck to skip)` }
      );
      if (!picks || !picks.length) return;
      try {
        const devDir = envDevDir(item.envObj);
        fs.mkdirSync(devDir, { recursive: true });
        for (const p of picks) {
          if (p.regen) {
            const proj = getProjects().find(pr => pr.name === item.projectName) || {};
            const envCfg = item.envObj || {};
            const lbl = envCfg.label || item.envLabel;
            const vol = volName(`${item.projectName}-${lbl}`);
            const fwOn = envCfg.firewall !== 'off';
            fs.writeFileSync(path.join(devDir, 'devcontainer.json'),
              devcontainerJson(item.projectName, lbl, vol, !!proj.shared, fwOn), 'utf8');
            continue;
          }
          let content = readTemplate(tplName, p.f);
          if (p.f === 'Dockerfile') content = applyBaseImageToDockerfile(content, (item.envObj || {}).baseImage);
          if (p.f === 'init-firewall.sh') content = content.replace(/\r\n/g, '\n');
          fs.writeFileSync(path.join(devDir, p.f), content, 'utf8');
        }
        const names = picks.map(p => p.f).join(' + ');
        vscode.window.showInformationMessage(`Re-applied ${names} for "${item.envLabel}" (template "${tplName}"). Rebuild to apply.`);
      } catch (e) { vscode.window.showErrorMessage('Failed to re-apply template: ' + e.message); }
    }),
    vscode.commands.registerCommand('cpt.deleteVolume', async (item) => {
      const names = (item && item.volNames) || (item && item.volName ? [item.volName] : []);
      if (!names.length) return;
      const msg = item.contextValue === 'volenv'
        ? `Delete ${names.length} volume(s) of container "${item.confirmName || names[0]}". Data (including your work) will be lost.`
        : `Delete volume "${names[0]}". Its data will be lost.`;
      const ok = await vscode.window.showWarningMessage(msg, { modal: true, detail: names.join('\n') }, 'Delete');
      if (ok !== 'Delete') return;
      const title = names.length > 1 ? `Deleting ${names.length} volumes…` : `Deleting volume "${names[0]}"…`;
      const failed = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: false },
        async (progress) => {
          const failed = [];
          for (let i = 0; i < names.length; i++) {
            progress.report({ message: names[i], increment: (1 / names.length) * 100 });
            if ((await run(item.engineExe, [...item.enginePrefix, 'volume', 'rm', names[i]])) === null) failed.push(names[i]);
          }
          return failed;
        }
      );
      volProvider.refresh(); provider.refresh();
      if (failed.length) vscode.window.showErrorMessage(`Could not delete (maybe in use): ${failed.join(', ')}. Stop the container and retry.`);
      else vscode.window.showInformationMessage(`Deleted ${names.length} volume(s).`);
    }),
    vscode.commands.registerCommand('cpt.removeEnvironment', async (item) => {
      if (!item || !item.projectName || !item.envLabel) return;
      const choice = await vscode.window.showWarningMessage(
        `Delete container "${item.envLabel}". Also delete its volumes (data) and container image?`,
        { modal: true, detail: 'Volumes are kept by default.' }, 'Keep volumes', 'Delete volumes & images');
      if (!choice) return;
      const projects = getProjects(); const idx = projects.findIndex(p => p.name === item.projectName);
      if (idx < 0) return;
      const envs = envsOf(projects[idx]);
      const e = envs.find(x => x.label === item.envLabel);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Deleting container "${item.envLabel}"…`, cancellable: false },
        async (progress) => {
          if (choice === 'Delete volumes & images' && e) {
            progress.report({ message: 'removing container, image and volumes' });
            await deleteEnvVolumes(item.projectName, e);
          } else {
            progress.report({ message: 'removing settings entry' });
          }
          const next = projects.slice();
          next[idx] = { ...projects[idx], environments: envs.filter(x => x.label !== item.envLabel) };
          await saveProjects(next);
        }
      );
      provider.refresh(); volProvider.refresh();
      vscode.window.showInformationMessage(`Deleted container "${item.envLabel}".`);
    }),
    vscode.commands.registerCommand('cpt.removeProject', async (item) => {
      if (!item || !item.projectName) return;
      const choice = await vscode.window.showWarningMessage(
        `Delete project "${item.projectName}". Also delete volumes and container images of all its containers?`,
        { modal: true, detail: 'Volumes are kept by default.' }, 'Keep volumes', 'Delete volumes & images');
      if (!choice) return;
      const projects = getProjects(); const idx = projects.findIndex(p => p.name === item.projectName);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Deleting project "${item.projectName}"…`, cancellable: false },
        async (progress) => {
          if (idx >= 0 && choice === 'Delete volumes & images') {
            const envs = envsOf(projects[idx]);
            for (let i = 0; i < envs.length; i++) {
              progress.report({ message: `container ${envs[i].label} (${i + 1}/${envs.length})`, increment: (1 / (envs.length + 1)) * 100 });
              await deleteEnvVolumes(item.projectName, envs[i]);
            }
            progress.report({ message: 'shared volumes', increment: (1 / (envs.length + 1)) * 100 });
            const seen = new Set();
            for (const e of envs) {
              const key = e.engine === 'wsl' ? `wsl:${e.distro}` : 'win';
              if (seen.has(key)) continue; seen.add(key);
              const exe = e.engine === 'wsl' ? 'wsl.exe' : 'docker';
              const prefix = e.engine === 'wsl' ? ['-d', e.distro, 'docker'] : [];
              await run(exe, [...prefix, 'volume', 'rm', sharedVolName(item.projectName)]);
            }
          } else {
            progress.report({ message: 'removing settings entry' });
          }
          await saveProjects(getProjects().filter(p => p.name !== item.projectName));
        }
      );
      provider.refresh(); volProvider.refresh();
      vscode.window.showInformationMessage(`Deleted project "${item.projectName}".`);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cpt.projects')) { provider.refresh(); volProvider.refresh(); }
    })
  );

  // View 登録（manifest 未反映でも他機能を壊さないよう個別に保護）。
  try {
    treeView = vscode.window.createTreeView('cpt.envs', { treeDataProvider: provider });
    // Track selected env items so envTreeItem can render the bright (active) cube icon for them.
    const onSelectionChange = treeView.onDidChangeSelection((ev) => {
      provider.selectedKeys.clear();
      for (const it of ev.selection) {
        if (it && it.projectName && it.envLabel) provider.selectedKeys.add(`${it.projectName}:${it.envLabel}`);
      }
      provider.refresh();
    });
    context.subscriptions.push(treeView, onSelectionChange, treeView.onDidChangeVisibility((e) => { if (e.visible) autoRefresh(); }));
  } catch (e) { /* 完全再起動で解消 */ }
  try {
    volView = vscode.window.createTreeView('cpt.volumes', { treeDataProvider: volProvider });
    context.subscriptions.push(volView, volView.onDidChangeVisibility((e) => { if (e.visible) volProvider.refresh(); }));
  } catch (e) {
    vscode.window.showWarningMessage('Containers Project Tree: the "Volume" view is not registered. Fully quit and reopen VS Code to show it.');
  }
}
function deactivate() {}
module.exports = { activate, deactivate };
