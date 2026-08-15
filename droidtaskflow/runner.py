"""将工程 .py 文件解析并执行。

被 main.py 的 if __name__ == '__main__' 块调用。
也可被 CLI 直接调用。
"""
import sys
from droidtaskflow.parser import parse_project_file
from droidtaskflow.executor import execute_project, Runtime
from droidtaskflow.models import (
    Project, Node, TaskInstance, OperationGroup,
    ExitDefinition, Edge, GlobalVarDef,
)


def build_project_model(project_dict: dict) -> Project:
    """将 parser 产出的 dict 转为 Project dataclass 模型。"""
    # 全局变量
    global_vars = {}
    for name, gv in project_dict.get('global_vars', {}).items():
        global_vars[name] = GlobalVarDef(
            name=gv['name'],
            type=gv.get('type', 'string'),
            default=gv.get('default', ''),
            description=gv.get('description', ''),
        )

    # 节点
    nodes = []
    for node_id, nd in project_dict.get('nodes', {}).items():
        # 信息任务
        info_tasks = []
        for t in nd.get('info_tasks', []):
            info_tasks.append(TaskInstance(
                id=t['id'],
                node_id=node_id,
                task_name=t['task_name'],
                param_values=t.get('param_values', {}),
                wire_inputs=t.get('wire_inputs', {}),
                alias=t.get('alias'),
            ))

        # 逻辑任务
        logic_tasks = []
        for t in nd.get('logic_tasks', []):
            logic_tasks.append(TaskInstance(
                id=t['id'],
                node_id=node_id,
                task_name=t['task_name'],
                param_values=t.get('param_values', {}),
                wire_inputs=t.get('wire_inputs', {}),
                alias=t.get('alias'),
                column=t.get('column', 0),
            ))

        # 操作组
        operation_groups = []
        for g in nd.get('operation_groups', []):
            ops = []
            for o in g.get('operations', []):
                ops.append(TaskInstance(
                    id=o['id'],
                    node_id=node_id,
                    task_name=o['task_name'],
                    param_values=o.get('param_values', {}),
                    wire_inputs=o.get('wire_inputs', {}),
                    alias=o.get('alias'),
                ))
            # trigger 是外部触发线 ID，需要合并到 external_inputs
            ext_inputs = list(g.get('external_inputs', []))
            trigger = g.get('trigger')
            if trigger and trigger not in ext_inputs:
                ext_inputs.append(trigger)
            operation_groups.append(OperationGroup(
                id=g['id'],
                name=g.get('name', ''),
                forced=g.get('forced', False),
                exit=g.get('exit'),
                trigger=trigger,
                external_inputs=ext_inputs,
                operations=ops,
            ))

        # 出口
        exits = {}
        for exit_name, ex in nd.get('exits', {}).items():
            exits[exit_name] = ExitDefinition(
                name=ex['name'],
                label=ex.get('label', ''),
            )

        nodes.append(Node(
            id=node_id,
            name=nd.get('name', node_id),
            position=nd.get('position', {'x': 0, 'y': 0}),
            info_tasks=info_tasks,
            logic_tasks=logic_tasks,
            operation_groups=operation_groups,
            exits=exits,
        ))

    # 边
    edges = []
    for e in project_dict.get('edges', []):
        edges.append(Edge(
            from_node=e['from_node'],
            from_exit=e['from_exit'],
            to_node=e['to_node'],
        ))

    return Project(
        id=project_dict.get('metadata', {}).get('name', 'untitled'),
        name=project_dict.get('metadata', {}).get('name', 'untitled'),
        version=project_dict.get('metadata', {}).get('version', '1.0'),
        global_vars=global_vars,
        nodes=nodes,
        edges=edges,
        start_node_id=project_dict.get('start_node_id', ''),
        created_at='',
        updated_at='',
    )


def _parse_cli_global_vars():
    """从 sys.argv 中解析 --key=value 格式的全局变量覆盖。"""
    overrides = {}
    for arg in sys.argv[1:]:
        if arg.startswith('--') and '=' in arg:
            key, _, value = arg[2:].partition('=')
            overrides[key] = value
    return overrides


def run_project_file(filepath):
    """解析并执行一个工程 .py 文件。

    Args:
        filepath: 工程 .py 文件路径
    """
    project_dict = parse_project_file(str(filepath))
    project = build_project_model(project_dict)
    runtime = Runtime(global_vars={})

    # 注入全局变量默认值
    for name, gv in project.global_vars.items():
        if name not in runtime.global_vars:
            runtime.global_vars[name] = gv.default

    # CLI 参数覆盖（如 --device_id=xxx）
    cli_overrides = _parse_cli_global_vars()
    runtime.global_vars.update(cli_overrides)

    execute_project(project, runtime)
