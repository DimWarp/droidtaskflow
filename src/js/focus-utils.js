// 默认禁用 button 键盘 Tab 焦点循环：除显式声明 tabindex="0" 的 button 外，
// 全部设为 tabindex=-1。Tab 键因此跳过所有 button，只走 input/textarea/select
// 等表单控件之间的焦点切换。
//
// 用户意图：自动化卡片按钮点击 → 弹框 → Esc 后，"多余黑框（focus-visible）"看着像
// 焦点头疼。直接把 button 从 Tab 循环里移除，焦点根本不会落到 button 上 → 黑框消失。
//
// 注意：这是 WAI-ARIA 反模式（交互元素应键盘可达）。本项目产品形态偏桌面端可视化
// 编辑，鼠标/触控是主交互路径，键盘只用于在输入框之间快速穿梭。如果将来要支持完整
// 键盘导航，把这个 disable 关掉、改用 :focus-visible 自定义样式即可。

/**
 * 把所有未显式声明 tabindex 的 <button> 设为 tabindex=-1。
 * 已显式 tabindex="0" 的保留（需要键盘可达的提交按钮等）。
 *
 * 同时挂一个 MutationObserver 监控全文档，新插入的 button 自动也走 tabindex=-1。
 * （项目是全量重绘 render() 模式，button 随时新增。）
 */
export function disableButtonTabIndex() {
    const _tagButton = (btn) => {
        if (btn.tagName === 'BUTTON' && !btn.hasAttribute('tabindex')) {
            btn.tabIndex = -1;
        }
    };
    // 一次性扫现有
    for (const btn of document.querySelectorAll('button')) _tagButton(btn);
    // 监听 DOM 变化（render() / 弹窗插入等动态加 button 也能自动加上）
    new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.tagName === 'BUTTON') _tagButton(node);
                if (node.querySelectorAll) {
                    for (const btn of node.querySelectorAll('button')) _tagButton(btn);
                }
            }
        }
    }).observe(document.body, { childList: true, subtree: true });
}