"""
@droidtaskflow:tool
@droidtaskflow:tool_type adb
"""
# droidtaskflow.tool.adb_tool — ADB 设备交互工具
# 基于 adb 命令行实现，所有函数通过 subprocess 调用 adb。

import re
import struct
import subprocess
import time

# NOTE: mysc_core / adbutils are imported lazily inside screen_on / screen_off
# so the merged droidtaskflow.py bundle stays loadable in the browser Pyodide
# (which has neither package installed). They're only required at actual
# execution time, when the backend Python interpreter runs the project.


# ═══════════════════════════════════════════════
#  Module-level device serial
# ═══════════════════════════════════════════════
# 由 executor 在执行项目前通过 set_serial() 设置。
# 公共 API 自动使用此 serial，调用方无需传入。

_serial: str | None = None

# 隐藏的单例图片容器，每次截图覆盖前一张，避免内存泄漏
_last_screenshot: bytes | None = None


def set_serial(serial: str | None):
    """设置当前模块的默认设备序列号。executor 在执行前调一次即可。"""
    global _serial
    _serial = serial or None


# ═══════════════════════════════════════════════
#  Internal helpers
# ═══════════════════════════════════════════════

def _adb(serial: str | None, *args) -> subprocess.CompletedProcess:
    """Run an adb command and return the CompletedProcess."""
    cmd = ['adb']
    if serial:
        cmd.extend(['-s', serial])
    cmd.extend(args)
    print('[ADB]', ' '.join(cmd))
    return subprocess.run(cmd, capture_output=True, text=True)


def _adb_bytes(serial: str | None, *args) -> bytes:
    """Run an adb command, return stdout as raw bytes."""
    cmd = ['adb']
    if serial:
        cmd.extend(['-s', serial])
    cmd.extend(args)
    print('[ADB]', ' '.join(cmd))
    r = subprocess.run(cmd, capture_output=True)
    return r.stdout


# ═══════════════════════════════════════════════
#  设备管理
# ═══════════════════════════════════════════════

def list_devices():
    """返回已连接设备列表。
    Returns:
        list[dict]: [{serial, model, status, android_version}, ...]
    """
    r = _adb(None, 'devices', '-l')
    devices = []
    for line in r.stdout.strip().split('\n')[1:]:  # skip "List of devices" header
        if not line.strip():
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        serial = parts[0]
        status = parts[1]
        model = ''
        for p in parts[2:]:
            if p.startswith('model:'):
                model = p.split(':', 1)[1]
                break
        devices.append({
            'serial': serial,
            'model': model,
            'status': status,
            'android_version': '',  # needs separate getprop call
        })
    return devices


def get_device_info():
    """获取设备详细信息。
    Returns:
        dict: {serial, model, brand, android_version, sdk, resolution, dpi}
    """
    def _prop(key):
        r = _adb(_serial, 'shell', 'getprop', key)
        return r.stdout.strip()

    def _wm(key):
        r = _adb(_serial, 'shell', 'wm', key)
        return r.stdout.strip()

    return {
        'serial': _serial or _adb(None, 'shell', 'getprop', 'ro.serialno').stdout.strip(),
        'model': _prop('ro.product.model'),
        'brand': _prop('ro.product.brand'),
        'android_version': _prop('ro.build.version.release'),
        'sdk': int(_prop('ro.build.version.sdk') or 0),
        'resolution': _wm('size').replace('Physical size: ', ''),
        'dpi': _wm('density').replace('Physical density: ', ''),
    }


# ═══════════════════════════════════════════════
#  触控操作
# ═══════════════════════════════════════════════

def tap(x: int, y: int):
    """点击屏幕坐标。
    Args:
        x, y: 目标坐标（像素）
    """
    _adb(_serial, 'shell', 'input', 'tap', str(x), str(y))


def long_press(x: int, y: int, duration: int = 1000):
    """长按屏幕坐标。
    Args:
        x, y: 目标坐标
        duration: 长按时长（毫秒）
    """
    _adb(_serial, 'shell', 'input', 'swipe', str(x), str(y), str(x), str(y), str(duration))


def swipe(x1: int, y1: int, x2: int, y2: int, duration: int = 300):
    """滑动操作。
    Args:
        x1, y1: 起点坐标
        x2, y2: 终点坐标
        duration: 滑动时长（毫秒）
    """
    _adb(_serial, 'shell', 'input', 'swipe',
         str(x1), str(y1), str(x2), str(y2), str(duration))


# ═══════════════════════════════════════════════
#  按键 & 输入
# ═══════════════════════════════════════════════

