import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextFireTime, scheduleSummary, buildUploadBundle, initAutomationPanel, __test } from '../../src/js/automation-panel.js';
import { state } from '../../src/js/state.js';
import { setLang, t } from '../../src/js/i18n.js';
import * as fsModule from '../../src/js/filesystem.js';
import * as bcModule from '../../src/js/backend-client.js';

const BASE_DOM = `
  <div id="automationTaskList"></div>
  <button id="btnAddAutomationTask"></button>
`;

function makeTask(over = {}) {
  return Object.assign({
    id: 't1', name: 'demo',
    schedule: { type: 'interval', unit: 'minutes', value: 30 },
    devices: ['S1'], vars: {}, enabled: true,
  }, over);
}

beforeEach(() => {
  document.body.innerHTML = BASE_DOM;
  __test.setTestClient(null);
  vi.restoreAllMocks();
  state.deviceListByBackend = {};   // 设备列表每例重置，避免 setDevices 串扰
});

// 给当前选中后端注入可用设备列表（serial 数组 → state.deviceListByBackend）
function setDevices(serials) {
  state.deviceListByBackend[bcModule.getSelectedBackendId()] = serials.map(s => ({ serial: s }));
}

/* ---- nextFireTime：与后端 schedule.py 语义一致 ---- */

describe('nextFireTime', () => {
  it('interval: after + delta', () => {
    const after = new Date(2026, 7, 13, 10, 0, 0);
    expect(nextFireTime({ type: 'interval', unit: 'minutes', value: 30 }, after))
      .toEqual(new Date(2026, 7, 13, 10, 30, 0));
  });

  it('daily: 已过则次日', () => {
    const after = new Date(2026, 7, 13, 10, 0, 0);
    expect(nextFireTime({ type: 'daily', time: '09:30' }, after))
      .toEqual(new Date(2026, 7, 14, 9, 30, 0));
  });

  it('weekly: 下一匹配星期几', () => {
    // 2026-08-13 是周四(JS getDay=4, 0=周一换算后 wd=3)。weekdays=[0,2,4] → 周五
    const after = new Date(2026, 7, 13, 10, 0, 0);
    const r = nextFireTime({ type: 'weekly', time: '09:30', weekdays: [0, 2, 4] }, after);
    expect(r.getDay()).toBe(5);   // 周五
    expect(r.getDate()).toBe(14);
  });

  it('monthly: 31 号在短月钳制到月末', () => {
    const after = new Date(2026, 0, 15, 0, 0, 0);
    const r = nextFireTime({ type: 'monthly', time: '00:00', day_of_month: 31 }, after);
    expect(r).toEqual(new Date(2026, 0, 31, 0, 0, 0));
    const r2 = nextFireTime({ type: 'monthly', time: '00:00', day_of_month: 31 }, r);
    expect(r2).toEqual(new Date(2026, 1, 28, 0, 0, 0));  // 2026 非闰年 → 2/28
  });

  it('yearly: 闰年 2/29 正常', () => {
    const after = new Date(2028, 1, 20, 0, 0, 0);
    const r = nextFireTime({ type: 'yearly', time: '00:00', month: 2, day_of_month: 29 }, after);
    expect(r).toEqual(new Date(2028, 1, 29, 0, 0, 0));
  });

  it('oneshot: 未到返回 at；已 fired 返回 null', () => {
    const after = new Date(2026, 7, 13, 8, 0, 0);
    expect(nextFireTime({ type: 'oneshot', at: '2026-08-14T09:30:00' }, after))
      .toEqual(new Date(2026, 7, 14, 9, 30, 0));
    expect(nextFireTime({ type: 'oneshot', at: '2026-08-14T09:30:00', fired: true }, after)).toBeNull();
    expect(nextFireTime({ type: 'oneshot', at: '2026-08-12T09:30:00' }, after)).toBeNull();
  });
});

/* ---- scheduleSummary ---- */

describe('scheduleSummary', () => {
  it('各类型生成摘要', () => {
    expect(scheduleSummary({ type: 'interval', unit: 'minutes', value: 30 })).toMatch(/30/);
    expect(scheduleSummary({ type: 'daily', time: '09:00' })).toMatch(/09:00/);
    expect(scheduleSummary({ type: 'weekly', time: '10:00', weekdays: [0, 2] })).toMatch(/10:00/);
    expect(scheduleSummary({ type: 'oneshot', at: '2026-08-14T09:30:00' })).toMatch(/2026-08-14/);
    expect(scheduleSummary({ type: 'oneshot', at: '2026-08-14T09:30:00', fired: true })).toContain('fired');
  });
});

/* ---- 上传自定义脚本打包 ---- */

describe('buildUploadBundle', () => {
  it('缺少 main.py 返回错误', async () => {
    const files = [new File(['print(1)\n'], 'foo.py', { type: 'text/plain' })];
    expect(await buildUploadBundle(files, '# stub')).toEqual({ error: 'main.py' });
  });

  it('含 main.py 打包成功且注入 droidtaskflow.py（zip PK 魔数）', async () => {
    const files = [
      new File(['print("hi")\n'], 'main.py', { type: 'text/plain' }),
      new File(['print(2)\n'], 'helper.py', { type: 'text/plain' }),
    ];
    const r = await buildUploadBundle(files, 'DTF_STUB');
    expect(r.error).toBeUndefined();
    expect(typeof r.b64).toBe('string');
    expect(r.b64.length).toBeGreaterThan(0);
    const bin = atob(r.b64);
    expect(bin.charCodeAt(0)).toBe(0x50); // 'P'
    expect(bin.charCodeAt(1)).toBe(0x4b); // 'K'
  });

  it('空列表返回 main.py 错误', async () => {
    expect(await buildUploadBundle([], '# stub')).toEqual({ error: 'main.py' });
  });
});

/* ---- openEditor：脚本字段（不要求打开工程文件） ---- */

function fakeClient() {
  return { state: 'connected', _automationHooked: false, on() {}, sendRaw() {} };
}
function openViaClick() {
  initAutomationPanel();
  document.getElementById('btnAddAutomationTask').click();
  return new Promise(r => setTimeout(r, 0));
}

