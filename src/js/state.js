/* ============================================================
   DATA + UTILITIES
   ============================================================ */

export const state = {
    dark: false,
    nodes: [],
    wires: [],
    zoom: 1,
    panX: 0,
    panY: 0,
    projectName: 'untitled',
    globalVars: [
        { name: 'device_id', type: 'string', value: '', fixed: true },
    ],
    dirty: false,
    // M2: device preview widget state
    devicePreview: {
        folded: true,                // 初始折叠
        source: null,                // 'backend' | 'local' | 'fetching' | null
        serial: null,                // 当前显示的是哪个设备
        blobUrl: null,               // object URL
        width: 0,
        height: 0,
        pickedPoint: null,           // {x, y, rgb: [r,g,b]} — click 选点
        hoverPoint: null,            // {x, y, rgb} | null — 鼠标悬浮实时（用于 infobar 第二行）
        pickerMode: true,            // 默认就是选点模式（M2 取消了选点按钮,渲染图片即 attach）
        fetching: false,             // 后端截图 in-flight
        inflightSerial: null,        // race 防护：当前 in-flight 请求的 serial
        foregroundApp: '',           // 当前前台 app "package/activity"
    },
    // M1: device selection per backend
    // selectedDeviceByBackend: {[backendId]: serial | undefined}
    // deviceListByBackend:    {[backendId]: Device[]}
    selectedDeviceByBackend: {},
    deviceListByBackend: {},
};

/* ============================================================
   M1: DEVICE SELECTION PERSISTENCE
   ============================================================ */

const LS_KEY_SELECTED_DEVICE = 'dtf:selected_device_by_backend';

export function setSelectedDevice(backendId, serial) {
    if (!backendId) return;
    if (serial) {
        state.selectedDeviceByBackend[backendId] = serial;
    } else {
        delete state.selectedDeviceByBackend[backendId];
    }
    try {
        localStorage.setItem(LS_KEY_SELECTED_DEVICE,
            JSON.stringify(state.selectedDeviceByBackend));
    } catch (e) { /* quota etc. */ }
}

export function getSelectedDevice(backendId) {
    if (!backendId) return undefined;
    return state.selectedDeviceByBackend[backendId];
}

export function loadSelectedDeviceFromStorage() {
    try {
        const raw = localStorage.getItem(LS_KEY_SELECTED_DEVICE);
        if (raw) state.selectedDeviceByBackend = JSON.parse(raw) || {};
    } catch (e) { /* corrupt json */ }
}

export function setDeviceList(backendId, devices) {
    if (!backendId) return;
    state.deviceListByBackend[backendId] = devices || [];
}

/**
 * Task definitions (name, alias, params, rets).
 * Populated at startup from public/preset_task.py (preset cards)
 * and the user workspace custom_task.py (custom overrides).
 * Do NOT hardcode entries here — add them to preset_task.py instead.
 */
export const DEFS = {};

/** Custom task function sources, keyed by def name. Populated by task-palette.js. */
export const _customTaskSources = {};

/* ============================================================
   COLORS
   ============================================================ */
export function portColor(seed, idx, total) {
    // 默认端口色 --port-default = oklch(0.62 0.02 270)（色相 270 的灰紫）。
    // 生成色相避开其附近 270±20，否则部分端口颜色与默认色几乎无法区分。
    // 做法：原始色相 < 249.5 的保留，>= 249.5 的整体右移 40。
    // 分段阈值取 249.5（而非 250）：h.toFixed(0) 四舍五入会把 249.5→250 拉回禁区，
    // 故让 <249.5 舍到 ≤249、>=249.5 舍到 ≥290，输出色相恒避开 [250,290)。
    const D = 20, LO = 270 - D, W = 2 * D;
    const raw = ((seed * 137 + idx * 137.5) % 360 + 360) % 360;
    const h = Math.round(raw < LO - 0.5 ? raw : raw + W) % 360;
    const L = 0.58 + (total > 1 ? (idx / (total - 1)) * 0.12 : 0);
    const C = 0.16 + (idx % 2) * 0.04;
    return `oklch(${L.toFixed(2)} ${C.toFixed(2)} ${h})`;
}
export function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i); return Math.abs(h); }

