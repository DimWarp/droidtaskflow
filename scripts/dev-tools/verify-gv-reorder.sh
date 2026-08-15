#!/usr/bin/env bash
# scripts/dev-tools/verify-gv-reorder.sh — 真实浏览器验证：全局变量栏拖拽排序 + 拖拽中竖线指示器
#
# 依赖: agent-browser CLI (chrome-mcp) + 本地 Vite dev server (:5173)
# 用法: bash scripts/dev-tools/verify-gv-reorder.sh
set -euo pipefail
B="agent-browser"
SESS="gvreorder-$$"
E() { $B eval --session "$SESS" "$1"; }

# 1. 打开应用（独立会话，避免污染已有页面）
$B open --session "$SESS" "http://localhost:5173/" >/dev/null
sleep 1.5

# 2. 启动弹窗 → 临时模式
if [ "$(E "Boolean(document.querySelector('#startupBtnTemp'))")" = "true" ]; then
  E "document.querySelector('#startupBtnTemp').click()"
  sleep 1
fi
E "Boolean(document.querySelector('#gvItems'))" >/dev/null

# 3. 添加自定义变量 a, b, c（device_id 固定项已存在）
for v in a b c; do
  E "document.querySelector('#gvAdd').click()"
  sleep 0.25
  # 直接赋值 + 派发 Enter（比 type 打字稳：不受模糊 150ms 延迟影响）
  E "(()=>{const i=document.querySelector('.gv__new-name'); if(!i) return 'NOINPUT'; i.value='$v'; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 'ok';})()"
  sleep 0.25
done

ORDER0=$(E "[...document.querySelectorAll('#gvItems .gv-item__name')].map(e=>e.textContent).join(',')")
echo "[初始顺序] $ORDER0"

# 4. 计算拖拽坐标：a（第 2 项，第 1 项是 device_id）→ 越过 c 右缘
R=$(E "(()=>{
  const names=[...document.querySelectorAll('#gvItems .gv-item__name')];
  // 拖拽手柄是名字本身（item 中心会落在类型下拉上，不算手柄）
  const a=names.find(e=>e.textContent==='a').getBoundingClientRect();
  const c=names.find(e=>e.textContent==='c').closest('.gv-item').getBoundingClientRect();
  return Math.round(a.left+a.width/2)+','+Math.round(a.top+a.height/2)+','+Math.round(c.right+40)+','+Math.round(a.top+a.height/2);
})()")
R="${R//\"/}"                       # 去掉 eval 返回值的双引号
IFS=',' read -r SX SY EX EY <<< "$R"
echo "[拖拽] a(起点 $SX,$SY) → 末尾($EX,$EY)"

# 5. 真实鼠标拖拽：按住 a 的名字，拖到 c 之后
$B mouse --session "$SESS" move "$SX" "$SY"
sleep 0.2
$B mouse --session "$SESS" down left
sleep 0.2
# 分步移动，确保超过 4px 阈值并触发指示线
$B mouse --session "$SESS" move "$SX" "$SY"
sleep 0.1
$B mouse --session "$SESS" move "$EX" "$EY"
sleep 0.3

# 6. 拖拽中：截图 + 断言竖线指示器可见
$B screenshot --session "$SESS" ".global-vars-bar" "tmp-shots/gv-reorder-middrag.png" >/dev/null 2>&1 || true
DL=$(E "(()=>{const l=document.querySelector('.gv-drop-line'); return l? (l.style.display)+'@'+l.style.left : 'NOLINE';})()")
echo "[拖拽中] 指示线: $DL (期望 block@数值)"
echo "[拖拽中] 被拖项弱化: $(E "Boolean(document.querySelector('.gv-item--dragging'))")"
echo "[拖拽中] body 拖拽态: $(E "document.body.classList.contains('gv-dragging')")"

# 7. 松手 → 校验顺序
$B mouse --session "$SESS" up left
sleep 0.3
ORDER1=$(E "[...document.querySelectorAll('#gvItems .gv-item__name')].map(e=>e.textContent).join(',')")
echo "[松手后] $ORDER1 (期望 device_id,b,c,a——device_id 固定项不动，a 移到末尾)"
echo "[拖拽态清理] body dragging=$(E "document.body.classList.contains('gv-dragging')") 指示线=$(E "(()=>{const l=document.querySelector('.gv-drop-line'); return l&&l.isConnected?l.style.display:'gone';})()")"