# Common Android key codes
KEY = {
    'HOME': 3, 'BACK': 4, 'CALL': 5, 'ENDCALL': 6,
    'VOLUME_UP': 24, 'VOLUME_DOWN': 25, 'POWER': 26, 'CAMERA': 27,
    'CLEAR': 28, 'A': 29, 'B': 30, 'C': 31, 'D': 32, 'E': 33,
    'F': 34, 'G': 35, 'H': 36, 'I': 37, 'J': 38, 'K': 39,
    'L': 40, 'M': 41, 'N': 42, 'O': 43, 'P': 44, 'Q': 45,
    'R': 46, 'S': 47, 'T': 48, 'U': 49, 'V': 50, 'W': 51,
    'X': 52, 'Y': 53, 'Z': 54, 'COMMA': 55, 'PERIOD': 56,
    'ALT_LEFT': 57, 'ALT_RIGHT': 58, 'SHIFT_LEFT': 59, 'SHIFT_RIGHT': 60,
    'TAB': 61, 'SPACE': 62, 'ENTER': 66, 'DEL': 67, 'GRAVE': 68,
    'MINUS': 69, 'EQUALS': 70, 'LEFT_BRACKET': 71, 'RIGHT_BRACKET': 72,
    'BACKSLASH': 73, 'SEMICOLON': 74, 'APOSTROPHE': 75, 'SLASH': 76,
    'AT': 77, 'PLUS': 81, 'MENU': 82, 'SEARCH': 84,
    'DPAD_UP': 19, 'DPAD_DOWN': 20, 'DPAD_LEFT': 21, 'DPAD_RIGHT': 22,
    'DPAD_CENTER': 23, 'MEDIA_PLAY_PAUSE': 85, 'MEDIA_STOP': 86,
    'MEDIA_NEXT': 87, 'MEDIA_PREVIOUS': 88, 'MEDIA_REWIND': 89,
    'MEDIA_FAST_FORWARD': 90,
}


def press_key(keycode: int):
    """发送按键事件。
    Args:
        keycode: Android 按键码（如 3=HOME, 4=BACK, 26=POWER, 66=ENTER）
    """
    _adb(_serial, 'shell', 'input', 'keyevent', str(keycode))


def input_text(text: str):
    """向当前焦点输入框输入文本（仅支持 ASCII）。"""
    # Escape special characters for shell
    safe = text.replace('\\', '\\\\').replace('"', '\\"')
    _adb(_serial, 'shell', 'input', 'text', safe)


# ═══════════════════════════════════════════════
#  ADBKeyboard（中文输入支持）
# ═══════════════════════════════════════════════
#
# `input text` 只支持 ASCII，中文输入需要 ADBKeyboard（com.android.adbkeyboard）：
# 它是一个输入法 APK，通过 am broadcast ADB_INPUT_TEXT 接收任意文本（含 UTF-8）。

_ADBKEYBOARD_PACKAGE = 'com.android.adbkeyboard'
_ADBKEYBOARD_IME = 'com.android.adbkeyboard/.AdbIME'
_ADBKEYBOARD_SOURCES = [
    # 官方：GitHub 仓库（302 重定向到 release 直链，urllib 自动跟随）。
    # 实测部分网络访问 GitHub 超时，故给较短超时，快速切到备用源。
    ('https://github.com/senzhk/ADBKeyBoard/raw/master/ADBKeyboard.apk', 8),
    # 备用：jsdelivr CDN（已实测 200 + APK 结构完整，可达性更好）
    ('https://cdn.jsdelivr.net/gh/senzhk/ADBKeyBoard@master/ADBKeyboard.apk', 15),
]


def has_package(package: str) -> bool:
    """检查设备是否已安装指定包（pm list packages 匹配）。"""
    r = _adb(_serial, 'shell', 'pm', 'list', 'packages', package)
    return package in r.stdout


def enable_ime(ime_id: str) -> None:
    """启用并切换输入法（ime enable + ime set）。"""
    _adb(_serial, 'shell', 'ime', 'enable', ime_id)
    _adb(_serial, 'shell', 'ime', 'set', ime_id)


def download_file(url: str, dest: str, timeout: int = 15) -> None:
    """下载文件到本地路径。用标准库 urllib——子进程环境无第三方依赖也能跑。"""
    import urllib.request
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        data = resp.read()
    with open(dest, 'wb') as f:
        f.write(data)


