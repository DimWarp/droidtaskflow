// 发现的无线设备列表弹窗：M9b。
// 调用方传 services 列表（mdns_scan 返回），渲染成可点列表。
// 点某一项 resolve 该 service（{name, service, address, port}），用户带回主 wifi-pair 流程预填字段。

import { t, applyStaticDom } from './i18n.js';

const HTML = `
  <div class="dlg-backdrop" role="dialog" aria-modal="true">
    <div class="dlg dlg--list">
      <header class="dlg__header">
        <h3 data-bind="title"></h3>
        <button class="dlg__close" type="button">✕</button>
      </header>
      <div class="dlg__body">
        <ul class="wifi-discover-list" data-bind="list"></ul>
        <p class="dlg__hint" data-bind="empty" hidden></p>
      </div>
      <footer class="dlg__footer">
        <button data-act="cancel" data-i18n="dialog.cancel">取消</button>
      </footer>
    </div>
  </div>
`;

/**
 * 打开"发现的设备"弹窗。
 * @param {Array<{name, service, address, port}>} services
 * @returns {Promise<object|null>} 选中的 service；null = 取消
 */
export function openWifiDiscoverDialog(services) {
    return new Promise((resolve) => {
        const wrap = document.createElement('div');
        wrap.innerHTML = HTML.trim();
        const root = wrap.firstElementChild;
        applyStaticDom(root);
        document.body.appendChild(root);

        const $title = root.querySelector('[data-bind="title"]');
        $title.textContent = t('backend.wifiDiscoverTitle');

        const $list = root.querySelector('[data-bind="list"]');
        const $empty = root.querySelector('[data-bind="empty"]');

        if (!services || services.length === 0) {
            $list.hidden = true;
            $empty.textContent = t('backend.wifiDiscoverEmpty');
            $empty.hidden = false;
        } else {
            $empty.hidden = true;
            for (const svc of services) {
                const li = document.createElement('li');
                li.className = 'wifi-discover-list__item';
                li.innerHTML = `
                    <div class="wifi-discover-list__name"></div>
                    <div class="wifi-discover-list__addr"></div>
                `;
                li.querySelector('.wifi-discover-list__name').textContent =
                    svc.name || svc.service || '(unnamed)';
                li.querySelector('.wifi-discover-list__addr').textContent =
                    `${svc.address}:${svc.port}`;
                li.onclick = () => close(svc);
                $list.appendChild(li);
            }
        }

        let onKeydown;
        function close(result) {
            if (onKeydown) document.removeEventListener('keydown', onKeydown);
            try { document.body.removeChild(root); } catch (_) {}
            resolve(result);
        }

        const $cancel = root.querySelector('[data-act="cancel"]');
        const $close = root.querySelector('.dlg__close');
        $cancel.onclick = () => close(null);
        $close.onclick = () => close(null);
        onKeydown = (e) => { if (e.key === 'Escape') close(null); };
        document.addEventListener('keydown', onKeydown);
    });
}