/* ============================================================
   STATE QUERIES
   ============================================================ */

/**
 * 规范化节点的 LOGIC 分区结构（多列模型）。
 *
 * `n.logic` 从 `Task[]`（旧，扁平）改为 `Task[][]`（新，每列一个数组）。
 * - 旧扁平数组自动迁移为单列 `[[...tasks]]`
 * - 显示规则：只要任一子列有卡片，就**保留所有子列（含空列）**——空子列也不隐藏、参与宽度均分
 * - 全部子列都空 → 重置为 `[]`（回到无 LOGIC 状态）
 *
 * 在 render() 与 fromPythonDSL 时调用，幂等。
 */
export function normalizeLogic(node) {
    if (!node.logic || !Array.isArray(node.logic)) node.logic = [];
    // 旧扁平数组 → 单列。
    // 用"是否含数组元素"判断列结构（而非看首元素）：首元素可能是 undefined（跳列空洞），
    // 旧扁平结构是纯 task 对象数组（无数组元素）。
    if (node.logic.length && !node.logic.some(el => Array.isArray(el))) {
        node.logic = [node.logic];
    }
    const anyCards = node.logic.some(c => Array.isArray(c) && c.length > 0);
    if (anyCards) {
        // LOGIC 激活：保留所有子列（跳过稀疏空洞），空列不删
        node.logic = node.logic.filter(c => Array.isArray(c));
    } else {
        node.logic = [];
    }
    return node.logic;
}

/** 某个任务在 LOGIC 分区中的列下标；不在 LOGIC 中则返回 null */
export function logicColOf(taskId) {
    for (const n of state.nodes) {
        for (let i = 0; i < (n.logic || []).length; i++) {
            if ((n.logic[i] || []).find(t => t.id === taskId)) return i;
        }
    }
    return null;
}

export function find(id) {
    for (const n of state.nodes) {
        for (const t of (n.info || [])) if (t.id === id) return t;
        for (const col of (n.logic || [])) for (const t of col) if (t.id === id) return t;
        for (const g of (n.groups || [])) {
            if (g.id === id) return g;
            for (const o of g.ops) if (o.id === id) return o;
        }
    }
    return null;
}

/**
 * 减少入口时选择要删除的端口下标。
 * 优先：未连线的入口（自下而上找第一个未连线）；兜底：全连线则删最底部。
 * @param {object} state 含 state.wires
 * @param {string} nodeId 节点 id
 * @param {string[]} inPorts 当前入口端口名数组
 * @returns {number} 要删除的下标
 */
export function pickInputToRemove(state, nodeId, inPorts) {
    for (let i = inPorts.length - 1; i >= 0; i--) {
        const wired = state.wires.some(w => w.to === nodeId + '.' + inPorts[i]);
        if (!wired) return i;
    }
    return inPorts.length - 1;
}

/**
 * 生成下一个入口端口名（保证不与已有入口撞名）。
 * 命名规则：in, in2, in3, ...（in 视作 1 号）。若用「长度+1」命名，删掉中间
 * 入口后长度错位会撞名（如 ['in','in3'] 再添加得 'in3' → 两个端口同一个 id，
 * 连一个变连两个、同色、删一个清共用线）。改为取最小可用后缀。
 * @param {string[]} inPorts 当前入口端口名数组
 * @returns {string} 新的唯一入口名
 */
export function nextInPortName(inPorts) {
    let i = 1;
    while (inPorts.includes(i === 1 ? 'in' : 'in' + i)) i++;
    return i === 1 ? 'in' : 'in' + i;
}

export function colOf(taskId) {
    for (const n of state.nodes) {
        for (const g of (n.groups || [])) { if (g.id === taskId) return 'operate'; }
        if ((n.info || []).find(t => t.id === taskId)) return 'info';
        if ((n.logic || []).some(col => col.find(t => t.id === taskId))) return 'logic';
        for (const g of (n.groups || [])) {
            if ((g.ops || []).find(t => t.id === taskId)) return 'operate';
        }
    }
    return null;
}

