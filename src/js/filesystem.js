/* ============================================================
   FILE SYSTEM — File System Access API + IndexedDB + Pyodide
   ============================================================ */
import { state } from './state.js';
import { toast } from './state.js';
import { toPythonDSL, fromPythonDSL } from './datamapper.js';
import { render } from './render.js';
import { renderGlobalVars } from './global-vars.js';
import { clearHistory } from './history.js';
import { t } from './i18n.js';

// Tool module sources (Vite ?raw — inlined at build time)
import adbToolPy from '../../droidtaskflow/tool/adb_tool.py?raw';
import llmToolPy from '../../droidtaskflow/tool/llm_tool.py?raw';
import ocrToolPy from '../../droidtaskflow/tool/ocr_tool.py?raw';
import imageToolPy from '../../droidtaskflow/tool/image_tool.py?raw';

const IDB_NAME = 'droidtaskflow';
const IDB_VERSION = 1;
let _dirHandle = null;
let _autoSaveTimer = null;

export function setDirHandle(h) { _dirHandle = h; }
export function getDirHandle() { return _dirHandle; }

function idbOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = () => { req.result.createObjectStore('settings'); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function storeDirHandle(handle) {
    const db = await idbOpen();
    const tx = db.transaction('settings', 'readwrite');
    tx.objectStore('settings').put(handle, 'dirHandle');
    return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}

export async function restoreDirHandle() {
    try {
        const db = await idbOpen();
        const tx = db.transaction('settings', 'readonly');
        const handle = await new Promise((resolve, reject) => {
            const req = tx.objectStore('settings').get('dirHandle');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        if (handle && (await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return handle;
    } catch (e) { /* no stored handle */ }
    return null;
}

const PROJECT_DIR = 'project';

/** Get or create the project/ subdirectory inside the workspace. */
export async function getProjectDir(dirHandle) {
    return dirHandle.getDirectoryHandle(PROJECT_DIR, { create: true });
}

/** Extract the project name from a .py file's content via regex (fast, no Pyodide). */
export async function getProjectName(dirHandle, filename) {
    const pd = await getProjectDir(dirHandle);
    const fh = await pd.getFileHandle(filename);
    const file = await fh.getFile();
    const code = await file.text();
    const m = code.match(/project\("([^"]+)"/);
    return m ? m[1] : filename.replace(/\.py$/, '');
}

/** Rename a project by replacing the project("...") call in the file. */
export async function renameProject(dirHandle, filename, newName) {
    const pd = await getProjectDir(dirHandle);
    const fh = await pd.getFileHandle(filename);
    const file = await fh.getFile();
    const code = await file.text();
    const updated = code.replace(/project\("([^"]*)"/, `project("${newName}"`);
    const writable = await fh.createWritable();
    await writable.write(updated);
    await writable.close();
}

/** Delete a project file from the project directory. */
export async function deleteProject(dirHandle, filename) {
    const pd = await getProjectDir(dirHandle);
    await pd.removeEntry(filename);
}

/** Copy a project file to a new UUID-named file. Returns the new filename. */
export async function copyProject(dirHandle, filename) {
    const pd = await getProjectDir(dirHandle);
    const src = await pd.getFileHandle(filename);
    const file = await src.getFile();
    const code = await file.text();
    const newFilename = crypto.randomUUID() + '.py';
    const fh = await pd.getFileHandle(newFilename, { create: true });
    const writable = await fh.createWritable();
    await writable.write(code);
    await writable.close();
    return newFilename;
}

/** Create a new project file with a UUID name. Returns the filename.
 * 
 * 不传 code：生成 NewProject 默认模板（仅含一个 start node + device_id 全局变量）。
 * 传 code：用 code 写文件，文件名前缀仍是 uuid（避免和现有工程冲突）。
 *   用例：自动化任务"提取脚本到工程"——后端从 bundle 读 main.py 内容，前端
 *   传 code 用真实工程内容（不是模板）。
 */
export async function createNewProject(dirHandle, code = null) {
    const pd = await getProjectDir(dirHandle);
    const uuid = crypto.randomUUID();
    const filename = uuid + '.py';
    if (!code) {
        // 默认 NewProject 模板（仅占位 start node，给用户一个起点）
        const startNodeId = 'n' + Date.now();
        code = `"""
@droidtaskflow:project
@droidtaskflow:version 1.0
"""
import sys
from pathlib import Path

try:
    from droidtaskflow import (
        project, start_node, node, node_info_task, node_logic_task,
        node_op_group, node_op_group_task, node_exit, edge, global_var,
    )
    from droidtaskflow.tool import adb_tool, llm_tool
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from droidtaskflow import (
        project, start_node, node, node_info_task, node_logic_task,
        node_op_group, node_op_group_task, node_exit, edge, global_var,
    )
    from droidtaskflow.tool import adb_tool, llm_tool

project("NewProject", version="1.0")
start_node("${startNodeId}")

global_var("device_id", "string", "")

@node("${startNodeId}", name="start", position={"x":100,"y":100})
@node_exit("out", "out")
def ${startNodeId}():
    pass


if __name__ == '__main__':
    try:
        __file__
        from droidtaskflow import run_project_file
        run_project_file(__file__)
    except NameError:
        pass  # Pyodide / embedded — no __file__, parse-only mode
`;
    }
    const fh = await pd.getFileHandle(filename, { create: true });
    const writable = await fh.createWritable();
    await writable.write(code);
    await writable.close();
    return filename;
}

/** List .py files in the project/ directory. */
export async function listProjectFiles(dirHandle) {
    try {
        const pd = await getProjectDir(dirHandle);
        const files = [];
        for await (const [name, handle] of pd.entries()) {
            if (handle.kind === 'file' && name.endsWith('.py')) files.push(name);
        }
        return files.sort();
    } catch (e) {
        console.warn('listProjectFiles failed:', e);
        return [];
    }
}

/**
 * 读工程文件的原始文本（不解析、不改状态、不加载 pyodide）。
 * 用于"从工程清单添加脚本"：工程文件本身就是 toPythonDSL 产物，
 * 其文本可直接作为自动化 bundle 的 main.py。
 */
export async function readProjectSource(dirHandle, filename) {
    const pd = await getProjectDir(dirHandle);
    const fileHandle = await pd.getFileHandle(filename);
    const file = await fileHandle.getFile();
    return await file.text();
}

/** Load and parse a specific project file into application state. */
export async function loadProjectFile(dirHandle, filename) {
    const pd = await getProjectDir(dirHandle);
    const fileHandle = await pd.getFileHandle(filename);
    const file = await fileHandle.getFile();
    const code = await file.text();
    const pyDict = await pyodideParse(code);
    fromPythonDSL(pyDict, state);
    render();
    renderGlobalVars();
    state.dirty = false;
    clearHistory();   // 加载工程 → 历史清空
}

export async function openDirectory() {
    if (!window.showDirectoryPicker) {
        toast(t('toast.noFSApi'));
        return null;
    }
    try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        setDirHandle(handle);

        // Post-picker operations — wrap with a timeout because some
        // environments (VS Code webview, etc.) may hang on IndexedDB
        // or file operations without surfacing an error.
        const done = (async () => {
            // IndexedDB may hang in constrained environments — give it
            // its own short timeout so it never blocks the rest.
            const idbTimeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(t('toast.idbTimeout'))), 3000)
            );
            try {
                await Promise.race([storeDirHandle(handle), idbTimeout]);
            } catch (e) {
                toast(t('toast.dirPermFail', { msg: e.message || t('toast.unknown') }));
            }
            toast(t('toast.dirBound'));
            return handle;
        })();

        const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(t('toast.opTimeout'))), 10000)
        );

        return await Promise.race([done, timeout]);
    } catch (e) {
        if (e.name === 'AbortError') return null;
        toast(t('toast.dirChooseFail', { msg: e.message || t('toast.dirPermHint') }));
        return null;
    }
}

