/* ============================================================
   DATA MAPPER — Python DSL conversion + merged runtime bundle
   ============================================================ */
import { state, DEFS, nodeOf, _customTaskSources, normalizeLogic } from './state.js';
import { gotoMarkerPortName, parseGotoMarkerPort } from './goto.js';

// Vite ?raw imports: droidtaskflow Python modules inlined at build time
import decoratorsPy from '../../droidtaskflow/decorators.py?raw';
import modelsPy from '../../droidtaskflow/models.py?raw';
import dslPy from '../../droidtaskflow/dsl.py?raw';
import triggerNodeExitPy from '../../droidtaskflow/trigger_node_exit.py?raw';
import executorPy from '../../droidtaskflow/executor.py?raw';
import parserPy from '../../droidtaskflow/parser.py?raw';
import runnerPy from '../../droidtaskflow/runner.py?raw';

// Tool modules (exported bundle includes these for runtime import)
import adbToolPy from '../../droidtaskflow/tool/adb_tool.py?raw';
import llmToolPy from '../../droidtaskflow/tool/llm_tool.py?raw';
import ocrToolPy from '../../droidtaskflow/tool/ocr_tool.py?raw';
import matchToolPy from '../../droidtaskflow/tool/image_tool.py?raw';

/** Serialize a JS value as a Python literal for code generation. */
function pyVal(v) {
    if (typeof v === 'boolean') return v ? 'True' : 'False';
    if (v === null || v === undefined) return 'None';
    return JSON.stringify(v);
}

/* ----------------------------------------------------------
   MERGED droidtaskflow.py BUNDLE
   ---------------------------------------------------------- */

/**
 * Strip internal cross-imports (from droidtaskflow.xxx import ...)
 * from a Python source string.  Handles multi-line parenthesised imports.
 */
function _stripInternalImports(src) {
    const lines = src.split('\n');
    const out = [];
    let inDroidtaskflowImport = false;
    for (const line of lines) {
        const trimmed = line.trimStart();
        if (inDroidtaskflowImport) {
            if (trimmed.includes(')')) inDroidtaskflowImport = false;
            continue;
        }
        if (/^\s*from droidtaskflow\b/.test(line)) {
            if (trimmed.endsWith('(')) inDroidtaskflowImport = true;
            continue;
        }
        out.push(line);
    }
    return out.join('\n');
}

/**
 * Build the merged droidtaskflow.py single-file bundle.
 * Modules are concatenated in dependency order with cross-imports stripped.
 * A small compat section at the end rebuilds the task_define namespace
 * required by executor.py's getattr() lookup pattern.
 */
/**
 * Extract top-level public function names and ALL_CAPS constants from Python source.
 * Used so the compat section stays in sync with the actual .py files automatically.
 */