describe('openEditor 脚本字段', () => {
  it('无打开工程也能打开编辑器，脚本字段渲染（工程模式默认）', async () => {
    state.nodes = [];
    __test.setTestClient(fakeClient());
    await openViaClick();
    const ed = document.querySelector('.automation-editor');
    expect(ed).toBeTruthy();
    const src = document.getElementById('ae-script-src');
    expect(src).toBeTruthy();
    // 二选一分段控件：默认选中"从工程清单选择"（project）
    expect(src.querySelector('input[type="radio"]:checked').value).toBe('project');
    expect(src.querySelectorAll('input[type="radio"]').length).toBe(2);
    // 无当前工程、无绑定目录 → 工程模式显示"无可用工程"
    expect(document.querySelector('.automation-editor__script-empty')).toBeTruthy();
    _closeEditorForTest();
  });

  it('工程清单显示工程名 + 未选择时浮层提示"请选择工程"（不进下拉列表）', async () => {
    vi.spyOn(fsModule, 'getDirHandle').mockReturnValue({});
    vi.spyOn(fsModule, 'listProjectFiles').mockResolvedValue(['demo.py', 'flow.py']);
    vi.spyOn(fsModule, 'getProjectName').mockImplementation(async (_dh, f) =>
      f === 'demo.py' ? '演示工程' : '流程自动化');
    __test.setTestClient(fakeClient());
    await openViaClick();
    const sel = document.getElementById('ae-script-project');
    expect(sel).toBeTruthy();
    const opts = [...sel.options];
    expect(opts[0].value).toBe('');           // 占位空值
    expect(opts[0].disabled).toBe(true);
    expect(opts[0].hidden).toBe(true);        // hidden：不进下拉列表，不是选项
    expect(opts[0].selected).toBe(true);      // 默认未选择
    const names = opts.map(o => o.textContent);
    expect(names).toContain('演示工程');       // 显示工程名，不是文件名
    expect(names).not.toContain('demo.py');
    expect(names).not.toContain('__current__');
    // 未选择时浮层显示占位提示（语言无关：有非空文字且不是任一工程名）
    const ph = document.querySelector('.ae-script-sel__ph');
    expect(ph).toBeTruthy();
    expect(ph.hidden).toBe(false);
    expect(ph.textContent.trim().length).toBeGreaterThan(0);
    expect(names).not.toContain(ph.textContent.trim());
    // 选中工程后浮层隐藏
    sel.value = 'demo.py';
    sel.dispatchEvent(new Event('change'));
    expect(ph.hidden).toBe(true);
    _closeEditorForTest();
  });

  it('变量区：固定 device_id 行（只读、无 ✕），"+" 每次加一行可删额外行', async () => {
    state.nodes = [];
    __test.setTestClient(fakeClient());
    await openViaClick();
    const varsBody = document.getElementById('ae-vars');
    const fixed = varsBody.querySelector('.ae-var-fixed');
    expect(fixed).toBeTruthy();
    expect(fixed.querySelector('.ae-var-key--fixed').textContent).toBe('device_id');
    expect(fixed.querySelector('input').readOnly).toBe(true);
    expect(fixed.querySelector('.ae-var-del')).toBeFalsy();   // device_id 行无 ✕
    // "+" 按钮只显示 "+"
    const addBtn = document.getElementById('ae-add-var');
    expect(addBtn.textContent.trim()).toBe('+');
    // 点一次加一行（名字 / 值 / ✕）
    addBtn.click();
    const rows = varsBody.querySelectorAll('.automation-editor__var-row');
    expect(rows.length).toBe(2);   // 固定行 + 1 额外行
    expect(rows[1].querySelector('.ae-var-del')).toBeTruthy();
    // ✕ 删除额外行
    rows[1].querySelector('.ae-var-del').click();
    expect(varsBody.querySelectorAll('.automation-editor__var-row').length).toBe(1);
    _closeEditorForTest();
  });

  it('切换到上传模式渲染文件输入 + main.py 提示', async () => {
    state.nodes = [];
    __test.setTestClient(fakeClient());
    await openViaClick();
    const src = document.getElementById('ae-script-src');
    const uploadRadio = src.querySelector('input[value="upload"]');
    uploadRadio.checked = true;   // 切到"上传自定义脚本"
    uploadRadio.dispatchEvent(new Event('change', { bubbles: true }));
    const box = document.getElementById('ae-script-box');
    expect(box.querySelector('#ae-script-files')).toBeTruthy();
    expect(box.textContent).toContain('main.py');
    // 切回"从工程清单选择"，上传 UI 消失
    const projRadio = src.querySelector('input[value="project"]');
    projRadio.checked = true;
    projRadio.dispatchEvent(new Event('change', { bubbles: true }));
    expect(box.querySelector('#ae-script-files')).toBeFalsy();
    _closeEditorForTest();
  });
});

/* ---- 多设备目标选择 ---- */

