import { describe, it, expect, beforeEach } from 'vitest';
import { toPythonDSL, fromPythonDSL, serializeGVValue } from '../../src/js/datamapper.js';
import { validateGVValue } from '../../src/js/global-vars.js';
import { state, DEFS } from '../../src/js/state.js';

beforeEach(() => {
    state.nodes = [];
    state.wires = [];
    state.projectName = 'test';
    state.globalVars = [];
    DEFS['ocr'] = { name: 'ocr', alias: 'OCR', params: [], rets: [] };
});

describe('serializeGVValue — dict/list 值序列化为 Python 字面量', () => {
    it('dict：JSON 文本 → Python dict 字面量', () => {
        expect(serializeGVValue({ type: 'dict', value: '{"a": 1, "b": "x"}' })).toBe('{"a": 1, "b": "x"}');
    });
    it('dict：嵌套 true/false/null → True/False/None', () => {
        expect(serializeGVValue({ type: 'dict', value: '{"ok": true, "no": false, "nil": null}' }))
            .toBe('{"ok": True, "no": False, "nil": None}');
    });
    it('list：JSON 数组 → Python list 字面量（含嵌套 dict + 布尔）', () => {
        expect(serializeGVValue({ type: 'list', value: '[1, 2.5, "s", {"k": true}, [false, null]]' }))
            .toBe('[1, 2.5, "s", {"k": True}, [False, None]]');
    });
    it('list：空数组', () => {
        expect(serializeGVValue({ type: 'list', value: '[]' })).toBe('[]');
    });
    it('非法 JSON → 回退为字符串字面量兜底', () => {
        expect(serializeGVValue({ type: 'dict', value: '{bad json' })).toBe('"{bad json"');
    });
    it('dict/list 空值 → 对应类型的空字面量（不是空字符串）', () => {
        expect(serializeGVValue({ type: 'dict', value: '' })).toBe('{}');
        expect(serializeGVValue({ type: 'list', value: '' })).toBe('[]');
        expect(serializeGVValue({ type: 'dict', value: '  ' })).toBe('{}');   // 纯空白也视为留空
    });
    it('string 类型维持字符串字面量（现状不受影响）', () => {
        expect(serializeGVValue({ type: 'string', value: 'hello' })).toBe('"hello"');
    });
});

describe('validateGVValue — dict/list 初始化值校验（语法 + 顶层类型匹配）', () => {
    it('dict：合法对象通过；数组/null/标量拒绝', () => {
        expect(validateGVValue('dict', '{"a": 1}')).toBeNull();
        expect(validateGVValue('dict', '{}')).toBeNull();
        expect(validateGVValue('dict', '[]')).toBe('type');       // 数组不是对象
        expect(validateGVValue('dict', 'null')).toBe('type');
        expect(validateGVValue('dict', '1')).toBe('type');
        expect(validateGVValue('dict', '"str"')).toBe('type');
    });
    it('list：合法数组通过；对象/null/标量拒绝（含 {} 场景）', () => {
        expect(validateGVValue('list', '[1, 2, "x"]')).toBeNull();
        expect(validateGVValue('list', '[]')).toBeNull();
        expect(validateGVValue('list', '[{"a": 1}]')).toBeNull();   // 数组元素可以是对象
        expect(validateGVValue('list', '{}')).toBe('type');          // 对象不是数组
        expect(validateGVValue('list', 'null')).toBe('type');
        expect(validateGVValue('list', '3')).toBe('type');
    });
    it('JSON 语法错误 → json', () => {
        expect(validateGVValue('dict', '{bad')).toBe('json');
        expect(validateGVValue('list', '[1,')).toBe('json');
    });
    it('非 dict/list 类型恒通过', () => {
        expect(validateGVValue('string', '任意内容')).toBeNull();
        expect(validateGVValue('number', 'abc')).toBeNull();
    });
});

describe('toPythonDSL — global_var 发射 dict/list 字面量', () => {
    it('dict 变量 → global_var("d", "dict", {...})', () => {
        state.globalVars = [
            { name: 'device_id', type: 'string', value: '', fixed: true },
            { name: 'cfg', type: 'dict', value: '{"timeout": 5, "flag": true}', fixed: false },
        ];
        const dsl = toPythonDSL(state);
        expect(dsl).toContain('global_var("cfg", "dict", {"timeout": 5, "flag": True})');
        expect(dsl).toContain('global_var("device_id", "string", "")');
    });
    it('list 变量 → global_var("l", "list", [...])', () => {
        state.globalVars = [
            { name: 'seq', type: 'list', value: '[1, 2, 3]', fixed: false },
        ];
        const dsl = toPythonDSL(state);
        expect(dsl).toContain('global_var("seq", "list", [1, 2, 3])');
    });
    it('dict/list 留空 → 发射 {} / [] 空字面量', () => {
        state.globalVars = [
            { name: 's', type: 'dict', value: '', fixed: false },
            { name: 'as', type: 'list', value: '', fixed: false },
        ];
        const dsl = toPythonDSL(state);
        expect(dsl).toContain('global_var("s", "dict", {})');
        expect(dsl).toContain('global_var("as", "list", [])');
    });
});

describe('fromPythonDSL — dict/list default 读回为 JSON 文本', () => {
    it('dict default（Python 解析后的 JS 对象）→ JSON 文本', () => {
        const pyDict = {
            metadata: { name: 'test', version: '1.0' },
            global_vars: {
                cfg: { name: 'cfg', type: 'dict', default: { timeout: 5, flag: true } },
            },
            start_node_id: null,
            nodes: {},
            edges: [],
        };
        fromPythonDSL(pyDict, state);
        expect(state.globalVars.find(g => g.name === 'cfg').value).toBe('{"timeout":5,"flag":true}');
    });
    it('list default → JSON 文本；string 类型维持字符串', () => {
        const pyDict = {
            metadata: { name: 'test', version: '1.0' },
            global_vars: {
                seq: { name: 'seq', type: 'list', default: [1, 'a', null] },
                name: { name: 'name', type: 'string', default: 'hello' },
            },
            start_node_id: null,
            nodes: {},
            edges: [],
        };
        fromPythonDSL(pyDict, state);
        expect(state.globalVars.find(g => g.name === 'seq').value).toBe('[1,"a",null]');
        expect(state.globalVars.find(g => g.name === 'name').value).toBe('hello');
    });
});
