from dataclasses import dataclass, field
from typing import Any


@dataclass
class Runtime:
    """执行时运行时上下文"""
    global_vars: dict[str, Any]
    log: list[dict[str, Any]] = field(default_factory=list)


def resolve_serial(global_vars: dict | None) -> str | None:
    """从 global_vars 提取 device_id。task 层调用此 helper 决定 adb 命令发到哪台设备。

    用途：M1 device management。task 函数声明 `global_vars=None` 参数（executor
    自动注入），调此 helper 拿 device_id，再显式传给 adb_tool。

    行为：
    - global_vars 为 None → None（Pyodide 预览 / 测试 / 未传 CLI args）
    - global_vars 为空 dict → None（CLI 没传 device_id）
    - global_vars 有 device_id → 返回该值（None / 字符串都行）

    为什么不放 adb_tool：adb_tool 是低层 adb 包装，不感知 runtime/global_vars；
    "device_id 从哪里来"是应用层决策，归 executor/task 层。
    """
    if global_vars is None:
        return None
    return global_vars.get("device_id")


def _find_task_func(task_name: str):
    """根据 task_name 查找任务函数。

    查找顺序：
    1. 合并包中 task_define 全局命名空间（由前端 compat 段构建）
    2. 当前模块 globals 中带 _task_meta 的函数
    3. None（未找到）
    """
    import sys
    # 合并包中 task_define 是 compat 段创建的命名空间对象
    td = sys.modules.get('droidtaskflow.task_define')
    if td is None:
        # 合并包中 task_define 是全局变量但未注册到 sys.modules
        td = globals().get('task_define')
    if td is not None:
        func = getattr(td, task_name, None)
        if func is not None:
            return func
    # 回退：在 globals 中找带 _task_meta 的函数
    for obj in globals().values():
        if callable(obj) and getattr(obj, '_task_meta', {}).get('alias') == task_name:
            return obj
    return None


def is_group_triggered(group, runtime: Runtime) -> bool:
    """操作组触发判定：在执行组内任何操作之前一次性判断

    触发条件（满足任一）：
    1. 强制启用 toggle ON
    2. 任一外部触发入口的数据 enable=True
    """
    if group.forced:
        return True
    for wire_id in group.external_inputs:
        wire_data = runtime.global_vars.get(wire_id)
        # 后缀匹配兜底：UI wire ID (t123.same) vs 发布 key (node_xxx.task.same)
        if not wire_data and '.' in wire_id:
            suffix = '.' + wire_id.rsplit('.', 1)[1]
            for k, v in runtime.global_vars.items():
                if k.endswith(suffix):
                    wire_data = v
                    break
        if wire_data and wire_data.get("enable", False):
            return True
    return False


def collect_task_inputs(task, runtime: Runtime) -> dict:
    """收集任务的输入参数

    取值优先级：
    1. 入口连线参数（来自上游任务输出，且 enable=True）
    2. 内部配置参数（task.param_values）

    系统注入：
    - global_vars（如果函数签名需要）
    """
    inputs = {}
    for param_name in task.param_values.keys():
        # 1. 尝试从连线获取
        wire_id = task.wire_inputs.get(param_name)
        if wire_id:
            wire_data = runtime.global_vars.get(wire_id)
            # Fallback: wire_id uses UI task ID (e.g. "t123.devices"), but results
            # are published under "node_<nodeId>.<taskName>.<returnName>".
            # Resolve by matching the return-name suffix across all published results.
            if not wire_data and '.' in wire_id:
                suffix = '.' + wire_id.rsplit('.', 1)[1]
                for k, v in runtime.global_vars.items():
                    if k.endswith(suffix):
                        wire_data = v
                        break
            if wire_data and wire_data.get("enable", False):
                inputs[param_name] = wire_data["value"]
                continue

        # 2. 退化到内部配置
        inputs[param_name] = task.param_values[param_name]

    # 系统注入参数
    inputs["global_vars"] = runtime.global_vars

    return inputs


def publish_task_result(task, result: list, runtime: Runtime) -> None:
    """任务结果写入 global_vars

    key 格式：{task_id}.{return_name} —— 与连线/触发引用（如 t123.pass）一致，可直接命中。
    用 task id 而非 task_name：同一节点内两个同名任务（如两个 math_compare）结果键互不覆盖，
    否则后执行的任务会覆盖先执行任务发布的结果，导致依赖它的触发组读到错误 enable。
    （无 id 的历史文件回退到 node_{node_id}.{task_name}.{return_name} 旧格式。）
    """
    if result is None:
        return
    # str is iterable but we need to treat it as a single return value
    if isinstance(result, str):
        result = [result]
    try:
        iter(result)
    except TypeError:
        return

    # 任务实例必须有 task_def 才能获取 return 名字
    if task.task_def is None:
        # 通过 task_name 动态查找（合并包中 task_define 是全局命名空间）
        task_def = _find_task_func(task.task_name)
        if task_def is None:
            return
        returns_meta = task_def._task_meta['returns']
    else:
        returns_meta = task.task_def._task_meta['returns']

    for return_meta, return_value in zip(returns_meta, result):
        # Normalise: built-in tasks return Result objects (with .enable/.value),
        # custom tasks may return plain values (dicts, strings, etc.).
        if hasattr(return_value, 'enable'):
            enable = return_value.enable
            value = return_value.value
        elif isinstance(return_value, dict):
            enable = return_value.get('enable', True)
            value = return_value.get('value', return_value)
        else:
            enable = True
            value = return_value
        if task.id:
            key = f"{task.id}.{return_meta['name']}"
        else:
            key = f"node_{task.node_id}.{task.task_name}.{return_meta['name']}"
        runtime.global_vars[key] = {"enable": enable, "value": value}


