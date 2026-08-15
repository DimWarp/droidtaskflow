"""
@droidtaskflow:tool
@droidtaskflow:tool_type ocr
"""
# droidtaskflow.tool.ocr_tool — OCR 文字识别工具
# 基于 RapidOCR (onnxruntime) 实现，延迟初始化引擎实例。

from __future__ import annotations

import io
from typing import Any

# 延迟初始化：首次调用时才加载模型
_engine = None


def _get_engine():
    global _engine
    if _engine is None:
        from rapidocr import RapidOCR
        _engine = RapidOCR()
    return _engine


def ocr(image: bytes, text_score: float = 0.5) -> list[dict[str, Any]]:
    """对图像执行 OCR 文字识别。
    Args:
        image: 图像数据（PNG/JPEG bytes）
        text_score: 文本置信度阈值 (0–1)，低于此值的结果被过滤
    Returns:
        list[dict]: 识别结果列表，每项包含:
            - text: 识别文本
            - score: 置信度 (0–1)
            - box: 文本框坐标 [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
    """
    engine = _get_engine()
    result = engine(image, text_score=text_score)
    if result is None or result.boxes is None:
        return []
    items = []
    for box, text, score in zip(result.boxes, result.txts, result.scores):
        items.append({
            "text": text,
            "score": float(score),
            "box": box.tolist() if hasattr(box, 'tolist') else box,
        })
    return items


def ocr_text(image: bytes, text_score: float = 0.5) -> str:
    """对图像执行 OCR，返回纯文本结果（换行分隔）。
    Args:
        image: 图像数据（PNG/JPEG bytes）
        text_score: 文本置信度阈值 (0–1)
    Returns:
        str: 识别到的所有文本，用换行连接
    """
    results = ocr(image, text_score=text_score)
    return "\n".join(item["text"] for item in results)