export async function saveToFile(state, dirHandle, filename = 'main.py') {
    const projectDir = await getProjectDir(dirHandle);
    const code = toPythonDSL(state);
    const fileHandle = await projectDir.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(code);
    await writable.close();
}

let _pyodide = null;
let _pyodideLoading = null;

export async function getPyodide() {
    if (_pyodide) return _pyodide;
    if (_pyodideLoading) return _pyodideLoading;
    toast(t('toast.pyInit'));
    _pyodideLoading = (async () => {
        const py = await loadPyodide({ indexURL: '/pyodide/' });
        await py.runPythonAsync(`
import sys
from types import ModuleType

_dtf = ModuleType('droidtaskflow')
_dtf_dsl = ModuleType('droidtaskflow.dsl')
_dtf_tool = ModuleType('droidtaskflow.tool')
_dtf.dsl = _dtf_dsl
_dtf.tool = _dtf_tool
sys.modules['droidtaskflow'] = _dtf
sys.modules['droidtaskflow.dsl'] = _dtf_dsl
sys.modules['droidtaskflow.tool'] = _dtf_tool

# ── dynamic tool sub-module loader ──
def _load_tool_module(name, code):
    """Create droidtaskflow.tool.<name> and exec code into its namespace."""
    full_name = f'droidtaskflow.tool.{name}'
    if full_name not in sys.modules:
        sub = ModuleType(full_name)
        sys.modules[full_name] = sub
        setattr(_dtf_tool, name, sub)
    exec(code, sys.modules[full_name].__dict__)

# ── project context (single-threaded; no threading.local needed) ──
_project_ctx = {}

def _get_project():
    if 'p' not in _project_ctx:
        _project_ctx['p'] = {
            'metadata': {},
            'global_vars': {},
            'start_node_id': None,
            'nodes': {},
            'edges': [],
            '_current_node_id': None,
            '_current_op_group_id': None,
        }
    return _project_ctx['p']

def _reset_project():
    _project_ctx.pop('p', None)

def project(name, version="1.0"):
    ctx = _get_project()
    ctx['metadata'] = {'name': name, 'version': version}

def start_node(node_id):
    ctx = _get_project()
    ctx['start_node_id'] = node_id

def global_var(name, type, default, description=""):
    ctx = _get_project()
    ctx['global_vars'][name] = {
        'name': name,
        'type': type,
        'default': default,
        'description': description,
    }

def node(id, name="", position=None, width=None, col_fractions=None, type=None, target="", in_ports=None):
    ctx = _get_project()
    if position is None:
        position = {'x': 0, 'y': 0}
    n = {
        'id': id,
        'name': name or id,
        'position': position,
        'info_tasks': [],
        'logic_tasks': [],
        'operation_groups': [],
        'exits': {},
    }
    if width is not None:
        n['width'] = width
    if col_fractions is not None:
        n['col_fractions'] = col_fractions
    if type:
        n['type'] = type
    if target:
        n['target'] = target
    if in_ports:
        n['in_ports'] = in_ports
    ctx['nodes'][id] = n
    ctx['_current_node_id'] = id
    def decorator(func):
        return func
    return decorator

def node_info_task(task_name, alias=None, id=None, **params):
    ctx = _get_project()
    node_id = ctx['_current_node_id']
    wires = params.pop('wires', {})
    ctx['nodes'][node_id]['info_tasks'].append({
        'id': id or f"{node_id}_info_{len(ctx['nodes'][node_id]['info_tasks'])}",
        'task_name': task_name,
        'alias': alias,
        'param_values': params,
        'wire_inputs': wires,
    })
    return lambda func: func

def node_logic_task(task_name, alias=None, column=0, id=None, **params):
    ctx = _get_project()
    node_id = ctx['_current_node_id']
    wires = params.pop('wires', {})
    ctx['nodes'][node_id]['logic_tasks'].append({
        'id': id or f"{node_id}_logic_{len(ctx['nodes'][node_id]['logic_tasks'])}",
        'task_name': task_name,
        'alias': alias,
        'column': column,
        'param_values': params,
        'wire_inputs': wires,
    })
    return lambda func: func

def node_op_group(id, name="", forced=False, exit=None, trigger=None):
    ctx = _get_project()
    node_id = ctx['_current_node_id']
    ctx['nodes'][node_id]['operation_groups'].append({
        'id': id,
        'name': name or id,
        'forced': forced,
        'exit': exit,
        'trigger': trigger,
        'external_inputs': [],
        'operations': [],
    })
    ctx['_current_op_group_id'] = id
    return lambda func: func

def node_op_group_task(task_name, alias=None, id=None, **params):
    ctx = _get_project()
    node_id = ctx['_current_node_id']
    op_group_id = ctx['_current_op_group_id']
    wires = params.pop('wires', {})
    for group in ctx['nodes'][node_id]['operation_groups']:
        if group['id'] == op_group_id:
            group['operations'].append({
                'id': id or f"{op_group_id}_op_{len(group['operations'])}",
                'task_name': task_name,
                'alias': alias,
                'param_values': params,
                'wire_inputs': wires,
            })
            break
    return lambda func: func

def node_exit(name, label=""):
    ctx = _get_project()
    node_id = ctx['_current_node_id']
    ctx['nodes'][node_id]['exits'][name] = {
        'name': name,
        'label': label or name,
    }
    return lambda func: func

def edge(from_node, from_exit, to_node, to_port="in"):
    ctx = _get_project()
    ctx['edges'].append({
        'from_node': from_node,
        'from_exit': from_exit,
        'to_node': to_node,
        'to_port': to_port,
    })

# ── task collector ──
class _TaskCollector:
    def __init__(self):
        self._cards = []
    def info_task(self, name, alias=None, params=None, rets=None):
        def deco(fn):
            self._cards.append({'key': name, 'alias': alias or name, 'category': 'info', 'params': params or {}, 'rets': rets or []})
            return fn
        return deco
    def logic_task(self, name, alias=None, params=None, rets=None):
        def deco(fn):
            self._cards.append({'key': name, 'alias': alias or name, 'category': 'logic', 'params': params or {}, 'rets': rets or []})
            return fn
        return deco
    def operate_task(self, name, alias=None, params=None, rets=None):
        def deco(fn):
            self._cards.append({'key': name, 'alias': alias or name, 'category': 'operate', 'params': params or {}, 'rets': rets or []})
            return fn
        return deco
    def _get_tasks(self):
        return self._cards
    def _reset_tasks(self):
        self._cards = []

_collector = _TaskCollector()

# ── attach everything to droidtaskflow.dsl ──
dsl_mod = sys.modules['droidtaskflow.dsl']
dsl_mod._get_project = _get_project
dsl_mod._reset_project = _reset_project
dsl_mod.project = project
dsl_mod.start_node = start_node
dsl_mod.global_var = global_var
dsl_mod.node = node
dsl_mod.node_info_task = node_info_task
dsl_mod.node_logic_task = node_logic_task
dsl_mod.node_op_group = node_op_group
dsl_mod.node_op_group_task = node_op_group_task
dsl_mod.node_exit = node_exit
dsl_mod.edge = edge
dsl_mod.info_task = _collector.info_task
dsl_mod.logic_task = _collector.logic_task
dsl_mod.operate_task = _collector.operate_task
dsl_mod._get_tasks = _collector._get_tasks
dsl_mod._reset_tasks = _collector._reset_tasks

# ── also expose DSL functions on droidtaskflow directly ──
_dtf_full = sys.modules['droidtaskflow']
_dsl_names = [
    '_get_project', '_reset_project',
    'project', 'start_node', 'node', 'node_info_task', 'node_logic_task',
    'node_op_group', 'node_op_group_task', 'node_exit', 'edge', 'global_var',
]
for _n in _dsl_names:
    setattr(_dtf_full, _n, getattr(dsl_mod, _n))
        `);
        _pyodide = py;
        toast(t('toast.pyReady'));
        return py;
    })();
    return _pyodideLoading;
}

