// 无线设备连接弹窗：M9 + M9e。
// 复用 dlg-backdrop / dlg 样式（与 backend-dialog 统一），暴露一组
// ip / connect_port / pair_port / code 字段。
//
// M9e 行为：
//   - ip 与 connect_port 必填（label 加 *）
//   - 如果 pair_port 与 code 都填了 → 走 pair 协议（adb pair + adb connect）
//   - 否则（仅 ip + connect_port）→ 仅 adb connect（手机已配对过 host / 旧 adb fallback）
//
// 成功：resolve { ip, connectPort, pairPort?, code? }
//   - pair+code 都填了 → 四个字段全返，caller 调 requestDevicePair
//   - 仅 ip+connectPort → resolve { ip, connectPort, onlyConnect: true }，
//     caller 调 requestDeviceConnectWifi
// 失败/取消：resolve null
//
// "尝试发现设备"按钮（M9b）保留，关闭弹窗让 caller 主动 mDNS 扫描。

import { t, applyStaticDom } from './i18n.js';

const HTML = `
  <div class="dlg-backdrop" role="dialog" aria-modal="true">
    <div class="dlg">
      <header class="dlg__header">
        <h3 data-bind="title"></h3>
        <button class="dlg__close" type="button">✕</button>
      </header>
      <div class="dlg__body">
        <label><span data-i18n="backend.wifiPairBackend">后端</span>
          <input data-name="backend" readonly tabindex="-1"></label>
        <label><span class="dlg__label-row"><span data-i18n="backend.wifiPairIp">IP</span><span class="dlg__required">*</span></span>
          <input data-name="ip" autocomplete="off"></label>
        <label><span class="dlg__label-row"><span data-i18n="backend.wifiPairConnectPort">端口（连接）</span><span class="dlg__required">*</span></span>
          <input data-name="connectPort" type="number" min="1" max="65535"></label>
        <label><span data-i18n="backend.wifiPairPairPort">端口（配对）</span>
          <input data-name="pairPort" type="number" min="1" max="65535"></label>
        <label><span data-i18n="backend.wifiPairCode">配对码</span>
          <input data-name="code" data-i18n-placeholder="backend.wifiPairCodePlaceholder"
                 placeholder="6 位配对码" autocomplete="off"></label>
        <hr class="dlg__divider">
        <p class="dlg__hint" data-i18n="backend.wifiPairHint">
          请在设备「开发者选项 → 无线调试」中查看
        </p>
        <p class="dlg__hint" data-i18n="backend.wifiPairAndroidOnly">
          仅支持 Android 11+
        </p>
        <div class="dlg__error" hidden></div>
      </div>
      <footer class="dlg__footer">
        <button data-act="cancel" data-i18n="dialog.cancel">取消</button>
        <button data-act="discover" data-i18n="backend.wifiPairDiscover">尝试发现设备</button>
        <button data-act="ok" class="dlg__ok" data-i18n="backend.wifiConnect">连接无线设备</button>
      </footer>
    </div>
  </div>
`;

/**
 * 打开无线设备弹窗。
 * @param {object} opts
 * @param {string} opts.backendName  只读展示，给用户确认是这个后端
 * @param {object} [opts.initial]    预填值 { ip, connectPort, pairPort? }
 *   mDNS 发现设备后回填 IP + 端口，让用户只需补配对码；
 *   编辑现有无线设备时回填 IP + 连接端口（配对端口/配对码可选）。
 * @returns {Promise<{ip, connectPort, pairPort, code} |
 *                  {ip, connectPort, onlyConnect:true} |
 *                  {discover:true} | null>}
 *   null              = 用户取消 / Esc / 关闭
 *   {discover}        = 用户点"尝试发现设备"
 *   {onlyConnect,...} = 用户点连接且只填了 ip + connect_port → 走 adb connect
 *   {ip,...}          = 用户点连接且填全配对信息 → 走 adb pair + adb connect
 */