describe('多设备目标选择', () => {
  it('初始 1 行且 ✕ 禁用；点 + 增行后 ✕ 可用；删回 1 行又禁用', async () => {
    __test.setTestClient(fakeClient());
    await openViaClick();
    const devBox = document.getElementById('ae-devices');
    let rows = devBox.querySelectorAll('.ae-device-row');
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector('.ae-device-del').disabled).toBe(true);   // 只剩 1 行 → ✕ 禁用
    document.getElementById('ae-add-device').click();                       // 点 + 增行
    rows = devBox.querySelectorAll('.ae-device-row');
    expect(rows.length).toBe(2);
    rows.forEach(r => expect(r.querySelector('.ae-device-del').disabled).toBe(false));
    rows[1].querySelector('.ae-device-del').click();                        // 删第二行
    rows = devBox.querySelectorAll('.ae-device-row');
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector('.ae-device-del').disabled).toBe(true);
    _closeEditorForTest();
  });

  it('device_id 固定行：单台显示序号，多台显示 "multi"，删回单台恢复', async () => {
    setDevices(['S1', 'S2']);
    __test.setTestClient(fakeClient());
    await openViaClick();
    const devBox = document.getElementById('ae-devices');
    const fixedVal = () => document.querySelector('.ae-var-fixed .ae-var-val').value;
    // 新建任务初始行不预选 → 固定行为空
    expect(fixedVal()).toBe('');
    const devSel = devBox.querySelector('.ae-device-sel');
    devSel.value = 'S1';
    devSel.dispatchEvent(new Event('change'));
    expect(fixedVal()).toBe('S1');
    // 加第二行（默认空占位），第 2 行选 S2 → multi
    document.getElementById('ae-add-device').click();
    const sel2 = devBox.querySelectorAll('.ae-device-sel')[1];
    sel2.value = 'S2';
    sel2.dispatchEvent(new Event('change'));
    expect(fixedVal()).toBe('multi');
    // 删第二行 → 恢复 S1
    devBox.querySelectorAll('.ae-device-row')[1].querySelector('.ae-device-del').click();
    expect(fixedVal()).toBe('S1');
    _closeEditorForTest();
  });

  it('保存：payload.devices 数组 + vars 不含 device_id', async () => {
    const cli = fakeSaveClient();
    await openEditorAndSelectProject(cli);
    document.getElementById('ae-add-device').click();                        // 加第二行选 S2
    const devSels = document.querySelectorAll('#ae-devices .ae-device-sel');
    devSels[1].innerHTML = '<option value="S2">S2</option>';
    devSels[1].value = 'S2';
    document.getElementById('ae-save').click();
    await flush();
    const payload = cli.payloads.find(p => p.type === 'automation_task_add' || p.type === 'automation_task_update');
    expect(payload.devices).toEqual(['S1', 'S2']);
    expect(payload.vars.device_id).toBeUndefined();
    _closeEditorForTest();
  });

  it('编辑任务按 task.devices 恢复多行', async () => {
    __test.setTestClient(fakeClient());
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask({ devices: ['S1', 'S2'] })] });
    document.querySelector('[data-act="edit"]').click();
    await new Promise(r => setTimeout(r, 0));
    const rows = document.querySelectorAll('#ae-devices .ae-device-row');
    expect(rows.length).toBe(2);
    _closeEditorForTest();
  });

  it('已被其他行选中的设备在本行置灰不可选', async () => {
    setDevices(['S1', 'S2', 'S3', 'S4']);
    __test.setTestClient(fakeClient());
    await openViaClick();
    const sels = () => [...document.querySelectorAll('#ae-devices .ae-device-sel')];
    const opt = (sel, v) => [...sel.options].find(o => o.value === v);
    // 新建任务初始行默认不选：空占位选项 hidden 不进下拉列表，浮层 span 显示"请选择设备"
    expect(sels()[0].value).toBe('');
    const ph0 = opt(sels()[0], '');
    expect(ph0.selected).toBe(true);
    expect(ph0.disabled).toBe(true);
    expect(ph0.hidden).toBe(true);
    const overlay0 = sels()[0].closest('.ae-device-selw').querySelector('.ae-device-sel__ph');
    expect(overlay0.hidden).toBe(false);
    expect(overlay0.textContent.trim().length).toBeGreaterThan(0);
    // 第 1 行选 S1
    sels()[0].value = 'S1';
    sels()[0].dispatchEvent(new Event('change'));
    expect(sels()[0].closest('.ae-device-selw').querySelector('.ae-device-sel__ph').hidden).toBe(true);
    // 加两行（默认均为空占位）
    document.getElementById('ae-add-device').click();
    document.getElementById('ae-add-device').click();
    expect(sels()[1].value).toBe('');
    expect(sels()[2].value).toBe('');
    // 第 2 行选 S2、第 3 行选 S3
    sels()[1].value = 'S2';
    sels()[1].dispatchEvent(new Event('change'));
    sels()[2].value = 'S3';
    sels()[2].dispatchEvent(new Event('change'));
    // 第 2 行里：S1（第 1 行占用）置灰，S2（本行）/S4 可选
    expect(opt(sels()[1], 'S1').disabled).toBe(true);
    expect(opt(sels()[1], 'S2').disabled).toBe(false);
    expect(opt(sels()[1], 'S4').disabled).toBe(false);
    // 第 3 行改成 S4 → 第 2 行里 S4 变置灰、S3 恢复可选
    sels()[2].value = 'S4';
    sels()[2].dispatchEvent(new Event('change'));
    expect(opt(sels()[1], 'S4').disabled).toBe(true);
    expect(opt(sels()[1], 'S3').disabled).toBe(false);
    _closeEditorForTest();
  });

  it('时间/日期时间输入框：右侧独立按钮（时钟/日历）', async () => {
    __test.setTestClient(fakeClient());
    state.nodes = [];
    await openViaClick();
    const typeSel = document.getElementById('ae-type');
    const sched = () => document.getElementById('ae-sched');
    // daily → 时间输入框包在 .ae-pick 里，右侧时钟按钮
    typeSel.value = 'daily';
    typeSel.dispatchEvent(new Event('change'));
    expect(sched().querySelector('input[type="time"]')).toBeTruthy();
    expect(sched().querySelector('.ae-pick .ae-pick-btn--time')).toBeTruthy();
    // oneshot → 日期时间输入框，.ae-dt 内右侧日历按钮
    typeSel.value = 'oneshot';
    typeSel.dispatchEvent(new Event('change'));
    expect(sched().querySelector('input[type="datetime-local"]')).toBeTruthy();
    expect(sched().querySelector('.ae-dt .ae-pick-btn--cal')).toBeTruthy();
    _closeEditorForTest();
  });

  it('历史弹窗：列名行 + 每行显示设备号', () => {
    __test.setTestClient(fakeClient());
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    document.querySelector('[data-act="history"]').click();
    __test.handleMessage({
      type: 'automation_history_list', task_id: 't1', total: 1,
      runs: [{ run_id: 'r1', task_id: 't1', status: 'success', device_id: 'S1', duration_ms: 1000 }],
    });
    // 列名行存在且五列标签有文字（状态/设备/时间/耗时/操作，语言无关）
    const head = document.querySelector('.automation-hist .automation-hist__head');
    expect(head).toBeTruthy();
    const headCells = [...head.children].map(s => s.textContent.trim()).filter(Boolean);
    expect(headCells.length).toBe(5);
    headCells.forEach(txt => expect(txt.length).toBeGreaterThan(0));
    // 数据行里的设备号（列名行的 .__hist-dev 不算）
    const rowDev = document.querySelector('.automation-hist .automation-hist__list .automation__hist-dev');
    expect(rowDev.textContent).toContain('S1');
    // 每行有"查看日志"/"删除记录"图标按钮（无日志时查看 disabled，删除仍可用）
    const logBtn = document.querySelector('.automation-hist .automation-hist__list .automation__hist-icon[data-act="log"]');
    const delBtn = document.querySelector('.automation-hist .automation-hist__list .automation__hist-icon[data-act="del"]');
    expect(logBtn).toBeTruthy();
    expect(delBtn).toBeTruthy();
    expect(logBtn.disabled).toBe(true);
    expect(delBtn.disabled).toBe(false);
    _closeHistoryDialogForTest();
  });

  it('历史弹窗"查看日志"按钮 → 按需读取并弹出可滚动日志框', () => {
    __test.setTestClient(fakeClient());
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    document.querySelector('[data-act="history"]').click();
    __test.handleMessage({
      type: 'automation_history_list', task_id: 't1', total: 1,
      runs: [{ run_id: 'r1', task_id: 't1', status: 'success', devices: ['S1'], duration_ms: 1000,
               log_path: ['runs/t1/run-a-S1.log'] }],
    });
    const logBtn = document.querySelector('.automation-hist .automation-hist__list .automation__hist-icon[data-act="log"]');
    expect(logBtn.disabled).toBe(false);
    logBtn.click();
    const logDlg = document.querySelector('.automation-log');
    expect(logDlg).toBeTruthy();
    // 历史列表不带日志内容：先 loading，收到日志读取响应后填内容
    expect(logDlg.querySelector('.automation-log__body').textContent).toContain(t('automation.logLoading'));
    __test.handleMessage({
      type: 'automation_log_read', run_id: 'r1',
      logs: [{ device_id: 'S1', exists: true, lines: ['line 1', 'line 2'] }],
    });
    expect(logDlg.querySelector('.automation-log__body').textContent).toContain('line 1');
    expect(logDlg.querySelector('.automation-log__body').textContent).toContain('line 2');
    // 关闭日志框 → 历史弹窗仍在
    document.querySelector('.automation-log .dlg__close').click();
    expect(document.querySelector('.automation-log')).toBeFalsy();
    expect(document.querySelector('.automation-hist')).toBeTruthy();
    _closeHistoryDialogForTest();
  });

  it('日志弹窗渲染 ANSI 控制台变色代码', () => {
    __test.setTestClient(fakeClient());
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    document.querySelector('[data-act="history"]').click();
    __test.handleMessage({
      type: 'automation_history_list', task_id: 't1', total: 1,
      runs: [{ run_id: 'r1', task_id: 't1', status: 'success', devices: ['S1'], duration_ms: 1000,
               log_path: ['runs/t1/run-a-S1.log'] }],
    });
    document.querySelector('.automation-hist .automation-hist__list .automation__hist-icon[data-act="log"]').click();
    __test.handleMessage({
      type: 'automation_log_read', run_id: 'r1',
      logs: [{ device_id: 'S1', exists: true, lines: ['\x1b[31mERROR\x1b[0m done'] }],
    });
    const body = document.querySelector('.automation-log .automation-log__body');
    // 红色 31 → #c00 的 span，代码本身被剥掉
    expect(body.innerHTML).toContain('color:#c00');
    expect(body.textContent).toBe('ERROR done');
    document.querySelector('.automation-log .dlg__close').click();
    _closeHistoryDialogForTest();
  });

  it('日志弹窗右键 → 弹出"复制"菜单，关闭弹窗一并移除', () => {
    __test.setTestClient(fakeClient());
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    document.querySelector('[data-act="history"]').click();
    __test.handleMessage({
      type: 'automation_history_list', task_id: 't1', total: 1,
      runs: [{ run_id: 'r1', task_id: 't1', status: 'success', devices: ['S1'], duration_ms: 1000,
               log_path: ['runs/t1/run-a-S1.log'] }],
    });
    document.querySelector('.automation-hist .automation-hist__list .automation__hist-icon[data-act="log"]').click();
    __test.handleMessage({
      type: 'automation_log_read', run_id: 'r1',
      logs: [{ device_id: 'S1', exists: true, lines: ['hello', 'world'] }],
    });
    const body = document.querySelector('.automation-log .automation-log__body');
    const menu = document.querySelector('.dlg-backdrop .console-copy-menu');
    expect(menu).toBeTruthy();
    expect(menu.hidden).toBe(true);
    // 右键日志区 → 自定义菜单出现，只有"复制"
    body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(menu.hidden).toBe(false);
    expect(menu.querySelector('button').textContent).toBe(t('console.copy'));
    // 点"复制" → 菜单收起（jsdom 无剪贴板/execCommand，_fallbackCopy 的 try/catch 兜底）
    menu.querySelector('button').click();
    expect(menu.hidden).toBe(true);
    // 关日志框 → 菜单元素一并移除
    document.querySelector('.automation-log .dlg__close').click();
    expect(document.querySelector('.console-copy-menu')).toBeFalsy();
    _closeHistoryDialogForTest();
  });

  it('多设备运行日志：标签页切换各设备日志', () => {
    __test.setTestClient(fakeClient());
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    document.querySelector('[data-act="history"]').click();
    __test.handleMessage({
      type: 'automation_history_list', task_id: 't1', total: 1,
      runs: [{ run_id: 'r1', task_id: 't1', status: 'success', devices: ['S1', 'S2'], duration_ms: 1000,
               log_path: ['runs/t1/run-a-S1.log', 'runs/t1/run-a-S2.log'] }],
    });
    document.querySelector('.automation-hist .automation-hist__list .automation__hist-icon[data-act="log"]').click();
    __test.handleMessage({
      type: 'automation_log_read', run_id: 'r1',
      logs: [
        { device_id: 'S1', exists: true, lines: ['s1 line'] },
        { device_id: 'S2', exists: true, lines: ['s2 line'] },
      ],
    });
    const tabs = [...document.querySelectorAll('.automation-log .automation-log__tab')];
    expect(tabs.length).toBe(2);
    expect(tabs[0].textContent).toContain('S1');
    expect(tabs[1].textContent).toContain('S2');
    const body = document.querySelector('.automation-log .automation-log__body');
    expect(body.textContent).toContain('s1 line');
    // 切到 S2
    tabs[1].click();
    expect(body.textContent).toContain('s2 line');
    expect(tabs[1].classList.contains('automation-log__tab--active')).toBe(true);
    document.querySelector('.automation-log .dlg__close').click();
    _closeHistoryDialogForTest();
  });

  it('删除记录：垃圾桶图标 → 确认弹窗 → 发送删除并移除该行', () => {
    const sent = [];
    const cli = { state: 'connected', _automationHooked: false, on() {}, sendRaw(o) { sent.push(o); return true; } };
    __test.setTestClient(cli);
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    document.querySelector('[data-act="history"]').click();
    __test.handleMessage({
      type: 'automation_history_list', task_id: 't1', total: 1,
      runs: [{ run_id: 'r1', task_id: 't1', status: 'success', devices: ['S1'], duration_ms: 1000,
               log_path: ['runs/t1/run-a-S1.log'] }],
    });
    const delBtn = document.querySelector('.automation-hist .automation-hist__list .automation__hist-icon[data-act="del"]');
    expect(delBtn.disabled).toBe(false);
    delBtn.click();
    const confirm = document.querySelector('.automation-confirm');
    expect(confirm).toBeTruthy();
    expect(confirm.textContent).toContain(t('automation.logDeleteMsg'));
    // 取消 → 不发送删除
    document.querySelector('#ae-del-cancel').click();
    expect(document.querySelector('.automation-confirm')).toBeFalsy();
    expect(sent.some(o => o.type === 'automation_log_delete')).toBe(false);
    // 再次点删除 → 确认 → 发送 LOG_DELETE
    delBtn.click();
    document.querySelector('#ae-del-ok').click();
    expect(sent.some(o => o.type === 'automation_log_delete' && o.run_id === 'r1')).toBe(true);
    // 后端确认 → 该条记录已删除（行消失，列表空态）
    __test.handleMessage({ type: 'automation_log_deleted', run_id: 'r1' });
    const list = document.querySelector('.automation-hist .automation-hist__list');
    expect(list.querySelector('.automation__hist-item')).toBeFalsy();
    expect(list.textContent).toContain(t('automation.historyEmpty'));
    _closeHistoryDialogForTest();
  });

  it('旧格式任务（vars.device_id、无 devices）卡片仍显示设备', () => {
    __test.setTestClient(fakeClient());
    __test.handleMessage({
      type: 'automation_task_list',
      tasks: [makeTask({ devices: undefined, vars: { device_id: 'S9' } })],
    });
    expect(document.getElementById('automationTaskList').textContent).toContain('S9');
  });
});