export async function pyodideParse(code) {
    const py = await getPyodide();
    await py.runPythonAsync(code);
    const result = py.runPython(`
import json, droidtaskflow.dsl as dsl
ctx = dsl._get_project()
json.dumps({
    'metadata': ctx.get('metadata', {}),
    'global_vars': ctx.get('global_vars', {}),
    'start_node_id': ctx.get('start_node_id', ''),
    'nodes': ctx.get('nodes', {}),
    'edges': ctx.get('edges', []),
})
    `);
    py.runPython('import sys; sys.modules["droidtaskflow.dsl"]._reset_project()');
    return JSON.parse(result);
}

export function scheduleAutoSave(state, filename) {
    if (!_dirHandle) return;
    if (!filename) return;  // no current project — don't auto-save
    clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(async () => {
        try { await saveToFile(state, _dirHandle, filename); } catch (e) { console.warn('Auto-save failed:', e); }
    }, 180000);
}

/**
 * Parse custom_task.py via Pyodide and return card definitions.
 * Each card: { key, alias, category, params: [{n, a, t}], rets: [{n, a}], source: string }
 */
async function parseCustomTaskFile(code) {
    const py = await getPyodide();
    py.runPython('import sys; sys.modules["droidtaskflow.dsl"]._reset_tasks()');
    try {
        await py.runPythonAsync(code);
    } catch (e) {
        return { cards: [], error: t('toast.customParseFail', { msg: e.message }) };
    }
    const raw = py.runPython('import sys, json; json.dumps(sys.modules["droidtaskflow.dsl"]._get_tasks())');
    const rawCards = JSON.parse(raw);
    // Extract function source from the original code for each card
    const cards = rawCards.map(c => {
        const source = extractFunctionSource(code, c.key);
        const paramsArr = [];
        for (const [pn, pt] of Object.entries(c.params || {})) {
            if (!pt || typeof pt !== 'object') {
                throw new Error(t('toast.paramObjFormat', { pn }));
            }
            paramsArr.push({
                n: pn, a: pn, t: pt.type, w: pt.ui_width,
                init: pt.init_value != null ? pt.init_value : '',
                opts: pt.opts || pt.options || [],   // list 类型下拉选项
            });
        }
        const retsArr = (c.rets || []).map(r => ({ n: r, a: r }));
        return { key: c.key, alias: c.alias, category: c.category, params: paramsArr, rets: retsArr, source };
    });
    return { cards, error: null };
}

