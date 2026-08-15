import threading

_tls = threading.local()


def _get_project():
    """获取当前线程的项目构建上下文"""
    if not hasattr(_tls, 'project'):
        _tls.project = {
            'metadata': {},
            'global_vars': {},
            'start_node_id': None,
            'nodes': {},
            'edges': [],
            '_current_node_id': None,
            '_current_op_group_id': None,
        }
    return _tls.project


def _reset_project():
    """重置当前线程的项目上下文（主要用于测试隔离）"""
    if hasattr(_tls, 'project'):
        del _tls.project


def project(name: str, version: str = "1.0"):
    ctx = _get_project()
    ctx['metadata'] = {'name': name, 'version': version}


def start_node(node_id: str):
    ctx = _get_project()
    ctx['start_node_id'] = node_id


def global_var(name: str, type: str, default, description: str = ""):
    ctx = _get_project()
    ctx['global_vars'][name] = {
        'name': name,
        'type': type,
        'default': default,
        'description': description,
    }


def node(id: str, name: str = "", position: dict = None, width: int = None, col_fractions: list = None, type: str = None, target: str = "", in_ports: list = None):
    """节点装饰器

    type: 节点类型判别（"goto" = goto 节点）。普通节点省略。
    target: goto 节点的目标节点 id（普通节点为空，未设目标时也为空）。
    in_ports: goto 节点的入口端口名列表（普通节点为空）。
    三者仅供前端回读 goto 结构，执行器不消费。
    """
    ctx = _get_project()
    n = {
        'id': id,
        'name': name or id,
        'position': position or {'x': 0, 'y': 0},
        'info_tasks': [],
        'logic_tasks': [],
        'operation_groups': [],
        'exits': {},
    }
    if width is not None:
        n['width'] = width
    if col_fractions is not None:
        n['col_fractions'] = col_fractions
    if type:
        n['type'] = type
    if target:
        n['target'] = target
    if in_ports:
        n['in_ports'] = in_ports
    ctx['nodes'][id] = n
    ctx['_current_node_id'] = id

    def decorator(func):
        return func
    return decorator


def node_info_task(task_name: str, alias: str = None, id: str = None, **params):
    """添加 info 任务

    id: 卡片持久化 id（前端会话内生成的 't...'），缺省时按位置生成。
    """
    ctx = _get_project()
    node_id = ctx['_current_node_id']
    wires = params.pop('wires', {})
    ctx['nodes'][node_id]['info_tasks'].append({
        'id': id or f"{node_id}_info_{len(ctx['nodes'][node_id]['info_tasks'])}",
        'task_name': task_name,
        'alias': alias,
        'param_values': params,
        'wire_inputs': wires,
    })
    return lambda func: func


def node_logic_task(task_name: str, alias: str = None, column: int = 0, id: str = None, **params):
    """添加 logic 任务

    column: LOGIC 多列模式下的子列下标（列主序执行依据；缺省 0 = 第一列）。
    id: 卡片持久化 id，缺省时按位置生成。
    """
    ctx = _get_project()
    node_id = ctx['_current_node_id']
    wires = params.pop('wires', {})
    ctx['nodes'][node_id]['logic_tasks'].append({
        'id': id or f"{node_id}_logic_{len(ctx['nodes'][node_id]['logic_tasks'])}",
        'task_name': task_name,
        'alias': alias,
        'column': column,
        'param_values': params,
        'wire_inputs': wires,
    })
    return lambda func: func


def node_op_group(id: str, name: str = "", forced: bool = False, exit: str = None, trigger: str = None):
    """开始一个操作组"""
    ctx = _get_project()
    node_id = ctx['_current_node_id']
    ctx['nodes'][node_id]['operation_groups'].append({
        'id': id,
        'name': name or id,
        'forced': forced,
        'exit': exit,
        'trigger': trigger,
        'external_inputs': [],
        'operations': [],
    })
    ctx['_current_op_group_id'] = id
    return lambda func: func


def node_op_group_task(task_name: str, alias: str = None, id: str = None, **params):
    """添加操作任务到当前操作组

    id: 卡片持久化 id，缺省时按位置生成。
    """
    ctx = _get_project()
    node_id = ctx['_current_node_id']
    op_group_id = ctx['_current_op_group_id']
    wires = params.pop('wires', {})
    for group in ctx['nodes'][node_id]['operation_groups']:
        if group['id'] == op_group_id:
            group['operations'].append({
                'id': id or f"{op_group_id}_op_{len(group['operations'])}",
                'task_name': task_name,
                'alias': alias,
                'param_values': params,
                'wire_inputs': wires,
            })
            break
    return lambda func: func


def node_exit(name: str, label: str = ""):
    """声明节点出口"""
    ctx = _get_project()
    node_id = ctx['_current_node_id']
    ctx['nodes'][node_id]['exits'][name] = {
        'name': name,
        'label': label or name,
    }
    return lambda func: func


def edge(from_node: str, from_exit: str, to_node: str, to_port: str = "in"):
    """声明节点间控制流连接

    to_port: 目标节点入口接线点名称（多入口支持，缺省 "in"）。
    """
    ctx = _get_project()
    ctx['edges'].append({
        'from_node': from_node,
        'from_exit': from_exit,
        'to_node': to_node,
        'to_port': to_port,
    })