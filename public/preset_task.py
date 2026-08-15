"""
@droidtaskflow:preset_cards
@droidtaskflow:version 1.0
"""
from droidtaskflow.dsl import info_task, logic_task, operate_task
from droidtaskflow.tool import adb_tool
from droidtaskflow.tool import ocr_tool

# ═══════════════════════════════════════════════
#  INFO — 场景信息提取
# ═══════════════════════════════════════════════


@info_task("list_devices", alias="list devices",
    params={},
    rets=["devices"])
def list_devices():
    devices = adb_tool.list_devices()
    return [{"enable": True, "value": devices}]

@info_task("current_activity", alias="current activity",
    rets=["package", "activity"])
def current_activity():
    packact = adb_tool.get_current_app()
    return [{"enable": True, "value": packact['package']}, {"enable": True, "value": packact['activity']}]

@info_task("screenshot", alias="screenshot",
    params={},
    rets=["screen_shot"])
def screenshot():
    """截取当前屏幕，返回 PNG 图片数据（缓存到内存单例，每次覆盖前一张）。"""
    data = adb_tool.screenshot()
    return [{"enable": True, "value": data}]

@info_task("read_global_var", alias="read global var",
    params={
        "var_name": {"type": "global_var", "ui_width": 1, "init_value": ""},
    },
    rets=["value"])
def read_global_var(var_name, global_vars=None):
    """读取一个全局变量的当前值（只读，不改动变量）。"""
    if not var_name or global_vars is None or var_name not in global_vars:
        return [{"enable": False, "value": None}]
    return [{"enable": True, "value": global_vars[var_name]}]

# ═══════════════════════════════════════════════
#  LOGIC — 逻辑分析
# ═══════════════════════════════════════════════

@logic_task("logic_print", alias="logic print",
    params={
        "input": {"type": "line", "ui_width": 0, "init_value": ""},
        "remark": {"type": "box", "ui_width": 1, "init_value": " ← value of input"}
    },
    rets=[])
def logic_print(input, remark, task_alias=None):
    if input is None:
        input = ""
    print(task_alias + ": " + str(input) + remark)

@logic_task("image_match", alias="image match",
    params={
        "screen_shot": {"type": "line", "ui_width": 0, "init_value": ""},
        "image": {"type": "image", "ui_width": 1, "init_value": ""},
        "threshold": {"type": "box", "ui_width": 1, "init_value": "0.8"},
    },
    rets=["boxes", "box0x", "box0y"])
def image_match(screen_shot, image="", threshold="0.8"):
    from droidtaskflow.tool import image_tool
    boxes = image_tool.match(base_img=screen_shot, image=image, threshold=float(threshold))
    if boxes:
        box0x = (boxes[0]['box'][0][0] + boxes[0]['box'][1][0] +  boxes[0]['box'][2][0] + boxes[0]['box'][3][0])/4
        box0y = (boxes[0]['box'][0][1] + boxes[0]['box'][1][1] +  boxes[0]['box'][2][1] + boxes[0]['box'][3][1])/4
        return [{"enable": True, "value": boxes}, {"enable": True, "value": box0x}, {"enable": True, "value": box0y}]
    else:
        return [{"enable": False, "value": None}, {"enable": False, "value": None}, {"enable": False, "value": None}]

@logic_task("ocr_recognize", alias="OCR recognize",
    params={
        "screen_shot": {"type": "line", "ui_width": 0, "init_value": ""},
        "text_score": {"type": "box", "ui_width": 1, "init_value": "0.5"},
    },
    rets=["texts", "boxes"])
def ocr_recognize(screen_shot=None, text_score="0.5"):
    results = ocr_tool.ocr(screen_shot, text_score=float(text_score))
    texts = "\n".join(item["text"] for item in results)
    boxes = [item["box"] for item in results]
    return [{"enable": True, "value": texts}, {"enable": True, "value": boxes}]

@logic_task("passthrough", alias="passthrough",
    params={
        "samein": {"type": "line", "ui_width": 1, "init_value": ""},
    },
    rets=["sameout"])
def passthrough(samein):
    return [{"enable": True, "value": samein}]

@logic_task("string_compare", alias="string compare",
    params={
        "str1": {"type": "line", "ui_width": 0, "init_value": ""},
        "str2": {"type": "box", "ui_width": 1, "init_value": ""},
    },
    rets=["same", "different"])