/** Extract function source code for a given function name from Python code. */
function extractFunctionSource(code, funcName) {
    const lines = code.split('\n');
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trimStart().startsWith(`def ${funcName}(`)) { start = i; break; }
    }
    if (start === -1) return '';
    // Collect decorator lines before the def
    let decoStart = start;
    while (decoStart > 0 && lines[decoStart - 1].trimStart().startsWith('@')) decoStart--;
    const sourceLines = [];
    for (let i = decoStart; i < lines.length; i++) {
        const line = lines[i];
        sourceLines.push(line);
        // End of function: next line at same indent level (not inside function body)
        if (i > start) {
            const nextLine = i + 1 < lines.length ? lines[i + 1] : null;
            if (nextLine === null) break;
            if (nextLine.trim() !== '' && nextLine.length > 0 && nextLine[0] !== ' ' && nextLine[0] !== '\t') {
                // Check if next non-empty line is at module level
                if (!nextLine.startsWith(' ') && nextLine.trim()) break;
            }
        }
    }
    return sourceLines.join('\n');
}

/** Fetch and parse the built-in preset tasks from the server. */
export async function loadPresetTasks() {
    try {
        const resp = await fetch('/preset_task.py');
        if (!resp.ok) {
            console.warn('preset_task.py not found (HTTP ' + resp.status + ')');
            return { cards: [], error: null };
        }
        const code = await resp.text();
        return await parseCustomTaskFile(code);
    } catch (e) {
        console.warn('Failed to load preset_task.py:', e);
        return { cards: [], error: null };
    }
}

