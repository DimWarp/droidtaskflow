/**
 * 判定一次 pointerdown 是否应启动画布平移。
 * 中键（1）恒可平移；右键（2）跟中键一样穿透任何元素平移（让"按住右键拖画布"在节点/工具栏上都生效），
 * 浏览器原生 contextmenu 已被 interactions.js 全局 preventDefault，不会弹系统菜单。
 * 左键（0）仅限空白且未拖线（拖线中左键已归拖线用）。
 * @param {number}  button             PointerEvent.button（0 左 / 1 中 / 2 右）
 * @param {boolean} overNode           光标是否命中 .node
 * @param {boolean} overZoomBar        光标是否命中 #zoomBar
 * @param {boolean} overToolbar        光标是否命中 .canvas-toolbar
 * @param {boolean} wireDragActive     是否正在拖线（!!wireDrag）
 * @param {boolean} overWireDelete     光标是否命中连线删除钮 .wire-delete
 */
export function shouldStartPan(button, overNode, overZoomBar, overToolbar, wireDragActive, overWireDelete) {
    if (button === 1) return true;
    // 右键（2）跟中键一样：穿透任何元素平移。之前的"只在拖线 / 空白才平移"太严，
    // 用户在节点标题上想拖画布时只移动了节点，文档设备预览 / zoomBar / 工具栏区域更点不到。
    if (button === 2) return true;
    if (button === 0) return !wireDragActive && !overNode && !overZoomBar && !overToolbar && !overWireDelete;
    return false;
}

/**
 * 根据 PointerEvent.buttons 位掩码的前后变化判定平移动作。
 * 关键：浏览器对「已按住某键时再按第二个键」不派发 pointerdown/pointerup，只派发
 * pointermove（e.button=新按键、e.buttons=按住位掩码）。因此平移启停必须基于
 * 位掩码（1=左 2=右 4=中）的上升/下降沿判定，而不是 pointerdown/up。
 * @param {number} prevButtons  上一个事件的 buttons 位掩码
 * @param {number} currButtons  当前事件的 buttons 位掩码
 * @param {{overNode:boolean, overZoomBar:boolean, overToolbar:boolean, wireDragActive:boolean}} ctx
 * @param {number|null} panButton 正在驱动平移的按钮（未平移时为 null）
 * @returns {{stop:true}|{start:true, button:number}|null}
 */
export function panButtonEdge(prevButtons, currButtons, ctx, panButton) {
    // 平移中：只响应「驱动按钮」对应位的下降沿 → 停止
    if (panButton != null) {
        const stopBit = panButton === 1 ? 4 : panButton === 2 ? 2 : 1;
        return ((prevButtons & stopBit) && !(currButtons & stopBit)) ? { stop: true } : null;
    }
    // 未平移：任一 pan 按钮的上升沿 → 交给 shouldStartPan 按目标判定
    const edges = [];
    if (!(prevButtons & 4) && (currButtons & 4)) edges.push(1);   // 中键按下
    if (!(prevButtons & 2) && (currButtons & 2)) edges.push(2);   // 右键按下
    if (!(prevButtons & 1) && (currButtons & 1)) edges.push(0);   // 左键按下
    for (const b of edges) {
        if (shouldStartPan(b, ctx.overNode, ctx.overZoomBar, ctx.overToolbar, ctx.wireDragActive, ctx.overWireDelete)) {
            return { start: true, button: b };
        }
    }
    return null;
}
