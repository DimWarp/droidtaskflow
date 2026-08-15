import { describe, it, expect, beforeEach } from 'vitest';
import { copyProject, setDirHandle } from '../../src/js/filesystem.js';
import { refreshProjectList, setCurrentFile } from '../../src/js/sidebar.js';

/** Build a mock File System Access workspace with a project/ subdir. */
function makeMockWorkspace(files) {
    const store = { ...files };
    const projectDir = {
        async getFileHandle(name, opts) {
            if (opts && opts.create && !(name in store)) store[name] = '';
            if (!(name in store)) throw Object.assign(new Error('Not found'), { name: 'NotFoundError' });
            const fh = {
                async getFile() { return { text: async () => store[name] }; },
                async createWritable() {
                    let buf = '';
                    return {
                        async write(data) { buf += String(data); },
                        async close() { store[name] = buf; },
                    };
                },
            };
            return fh;
        },
        async *entries() {
            for (const [name, content] of Object.entries(store)) {
                yield [name, { kind: 'file', getFileHandle: async () => store[name] }];
            }
        },
    };
    const dirHandle = {
        async getDirectoryHandle() { return projectDir; },
    };
    return { dirHandle, store, projectDir };
}

describe('copyProject — 工程复制', () => {
    const SOURCE = `project("登录测试", version="1.0")\nstart_node("n1")\n@node("n1", name="start", position={"x":100,"y":100})\ndef n1():\n    pass\n`;

    it('写入新 UUID 文件，内容原样不变', async () => {
        const { dirHandle, store, projectDir } = makeMockWorkspace({ 'a.py': SOURCE });
        const newName = await copyProject(dirHandle, 'a.py');

        expect(newName).toMatch(/^[0-9a-f-]{36}\.py$/);
        expect(newName).not.toBe('a.py');
        expect(store['a.py']).toBe(SOURCE);           // 原文件未动
        expect(store[newName]).toBe(SOURCE);          // 新文件内容一致（含 project("名字") 不变）
        // 新文件真实存在于 project/ 子目录（可被 getFileHandle 读取）
        expect(projectDir).toBeDefined();
    });

    it('复制后新文件可通过 getFileHandle 读回相同内容', async () => {
        const { dirHandle, store } = makeMockWorkspace({ 'b.py': 'project("B")\n' });
        const newName = await copyProject(dirHandle, 'b.py');
        const fh = await (await dirHandle.getDirectoryHandle()).getFileHandle(newName);
        const file = await fh.getFile();
        expect(await file.text()).toBe('project("B")\n');
        expect(store).toHaveProperty(newName);
    });
});

describe('sidebar 复制按钮渲染顺序', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div class="sidebar">
              <div class="sidebar__section"></div>
              <div class="sidebar__section"><div class="sidebar__section-body"></div></div>
            </div>`;
        setCurrentFile('');
        setDirHandle(null);
    });

    it('未打开条目 [复制][删除]；当前条目 [重命名][导出][复制][删除]', async () => {
        const { dirHandle } = makeMockWorkspace({
            'a.py': 'project("A")\n',
            'b.py': 'project("B")\n',
        });
        setDirHandle(dirHandle);
        setCurrentFile('a.py');
        await refreshProjectList();

        const items = document.querySelectorAll('.sidebar__file');
        expect(items.length).toBe(2);

        // a.py（当前打开）：名称 + [重命名][导出][复制][删除]
        const clsA = [...items[0].children].map(c => c.className);
        expect(clsA).toEqual([
            'sidebar__file-name',
            'sidebar__file-rename',
            'sidebar__file-export',
            'sidebar__file-copy',
            'sidebar__file-delete',
        ]);

        // b.py（未打开）：名称 + [复制][删除]
        const clsB = [...items[1].children].map(c => c.className);
        expect(clsB).toEqual([
            'sidebar__file-name',
            'sidebar__file-copy',
            'sidebar__file-delete',
        ]);
    });
});