export async function loadCustomTasks() {
    const dh = getDirHandle();
    if (!dh) return { cards: [], error: null };
    try {
        const fh = await dh.getFileHandle('custom_task.py');
        const file = await fh.getFile();
        const code = await file.text();
        return await parseCustomTaskFile(code);
    } catch (e) {
        if (e.name === 'NotFoundError') {
            // File doesn't exist — create empty template
            await createEmptyCustomTaskFile(dh);
            return { cards: [], error: null };
        }
        // File exists but can't be read (permission, etc.) — don't overwrite
        console.warn('Cannot read custom_task.py:', e);
        return { cards: [], error: t('toast.customReadFail', { msg: e.message }) };
    }
}

export async function createEmptyCustomTaskFile(dirHandle) {
    // Never overwrite an existing custom_task.py
    try {
        const existing = await dirHandle.getFileHandle('custom_task.py');
        // File already exists — don't touch it
        return;
    } catch (e) {
        if (e.name !== 'NotFoundError') throw e;
    }

    const template = `"""
@droidtaskflow:custom_cards
@droidtaskflow:version 1.0
"""
from droidtaskflow.dsl import info_task, logic_task, operate_task
# from droidtaskflow.tool import adb_tool, llm_tool

# INFO cards example:
# @info_task("my_ocr", alias="自定义OCR",
#     params={
#         "language": {"type": "box", "ui_width": 1, "init_value": "中文"},
#         "threshold": {"type": "box", "ui_width": 1, "init_value": "0.8"},
#     },
#     rets=["ocr_result", "confidence"])
# def my_ocr(language="中文", threshold=0.8):
#     from droidtaskflow.tool import ocr
#     return ocr.recognize(language=language, threshold=threshold)

# LOGIC cards example:
# @logic_task("my_check", alias="条件检查",
#     params={
#         "condition": {"type": "line", "ui_width": 1, "init_value": ""},
#         "expression": {"type": "code", "ui_width": 1, "init_value": ""},
#     },
#     rets=["true_out", "false_out"])
# def my_check(condition=None, expression=""):
#     from droidtaskflow.tool import check
#     return check.evaluate(condition, expression)

# OPERATE cards example:
# @operate_task("my_tap", alias="自定义点击",
#     params={
#         "x": {"type": "both", "ui_width": 0.5, "init_value": 540},
#         "y": {"type": "both", "ui_width": 0.5, "init_value": 960},
#     })
# def my_tap(x=100, y=200):
#     from droidtaskflow.tool import touch
#     touch.tap(x, y)
`;
    const fh = await dirHandle.getFileHandle('custom_task.py', { create: true });
    const writable = await fh.createWritable();
    await writable.write(template);
    await writable.close();
}

/**
 * Load tool .py modules into droidtaskflow.tool.<name> in Pyodide.
 * Sources are inlined at build time via Vite ?raw imports.
 * Called once on startup — Pyodide is lazy-init'd by getPyodide().
 */
export async function loadToolFiles() {
    const py = await getPyodide();
    const toolModules = {
        'adb_tool': adbToolPy,
        'llm_tool': llmToolPy,
        'ocr_tool': ocrToolPy,
        'image_tool': imageToolPy,
    };

    for (const [name, code] of Object.entries(toolModules)) {
        py.runPython(`
import sys
_mod_name = '${name}'
_mod_code = ${JSON.stringify(code)}
_dtf_tool = sys.modules['droidtaskflow.tool']
_load_tool_module(_mod_name, _mod_code)
        `);
    }
}

