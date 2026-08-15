// 后端对话框：添加 / 编辑。校验 + 可选的"测试"按钮(轻量级连通性探测)。
// 不再在对话框内直接 connect — 添加后用户通过 sidebar 行内的"连接"按钮触发。

import { state, toast } from './state.js';
import { t, applyStaticDom } from './i18n.js';

// 静态中文用 data-i18n 标记；每次打开对话框后 applyStaticDom(root) 按当前语言渲染。
// （不放 t() 到模板里——模块级常量只在加载时求值一次，语言切换不会刷新）
const HTML = `
  <div class="dlg-backdrop" role="dialog" aria-modal="true">
    <div class="dlg">
      <header class="dlg__header">
        <h3 data-bind="title"></h3>
        <button class="dlg__close" type="button">✕</button>
      </header>
      <div class="dlg__body">
        <label><span data-i18n="backend.name">名称</span> <input data-name="name" data-i18n-placeholder="backend.namePlaceholder" placeholder="可选，留空用 host:port"></label>
        <label><span data-i18n="backend.host">主机</span> <input data-name="host" data-i18n-placeholder="backend.hostPlaceholder" placeholder="192.168.x.x 或 localhost"></label>
        <label><span data-i18n="backend.port">端口</span> <input data-name="port" type="number" min="1" max="65535"></label>
        <div class="dlg__error" hidden></div>
      </div>
      <footer class="dlg__footer">
        <button data-act="cancel" data-i18n="dialog.cancel">取消</button>
        <button data-act="test" class="dlg__test" type="button">
          <span class="dlg__test-spinner" hidden></span>
          <span class="dlg__test-label" data-i18n="backend.test">测试</span>
        </button>
        <button data-act="ok" class="dlg__ok"></button>
      </footer>
    </div>
  </div>
`;

/**
 * 打开添加后端对话框。返回 {host, port, name}，**不连接**，由 sidebar 行内"连接"按钮触发
 */
export async function openAddBackendDialog() {
  return openBackendDialog({ title: t('backend.addTitle'), okLabel: t('backend.add') });
}

/**
 * 打开编辑后端对话框。`initial` 提供 host/port/name 的当前值。返回 {host, port, name}。
 */
export async function openEditBackendDialog(initial) {
  return openBackendDialog({ title: t('backend.editTitle'), okLabel: t('dialog.save'), initial });
}

/**
 * 通用后端对话框。
 * @param {object}  [opts]
 * @param {string}  [opts.title='添加后端']    标题文本
 * @param {string}  [opts.okLabel='添加']      确认按钮文本（添加 / 保存）
 * @param {object}  [opts.initial]             预填值 { host, port, name }
 * @returns {Promise<{host, port, name} | null>}
 */
export async function openBackendDialog(opts = {}) {
  const { title = t('backend.addTitle'), okLabel = t('backend.add'), initial = null } = opts;
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.innerHTML = HTML.trim();
    const root = wrap.firstElementChild;
    applyStaticDom(root);   // 静态 label/placeholder/按钮按当前语言渲染
    document.body.appendChild(root);

    const $title = root.querySelector('[data-bind="title"]');
    $title.textContent = title;
    const $name = root.querySelector('[data-name="name"]');
    const $host = root.querySelector('[data-name="host"]');
    const $port = root.querySelector('[data-name="port"]');
    const $err = root.querySelector('.dlg__error');
    const $ok = root.querySelector('[data-act="ok"]');
    const $test = root.querySelector('[data-act="test"]');
    const $testLabel = $test.querySelector('.dlg__test-label');
    const $testSpinner = $test.querySelector('.dlg__test-spinner');
    const $cancel = root.querySelector('[data-act="cancel"]');
    const $close = root.querySelector('.dlg__close');
    $ok.textContent = okLabel;

    if (initial) {
      if (initial.host != null) $host.value = initial.host;
      if (initial.port != null) $port.value = String(initial.port);
      if (initial.name != null) $name.value = initial.name;
    }

    let onKeydown;
    function close(result) {
      if (onKeydown) document.removeEventListener('keydown', onKeydown);
      try { document.body.removeChild(root); } catch (_) {}
      resolve(result);
    }

    function readHostPort() {
      const host = $host.value.trim();
      const port = parseInt($port.value, 10);
      if (!host) return { error: t('backend.errHostEmpty') };
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        return { error: t('backend.errPortRange') };
      }
      return { host, port };
    }

    $cancel.onclick = () => close(null);
    $close.onclick = () => close(null);
    // ESC 也关闭；不响应点击弹窗外部:用户填了一半数据误点背景就丢数据了,只能走取消/添加/ESC
    onKeydown = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKeydown);

    $test.onclick = async () => {
      $err.hidden = true;
      const hp = readHostPort();
      if (hp.error) { $err.textContent = hp.error; $err.hidden = false; return; }
      const { host, port } = hp;
      $test.disabled = true;
      // 用 spinner 替换"测试"文字(不是改字),按钮宽度由 min-width 锁住不变
      $testLabel.hidden = true;
      $testSpinner.hidden = false;
      try {
        const result = await _testBackend(host, port);
        _showTestToast(result);
      } catch (e) {
        toast(t('backend.testFail', { msg: e && e.message ? e.message : e }));
      } finally {
        $test.disabled = false;
        $testLabel.hidden = false;
        $testSpinner.hidden = true;
      }
    };

    $ok.onclick = () => {
      $err.hidden = true;
      const hp = readHostPort();
      if (hp.error) { $err.textContent = hp.error; $err.hidden = false; return; }
      const name = $name.value.trim();
      close({ host: hp.host, port: hp.port, name });
    };

    // Enter 在 host/port 任意字段都触发"添加"(测试按钮更近,语义上先测后加,
    // 但 Enter 在 port 时仍按添加走,避免输入完端口后被强制测试)
    [$host, $port, $name].forEach(($el) => {
      $el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $ok.click();
      });
    });
  });
}

/**
 * 调用后端 GET /test 做轻量级连通性测试。
 * 后端约定接口返回 JSON：{http, ws, device_list, total} 每个字段 'ok' | 'failed'。
 * total = 'ok' 表示全部通过。
 *
 * 前端只负责发起请求 + 渲染结果,具体检查逻辑在后端。
 * @returns {Promise<{http, ws, device_list, total, error?}>}
 */
async function _testBackend(host, port) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);  // 测试包含 ws 握手 + 首条消息,稍长
  try {
    const r = await fetch(`http://${host}:${port}/test`, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (typeof j !== 'object' || j == null) throw new Error('invalid response');
    return j;
  } catch (e) {
    return {
      http: 'failed',
      ws: 'failed',
      device_list: 'failed',
      total: 'failed',
      error: e && e.message ? e.message : String(e),
    };
  } finally {
    clearTimeout(t);
  }
}

function _showTestToast(result) {
  const f = (v) => (v === 'ok' ? t('backend.pass') : t('backend.fail'));
  if (result.total === 'ok') {
    toast(t('backend.testPass'));
  } else {
    const parts = [];
    if (result.http) parts.push(`HTTP ${f(result.http)}`);
    if (result.ws) parts.push(`WS ${f(result.ws)}`);
    if (result.device_list) parts.push(t('backend.deviceList', { s: f(result.device_list) }));
    const detail = parts.length ? parts.join(' / ') : 'unknown';
    const err = result.error ? t('backend.errSuffix', { msg: result.error }) : '';
    toast(t('backend.testFailDetail', { detail, err }));
  }
}