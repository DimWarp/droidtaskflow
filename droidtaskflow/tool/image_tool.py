"""
@droidtaskflow:tool
@droidtaskflow:tool_type match
"""
# droidtaskflow.tool.match — 图像模板匹配工具
# 基于 OpenCV matchTemplate 实现，在屏幕截图中查找模板图像。

from __future__ import annotations

import base64
import re
from typing import Any


def _decode_image(image: str) -> bytes:
    """将 base64 data URL 或纯 base64 字符串解码为 bytes。"""
    if ',' in image:
        image = image.split(',', 1)[1]
    return base64.b64decode(image)


def match(base_img: bytes, image: str, threshold: float = 0.8) -> list[dict[str, Any]]:
    """在屏幕截图中查找模板图像，返回所有匹配位置。

    Args:
        base_img: 屏幕截图（PNG/JPEG bytes），由上游截图任务传入
        image: 模板图片，base64 data URL 或纯 base64 编码的 PNG/JPEG
        threshold: 匹配阈值 (0–1)，越高越严格
    Returns:
        list[dict]: 匹配结果列表，每项包含:
            - box: 匹配区域坐标 [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
            - score: 匹配置信度 (0–1)
            - center: 中心坐标 {"x": int, "y": int}
    """
    import cv2
    import numpy as np

    def _log(msg: str):
        # 直接打到 stdout，后端会通过 log 事件回流到前端控制台面板
        print(f"[image_match] {msg}")

    # 最大输出框数 + 每尺度 top-K：在收集阶段就压住候选规模，
    # 否则阈值低时（如 0.2）全图命中点有几万个，Python 循环 + NMS O(n²) 会卡死。
    MAX_BOXES = 10            # 最终最多返回的框数
    TOP_K_PER_SCALE = 20      # 每个尺度最多保留的高分候选（5 尺度 × 20 = ≤100 个进 Python 循环）

    template_bytes = _decode_image(image)
    template_arr = np.frombuffer(template_bytes, dtype=np.uint8)
    template = cv2.imdecode(template_arr, cv2.IMREAD_COLOR)
    if template is None:
        _log(f"模板图片解码失败: base64 长度={len(template_bytes)}, 前8字节={template_bytes[:8].hex() if template_bytes else 'empty'}")
        return []
    _log(f"模板解码OK: shape={template.shape}, base64 长度={len(template_bytes)}")

    base_is_bytes = isinstance(base_img, bytes)
    _log(f"base_img 类型={type(base_img).__name__}, 长度={len(base_img) if hasattr(base_img, '__len__') else 'N/A'}")
    if not base_is_bytes and isinstance(base_img, str):
        # 是 base64 data URL 还是纯 base64？前 22 字节内容用于区分
        _log(f"base_img 是 str: 前40字符={base_img[:40]!r}")

    screen_arr = np.frombuffer(base_img if base_is_bytes else base_img.encode('latin-1'), dtype=np.uint8)
    screen_img = cv2.imdecode(screen_arr, cv2.IMREAD_COLOR)
    if screen_img is None:
        _log(f"截图解码失败: 是bytes={base_is_bytes}, 字节长度={len(screen_arr)}")
        return []
    _log(f"截图解码OK: shape={screen_img.shape}")

    th, tw = template.shape[:2]
    sh_, sw_ = screen_img.shape[:2]
    _log(f"模板尺寸={tw}x{th}, 截图尺寸={sw_}x{sh_}, threshold={threshold}")

    # 多尺度匹配：在几个缩放比例下尝试
    results = []
    for scale in [1.0, 0.75, 0.5, 1.25, 1.5]:
        sw = int(tw * scale)
        sh = int(th * scale)
        if sw < 10 or sh < 10 or sw > screen_img.shape[1] or sh > screen_img.shape[0]:
            _log(f"  scale={scale}: 跳过 (缩放后 {sw}x{sh} 超出范围或太小)")
            continue
        resized = cv2.resize(template, (sw, sh), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
        res = cv2.matchTemplate(screen_img, resized, cv2.TM_CCOEFF_NORMED)
        # 阈值过滤 → 取该尺度 top-K 高分点。np.argpartition 是 O(n) 选择，
        # 只把 top-K 拉进 Python 循环，避免低阈值时几万个点逐个建 dict。
        mask = res >= threshold
        total_hits = int(mask.sum())
        max_score = float(res.max()) if res.size else 0.0
        ys = xs = scores = np.array([], dtype=np.int64)
        if total_hits > 0:
            ys, xs = np.nonzero(mask)
            scores = res[ys, xs]
            if len(scores) > TOP_K_PER_SCALE:
                top = np.argpartition(scores, -TOP_K_PER_SCALE)[-TOP_K_PER_SCALE:]
                ys, xs, scores = ys[top], xs[top], scores[top]
        kept = len(scores)
        _log(f"  scale={scale}: 缩放后模板 {sw}x{sh}, 命中像素={total_hits}, 保留top={kept}, 最高分数={max_score:.4f}")
        for y, x, score in zip(ys, xs, scores):
            score = float(score)
            results.append({
                "box": [[x, y], [x + sw, y], [x + sw, y + sh], [x, y + sh]],
                "score": round(score, 4),
                "center": {"x": x + sw // 2, "y": y + sh // 2},
            })

    _log(f"多尺度共收集候选 {len(results)} 个，开始 NMS 去重...")

    # NMS: 按 score 降序，去除重叠框。凑满 MAX_BOXES 即提前结束——
    # 候选已按分数降序，越往后分数越低，不会出现"后面更高的"。
    results.sort(key=lambda r: r["score"], reverse=True)
    filtered = []
    for r in results:
        cx, cy = r["center"]["x"], r["center"]["y"]
        too_close = False
        for f in filtered:
            if abs(cx - f["center"]["x"]) < tw * 0.3 and abs(cy - f["center"]["y"]) < th * 0.3:
                too_close = True
                break
        if not too_close:
            filtered.append(r)
            if len(filtered) >= MAX_BOXES:
                break

    _log(f"NMS 后最终返回 {len(filtered)} 个结果: " + (
        str([{"box": r["box"], "score": r["score"]} for r in filtered])
        if filtered else "（无匹配）"))
    return filtered
