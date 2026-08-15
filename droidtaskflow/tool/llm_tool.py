"""
@droidtaskflow:tool
@droidtaskflow:tool_type llm
"""
# droidtaskflow.tool.llm_tool — LLM / 大模型调用工具
# 函数签名已定义，具体实现需根据后端服务补齐。
# 在 Pyodide 沙箱中这些函数为桩代码，实际运行时由后端注入真实实现。

from __future__ import annotations

import json
from typing import Any


# ── 基础调用 ──

def ask(
    prompt: str,
    model: str = "gpt-4",
    system: str = "",
    temperature: float = 0.7,
    max_tokens: int = 2048,
) -> str:
    """向 LLM 发送提问并返回纯文本回答。
    Args:
        prompt: 用户提示词
        model: 模型名称
        system: 系统提示词（可选）
        temperature: 生成温度 (0.0–2.0)
        max_tokens: 最大输出 token 数
    Returns:
        str: LLM 回答文本
    """
    pass


# ── 分类 ──

def classify(
    text: str,
    labels: list[str],
    model: str = "gpt-4",
) -> dict:
    """将文本分类到给定标签。
    Args:
        text: 待分类文本
        labels: 候选标签列表，如 ["正面", "负面", "中性"]
        model: 模型名称
    Returns:
        dict: {label: 最佳标签, confidence: 置信度(0–1), scores: {标签: 分数}}
    """
    pass


# ── 结构化提取 ──

def extract_info(
    text: str,
    schema: dict,
    model: str = "gpt-4",
) -> dict:
    """从文本中提取结构化信息。
    Args:
        text: 源文本
        schema: JSON Schema 描述提取结构，如 {"name": "string", "age": "int"}
        model: 模型名称
    Returns:
        dict: 按 schema 填充的结构化数据
    """
    pass


# ── 摘要 ──

def summarize(
    text: str,
    max_words: int = 100,
    model: str = "gpt-4",
) -> str:
    """对长文本进行摘要。
    Args:
        text: 待摘要文本
        max_words: 摘要最大字数
        model: 模型名称
    Returns:
        str: 摘要文本
    """
    pass


# ── 翻译 ──

def translate(
    text: str,
    target_lang: str = "en",
    source_lang: str = "auto",
    model: str = "gpt-4",
) -> str:
    """翻译文本到目标语言。
    Args:
        text: 待翻译文本
        target_lang: 目标语言代码（如 "zh", "en", "ja"）
        source_lang: 源语言代码，"auto" 为自动检测
        model: 模型名称
    Returns:
        str: 翻译结果
    """
    pass


# ── 视觉理解 ──

def vision(
    image: bytes,
    prompt: str,
    model: str = "gpt-4-vision",
) -> str:
    """对图像内容进行理解/描述。
    Args:
        image: 图像数据（PNG/JPEG bytes）
        prompt: 对图像提出的问题或描述要求
        model: 视觉模型名称
    Returns:
        str: 模型对图像的回答
    """
    pass


# ── 代码生成 ──

def generate_code(
    spec: str,
    language: str = "python",
    model: str = "gpt-4",
) -> str:
    """根据自然语言描述生成代码。
    Args:
        spec: 功能描述
        language: 目标编程语言
        model: 模型名称
    Returns:
        str: 生成的代码
    """
    pass


# ── 工具调用（Function Calling） ──

def function_call(
    prompt: str,
    functions: list[dict],
    model: str = "gpt-4",
) -> dict:
    """让 LLM 选择并调用一个函数。
    Args:
        prompt: 用户意图描述
        functions: 可用函数列表，每个为 {name, description, parameters(JSON Schema)}
        model: 模型名称
    Returns:
        dict: {function: 函数名, arguments: 参数 dict}
    """
    pass