def _execute_task_callable(task, inputs: dict, runtime: Runtime) -> list:
    """执行任务函数（解析 task_name → 函数）"""
    import inspect
    from droidtaskflow.trigger_node_exit import trigger_node_exit

    # 任务查找：先 builtin，再 trigger_node_exit
    func = _find_task_func(task.task_name)
    if func is None and task.task_name == 'trigger_node_exit':
        func = trigger_node_exit

    if func is None:
        raise ValueError(f"Task not found: {task.task_name}")

    # 一次性固化：UI 没写 alias 的旧工程，首次执行时从 preset 拷贝
    if not task.alias and task.task_def is not None:
        task.alias = task.task_def._task_meta.get('alias') or task.task_name

    # Filter inputs to only what the function accepts (custom tasks may not take global_vars etc.)
    try:
        sig = inspect.signature(func)
        filtered = {k: v for k, v in inputs.items() if k in sig.parameters}
        if 'task_alias' in sig.parameters:
            filtered['task_alias'] = task.alias
    except (ValueError, TypeError):
        filtered = inputs

    return func(**filtered)


def execute_node(node, runtime: Runtime) -> str | None:
    """节点执行主算法。返回触发的 exit_name，或 None（流程结束）

    阶段：
    1. info（场景信息提取）
    2. logic（逻辑分析）
    3. operate（操作组）
    """
    # 阶段 1: 场景信息提取
    for task in node.info_tasks:
        inputs = collect_task_inputs(task, runtime)
        result = _execute_task_callable(task, inputs, runtime)
        publish_task_result(task, result, runtime)

    # 阶段 2: 逻辑分析
    # LOGIC 多列：按列主序执行——先列 0 全部（列内从上到下），再列 1 全部…
    # 稳定排序（(column, 原下标)），保证手写/乱序文件也按"列顺序"执行。
    for _, task in sorted(enumerate(node.logic_tasks), key=lambda p: (p[1].column, p[0])):
        inputs = collect_task_inputs(task, runtime)
        result = _execute_task_callable(task, inputs, runtime)
        publish_task_result(task, result, runtime)

    # 阶段 3: 操作（顺序执行所有操作组）
    next_exit = None
    for group in node.operation_groups:
        triggered = is_group_triggered(group, runtime)
        if not triggered:
            continue

        for op in group.operations:
            op_inputs = collect_task_inputs(op, runtime)
            if op.task_name == 'trigger_node_exit':
                # trigger_node_exit 不真正执行（它是元任务），直接从 param_values 取 exit_name
                group.fired_exit = op.param_values.get('exit_name')
            else:
                _execute_task_callable(op, op_inputs, runtime)

        # group.exit 由 @node_op_group(exit="out") 设置，作为 trigger_node_exit 的替代
        if group.fired_exit is None and group.exit:
            group.fired_exit = group.exit

        if next_exit is None and group.fired_exit is not None:
            next_exit = group.fired_exit

    return next_exit


def _find_next_node(project, from_node_id: str, exit_name) -> str | None:
    """根据出口找下一节点"""
    if exit_name is None:
        return None
    for edge in project.edges:
        if edge.from_node == from_node_id and edge.from_exit == exit_name:
            return edge.to_node
    return None


def execute_project(project, runtime: Runtime) -> None:
    """项目执行入口

    从 start_node 开始，按 edges 控制流跳转，直到没有下一节点或发生异常。

    M1 全局变量初始化规则（命令传参优先）：
    1. CLI args 已由 runner 注入到 runtime.global_vars（脚本没传为 None）
    2. project init value 仅作默认值：该变量未被 CLI 传入时才用（空串 / None 都跳过）
    3. 结果：CLI args（若传入）> project init value（非空）> 空
    """
    for gv_name, gv_def in project.global_vars.items():
        if gv_name not in runtime.global_vars and gv_def.default is not None and gv_def.default != "":
            runtime.global_vars[gv_name] = gv_def.default

    # 将 device_id 注入 adb_tool 模块，所有公共 API 自动使用
    # 用 sys.modules 获取（合并包中内部 import 被剥离，直接 import 会 NameError）
    import sys
    _adb_mod = sys.modules.get('droidtaskflow.tool.adb_tool')
    if _adb_mod is not None:
        _adb_mod.set_serial(resolve_serial(runtime.global_vars))

    current_node_id = project.start_node_id
    while current_node_id is not None:
        node = next(n for n in project.nodes if n.id == current_node_id)
        next_exit_name = execute_node(node, runtime)
        current_node_id = _find_next_node(project, current_node_id, next_exit_name)