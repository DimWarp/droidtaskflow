from dataclasses import dataclass, field
from typing import Any


@dataclass
class GlobalVarDef:
    name: str
    type: str          # "string" | "number" | "boolean" | "object"
    default: Any
    description: str = ""


@dataclass
class TaskInstance:
    """节点内的具体任务实例"""
    id: str
    node_id: str
    task_name: str
    task_def: Any | None = None   # 引用任务定义（来自 spec-01 解析）
    param_values: dict[str, Any] = field(default_factory=dict)
    wire_inputs: dict[str, str] = field(default_factory=dict)
    position: int = 0
    alias: str | None = None   # 实例别名；None 时由 executor 从 task_def._task_meta['alias'] 兜底
    column: int = 0            # LOGIC 多列：所属子列下标（列主序执行依据）


@dataclass
class OperationGroup:
    id: str
    name: str = ""
    forced: bool = False
    exit: str | None = None
    trigger: str | None = None
    external_inputs: list[str] = field(default_factory=list)
    operations: list[TaskInstance] = field(default_factory=list)
    fired_exit: str | None = None


@dataclass
class ExitDefinition:
    name: str
    label: str = ""


@dataclass
class Node:
    id: str
    name: str = ""
    info_tasks: list[TaskInstance] = field(default_factory=list)
    logic_tasks: list[TaskInstance] = field(default_factory=list)
    operation_groups: list[OperationGroup] = field(default_factory=list)
    exits: dict[str, ExitDefinition] = field(default_factory=dict)
    breakpoint: bool = False
    position: dict[str, float] = field(default_factory=lambda: {"x": 0, "y": 0})


@dataclass
class Edge:
    from_node: str
    from_exit: str
    to_node: str


@dataclass
class Project:
    id: str
    name: str
    version: str
    global_vars: dict[str, GlobalVarDef]
    nodes: list[Node]
    edges: list[Edge]
    start_node_id: str
    created_at: str
    updated_at: str