def string_compare(str1, str2):
    if str1 == str2:
        return [{"enable": True, "value": None}, {"enable": False, "value": None}]
    else:
        return [{"enable": False, "value": None}, {"enable": True, "value": None}]

@logic_task("find_button_in_ocr", alias="find button in OCR",
    params={
        "ocr_text": {"type": "line", "ui_width": 0, "init_value": ""},
        "ocr_box": {"type": "line", "ui_width": 0, "init_value": ""},
        "text": {"type": "box", "ui_width": 1, "init_value": ""},
    },
    rets=["x", "y"])
def find_button_in_ocr(ocr_text, ocr_box, text):
    """在 OCR 结果中查找包含指定文本的条目，返回其中心坐标。"""
    import json
    if not ocr_text or not text:
        return [{"enable": False, "value": 0}, {"enable": False, "value": 0}]
    texts = ocr_text.split("\n") if isinstance(ocr_text, str) else []
    try:
        boxes = json.loads(ocr_box) if isinstance(ocr_box, str) else ocr_box
    except (json.JSONDecodeError, TypeError):
        boxes = []
    for i, t in enumerate(texts):
        if text in t and i < len(boxes):
            box = boxes[i]
            cx = int(sum(p[0] for p in box) / 4)
            cy = int(sum(p[1] for p in box) / 4)
            return [{"enable": True, "value": cx}, {"enable": True, "value": cy}]
    return [{"enable": False, "value": 0}, {"enable": False, "value": 0}]

@logic_task("custom_code", alias="custom code",
    params={
        "input": {"type": "line", "ui_width": 1},
        "code": {"type": "code", "ui_width": 1, "init_value": "print(input)\nprint(output)"},
    },
    rets=["output"])
def custom_code(input, code):
    output = [{"enable": True, "value": None}]
    exec(code)
    return output

@logic_task("math_calculate", alias="math calculate",
    params={
        "input": {"type": "line", "ui_width": 0, "init_value": ""},
        "operator": {"type": "list", "ui_width": 0.3, "init_value": "+",
                     "opts": ["+", "-", "*", "/"]},
        "value": {"type": "both", "ui_width": 0.7, "init_value": "1"},
    },
    rets=["result"])
def math_calculate(input, operator="+", value=1):
    """对输入值做算术运算：result = input <op> value。"""
    try:
        current = float(input)
        operand = float(value)
        if operator == '+':
            result = current + operand
        elif operator == '-':
            result = current - operand
        elif operator == '*':
            result = current * operand
        elif operator == '/':
            result = current / operand
        else:
            return [{"enable": False, "value": None}]
    except (TypeError, ValueError, ZeroDivisionError):
        return [{"enable": False, "value": None}]
    return [{"enable": True, "value": result}]

@logic_task("math_compare", alias="math compare",
    params={
        "input": {"type": "line", "ui_width": 0, "init_value": ""},
        "operator": {"type": "list", "ui_width": 0.3, "init_value": ">",
                     "opts": [">", ">=", "<=", "<", "=", "!="]},
        "value": {"type": "both", "ui_width": 0.7, "init_value": "0"},
    },
    rets=["pass", "fail"])
def math_compare(input, operator=">", value=0):
    """数值比较：input <op> value 成立 → pass 出口 enable，否则 fail 出口 enable。"""
    try:
        a = float(input)
        b = float(value)
        if operator == '>':
            ok = a > b
        elif operator == '>=':
            ok = a >= b
        elif operator == '<=':
            ok = a <= b
        elif operator == '<':
            ok = a < b
        elif operator == '=':
            ok = a == b
        elif operator == '!=':
            ok = a != b
        else:
            ok = False
    except (TypeError, ValueError):
        ok = False
    if ok:
        return [{"enable": True, "value": None}, {"enable": False, "value": None}]
    return [{"enable": False, "value": None}, {"enable": True, "value": None}]

# ═══════════════════════════════════════════════
#  OPERATE — 操作
# ═══════════════════════════════════════════════

@operate_task("set_global_var", alias="set global var",
    params={
        "glo_var": {"type": "global_var", "ui_width": 0.5, "init_value": ""},
        "value": {"type": "both", "ui_width": 0.5, "init_value": ""},
    },
    rets=["new_value"])
def set_global_var(glo_var, value, global_vars=None):
    if not glo_var or global_vars is None:
        return [{"enable": False, "value": None}]
    global_vars[glo_var] = value
    return [{"enable": True, "value": value}]