export function openWifiPairDialog(opts) {
    const { backendName, initial = null } = opts;
    return new Promise((resolve) => {
        const wrap = document.createElement('div');
        wrap.innerHTML = HTML.trim();
        const root = wrap.firstElementChild;
        applyStaticDom(root);
        document.body.appendChild(root);

        const $title = root.querySelector('[data-bind="title"]');
        $title.textContent = t('backend.wifiConnectTitle');

        const $backend = root.querySelector('[data-name="backend"]');
        const $ip = root.querySelector('[data-name="ip"]');
        const $pairPort = root.querySelector('[data-name="pairPort"]');
        const $connectPort = root.querySelector('[data-name="connectPort"]');
        const $code = root.querySelector('[data-name="code"]');
        const $err = root.querySelector('.dlg__error');
        const $ok = root.querySelector('[data-act="ok"]');
        const $discover = root.querySelector('[data-act="discover"]');
        const $cancel = root.querySelector('[data-act="cancel"]');
        const $close = root.querySelector('.dlg__close');

        $backend.value = backendName || '';
        if (initial) {
            if (initial.ip != null) $ip.value = String(initial.ip);
            if (initial.connectPort != null) $connectPort.value = String(initial.connectPort);
            if (initial.pairPort != null) $pairPort.value = String(initial.pairPort);
            // 编辑模式下不预填 code（每次配对随机）
        }

        let onKeydown;
        function close(result) {
            if (onKeydown) document.removeEventListener('keydown', onKeydown);
            try { document.body.removeChild(root); } catch (_) {}
            resolve(result);
        }

        function readFields() {
            const ip = $ip.value.trim();
            const pairPort = parseInt($pairPort.value, 10);
            const connectPort = parseInt($connectPort.value, 10);
            const code = $code.value.trim();
            // 必填：IP + 连接端口
            if (!ip) return { error: t('backend.errHostEmpty') };
            if (!Number.isFinite(connectPort) || connectPort < 1 || connectPort > 65535) {
                return { error: t('backend.errPortRange') };
            }
            // pairPort 与 code 选填：
            //   - 都填了 → 走 pair（手机尚未配对本 host / 重新配对）
            //   - 都没填 → 走仅 connect（手机已配对过本 host，重连）
            //   - 只填一个 → 半填的 pair 信息无效（提示用户填全或都留空）
            const hasPairPort = $pairPort.value.trim() !== ''
                && Number.isFinite(pairPort) && pairPort >= 1 && pairPort <= 65535;
            const hasCode = code !== '';
            if (hasPairPort !== hasCode) {
                return { error: t('backend.wifiPairHalfFilled') };
            }
            if (hasPairPort && hasCode) {
                return { ip, connectPort, pairPort, code };
            }
            return { ip, connectPort, onlyConnect: true };
        }

        $cancel.onclick = () => close(null);
        $close.onclick = () => close(null);
        onKeydown = (e) => { if (e.key === 'Escape') close(null); };
        document.addEventListener('keydown', onKeydown);

        // M9b: "尝试发现设备"按钮 — 关闭弹窗，让 caller 主动调 mDNS 扫描
        $discover.onclick = () => close({ discover: true });

        $ok.onclick = () => {
            $err.hidden = true;
            const r = readFields();
            if (r.error) { $err.textContent = r.error; $err.hidden = false; return; }
            if (r.onlyConnect) {
                close({ ip: r.ip, connectPort: r.connectPort, onlyConnect: true });
            } else {
                close({ ip: r.ip, connectPort: r.connectPort, pairPort: r.pairPort, code: r.code });
            }
        };

        // Enter 任一字段都触发"连接"
        [$ip, $pairPort, $connectPort, $code].forEach(($el) => {
            $el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') $ok.click();
            });
        });

        // 自动 focus IP 字段
        setTimeout(() => $ip.focus(), 0);
    });
}
