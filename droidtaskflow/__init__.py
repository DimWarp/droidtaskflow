"""droidtaskflow: 可视化 Android 自动化测试工具"""

__version__ = "0.1.0"

# Re-export DSL builders so users can do:
#   from droidtaskflow import project, node, edge, ...
from droidtaskflow.dsl import (
    project, start_node, node, node_info_task, node_logic_task,
    node_op_group, node_op_group_task, node_exit, edge, global_var,
    _get_project, _reset_project,
)

# Re-export runner entry point
from droidtaskflow.runner import run_project_file
