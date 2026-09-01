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

@info_task("iterate_global_list", alias="iterate global list",
    params={
        "list_name": {"type": "global_var", "ui_width": 0.5, "init_value": ""},
        "index": {"type": "global_var", "ui_width": 0.5, "init_value": ""},
    },
    rets=["value"])
def iterate_global_list(list_name, index, global_vars=None):
    if not list_name or global_vars is None or list_name not in global_vars or index is None or index not in global_vars:
        return [{"enable": False, "value": None}]
    if len(global_vars[list_name]) <= int(global_vars[index]):
        return [{"enable": False, "value": None}]
    value = global_vars[list_name][int(global_vars[index])]
    global_vars[index] = int(global_vars[index]) + 1
    return [{"enable": True, "value": value}]

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
        "code": {"type": "code", "ui_width": 1, "init_value": "output = [{'enable': True, 'value': input}]"},
    },
    rets=["output"])
def custom_code(input, code):
    # exec 必须用显式 dict 命名空间并读回：函数内裸 exec(code) 的赋值不会写局部变量槽
    # （CPython LOAD_FAST 行为），用户写 `output = [...]` 永远不生效、返回初始值。
    _locals = {'input': input}
    exec(code, globals(), _locals)
    output = _locals.get('output', {'enable': False, 'value': None})
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

@operate_task("sleep", alias="sleep",
    params={
        "millisecond": {"type": "box", "ui_width": 1, "init_value": "100"},
    },
    rets=[])
def sleep(millisecond):
    import time
    time.sleep(int(millisecond) / 1000)

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

@operate_task("adb_input_text", alias="input text",
    params={
        "text": {"type": "line", "ui_width": 1, "init_value": ""},
    })
def adb_input_text(text):
    """输入文本（支持中文）。

    前置逻辑：确保设备装有 ADBKeyboard（com.android.adbkeyboard）——未安装则从
    官方源下载（失败/超时自动换备用源）并安装、启用切换输入法；然后通过
    ADBKeyboard 广播输入，支持 UTF-8 中文。
    """
    adb_tool.ensure_adbkeyboard()
    adb_tool.input_text_unicode(text)

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

# press key：下拉放常用的 Android 按键码（adb_tool.KEY 的键名），函数直接转换
_PRESS_KEYS = ["POWER", "BACK", "HOME", "MENU", "VOLUME_UP", "VOLUME_DOWN",
               "ENTER", "DEL", "SPACE", "TAB", "DPAD_UP", "DPAD_DOWN",
               "DPAD_LEFT", "DPAD_RIGHT", "DPAD_CENTER", "SEARCH",
               "MEDIA_PLAY_PAUSE", "CAMERA"]

@operate_task("adb_press_key", alias="press key",
    params={
        "key": {"type": "list", "ui_width": 1, "init_value": "POWER",
                "opts": _PRESS_KEYS},
    })
def adb_press_key(key):
    """按下指定按键（adb_tool.KEY 的键名 → keycode）。"""
    if key in adb_tool.KEY:
        adb_tool.press_key(adb_tool.KEY[key])

# ── 退出带状态：让脚本"控制自己的成功/失败 + 信息" ────────────────────────────
# 这是 operate 卡片的退出机制约定——按固定格式 print 一行后 sys.exit()：
#   [droidtaskflow job exit] exit code: <X> - <status>, message: <msg>
# 后端 _extract_exit_msg 正则匹配，存到 history.json 的 exit_msg 字段；
# 前端在自动化卡片 + 历史弹窗的"信息"列展示。
#
# 状态码语义：
#   0  → 外部判定 success（沿用 process exit code 习惯）
#   59 → 外部判定 failed（自定义失败码；后端只看 "code != 0" 走 failed 路径）
#
# 第一次调用此卡片脚本立即退出（业务约束，不可恢复）。后续节点不再执行。

@operate_task("exit_with_status", alias="exit with status",
    params={
        "status": {"type": "list", "ui_width": 0.4, "init_value": "success",
                   "opts": ["success", "failed"]},
        "msg": {"type": "both", "ui_width": 0.6, "init_value": "exit msg not set"},
    })
def exit_with_status(status="success", msg=""):
    """脚本按 status + msg 退出。后端从 stdout 抓取并写入 history.exit_msg。

    success → exit code 0；failed → exit code 59。后端统一把 "code != 0" 判 failed，
    把 "code == 0" 判 success（与现有 process exit code 习惯一致）。
    """
    import sys
    if status == "failed":
        code, status_str = 59, "failed"
    else:
        code, status_str = 0, "success"
    # 单行 print：后端正则 `\[droidtaskflow job exit\] exit code: (\d+) - (\w+), message: (.+)`
    # 匹配后取 code → 决定 status enum；取 msg → 存 exit_msg 字段。
    print(f"[droidtaskflow job exit] exit code: {code} - {status_str}, message: {msg}")
    sys.exit(code)