@operate_task("operate_print", alias="operate print",
    params={
        "input": {"type": "line", "ui_width": 0, "init_value": ""},
        "remark": {"type": "box", "ui_width": 1, "init_value": " ← value of input"}
    },
    rets=[])
def operate_print(input, remark, task_alias=None):
    if input is None:
        input = ""
    print(task_alias + ": " + str(input) + remark)

@operate_task("sleep", alias="sleep",
    params={
        "millisecond": {"type": "box", "ui_width": 1, "init_value": "100"},
    },
    rets=[])
def sleep(millisecond):
    import time
    time.sleep(int(millisecond) / 1000)

@operate_task("adb_power_on", alias="power on",
    params={},
    rets=[])
def adb_power_on():
    """锁屏时按 POWER 唤醒；已亮屏则不操作。"""
    if "Asleep" in adb_tool.shell("dumpsys power | grep mWakefulness="):
        adb_tool.press_key(adb_tool.KEY['POWER'])

@operate_task("adb_power_off", alias="power off",
    params={},
    rets=[])
def adb_power_off():
    """亮屏时按 POWER 熄屏；已息屏则不操作。"""
    if "Awake" in adb_tool.shell("dumpsys power | grep mWakefulness="):
        adb_tool.press_key(adb_tool.KEY['POWER'])

@operate_task("scrcpy_screen_on", alias="screen on",
    params={},
    rets=[])
def scrcpy_screen_on():
    """唤醒屏幕（不影响解锁状态，不锁屏）。

    走 mysc_core SET_SCREEN_POWER_MODE 控制包，而非 POWER 键。
    已解锁状态保持解锁；不会触发 Keyguard。
    """
    adb_tool.screen_on()

@operate_task("scrcpy_screen_off", alias="screen off",
    params={},
    rets=[])
def scrcpy_screen_off():
    """熄灭屏幕（不影响解锁状态）。

    走 mysc_core SET_SCREEN_POWER_MODE 控制包，并通过 cleanup=False
    阻止 scrcpy-server 退出时恢复屏幕。仅关显示，不进 Keyguard。
    """
    adb_tool.screen_off()

@operate_task("adb_unlock", alias="unlock",
    params={},
    rets=[])
def adb_unlock():
    adb_tool.swipe(537, 1721, 537, 644, 300)

@operate_task("adb_back", alias="back",
    params={},
    rets=[])
def adb_back():
    adb_tool.press_key(adb_tool.KEY['BACK'])

@operate_task("adb_swipe", alias="swipe",
    params={
        "x1": {"type": "both", "ui_width": 0.5, "init_value": 540},
        "y1": {"type": "both", "ui_width": 0.5, "init_value": 960},
        "x2": {"type": "both", "ui_width": 0.5, "init_value": 540},
        "y2": {"type": "both", "ui_width": 0.5, "init_value": 500},
        "duration": {"type": "both", "ui_width": 0.5, "init_value": 300},
    })
def adb_swipe(x1=540, y1=960, x2=540, y2=500, duration=300):
    adb_tool.swipe(x1, y1, x2, y2, duration)

@operate_task("adb_tap", alias="tap",
    params={
        "x": {"type": "both", "ui_width": 0.5, "init_value": 21},
        "y": {"type": "both", "ui_width": 0.5, "init_value": 5}
        })
def adb_tap(x, y):
    adb_tool.tap(int(x), int(y))

@operate_task("adb_tap_offset", alias="tap offset",
    params={
        "x": {"type": "line", "ui_width": 0.5, "init_value": 21},
        "y": {"type": "line", "ui_width": 0.5, "init_value": 5},
        "x_offset": {"type": "box", "ui_width": 0.5, "init_value": 0},
        "y_offset": {"type": "box", "ui_width": 0.5, "init_value": 0}
        })
def adb_tap_offset(x, y, x_offset=0, y_offset=0):
    adb_tool.tap(x + int(x_offset), y + int(y_offset))

@operate_task("adb_start_app", alias="start app",
    params={
        "package": {"type": "both", "ui_width": 1, "init_value": "com.example.app"},
    })
def adb_start_app(package):
    adb_tool.start_app(package)

@operate_task("adb_stop_app", alias="stop app",
    params={
        "package": {"type": "both", "ui_width": 1, "init_value": "com.example.app"},
    })
def adb_stop_app(package):
    adb_tool.stop_app(package)