def ensure_adbkeyboard() -> None:
    """确保设备装有 ADBKeyboard 并已启用（支持中文输入）。

    检查 com.android.adbkeyboard：未安装则按源列表逐个下载（超时/失败换下一个源），
    adb install 安装，ime enable + ime set 启用切换。已安装也幂等地重新启用
    （避免系统重置了输入法选择）。
    """
    if has_package(_ADBKEYBOARD_PACKAGE):
        enable_ime(_ADBKEYBOARD_IME)
        return
    import os
    # 下载到脚本同目录（bundle 解压目录，即子进程 cwd = main.py 所在目录），
    # 安装完成后删除，不残留临时文件。
    dest = os.path.join(os.getcwd(), 'ADBKeyboard.apk')
    last_err = None
    try:
        for url, timeout in _ADBKEYBOARD_SOURCES:
            try:
                download_file(url, dest, timeout=timeout)
                install_app(dest)
                enable_ime(_ADBKEYBOARD_IME)
                print(f"[adbkeyboard] installed from {url}")
                return
            except Exception as e:
                last_err = e
                print(f"[adbkeyboard] source failed: {url}: {e}")
        raise RuntimeError(f"ADBKeyboard install failed: {last_err}")
    finally:
        try:
            os.remove(dest)
        except OSError:
            pass


def input_text_unicode(text: str) -> None:
    """通过 ADBKeyboard 广播输入任意文本（含中文）。

    前置要求 ensure_adbkeyboard() 已装好并启用。adb 客户端把 args 拼成
    设备端 shell 命令，特殊字符需转义：单引号包裹 + 内嵌单引号转义。
    """
    safe = text.replace("'", "'\\''")
    _adb(_serial, 'shell', 'am', 'broadcast', '-a', 'ADB_INPUT_TEXT',
         '--es', 'msg', f"'{safe}'")


# ═══════════════════════════════════════════════
#  电源管理（mysc_core）
# ═══════════════════════════════════════════════
#
# 通过 scrcpy 3.3 协议 SET_SCREEN_POWER_MODE 控制包直接切换屏幕电源状态。
# 不走 POWER 键——在该 OPPO 设备上按 POWER 会触发锁屏（参见
# feedback-android-223-locks）。两条命令都不会改变解锁状态：
#   - 息屏 → 仅关显示，不进 Keyguard
#   - 亮屏 → 仅唤醒，已解锁状态保持解锁
#
# 关键点：cleanup=False 必须传，否则 scrcpy-server 的 CleanUp.runCleanUp()
# 会在会话断开时把屏幕状态恢复到初始值，导致息屏"假成功"。
# （参见 reference-scrcpy-cleanup-restores-screen）

def screen_on():
    """唤醒屏幕（不影响解锁状态）。

    用 mysc_core 直接发 SET_SCREEN_POWER_MODE=ON 控制包。
    不走 POWER 键——POWER 键在该 OPPO 设备上会触发锁屏。
    """
    # 动态导入 adbutils / mysc_core：datamapper.js 会扫描 .py 源文件，
    # 把所有以 `import ` 或 `from ` 开头的行提升到合并后的
    # droidtaskflow.py 顶部。浏览器 Pyodide 没装这两个包，提到顶部
    # 会导致整个 bundle 加载失败。所以用 __import__ 绕开文本匹配，
    # 仅在后端真正执行时才解析这两个名字。
    _AdbClient = __import__('adbutils').AdbClient
    _Connection = __import__('mysc_core.connection', fromlist=['']).Connection

    device = _AdbClient().device(_serial)
    conn = _Connection.connect(device, {
        'control': True,
        'video': False, 'audio': False,
        'cleanup': False,    # 关掉 scrcpy-server CleanUp
        'stay_awake': True,
    })
    conn.send(struct.pack('>BB', 10, 1))   # SET_SCREEN_POWER_MODE = ON
    time.sleep(0.3)                         # 等 server 真正处理完
    conn.disconnect()


def screen_off():
    """熄灭屏幕（不影响解锁状态）。

    用 mysc_core 直接发 SET_SCREEN_POWER_MODE=OFF 控制包。
    必须 cleanup=False，否则 scrcpy-server 退出时 CleanUp.runCleanUp()
    会把屏幕状态恢复到初始值，导致息屏"假成功"。
    """
    # 动态导入：见 screen_on 的注释——避开 datamapper.js 的 import 文本扫描，
    # 让浏览器 Pyodide bundle 能加载，仅在后端执行时才解析这两个名字。
    _AdbClient = __import__('adbutils').AdbClient
    _Connection = __import__('mysc_core.connection', fromlist=['']).Connection

    device = _AdbClient().device(_serial)
    conn = _Connection.connect(device, {
        'control': True,
        'video': False, 'audio': False,
        'cleanup': False,    # 关键：禁用 server 端 CleanUp
        'stay_awake': True,
    })
    conn.send(struct.pack('>BB', 10, 0))   # SET_SCREEN_POWER_MODE = OFF
    time.sleep(0.3)                         # 等 server 真正处理完
    conn.disconnect()


