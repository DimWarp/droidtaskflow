import importlib.util
from droidtaskflow.dsl import _get_project


def parse_project_file(filepath: str) -> dict:
    """解析项目 Python 文件为 dict 数据结构"""
    spec = importlib.util.spec_from_file_location("project_module", filepath)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    ctx = _get_project()

    # 清理临时数据
    return {
        'metadata': dict(ctx['metadata']),
        'global_vars': {k: dict(v) for k, v in ctx['global_vars'].items()},
        'start_node_id': ctx['start_node_id'],
        'nodes': {nid: _deep_copy_node(node_data) for nid, node_data in ctx['nodes'].items()},
        'edges': [dict(e) for e in ctx['edges']],
    }


def _deep_copy_node(node_data: dict) -> dict:
    """深拷贝节点数据，避免外部修改影响 context"""
    return {
        'id': node_data['id'],
        'name': node_data['name'],
        'position': dict(node_data['position']),
        'info_tasks': [dict(t) for t in node_data['info_tasks']],
        'logic_tasks': [dict(t) for t in node_data['logic_tasks']],
        'operation_groups': [_deep_copy_group(g) for g in node_data['operation_groups']],
        'exits': {k: dict(v) for k, v in node_data['exits'].items()},
        'target': node_data.get('target', ''),
        'in_ports': list(node_data.get('in_ports', []) or []),
    }


def _deep_copy_group(group: dict) -> dict:
    return {
        'id': group['id'],
        'name': group['name'],
        'forced': group['forced'],
        'exit': group.get('exit'),
        'trigger': group.get('trigger'),
        'external_inputs': list(group['external_inputs']),
        'operations': [dict(op) for op in group['operations']],
    }