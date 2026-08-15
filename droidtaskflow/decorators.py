from functools import wraps

VALID_TASK_TYPES = {"info", "logic", "operate"}


class TaskDefinitionError(ValueError):
    """装饰器参数不合法时抛出"""
    pass


def task(alias: str, type_: str):
    """任务顶层装饰器。type_ ∈ {"info", "logic", "operate"}

    设计要点：装饰器从内向外应用，@task 在 @param/@returns 外层。
    因此 @param/@returns 先运行，把数据暂存到 _pending_params/_pending_returns，
    @task 最后统一收集并初始化 _task_meta。
    """
    if type_ not in VALID_TASK_TYPES:
        raise TaskDefinitionError(
            f"task(): type_ must be one of {VALID_TASK_TYPES}, got {type_!r}"
        )
    def decorator(func):
        # 收集 @param/@returns 暂存的数据（如果有）
        params = getattr(func, "_pending_params", [])
        returns = getattr(func, "_pending_returns", [])

        func._task_meta = {
            "alias": alias,
            "type": type_,
            "params": params,
            "returns": returns,
        }

        # 清理临时属性，避免污染原函数
        for attr in ("_pending_params", "_pending_returns"):
            if hasattr(func, attr):
                delattr(func, attr)

        @wraps(func)
        def wrapper(*args, **kwargs):
            return func(*args, **kwargs)
        wrapper._task_meta = func._task_meta
        return wrapper
    return decorator


VALID_PARAM_TYPES = {"line", "box", "code", "list"}


def param(name: str, alias: str, type_: str, length: float = 1.0, options=None):
    """参数装饰器。type_ ∈ {"line", "box", "code", "list"}

    在 bare function 上暂存到 _pending_params，由外层 @task 收集。
    """
    if type_ not in VALID_PARAM_TYPES:
        raise TaskDefinitionError(
            f"param(): type_ must be one of {VALID_PARAM_TYPES}, got {type_!r}"
        )
    if type_ == "list" and not options:
        raise TaskDefinitionError(
            f"param({name!r}): type 'list' requires non-empty options"
        )
    if not (0 <= length <= 1):
        raise TaskDefinitionError(
            f"param({name!r}): length must be in [0, 1], got {length}"
        )
    def decorator(func):
        if not hasattr(func, "_pending_params"):
            func._pending_params = []
        # prepend：因为装饰器从内向外应用，倒序 append 会得到 ['b','a']；
        # prepend 让最终顺序与源码书写顺序一致 ['a','b']
        func._pending_params.insert(0, {
            "name": name, "alias": alias,
            "type": type_, "length": length,
            "options": options,
        })
        return func
    return decorator


def returns(name: str, alias: str):
    """返回值装饰器（出口接线点）

    在 bare function 上暂存到 _pending_returns，由外层 @task 收集。
    """
    def decorator(func):
        if not hasattr(func, "_pending_returns"):
            func._pending_returns = []
        # 同 @param：prepend 保持源码书写顺序
        func._pending_returns.insert(0, {"name": name, "alias": alias})
        return func
    return decorator


from types import SimpleNamespace


def make_result(enable: bool = False, value=None):
    """构造任务返回的 enable/value 数据契约对象"""
    return SimpleNamespace(enable=enable, value=value)


def render_task_to_json(func) -> dict:
    """将装饰任务函数渲染为 JSON 元数据"""
    if not hasattr(func, '_task_meta'):
        raise TaskDefinitionError(
            f"render_task_to_json: {func.__name__!r} has no _task_meta"
        )
    meta = func._task_meta
    return {
        'name': func.__name__,
        'alias': meta['alias'],
        'type': meta['type'],
        'params': meta['params'],
        'returns': meta['returns'],
    }