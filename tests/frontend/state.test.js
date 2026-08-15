import { describe, it, expect } from 'vitest';
import { state, pickInputToRemove, nextInPortName, portColor, hash } from '../../src/js/state.js';

describe('portColor — 色相避开默认端口色附近', () => {
    // 默认端口色 --port-default = oklch(0.62 0.02 270)，hue 270 的灰紫。
    // 生成色相必须避开其附近 [250, 290)，否则与默认色难以区分。
    it('大量种子下色相从不落入 [250, 290)', () => {
        for (let i = 0; i < 5000; i++) {
            const c = portColor(hash('t' + i), i % 3, 3);
            const h = parseInt(c.match(/ ([0-9]+)\)/)[1]);
            const inBand = h >= 250 && h < 290;
            if (inBand) throw new Error('hue in forbidden band: ' + c);
        }
        expect(true).toBe(true);
    });

    it('节点出口多端口也避开禁区', () => {
        for (let i = 0; i < 1000; i++) {
            const c = portColor(hash('n' + i), 100, 1000);
            const h = parseInt(c.match(/ ([0-9]+)\)/)[1]);
            expect(h < 250 || h >= 290).toBe(true);
        }
    });

    it('色相仍保持多样（覆盖不同区间）', () => {
        const seen = new Set();
        for (let i = 0; i < 500; i++) seen.add(portColor(hash('t' + i), 0, 1));
        // 320 个可用色相，应能覆盖多个不同值（低冲突）
        expect(seen.size).toBeGreaterThan(50);
    });
});

describe('pickInputToRemove — 减少入口选择', () => {
    it('存在未连线入口时优先删未连线（自下而上第一个）', () => {
        // in 已连线，in2/in3 未连线 → 删最底部未连线 in3
        expect(pickInputToRemove({ wires: [{ from: 'a.x', to: 'n1.in' }] }, 'n1', ['in', 'in2', 'in3'])).toBe(2);
        // in / in3 已连线，in2 未连线 → 自下而上第一个未连线是 in2
        const st = { wires: [{ from: 'a.x', to: 'n1.in' }, { from: 'b.y', to: 'n1.in3' }] };
        expect(pickInputToRemove(st, 'n1', ['in', 'in2', 'in3'])).toBe(1);
        // 仅 in 未连线（最底部 in2 已连线）→ 删 in
        const st2 = { wires: [{ from: 'a.x', to: 'n1.in2' }] };
        expect(pickInputToRemove(st2, 'n1', ['in', 'in2'])).toBe(0);
    });

    it('全部连线 → 删最底部', () => {
        const st = { wires: [{ from: 'a.x', to: 'n1.in' }, { from: 'b.y', to: 'n1.in2' }] };
        expect(pickInputToRemove(st, 'n1', ['in', 'in2'])).toBe(1);
    });

    it('无连线 → 删最底部', () => {
        expect(pickInputToRemove({ wires: [] }, 'n1', ['in', 'in2'])).toBe(1);
    });
});

describe('nextInPortName — 入口命名不撞名', () => {
    it('空 → in', () => {
        expect(nextInPortName([])).toBe('in');
    });
    it('顺序命名 → in4', () => {
        expect(nextInPortName(['in', 'in2', 'in3'])).toBe('in4');
    });
    it('删除中间后取最小可用（补洞）→ 不生成重复 in3', () => {
        expect(nextInPortName(['in', 'in3'])).toBe('in2');
    });
    it('缺 in 时补 in', () => {
        expect(nextInPortName(['in2', 'in3'])).toBe('in');
    });
    it('乱序 → 最小可用后缀', () => {
        expect(nextInPortName(['in2', 'in', 'in4'])).toBe('in3');
    });
    it('全占满 → 继续递增', () => {
        expect(nextInPortName(['in', 'in2', 'in3', 'in4'])).toBe('in5');
    });
});

describe('state.devicePreview', () => {
    it('has all required fields with correct defaults', () => {
        expect(state.devicePreview).toBeDefined();
        expect(state.devicePreview.folded).toBe(true);
        expect(state.devicePreview.source).toBeNull();
        expect(state.devicePreview.serial).toBeNull();
        expect(state.devicePreview.blobUrl).toBeNull();
        expect(state.devicePreview.width).toBe(0);
        expect(state.devicePreview.height).toBe(0);
        expect(state.devicePreview.pickedPoint).toBeNull();
        expect(state.devicePreview.pickerMode).toBe(true);
        expect(state.devicePreview.fetching).toBe(false);
        expect(state.devicePreview.inflightSerial).toBeNull();
    });

    it('can be mutated (write/read)', () => {
        state.devicePreview.serial = 'S49';
        state.devicePreview.width = 720;
        state.devicePreview.height = 1280;
        expect(state.devicePreview.serial).toBe('S49');
        expect(state.devicePreview.width).toBe(720);
    });
});