/* ---- 中英文切换：卡片按钮文案跟随语言 ---- */

describe('中英文切换', () => {
  it('卡片运行/历史/编辑/删除按钮文案随语言切换', () => {
    setLang('zh');   // 明确基线（jsdom navigator.language 默认 en）
    __test.setTestClient(fakeClient());
    initAutomationPanel();   // 注册 onLanguageChange → 重渲染卡片
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    const btns = () => [...document.querySelectorAll('#automationTaskList .automation__task-actions button')]
      .map(b => b.textContent.trim());
    expect(btns()).toEqual(['运行', '历史', '编辑', '删除']);
    setLang('en');
    expect(btns()).toEqual(['Run', 'History', 'Edit', 'Delete']);
    setLang('zh');   // 还原，避免影响后续测试
    expect(btns()).toEqual(['运行', '历史', '编辑', '删除']);
  });
});

/* ---- 保存按钮：转圈 → 等后端 ack（req_id）→ 成功关弹窗 / 失败保持弹窗 ---- */

function fakeSaveClient() {
  const handlers = {};
  const payloads = [];
  return {
    state: 'connected',
    _automationHooked: false,
    payloads,
    handlers,
    on(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    sendRaw(obj) { payloads.push(obj); return true; },
  };
}

// 让微任务链落定
function flush(n = 3) {
  return new Promise((r) => {
    const t = setInterval(() => { if (--n <= 0) { clearInterval(t); r(); } }, 0);
  });
}

// 工程模式 + 全部 mock（filesystem/bundle 均为微任务级，无 JSZip 真实异步）
async function openEditorAndSelectProject(cli) {
  vi.spyOn(fsModule, 'getDirHandle').mockReturnValue({});
  vi.spyOn(fsModule, 'listProjectFiles').mockResolvedValue(['demo.py']);
  vi.spyOn(fsModule, 'getProjectName').mockResolvedValue('演示工程');
  vi.spyOn(fsModule, 'readProjectSource').mockResolvedValue('print(1)\n');
  vi.spyOn(bcModule, 'buildProjectBundle').mockResolvedValue(new Uint8Array([80, 75]));
  vi.spyOn(bcModule, 'bytesToBase64').mockReturnValue('b64-stub');
  __test.setTestClient(cli);
  state.nodes = [];
  await openViaClick();
  const sel = document.getElementById('ae-script-project');
  sel.value = 'demo.py';
  sel.dispatchEvent(new Event('change'));
  document.getElementById('ae-name').value = 'my task';
  const devSel = document.getElementById('ae-devices').querySelector('.ae-device-sel');
  devSel.innerHTML = '<option value="S1">S1</option>';
  devSel.value = 'S1';
}

describe('保存 ack 流程', () => {
  it('保存成功：转圈 → 收到 added ack（req_id 匹配）→ 关弹窗', async () => {
    const cli = fakeSaveClient();
    await openEditorAndSelectProject(cli);
    document.getElementById('ae-save').click();
    await flush();
    const saveBtn = document.getElementById('ae-save');
    expect(saveBtn.disabled).toBe(true);
    expect(document.getElementById('ae-save-spinner').hidden).toBe(false);
    // 未收到 ack 前不关弹窗
    expect(document.querySelector('.dlg-backdrop')).toBeTruthy();
    // init 时还会发 list_req/history_req，过滤出本次 add
    const addPayloads = cli.payloads.filter(p => p.type === 'automation_task_add' || p.type === 'automation_task_update');
    expect(addPayloads.length).toBe(1);
    const payload = addPayloads[0];
    expect(payload.req_id).toBeTruthy();
    // 后端广播 added ack（req_id 匹配）
    const task = { id: 't9', name: 'my task', schedule: payload.schedule, vars: payload.vars, enabled: true };
    (cli.handlers.automation || []).forEach(fn => fn({ type: 'automation_task_added', task, req_id: payload.req_id }));
    await flush();
    expect(document.querySelector('.dlg-backdrop')).toBeFalsy();
    expect(__test.tasks.some(t => t.id === 't9')).toBe(true);
  });

  it('保存失败：错误帧（req_id 匹配）→ 完成转圈、保持弹窗、显示错误', async () => {
    const cli = fakeSaveClient();
    await openEditorAndSelectProject(cli);
    document.getElementById('ae-save').click();
    await flush();
    const payload = cli.payloads.find(p => p.type === 'automation_task_add' || p.type === 'automation_task_update');
    (cli.handlers.error || []).forEach(fn => fn({ type: 'error', message: 'bad zip', req_id: payload.req_id }));
    await flush();
    expect(document.getElementById('ae-save').disabled).toBe(false);
    expect(document.getElementById('ae-save-spinner').hidden).toBe(true);
    const errEl = document.getElementById('ae-error');
    expect(errEl.hidden).toBe(false);
    expect(errEl.textContent).toContain('bad zip');
    expect(document.querySelector('.dlg-backdrop')).toBeTruthy();
    _closeEditorForTest();
  });

  it('保存失败：后端断开（state→disconnected）→ 保持弹窗 + 提示', async () => {
    const cli = fakeSaveClient();
    await openEditorAndSelectProject(cli);
    document.getElementById('ae-save').click();
    await flush();
    (cli.handlers.state || []).forEach(fn => fn('disconnected'));
    await flush();
    const errEl = document.getElementById('ae-error');
    expect(errEl.hidden).toBe(false);
    expect(errEl.textContent.trim().length).toBeGreaterThan(0);
    expect(document.querySelector('.dlg-backdrop')).toBeTruthy();
    expect(document.getElementById('ae-save').disabled).toBe(false);
    _closeEditorForTest();
  });

  it('req_id 不匹配的广播不误关弹窗', async () => {
    const cli = fakeSaveClient();
    await openEditorAndSelectProject(cli);
    document.getElementById('ae-save').click();
    await flush();
    const payload = cli.payloads.find(p => p.type === 'automation_task_add' || p.type === 'automation_task_update');
    // 其他客户端的 add 广播（不同 req_id）不应结束本次保存
    (cli.handlers.automation || []).forEach(fn => fn({
      type: 'automation_task_added',
      task: { id: 'other', name: 'x', schedule: payload.schedule, vars: payload.vars },
      req_id: 'someone-else',
    }));
    await flush();
    expect(document.querySelector('.dlg-backdrop')).toBeTruthy();
    // 自己的 ack 到达才收尾
    (cli.handlers.automation || []).forEach(fn => fn({
      type: 'automation_task_added',
      task: { id: 'mine', name: 'my task', schedule: payload.schedule, vars: payload.vars },
      req_id: payload.req_id,
    }));
    await flush();
    expect(document.querySelector('.dlg-backdrop')).toBeFalsy();
  });
});

/* ---- 编辑脚本下拉：后端已存脚本项（__backend__，保存时不重发覆盖） ---- */

describe('编辑脚本下拉：后端已存脚本项', () => {
  async function openEditWithStoredScript(cli, scriptName, projectName) {
    vi.spyOn(fsModule, 'getDirHandle').mockReturnValue({});
    vi.spyOn(fsModule, 'listProjectFiles').mockResolvedValue(['demo.py']);
    vi.spyOn(fsModule, 'getProjectName').mockResolvedValue('演示工程');
    vi.spyOn(fsModule, 'readProjectSource').mockResolvedValue('print(1)\n');
    vi.spyOn(bcModule, 'buildProjectBundle').mockResolvedValue(new Uint8Array([80, 75]));
    vi.spyOn(bcModule, 'bytesToBase64').mockReturnValue('b64-stub');
    __test.setTestClient(cli);
    const script = { source: 'project', name: scriptName };
    if (projectName) script.project_name = projectName;
    __test.handleMessage({
      type: 'automation_task_list',
      tasks: [makeTask({ id: 't1', script })],
    });
    document.querySelector('[data-act="edit"]').click();
    await new Promise(r => setTimeout(r, 0));
  }

  it('编辑工程型任务：默认选中"后端"项，显示 项目名（后端）', async () => {
    await openEditWithStoredScript(fakeClient(), 'e4706475-abc.py');
    const sel = document.getElementById('ae-script-project');
    expect(sel).toBeTruthy();
    expect(sel.value).toBe('__backend__');
    const opt = [...sel.options].find(o => o.value === '__backend__');
    expect(opt).toBeTruthy();
    expect(opt.selected).toBe(true);
    expect(opt.textContent.startsWith('e4706475-abc.py')).toBe(true);
    // 带"（后端）/(backend)"后缀（语言无关：比项目名多出后缀文字）
    expect(opt.textContent.length).toBeGreaterThan('e4706475-abc.py'.length);
    _closeEditorForTest();
  });

  it('编辑时"后端"项用 script.project_name 显示（不用 script.name）', async () => {
    await openEditWithStoredScript(fakeClient(), 'e4706475-abc.py', '演示工程');
    const opt = [...document.getElementById('ae-script-project').options]
      .find(o => o.value === '__backend__');
    expect(opt.textContent.startsWith('演示工程')).toBe(true);
    expect(opt.textContent).not.toContain('e4706475-abc.py');
    _closeEditorForTest();
  });

  it('保持"后端"项保存 → 不重发 zip_b64 / script（后端脚本原样保留）', async () => {
    const cli = fakeSaveClient();
    await openEditWithStoredScript(cli, 'e4706475-abc.py');
    document.getElementById('ae-save').click();
    await flush();
    const payload = cli.payloads.find(p => p.type === 'automation_task_update');
    expect(payload).toBeTruthy();
    expect(payload.zip_b64).toBeUndefined();
    expect(payload.script).toBeUndefined();
    // ack 收尾（清 pending，避免泄漏到下一测试）
    (cli.handlers.automation || []).forEach(fn => fn({
      type: 'automation_task_updated',
      task: { id: 't1', name: payload.name, schedule: payload.schedule, vars: payload.vars },
      req_id: payload.req_id,
    }));
    await flush();
  });

  it('改选前端工程后保存 → 重发 bundle 覆盖后端脚本', async () => {
    const cli = fakeSaveClient();
    await openEditWithStoredScript(cli, 'e4706475-abc.py');
    const sel = document.getElementById('ae-script-project');
    sel.value = 'demo.py';
    sel.dispatchEvent(new Event('change'));
    document.getElementById('ae-save').click();
    await flush();
    const payload = cli.payloads.find(p => p.type === 'automation_task_update');
    expect(payload.zip_b64).toBe('b64-stub');
    // script 元数据带 project_name（工程显示名），随任务持久化
    expect(payload.script).toEqual({ source: 'project', name: 'demo.py', project_name: '演示工程' });
    (cli.handlers.automation || []).forEach(fn => fn({
      type: 'automation_task_updated',
      task: { id: 't1', name: payload.name, schedule: payload.schedule, vars: payload.vars },
      req_id: payload.req_id,
    }));
    await flush();
  });
});

/* ---- 可用性：未选中/未连接后端 → 整区不可用 ---- */

describe('自动化区可用性', () => {
  it('无选中/未连接后端：显示提示文字 + 禁添加按钮 + 隐藏历史折叠区', () => {
    __test.setTestClient(null);
    initAutomationPanel();
    expect(document.getElementById('btnAddAutomationTask').disabled).toBe(true);
    const list = document.getElementById('automationTaskList');
    expect(list.querySelector('.automation__unavailable')).toBeTruthy();
    expect(list.textContent.trim().length).toBeGreaterThan(0);
  });

  it('选中后端且已连接：恢复可用（空任务显示空态）', () => {
    __test.setTestClient(fakeClient());
    initAutomationPanel();
    expect(document.getElementById('btnAddAutomationTask').disabled).toBe(false);
    expect(document.getElementById('automationTaskList').querySelector('.automation__unavailable')).toBeFalsy();
  });

  it('后端断开（state→disconnected）→ 立即进入不可用状态', () => {
    const cli = fakeSaveClient();
    __test.setTestClient(cli);
    initAutomationPanel();
    expect(document.getElementById('btnAddAutomationTask').disabled).toBe(false);
    cli.state = 'disconnected';   // 真实 client._setState 会改 state；fake 需手动同步
    (cli.handlers.state || []).forEach(fn => fn('disconnected'));
    expect(document.getElementById('btnAddAutomationTask').disabled).toBe(true);
    expect(document.getElementById('automationTaskList').querySelector('.automation__unavailable')).toBeTruthy();
  });
});

function _closeEditorForTest() {
  const root = document.querySelector('.dlg-backdrop');
  if (root) root.remove();
}

/* ---- 运行历史弹窗（每任务卡片入口） ---- */

describe('运行历史弹窗', () => {
  beforeEach(() => {
    __test.setTestClient(fakeClient());
  });

  it('任务卡片"历史"按钮位于"立即运行 / 编辑"之间，点开渲染该任务历史', () => {
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    const actions = document.querySelector('[data-act="run"]').parentElement;
    expect([...actions.querySelectorAll('button')].map(b => b.dataset.act))
      .toEqual(['run', 'history', 'edit', 'remove']);
    document.querySelector('[data-act="history"]').click();
    const dlg = document.querySelector('.automation-hist');
    expect(dlg).toBeTruthy();
    expect(dlg.querySelector('.dlg__header h3').textContent).toContain('demo');
    // 任务级历史响应（task_id 匹配）→ 弹窗渲染
    __test.handleMessage({
      type: 'automation_history_list', task_id: 't1', total: 1, limit: 50, offset: 0,
      runs: [{ run_id: 'r1', task_id: 't1', task_name: 'demo', status: 'success',
               duration_ms: 1200, started_at: '2026-08-13T10:00:00' }],
    });
    const items = dlg.querySelectorAll('.automation__hist-item');
    expect(items.length).toBe(1);
    expect(items[0].textContent).toContain('1.2s');
    _closeHistoryDialogForTest();
  });

  it('全局历史响应（无 task_id）不覆盖弹窗内容', () => {
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    document.querySelector('[data-act="history"]').click();
    __test.handleMessage({
      type: 'automation_history_list', task_id: 't1', total: 1,
      runs: [{ run_id: 'r1', task_id: 't1', status: 'success', duration_ms: 1000 }],
    });
    expect(document.querySelector('.automation-hist').querySelectorAll('.automation__hist-item').length).toBe(1);
    // 全局历史响应（不带 task_id）→ 走全局分支，弹窗内容不变
    __test.handleMessage({
      type: 'automation_history_list', total: 1,
      runs: [{ run_id: 'g1', task_id: 'other', status: 'failed', duration_ms: 500 }],
    });
    expect(document.querySelector('.automation-hist').querySelectorAll('.automation__hist-item').length).toBe(1);
    _closeHistoryDialogForTest();
  });

  it('ESC 关闭历史弹窗', () => {
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    document.querySelector('[data-act="history"]').click();
    expect(document.querySelector('.automation-hist')).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.automation-hist')).toBeFalsy();
  });
});

function _closeHistoryDialogForTest() {
  const root = document.querySelector('.automation-hist')?.closest('.dlg-backdrop');
  if (root) root.remove();
}

/* ---- 消息处理 + 渲染 ---- */

describe('消息处理 / 渲染', () => {
  // renderTasks 依赖"选中后端已连接"才渲染任务卡片；直接 handleMessage 时给个已连接 client
  beforeEach(() => {
    __test.setTestClient(fakeClient());
  });

  it('TASK_LIST 渲染任务卡片', () => {
    __test.handleMessage({
      type: 'automation_task_list',
      tasks: [makeTask(), makeTask({ id: 't2', name: 'b' })],
    });
    expect(__test.tasks.length).toBe(2);
    const cards = document.querySelectorAll('.automation__task');
    expect(cards.length).toBe(2);
    expect(cards[0].querySelector('.automation__task-name').textContent).toBe('demo');
    expect(document.getElementById('automationTaskList').textContent).toContain('S1');
  });

  it('TASK_ADDED 增量加入 + 重渲染', () => {
    __test.handleMessage({ type: 'automation_task_list', tasks: [] });
    __test.handleMessage({ type: 'automation_task_added', task: makeTask() });
    expect(document.querySelectorAll('.automation__task').length).toBe(1);
  });

  it('TASK_REMOVED 移除', () => {
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    __test.handleMessage({ type: 'automation_task_removed', task_id: 't1' });
    expect(__test.tasks).toEqual([]);
    expect(document.querySelector('.automation__empty')).toBeTruthy();
  });

  it('TASK_UPDATED 替换', () => {
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    __test.handleMessage({ type: 'automation_task_updated', task: makeTask({ name: 'renamed' }) });
    expect(document.querySelector('.automation__task-name').textContent).toBe('renamed');
  });

  it('HISTORY_LIST 记录历史', () => {
    __test.handleMessage({
      type: 'automation_history_list',
      runs: [{ run_id: 'r1', task_id: 't1', task_name: 'demo', status: 'success', duration_ms: 1200 }],
      total: 1,
    });
    expect(__test.history.length).toBe(1);
    expect(__test.history[0].status).toBe('success');
  });

  it('空列表显示空态', () => {
    __test.handleMessage({ type: 'automation_task_list', tasks: [] });
    const empty = document.querySelector('.automation__empty');
    expect(empty).toBeTruthy();
    expect(empty.textContent.trim().length).toBeGreaterThan(0);
  });
});

describe('排队中徽标', () => {
  beforeEach(() => {
    __test.setTestClient(fakeClient());
    __test.resetRuns();   // _activeRuns/_queuedRuns 为模块级状态，逐例清空防串扰
  });

  it('run_queued 后任务卡片显示排队中，运行按钮变"取消"并可点击', () => {
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    __test.handleMessage({ type: 'automation_run_started', run_id: 'r1', task_id: 't1' });
    __test.handleMessage({ type: 'automation_run_queued', run_id: 'r2', task_id: 't1' });
    const txt = document.querySelector('.automation__task-status').textContent;
    expect(txt).toContain('排队中');
    expect(txt).toContain('运行中');
    const runBtn = document.querySelector('.automation__task-actions [data-act="run"]');
    expect(runBtn.disabled).toBe(false);
    expect(runBtn.textContent).toBe(t('automation.cancel'));
  });

  it('仅排队中时运行按钮也变"取消"，点击发送取消消息', () => {
    const sent = [];
    const cli = { state: 'connected', _automationHooked: false, on() {}, sendRaw(o) { sent.push(o); return true; } };
    __test.setTestClient(cli);
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    __test.handleMessage({ type: 'automation_run_queued', run_id: 'r2', task_id: 't1' });
    const runBtn = document.querySelector('.automation__task-actions [data-act="run"]');
    expect(runBtn.disabled).toBe(false);
    expect(runBtn.textContent).toBe(t('automation.cancel'));
    runBtn.click();
    expect(sent).toContainEqual({ type: 'automation_cancel', task_id: 't1' });
  });

  it('run_unqueued 后排队中徽标消失，运行按钮恢复可用', () => {
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    __test.handleMessage({ type: 'automation_run_queued', run_id: 'r2', task_id: 't1' });
    __test.handleMessage({ type: 'automation_run_unqueued', run_id: 'r2', task_id: 't1' });
    expect(document.querySelector('.automation__task-status').textContent).not.toContain('排队中');
    expect(document.querySelector('.automation__task-actions [data-act="run"]').disabled).toBe(false);
  });

  it('exit 同时清除运行中与排队中，运行按钮恢复可用', () => {
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    __test.handleMessage({ type: 'automation_run_started', run_id: 'r1', task_id: 't1' });
    __test.handleMessage({ type: 'automation_run_queued', run_id: 'r2', task_id: 't1' });
    __test.handleMessage({ type: 'automation_exit', run_id: 'r1', task_id: 't1', code: 0, status: 'success' });
    __test.handleMessage({ type: 'automation_exit', run_id: 'r2', task_id: 't1', code: 0, status: 'success' });
    const txt = document.querySelector('.automation__task-status').textContent;
    expect(txt).not.toContain('运行中');
    expect(txt).not.toContain('排队中');
    expect(document.querySelector('.automation__task-actions [data-act="run"]').disabled).toBe(false);
  });
});

describe('上次结果：EXIT 同步更新（不等 history_list 响应）', () => {
  beforeEach(() => {
    __test.setTestClient(fakeClient());
  });

  it('初始 history=[success] → 卡片显示成功', () => {
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    __test.handleMessage({
      type: 'automation_history_list',
      runs: [{ run_id: 'r1', task_id: 't1', status: 'success' }],
    });
    expect(document.querySelector('.automation__task-status').textContent)
      .toContain('成功');
  });

  it('EXIT failed（无 history_list 响应）→ 卡片立即显示失败', () => {
    // 关键场景：refreshHistory 是异步的，如果不等它返回就 renderTasks，
    // 卡片会用 EXIT 之前的旧 _history 渲染，显示"成功"。EXIT 处理必须
    // 同步把 status 写进 _history，renderTasks 才能立刻显示"失败"。
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    __test.handleMessage({
      type: 'automation_history_list',
      runs: [{ run_id: 'r1', task_id: 't1', status: 'success' }],
    });
    __test.handleMessage({
      type: 'automation_exit', run_id: 'r2', task_id: 't1', code: 1, status: 'failed',
    });
    expect(document.querySelector('.automation__task-status').textContent)
      .toContain('失败');
  });

  it('EXIT 后 history_list 响应回来 → _history 不重复（run_id 唯一，字段被完整版覆盖）', () => {
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    __test.handleMessage({
      type: 'automation_exit', run_id: 'r2', task_id: 't1', code: 1, status: 'failed',
    });
    expect(__test.history.filter(r => r.run_id === 'r2').length).toBe(1);

    __test.handleMessage({
      type: 'automation_history_list',
      runs: [
        { run_id: 'r2', task_id: 't1', status: 'failed', duration_ms: 1234 },
        { run_id: 'r1', task_id: 't1', status: 'success' },
      ],
    });
    const r2 = __test.history.find(r => r.run_id === 'r2');
    expect(r2.duration_ms).toBe(1234);
    expect(__test.history.filter(r => r.run_id === 'r2').length).toBe(1);
  });
});

describe('删除任务确认弹窗', () => {
  beforeEach(() => {
    __test.setTestClient(fakeClient());
    __test.resetRuns();
  });

  it('垃圾桶 → 自定义确认弹窗（非浏览器原生 confirm），取消不发送删除', () => {
    const sent = [];
    const cli = { state: 'connected', _automationHooked: false, on() {}, sendRaw(o) { sent.push(o); return true; } };
    __test.setTestClient(cli);
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    document.querySelector('[data-act="remove"]').click();
    const confirm = document.querySelector('.automation-confirm');
    expect(confirm).toBeTruthy();
    expect(confirm.textContent).toContain(t('automation.deleteConfirm', { name: 'demo' }));
    // 取消 → 关闭且不发送删除
    document.querySelector('#ae-del-cancel').click();
    expect(document.querySelector('.automation-confirm')).toBeFalsy();
    expect(sent.some(o => o.type === 'automation_task_remove')).toBe(false);
  });

  it('确认 → 发送删除并关闭弹窗', () => {
    const sent = [];
    const cli = { state: 'connected', _automationHooked: false, on() {}, sendRaw(o) { sent.push(o); return true; } };
    __test.setTestClient(cli);
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    document.querySelector('[data-act="remove"]').click();
    document.querySelector('#ae-del-ok').click();
    expect(sent.some(o => o.type === 'automation_task_remove' && o.task_id === 't1')).toBe(true);
    expect(document.querySelector('.automation-confirm')).toBeFalsy();
  });

  it('运行/排队中：删除按钮禁用；结束后恢复', () => {
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    __test.handleMessage({ type: 'automation_run_queued', run_id: 'r2', task_id: 't1' });
    expect(document.querySelector('.automation__task-actions [data-act="remove"]').disabled).toBe(true);
    __test.handleMessage({ type: 'automation_run_unqueued', run_id: 'r2', task_id: 't1' });
    expect(document.querySelector('.automation__task-actions [data-act="remove"]').disabled).toBe(false);
  });

  it('弹窗打开期间任务进入运行：确认 → 删除失败，不发送删除', () => {
    const sent = [];
    const cli = { state: 'connected', _automationHooked: false, on() {}, sendRaw(o) { sent.push(o); return true; } };
    __test.setTestClient(cli);
    __test.handleMessage({ type: 'automation_task_list', tasks: [makeTask()] });
    document.querySelector('[data-act="remove"]').click();
    // 竞态：确认前任务开始运行
    __test.handleMessage({ type: 'automation_run_started', run_id: 'r1', task_id: 't1' });
    document.querySelector('#ae-del-ok').click();
    expect(sent.some(o => o.type === 'automation_task_remove')).toBe(false);
    expect(document.querySelector('.automation-confirm')).toBeFalsy();
  });
});