function topLevelNames(pySrc) {
    const names = [];
    for (const line of pySrc.split('\n')) {
        // Top-level function: "def name("  (skip private _names)
        const dm = line.match(/^def\s+(\w+)\s*\(/);
        if (dm && !dm[1].startsWith('_')) { names.push(dm[1]); continue; }
        // Top-level UPPER_CASE constant: "NAME = "
        const cm = line.match(/^([A-Z][A-Z_0-9]+)\s*=/);
        if (cm) { names.push(cm[1]); }
    }
    return names;
}

export function generateDroidtaskflowPy() {
    const modules = [
        { name: 'decorators',       src: decoratorsPy },
        { name: 'models',           src: modelsPy },
        { name: 'dsl',              src: dslPy },
        { name: 'trigger_node_exit', src: triggerNodeExitPy },
        { name: 'executor',         src: executorPy },
        { name: 'parser',           src: parserPy },
        { name: 'runner',           src: runnerPy },
        { name: 'tool.adb_tool',    src: adbToolPy },
        { name: 'tool.llm_tool',    src: llmToolPy },
        { name: 'tool.ocr_tool',    src: ocrToolPy },
        { name: 'tool.image_tool',  src: matchToolPy },
    ];

    // task_define / task_define_custom 已移除；任务通过 _task_meta 自动发现
    const taskDefNames = [];
    const adbNames = topLevelNames(adbToolPy);
    const llmNames = topLevelNames(llmToolPy);
    const ocrNames = topLevelNames(ocrToolPy);
    const matchNames = topLevelNames(matchToolPy);

    const lines = [];
    lines.push('"""');
    lines.push('droidtaskflow — merged runtime library (single-file bundle).');
    lines.push('Auto-generated.  Do not edit manually.');
    lines.push('"""');
    lines.push('');
    lines.push('from __future__ import annotations');
    lines.push('');
    lines.push('import sys');
    lines.push('from pathlib import Path');
    lines.push('');

    // Collect unique stdlib/third-party imports from all modules
    const seenImports = new Set();
    for (const mod of modules) {
        for (const line of mod.src.split('\n')) {
            const t = line.trim();
            if (t.startsWith('import ') || t.startsWith('from ')) {
                // Skip internal droidtaskflow imports
                if (t.includes('droidtaskflow')) continue;
                // Skip __future__ imports (already emitted at top of file)
                if (t.includes('__future__')) continue;
                seenImports.add(t);
            }
        }
    }
    for (const imp of [...seenImports].sort()) {
        lines.push(imp);
    }
    lines.push('');

    // Emit each module body (stripped of internal imports + stdlib imports)
    for (const mod of modules) {
        lines.push(`# ═══════════════════════════════════════════════`);
        lines.push(`#  ${mod.name}`);
        lines.push(`# ═══════════════════════════════════════════════`);

        let body = _stripInternalImports(mod.src);
        // Also strip stdlib/third-party imports (already collected above)
        body = body.split('\n').filter(line => {
            const t = line.trim();
            if (t.startsWith('import ') || t.startsWith('from ')) {
                if (!t.includes('droidtaskflow')) return false;
            }
            return true;
        }).join('\n');
        // Remove leading blank lines
        body = body.replace(/^\n+/, '');
        lines.push(body);
        lines.push('');
    }

    // Compatibility: rebuild task_define namespace for executor's getattr() lookup
    lines.push('# ═══════════════════════════════════════════════');
    lines.push('#  Compat: task_define namespace for executor');
    lines.push('# ═══════════════════════════════════════════════');
    lines.push('# Build a lookup module-like object so executor.py can do');
    lines.push('#   func = getattr(task_define, task.task_name, None)');
    lines.push(`_TASK_FUNC_NAMES = ${JSON.stringify(taskDefNames)}`);
    lines.push('class _TaskDefineNS:');
    lines.push('    pass');
    lines.push('task_define = _TaskDefineNS()');
    lines.push('for _tn in _TASK_FUNC_NAMES:');
    lines.push('    if _tn in globals():');
    lines.push('        setattr(task_define, _tn, globals()[_tn])');
    // Also register any custom tasks that have _task_meta
    lines.push('# Also pick up any user-defined tasks (with _task_meta attribute)');
    lines.push('for _name, _obj in list(globals().items()):');
    lines.push('    if callable(_obj) and hasattr(_obj, "_task_meta"):');
    lines.push('        if not hasattr(task_define, _name):');
    lines.push('            setattr(task_define, _name, _obj)');
    lines.push('# Register in sys.modules so executor can find it');
    lines.push('sys.modules["droidtaskflow.task_define"] = task_define');
    lines.push('');

    // Compatibility: register every merged sub-module in sys.modules so that
    // `from droidtaskflow.<sub> import X` works in the merged bundle.
    //
    // Why needed: the bundle is a single .py file (loaded as a module), but
    // user code (preset_task.py etc.) does `from droidtaskflow.executor
    // import resolve_serial`. Without sys.modules entries for executor/dsl/...
    // Python raises "'droidtaskflow' is not a package".
    //
    // We register a fake ModuleType for every sub-module and populate it
    // with the module's top-level defs + constants (extracted by
    // topLevelNames so the list stays in sync with the .py source).
    //
    // For nested paths (tool.adb_tool) we also set the leaf as an attribute
    // on the parent ModuleType so that `from droidtaskflow.tool import adb_tool`
    // resolves via attribute lookup too.
    lines.push('# ═══════════════════════════════════════════════');
    lines.push('#  Compat: sub-module registration');
    lines.push('# ═══════════════════════════════════════════════');
    lines.push('# Register every merged sub-module as a fake sys.modules entry.');
    lines.push('# type(sys) returns ModuleType — avoids needing "from types import ModuleType".');
    lines.push('_ModType = type(sys)');
    lines.push('');

    // Compute fqn / parent / leaf / top-level names for every module
    const subMods = modules.map((m) => ({
        fqn: 'droidtaskflow.' + m.name,
        parts: m.name.split('.'),
        leaf: m.name.split('.').pop(),
        names: topLevelNames(m.src),
    }));
    // Helper: turn a dotted name into a safe Python identifier for the local var
    const pyId = (s) => s.replace(/\./g, '_');

    // 1) Ensure every parent namespace exists (e.g. droidtaskflow.tool)
    const parentFqns = [...new Set(
        subMods.map((sm) => sm.parts.length > 1 ? 'droidtaskflow.' + sm.parts.slice(0, -1).join('.') : null)
            .filter(Boolean)
    )];
    for (const parentFqn of parentFqns) {
        lines.push(`# parent namespace: ${parentFqn}`);
        lines.push(`_mod_${pyId(parentFqn)} = _ModType("${parentFqn}")`);
        lines.push(`sys.modules["${parentFqn}"] = _mod_${pyId(parentFqn)}`);
        lines.push('');
    }

    // 2) Register each sub-module and populate its attributes
    for (const sm of subMods) {
        const id = pyId(sm.fqn);
        lines.push(`# ${sm.fqn}`);
        lines.push(`_mod_${id} = _ModType("${sm.fqn}")`);
        lines.push(`_NAMES_${id} = ${JSON.stringify(sm.names)}`);
        lines.push(`for _n in _NAMES_${id}:`);
        lines.push(`    if _n in globals():`);
        lines.push(`        setattr(_mod_${id}, _n, globals()[_n])`);
        lines.push(`sys.modules["${sm.fqn}"] = _mod_${id}`);
        if (sm.parts.length > 1) {
            const parentFqn = 'droidtaskflow.' + sm.parts.slice(0, -1).join('.');
            lines.push(`_mod_${pyId(parentFqn)}.${sm.leaf} = _mod_${id}  # attribute access too`);
        }
        lines.push('');
    }

    return lines.join('\n') + '\n';
}

/* ----------------------------------------------------------
   PROJECT DSL  (saved file = exported main.py)
   ---------------------------------------------------------- */

const DSL_IMPORT_NAMES = [
    'project', 'start_node', 'node', 'node_info_task', 'node_logic_task',
    'node_op_group', 'node_op_group_task', 'node_exit', 'edge', 'global_var',
];

/**
 * Generate the project .py file content.
 * This is BOTH the saved project file AND the exported main.py — same format.
 */
export function toPythonDSL(state) {
    const lines = [];
    lines.push('"""');
    lines.push('@droidtaskflow:project');
    lines.push('@droidtaskflow:version 1.0');
    lines.push('"""');
    lines.push('');
    lines.push('import sys');
    lines.push('from pathlib import Path');
    lines.push('');
    // Fallback: prefer installed package, else find droidtaskflow.py alongside
    lines.push('try:');
    lines.push('    from droidtaskflow import (');
    for (const n of DSL_IMPORT_NAMES) {
        lines.push(`        ${n},`);
    }
    lines.push('    )');
    lines.push('    from droidtaskflow.tool import adb_tool, llm_tool, ocr_tool, image_tool');
    lines.push('except ImportError:');
    lines.push("    sys.path.insert(0, str(Path(__file__).resolve().parent))");
    lines.push('    from droidtaskflow import (');
    for (const n of DSL_IMPORT_NAMES) {
        lines.push(`        ${n},`);
    }
    lines.push('    )');
    lines.push('    from droidtaskflow.tool import adb_tool, llm_tool, ocr_tool, image_tool');
    lines.push('');

    // --- Collect referenced custom task defs ---
    const usedCustomDefs = new Set();
    for (const n of state.nodes) {
        for (const t of [...(n.info || []), ...(n.logic || []).flat()]) {
            if (_customTaskSources[t.def]) usedCustomDefs.add(t.def);
        }
        for (const g of (n.groups || [])) {
            for (const o of g.ops) {
                if (_customTaskSources[o.def]) usedCustomDefs.add(o.def);
            }
        }
    }
    if (usedCustomDefs.size > 0) {
        lines.push('# --- custom task definitions ---');
        for (const key of usedCustomDefs) {
            lines.push(_customTaskSources[key]);
            lines.push('');
        }
        // Register each custom task in task_define so the executor can find them.
        // Wrapped in try/except for Pyodide (where task_define is a mock stub).
        lines.push('try:');
        lines.push('    import droidtaskflow as _dtf');
        for (const key of usedCustomDefs) {
            lines.push(`    _dtf.task_define.${key} = ${key}`);
            // Attach _task_meta if the bare function doesn't have it yet
            const d = DEFS[key];
            if (d) {
                const meta = JSON.stringify({
                    type: d.category || 'info',
                    alias: d.alias || d.name,
                    params: (d.params || []).map(p => ({name: p.n, alias: p.a, type: p.t, length: p.w || 1})),
                    returns: (d.rets || []).map(r => ({name: r.n, alias: r.a})),
                });
                lines.push(`    if not hasattr(${key}, '_task_meta'):`);
                lines.push(`        ${key}._task_meta = ${meta}`);
            }
        }
        lines.push('except (ImportError, AttributeError):');
        lines.push('    pass  # Pyodide / parse-only — tasks registered via collector');
        lines.push('');
        lines.push('# --- project ---');
        lines.push('');
    }

    lines.push(`project("${state.projectName || 'untitled'}", version="1.0")`);
    // Emit start_node (first node is the entry point)
    if (state.nodes.length > 0) {
        lines.push(`start_node("${state.nodes[0].id}")`);
    }
    lines.push('');

    // Global variables
    (state.globalVars || []).forEach(gv => {
        lines.push(`global_var("${gv.name}", "${gv.type}", ${JSON.stringify(gv.value != null ? String(gv.value) : '')})`);
    });
    if (state.globalVars && state.globalVars.length) lines.push('');

    const crossWires = [];
    const intraMap = {};
    state.wires.forEach(w => {
        const [fid] = w.from.split('.');
        const [tid] = w.to.split('.');
        const tNode = state.nodes.find(n => n.id === tid);
        if (tNode && tNode.type === 'goto') return;   // goto 入口线由扁平边替代，不发普通 edge
        const fnId = nodeOf(fid), tnId = nodeOf(tid);
        if (fnId && tnId && fnId !== tnId) {
            crossWires.push(w);
        } else {
            if (!intraMap[tid]) intraMap[tid] = {};
            const [, tpn] = w.to.split('.');
            intraMap[tid][tpn] = w.from;
        }
    });

    state.nodes.forEach(n => {
        const pos = JSON.stringify({ x: n.x, y: n.y });
        const parts = [`"${n.id}"`, `name="${n.name}"`];
        // goto 判别字段恒发射：未设目标（target 为空）的 goto 靠 type 在重载时识别
        if (n.type === 'goto') parts.push(`type="goto"`);
        parts.push(`position=${pos}`);
        if (n.w && n.w !== 560) parts.push(`width=${n.w}`);
        if (n.colF && JSON.stringify(n.colF) !== '[1,1,1.15]') parts.push(`col_fractions=${JSON.stringify(n.colF)}`);
        if (n.type === 'goto' && n.target) parts.push(`target="${n.target}"`);
        // 所有节点（含普通）发射 in_ports；默认单入口 ['in'] 省略（与 edge 默认 to_port='in' 一致）
        if (Array.isArray(n.inPorts) && JSON.stringify(n.inPorts) !== '["in"]') parts.push(`in_ports=${JSON.stringify(n.inPorts)}`);
        lines.push('@node(' + parts.join(', ') + ')');
        if (n.outPorts) n.outPorts.forEach(pn => lines.push(`@node_exit("${pn}", "${pn}")`));

        (n.info || []).forEach(t => {
            const d = DEFS[t.def];
            if (!d) return;
            const parts = [`"${d.name}"`];
            parts.push(`alias="${t._name || d.alias}"`);
            parts.push(`id="${t.id}"`);
            for (const [k, v] of Object.entries(t.f || {})) parts.push(`${k}=${pyVal(v)}`);
            const iw = intraMap[t.id];
            if (iw && Object.keys(iw).length) parts.push(`wires=${JSON.stringify(iw)}`);
            lines.push('@node_info_task(' + parts.join(', ') + ')');
        });

        // LOGIC 多列：按列顺序输出，列下标 > 0 时带 column=N（单列工程输出与旧格式一致）
        (n.logic || []).forEach((col, ci) => {
            col.forEach(t => {
                const d = DEFS[t.def];
                if (!d) return;
                const parts = [`"${d.name}"`];
                parts.push(`alias="${t._name || d.alias}"`);
                parts.push(`id="${t.id}"`);
                if (ci !== 0) parts.push(`column=${ci}`);
                for (const [k, v] of Object.entries(t.f || {})) parts.push(`${k}=${pyVal(v)}`);
                const iw = intraMap[t.id];
                if (iw && Object.keys(iw).length) parts.push(`wires=${JSON.stringify(iw)}`);
                lines.push('@node_logic_task(' + parts.join(', ') + ')');
            });
        });

        (n.groups || []).forEach((g, gi) => {
            const groupParts = [`"${g.id}"`, `name="${g.name}"`, `forced=${pyVal(g.on)}`];
            if (g.in && g.in.trigger) groupParts.push(`trigger="${g.in.trigger}"`);
            // 组出口 ↔ 节点出口：exit= 取组持久化属性（重排组不改变出口归属）；
            // 无 exit 的组（未 render 直接序列化的裸节点）退回按下标取对应出口名
            const exitName = g.exit || (n.outPorts && n.outPorts[gi]);
            if (exitName) groupParts.push(`exit="${exitName}"`);
            lines.push('@node_op_group(' + groupParts.join(', ') + ')');
            g.ops.forEach(o => {
                const d = DEFS[o.def];
                if (!d) return;
                const parts = [`"${d.name}"`];
                parts.push(`alias="${o._name || d.alias}"`);
                parts.push(`id="${o.id}"`);
                for (const [k, v] of Object.entries(o.f || {})) parts.push(`${k}=${pyVal(v)}`);
                const iw = intraMap[o.id];
                if (iw && Object.keys(iw).length) parts.push(`wires=${JSON.stringify(iw)}`);
                lines.push('@node_op_group_task(' + parts.join(', ') + ')');
            });
        });

        lines.push(`def ${n.id}():`);
        lines.push('    pass');
        lines.push('');
    });

    crossWires.forEach(w => {
        const [fid, fpn] = w.from.split('.');
        const [tid, tpn] = w.to.split('.');
        if (tpn && tpn !== 'in') {
            // 多入口：edge 带 to_port 参数（旧格式默认 'in'）
            lines.push(`edge("${fid}", "${fpn}", "${tid}", "${tpn}")`);
        } else {
            lines.push(`edge("${fid}", "${fpn}", "${tid}")`);
        }
    });
    // goto 扁平边：已接线入口 → 指向目标节点标记端口的真实 edge（运行时等效于直接连线）
    for (const g of state.nodes) {
        if (g.type !== 'goto' || !g.target) continue;
        if (!state.nodes.find(n => n.id === g.target)) continue;
        for (const pn of (g.inPorts || [])) {
            const w = state.wires.find(x => x.to === g.id + '.' + pn);
            if (!w) continue;
            const [fid, fpn] = w.from.split('.');
            lines.push(`edge("${fid}", "${fpn}", "${g.target}", "${gotoMarkerPortName(g.id, pn)}")`);
        }
    }
    lines.push('');

    // Safe entry point — works in real Python, skipped in Pyodide (no __file__)
    lines.push("if __name__ == '__main__':");
    lines.push('    try:');
    lines.push('        __file__');
    lines.push('        from droidtaskflow import run_project_file');
    lines.push('        run_project_file(__file__)');
    lines.push('    except NameError:');
    lines.push('        pass  # Pyodide / embedded — no __file__, parse-only mode');

    return lines.join('\n') + '\n';
}

export function fromPythonDSL(pyDict, state) {
    state.nodes = [];
    state.wires = [];

    // Restore project name
    if (pyDict.metadata && pyDict.metadata.name) {
        state.projectName = pyDict.metadata.name;
    } else {
        state.projectName = 'untitled';
    }

    // Restore global variables (device_id is fixed: true — type locked, not deletable)
    if (pyDict.global_vars && Object.keys(pyDict.global_vars).length) {
        state.globalVars = Object.values(pyDict.global_vars).map(gv => ({
            name: gv.name,
            type: gv.type || 'string',
            value: gv.default != null ? String(gv.default) : '',
            // device_id 是系统变量, 不论 project 文件里写没写 fixed 字段, 都强制 type-locked.
            // 原因: backend dsl.py:global_var() 不接受 fixed 参数, 文件里根本没有这个字段;
            // !!gv.fixed 永远是 false. 其它用户变量照旧走文件里读到的 fixed (目前也只会是 false).
            fixed: gv.name === 'device_id' ? true : !!gv.fixed,
        }));
    } else {
        state.globalVars = [
            { name: 'device_id', type: 'string', value: '', fixed: true },
        ];
    }

    let idCounter = 0;
    const newId = () => 't' + (++idCounter);

    for (const [nodeId, node] of Object.entries(pyDict.nodes)) {
        // goto 判别：type="goto"（新格式，未设目标也可靠）或旧文件仅 target 非空
        if (node.type === 'goto' || node.target) {
            // goto 节点：目标 + 入口结构由 target / in_ports 字段还原
            state.nodes.push({
                id: nodeId, type: 'goto', name: node.name,
                x: node.position ? node.position.x : 60,
                y: node.position ? node.position.y : 60,
                w: node.width || 0, colF: null,
                target: node.target || null,
                inPorts: Array.isArray(node.in_ports) && node.in_ports.length ? [...new Set(node.in_ports)] : ['in'],
                outPorts: [],
                info: [], logic: [], groups: [],
            });
            continue;
        }
        const n = {
            id: nodeId,
            name: node.name,
            x: node.position ? node.position.x : 60,
            y: node.position ? node.position.y : 60,
            w: node.width || 0,
            colF: node.col_fractions || null,
            info: [],
            logic: [],
            groups: [],
            inPorts: Array.isArray(node.in_ports) && node.in_ports.length ? [...new Set(node.in_ports)] : ['in'],
            outPorts: Object.keys(node.exits || {}),
        };

        (node.info_tasks || []).forEach(t => {
            const tid = t.id || newId();
            const taskObj = { id: tid, def: t.task_name, f: { ...(t.param_values || {}) }, in: {} };
            if (t.alias) taskObj._name = t.alias;
            n.info.push(taskObj);
        });
        (node.logic_tasks || []).forEach(t => {
            const tid = t.id || newId();
            const taskObj = { id: tid, def: t.task_name, f: { ...(t.param_values || {}) }, in: {} };
            if (t.alias) taskObj._name = t.alias;
            // LOGIC 多列：按 column 字段分组（旧文件无 column → 全部归列 0）
            const colIdx = (t.column != null ? t.column : 0) || 0;
            if (!n.logic[colIdx]) n.logic[colIdx] = [];
            n.logic[colIdx].push(taskObj);
        });
        // 清理空列 / 压缩跳过的列下标
        normalizeLogic(n);
        // 空子列恢复：col_fractions 长度 = 2 + 子列数（含空列）。
        // DSL 本身无法表示空列（没有 task 就没有 column 记录），据此把加载后丢失的空列补齐。
        const cf = node.col_fractions;
        if (cf && Array.isArray(cf) && cf.length >= 3) {
            const expectedCols = cf.length - 2;
            while (n.logic.length < expectedCols) n.logic.push([]);
        }
        (node.operation_groups || []).forEach(g => {
            // exit 是组的持久化出口名（运行时匹配 edge.from_exit），重排组时须保留
            const group = { id: g.id, name: g.name, on: !!g.forced, ops: [], in: {}, exit: g.exit || null };
            if (g.trigger) {
                group.in.trigger = g.trigger;
                state.wires.push({ from: g.trigger, to: g.id + '.trigger' });
            }
            // 组出口 ↔ 节点出口 不再存连线：render 时由 normalizeExits 配对（exit 名保留）
            (g.operations || []).forEach(o => {
                const oid = o.id || newId();
                const opObj = { id: oid, def: o.task_name, f: { ...(o.param_values || {}) }, in: {} };
                if (o.alias) opObj._name = o.alias;
                group.ops.push(opObj);
            });
            n.groups.push(group);
        });
        state.nodes.push(n);
    }

    for (const [nodeId, node] of Object.entries(pyDict.nodes)) {
        const jsNode = state.nodes.find(n => n.id === nodeId);
        if (!jsNode) continue;
        let infoIdx = 0;
        for (const t of (node.info_tasks || [])) {
            if (t.wire_inputs && infoIdx < jsNode.info.length) {
                const taskIn = {};
                for (const [pn, src] of Object.entries(t.wire_inputs)) {
                    taskIn[pn] = src;
                    state.wires.push({ from: src, to: jsNode.info[infoIdx].id + '.' + pn });
                }
                jsNode.info[infoIdx].in = taskIn;
            }
            infoIdx++;
        }
        // LOGIC 多列：按 column 分组还原 wire（逐列计数，保证列内顺序一致）
        const logicColCounters = {};
        for (const t of (node.logic_tasks || [])) {
            if (t.wire_inputs) {
                const col = (t.column != null ? t.column : 0) || 0;
                const ci = logicColCounters[col] || 0;
                logicColCounters[col] = ci + 1;
                const colArr = jsNode.logic[col] || (jsNode.logic[col] = []);
                const taskObj = colArr[ci];
                if (taskObj) {
                    const taskIn = {};
                    for (const [pn, src] of Object.entries(t.wire_inputs)) {
                        taskIn[pn] = src;
                        state.wires.push({ from: src, to: taskObj.id + '.' + pn });
                    }
                    taskObj.in = taskIn;
                }
            }
        }
        let groupIdx = 0;
        for (const g of (node.operation_groups || [])) {
            const jsGroup = jsNode.groups[groupIdx];
            if (!jsGroup) break;
            let opIdx = 0;
            for (const o of (g.operations || [])) {
                if (o.wire_inputs && opIdx < jsGroup.ops.length) {
                    const opIn = {};
                    for (const [pn, src] of Object.entries(o.wire_inputs)) {
                        opIn[pn] = src;
                        state.wires.push({ from: src, to: jsGroup.ops[opIdx].id + '.' + pn });
                    }
                    jsGroup.ops[opIdx].in = opIn;
                }
                opIdx++;
            }
            groupIdx++;
        }
    }

    (pyDict.edges || []).forEach(e => {
        const toPort = e.to_port || 'in';
        // goto 扁平边：还原 goto 入口线，不保留指向标记端口的边（标记为派生视觉）
        const pm = parseGotoMarkerPort(toPort);
        if (pm) {
            const g = state.nodes.find(n => n.id === pm.gotoId && n.type === 'goto');
            if (g) {
                state.wires.push({ from: e.from_node + '.' + e.from_exit, to: g.id + '.' + pm.entryName });
                if (!g.inPorts.includes(pm.entryName)) g.inPorts.push(pm.entryName);
            }
            return;
        }
        state.wires.push({ from: e.from_node + '.' + e.from_exit, to: e.to_node + '.' + toPort });
        // 确保目标节点有这个入口接线点（多个上游 edge → 多个入口端口）
        const targetNode = state.nodes.find(n => n.id === e.to_node);
        if (targetNode) {
            if (!targetNode.inPorts) targetNode.inPorts = ['in'];
            if (!targetNode.inPorts.includes(toPort)) targetNode.inPorts.push(toPort);
        }
    });

    return state;
}