export function nodeOf(taskId) {
    for (const n of state.nodes) {
        if (n.id === taskId) return n.id;
    }
    for (const n of state.nodes) {
        for (const g of (n.groups || [])) { if (g.id === taskId) return n.id; }
        if ((n.info || []).find(t => t.id === taskId)) return n.id;
        if ((n.logic || []).some(col => col.find(t => t.id === taskId))) return n.id;
        for (const g of (n.groups || [])) {
            if ((g.ops || []).find(t => t.id === taskId)) return n.id;
        }
    }
    return null;
}

export function isValidConnection(fromTaskId, toTaskId, fromDir, toDir) {
    if (fromTaskId === toTaskId) return false;
    const fromNode = nodeOf(fromTaskId), toNode = nodeOf(toTaskId);
    if (!fromNode || !toNode) return false;
    const fromIsNode = fromNode === fromTaskId;
    const toIsNode = toNode === toTaskId;
    const sameNode = fromNode === toNode;

    // Direction check: target 'out' ports only valid for 操作组出口→节点出口
    if (toDir === 'out') {
        const fromGroup = state.nodes.flatMap(n => n.groups || []).find(g => g.id === fromTaskId);
        if (!(fromGroup && toIsNode && sameNode)) return false;
    }

    if (fromIsNode && toIsNode) return fromNode !== toNode;
    if (fromIsNode) {
        const toGroup = state.nodes.flatMap(n => n.groups || []).find(g => g.id === toTaskId);
        if (toGroup && sameNode) return true;
    }
    const fromGroup = state.nodes.flatMap(n => n.groups || []).find(g => g.id === fromTaskId);
    if (fromGroup && toIsNode && sameNode) return true;

    if (sameNode) {
        const fc = colOf(fromTaskId), tc = colOf(toTaskId);
        if (fc === 'info' && tc === 'logic') return true;
        if (fc === 'logic') {
            // LOGIC 子列间连线：仅允许前一列出口 → 相邻后一列入口（纯数据传递，不控制执行顺序）
            if (tc === 'logic') {
                const fCol = logicColOf(fromTaskId), tCol = logicColOf(toTaskId);
                if (fCol != null && tCol != null && fCol + 1 === tCol) return true;
                return false;
            }
            if (tc === 'operate') return true;
            const toGroup = state.nodes.flatMap(n => n.groups || []).find(g => g.id === toTaskId);
            if (toGroup) return true;
        }
    }
    return false;
}

/* ============================================================
   TOAST
   ============================================================ */
const TOAST_MS = 2000;
let _toastContainer = null;

function _getToastContainer() {
    if (!_toastContainer) {
        _toastContainer = document.createElement('div');
        _toastContainer.className = 'toast-container';
        document.body.appendChild(_toastContainer);
    }
    return _toastContainer;
}

export function toast(msg) {
    const container = _getToastContainer();
    const t = document.createElement('div');
    // Start collapsed so existing toasts are pushed up smoothly
    t.className = 'toast toast--entering';
    t.textContent = msg;

    let timer;

    t.addEventListener('mouseenter', () => {
        clearTimeout(timer);
        t.classList.add('toast--pinned');
    });
    t.addEventListener('mouseleave', () => {
        t.classList.remove('toast--pinned');
        timer = setTimeout(() => _dismiss(t), TOAST_MS);
    });

    container.appendChild(t);

    // Trigger expand animation on next frame
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            t.classList.remove('toast--entering');
            t.classList.add('toast--show');
            timer = setTimeout(() => _dismiss(t), TOAST_MS);
        });
    });
}

function _dismiss(t) {
    t.classList.add('toast--leaving');
    t.classList.remove('toast--show');
    // Remove from DOM after collapse animation completes
    setTimeout(() => { t.remove(); }, 300);
}