# ═══════════════════════════════════════════════
#  截图
# ═══════════════════════════════════════════════

def screenshot(save_to: str = None) -> bytes:
    """截取屏幕，返回 PNG 二进制数据。
    截图同时缓存到模块级 _last_screenshot（单例容器），每次覆盖前一张。
    Args:
        save_to: 可选，同时保存到设备的路径（如 "/sdcard/droidtask_screenshot.png"）。
                 默认 None 表示不写设备，仅返回二进制。
    Returns:
        bytes: PNG 截图数据
    """
    global _last_screenshot
    data = _adb_bytes(_serial, 'exec-out', 'screencap', '-p')
    _last_screenshot = data
    if save_to:
        _adb(_serial, 'shell', 'screencap', '-p', save_to)
    return data


# ═══════════════════════════════════════════════
#  应用管理
# ═══════════════════════════════════════════════

def install_app(apk_path: str):
    """安装 APK。
    Args:
        apk_path: 本地 APK 文件路径
    """
    r = _adb(_serial, 'install', '-r', apk_path)
    if 'Success' not in r.stdout:
        raise RuntimeError(f'APK install failed: {r.stdout.strip() or r.stderr.strip()}')


def uninstall_app(package: str):
    """卸载应用。"""
    r = _adb(_serial, 'uninstall', package)
    if 'Success' not in r.stdout:
        raise RuntimeError(f'Uninstall failed: {r.stdout.strip() or r.stderr.strip()}')


def start_app(package: str, activity: str | None = None):
    """启动应用。
    Args:
        package: 包名
        activity: Activity 全限定名，为 None 时启动默认 launcher activity
    """
    if activity:
        target = f'{package}/{activity}'
    else:
        # Resolve launcher activity
        r = _adb(_serial, 'shell', 'cmd', 'package', 'resolve-activity',
                 '--brief', package)
        launcher = r.stdout.strip()
        if not launcher:
            _adb(_serial, 'shell', 'monkey', '-p', package,
                 '-c', 'android.intent.category.LAUNCHER', '1')
            return
        # resolve-activity --brief outputs two lines: intent flags + component
        # Only keep the line containing the package/activity (has a '/')
        for line in launcher.split('\n'):
            line = line.strip()
            if '/' in line and line.startswith(package):
                target = line
                break
        else:
            _adb(_serial, 'shell', 'monkey', '-p', package,
                 '-c', 'android.intent.category.LAUNCHER', '1')
            return
    _adb(_serial, 'shell', 'am', 'start', '-n', target)


def stop_app(package: str):
    """强制停止应用。"""
    _adb(_serial, 'shell', 'am', 'force-stop', package)


def get_current_app() -> dict:
    """获取当前前台应用。
    Returns:
        dict: {package, activity}
    """
    r = _adb(_serial, 'shell', 'dumpsys', 'activity', 'activities')
    out = r.stdout

    # Android 10+: mFocusedApp=ActivityRecord{hash uid package/activity tNN}
    m = re.search(r'mFocusedApp=ActivityRecord\{[^}]*\S+\s+(\S+)/(\S+)', out)
    if m:
        return {'package': m.group(1), 'activity': m.group(2)}

    # Android 10+ alternative: mResumedActivity: ActivityRecord{...}
    m = re.search(r'mResumedActivity:\s*ActivityRecord\{[^}]*\S+\s+(\S+)/(\S+)', out)
    if m:
        return {'package': m.group(1), 'activity': m.group(2)}

    # Android 9-: mFocusedActivity={ActivityRecord{package/activity ...}}
    m = re.search(r'mFocusedActivity=\{[^}]*\S+\s+(\S+)/(\S+)', out)
    if m:
        return {'package': m.group(1), 'activity': m.group(2)}

    return {'package': '', 'activity': ''}


# ═══════════════════════════════════════════════
#  Shell
# ═══════════════════════════════════════════════

def shell(command: str) -> str:
    """在设备上执行 shell 命令并返回输出。
    Args:
        command: shell 命令字符串
    Returns:
        str: 命令输出
    """
    r = _adb(_serial, 'shell', command)
    return r.stdout


# ═══════════════════════════════════════════════
#  文件传输
# ═══════════════════════════════════════════════

def push_file(local: str, remote: str):
    """将本地文件推送到设备。"""
    r = _adb(_serial, 'push', local, remote)
    if r.returncode != 0:
        raise RuntimeError(f'Push failed: {r.stderr.strip()}')


def pull_file(remote: str, local: str):
    """从设备拉取文件到本地。"""
    r = _adb(_serial, 'pull', remote, local)
    if r.returncode != 0:
        raise RuntimeError(f'Pull failed: {r.stderr.strip()}')
