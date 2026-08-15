from droidtaskflow.decorators import task, param


@task(alias="触发节点出口", type_="operate")
@param("exit_name", alias="出口名", type_="box")
def trigger_node_exit(exit_name, current_node=None, global_vars=None):
    """触发当前节点的指定出口（仅在操作组内有效）

    此任务是系统级任务，不是用户可定义的。
    通过 current_node 参数访问当前节点（由 executor 注入）。
    """
    if current_node is not None:
        current_node.fired_exit = exit_name
    return []