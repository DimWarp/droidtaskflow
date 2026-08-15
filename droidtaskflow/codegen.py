def generate_python(project: dict) -> str:
    """生成项目对应的 Python DSL 代码"""
    lines = []
    lines.append('"""')
    lines.append('@droidtaskflow:project')
    lines.append('@droidtaskflow:version 1.0')
    lines.append('"""')
    lines.append('')
    lines.append('from droidtaskflow.dsl import (')
    lines.append('    project, start_node, node, node_info_task, node_logic_task,')
    lines.append('    node_op_group, node_op_group_task, node_exit, edge, global_var,')
    lines.append(')')
    lines.append('')

    # 项目元数据
    meta = project['metadata']
    lines.append(f'project("{meta["name"]}", version="{meta["version"]}")')
    lines.append(f'start_node("{project["start_node_id"]}")')
    lines.append('')

    # 全局变量
    for gv in project['global_vars'].values():
        default_repr = repr(gv['default'])
        desc_repr = repr(gv.get('description', ''))
        lines.append(
            f'global_var("{gv["name"]}", "{gv["type"]}", {default_repr}, '
            f'description={desc_repr})'
        )
    lines.append('')

    # 节点
    for node in project['nodes'].values():
        lines.extend(_generate_node(node))
        lines.append('')

    # edges（多入口时带 to_port）
    for edge in project['edges']:
        to_port = edge.get('to_port', 'in')
        if to_port and to_port != 'in':
            lines.append(f'edge("{edge["from_node"]}", "{edge["from_exit"]}", "{edge["to_node"]}", "{to_port}")')
        else:
            lines.append(f'edge("{edge["from_node"]}", "{edge["from_exit"]}", "{edge["to_node"]}")')

    return '\n'.join(lines) + '\n'


def _generate_node(node: dict) -> list:
    lines = []
    pos_repr = repr(node['position'])
    # goto 判别字段 + 入口端口持久化：与前端 toPythonDSL 一致
    parts = [f'@node("{node["id"]}", name="{node["name"]}"']
    if node.get('type') == 'goto':
        parts.append('type="goto"')
    parts.append(f'position={pos_repr}')
    in_ports = node.get('in_ports')
    if in_ports and in_ports != ['in']:
        parts.append(f'in_ports={in_ports!r}')
    lines.append(', '.join(parts) + ')')

    for exit_ in node['exits'].values():
        lines.append(f'@node_exit("{exit_["name"]}", "{exit_["label"]}")')

    for task in node['info_tasks']:
        lines.append('@node_info_task(' + _format_task(task) + ')')

    for task in node['logic_tasks']:
        lines.append('@node_logic_task(' + _format_task(task, column=task.get('column', 0)) + ')')

    for group in node['operation_groups']:
        lines.append(
            f'@node_op_group("{group["id"]}", name="{group["name"]}", '
            f'forced={group["forced"]})'
        )
        for op in group['operations']:
            lines.append('@node_op_group_task(' + _format_task(op) + ')')

    lines.append(f'def {node["id"]}():')
    lines.append('    pass')
    return lines


def _format_task(task: dict, column: int = 0) -> str:
    parts = [f'"{task["task_name"]}"']
    # 卡片持久化 id：存在时写进 DSL，重载直接读回（与前端 toPythonDSL 保持一致）
    if task.get('id'):
        parts.append(f'id="{task["id"]}"')
    # LOGIC 多列：列下标 > 0 时输出 column=N（与前端 toPythonDSL 保持一致）
    if column:
        parts.append(f'column={column}')
    for k, v in task['param_values'].items():
        parts.append(f'{k}={v!r}')
    if task.get('wire_inputs'):
        parts.append(f'wires={task["wire_inputs"]!r}')
    return ', '.join(parts)