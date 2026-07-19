# -*- coding: utf-8 -*-
"""剧本杀联机服务器 — 纯 Python 标准库，无需安装依赖。

运行: python server.py
本机访问: http://localhost:8899
局域网访问: http://<本机IP>:8899 (启动时会打印)
"""
import json
import os
import random
import socket
import string
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
SCRIPTS_DIR = os.path.join(BASE_DIR, "scripts")
# 本地默认 8899；云平台（如 Render）会通过环境变量 PORT 指定端口
PORT = int(os.environ.get("PORT", "8899"))

# ---------------- 剧本加载 ----------------

SCRIPTS = {}

def load_scripts():
    SCRIPTS.clear()
    for fn in os.listdir(SCRIPTS_DIR):
        if fn.endswith(".json"):
            with open(os.path.join(SCRIPTS_DIR, fn), encoding="utf-8") as f:
                data = json.load(f)
                SCRIPTS[data["id"]] = data

# ---------------- 房间状态 ----------------

LOCK = threading.RLock()
ROOMS = {}  # code -> room dict

PHASE_LABELS = {
    "lobby": "等待大厅",
    "reading": "阅读剧本",
    "vote": "投票指认",
    "reveal": "真相揭晓",
}

def new_room_code():
    while True:
        code = "".join(random.choices(string.digits, k=4))
        if code not in ROOMS:
            return code

def new_player_id():
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=12))

def make_room(script_id):
    script = SCRIPTS[script_id]
    phases = ["lobby", "reading"]
    for i in range(len(script["rounds"])):
        phases.append("round%d" % (i + 1))
    phases += ["vote", "reveal"]
    return {
        "code": new_room_code(),
        "script_id": script_id,
        "phases": phases,
        "phase_idx": 0,
        "host": None,
        "players": {},           # pid -> player
        "chat": [],              # {name, char_name, text, ts, system}
        "found": {},             # clue_id -> {"finder": pid, "public": bool}
        "votes": {},             # pid -> char_id
        "created": time.time(),
        "ver": 0,                # 状态版本号，任何变化时 +1，客户端据此增量拉取
    }

def bump(room):
    room["ver"] += 1

def sys_msg(room, text):
    room["chat"].append({"name": "系统", "char_name": "", "text": text,
                         "ts": time.time(), "system": True})
    bump(room)

def room_phase(room):
    return room["phases"][room["phase_idx"]]

def current_round(room):
    """当前搜证轮索引，非搜证阶段返回 -1"""
    ph = room_phase(room)
    if ph.startswith("round"):
        return int(ph[5:]) - 1
    return -1

def phase_label(room):
    ph = room_phase(room)
    if ph.startswith("round"):
        script = SCRIPTS[room["script_id"]]
        return script["rounds"][int(ph[5:]) - 1]["name"]
    return PHASE_LABELS.get(ph, ph)

def clue_by_id(script, clue_id):
    for rnd in script["rounds"]:
        for loc, clues in rnd["locations"].items():
            for c in clues:
                if c["id"] == clue_id:
                    return c, loc
    return None, None

def char_by_id(script, char_id):
    for c in script["characters"]:
        if c["id"] == char_id:
            return c
    return None

# ---------------- API 处理 ----------------

class ApiError(Exception):
    pass

def get_room(code):
    room = ROOMS.get(code)
    if not room:
        raise ApiError("房间不存在或已关闭")
    return room

def get_player(room, pid):
    p = room["players"].get(pid)
    if not p:
        raise ApiError("你不在这个房间里（可能已被移除）")
    return p

def api_scripts(body, qs):
    return {"scripts": [{
        "id": s["id"], "title": s["title"], "tagline": s["tagline"],
        "players": len(s["characters"]), "difficulty": s.get("difficulty", ""),
        "duration": s.get("duration", ""),
    } for s in SCRIPTS.values()]}

def api_create(body, qs):
    name = (body.get("name") or "").strip()[:12]
    script_id = body.get("script_id")
    if not name:
        raise ApiError("请输入昵称")
    if script_id not in SCRIPTS:
        raise ApiError("剧本不存在")
    room = make_room(script_id)
    pid = new_player_id()
    room["host"] = pid
    room["players"][pid] = {
        "id": pid, "name": name, "char": None, "want_random": False,
        "search_left": 0, "last_seen": time.time(),
    }
    ROOMS[room["code"]] = room
    sys_msg(room, "%s 创建了房间，剧本：《%s》" % (name, SCRIPTS[script_id]["title"]))
    return {"room": room["code"], "player_id": pid}

def api_join(body, qs):
    name = (body.get("name") or "").strip()[:12]
    if not name:
        raise ApiError("请输入昵称")
    room = get_room(body.get("room", "").strip())
    if room_phase(room) != "lobby":
        raise ApiError("游戏已经开始，无法加入")
    script = SCRIPTS[room["script_id"]]
    if len(room["players"]) >= len(script["characters"]):
        raise ApiError("房间已满")
    for p in room["players"].values():
        if p["name"] == name:
            raise ApiError("昵称已被占用，换一个吧")
    pid = new_player_id()
    room["players"][pid] = {
        "id": pid, "name": name, "char": None, "want_random": False,
        "search_left": 0, "last_seen": time.time(),
    }
    sys_msg(room, "%s 加入了房间" % name)
    return {"room": room["code"], "player_id": pid}

def api_pick(body, qs):
    room = get_room(body.get("room", ""))
    p = get_player(room, body.get("player_id", ""))
    if room_phase(room) != "lobby":
        raise ApiError("游戏已开始，不能换角色")
    char_id = body.get("char_id")
    if char_id == "random":
        p["char"] = None
        p["want_random"] = True
        sys_msg(room, "%s 选择随机分配角色" % p["name"])
        return {}
    script = SCRIPTS[room["script_id"]]
    if not char_by_id(script, char_id):
        raise ApiError("角色不存在")
    for other in room["players"].values():
        if other["id"] != p["id"] and other["char"] == char_id:
            raise ApiError("该角色已被选择")
    p["char"] = char_id
    p["want_random"] = False
    sys_msg(room, "%s 选择了角色「%s」" % (p["name"], char_by_id(script, char_id)["name"]))
    return {}

def api_start(body, qs):
    room = get_room(body.get("room", ""))
    p = get_player(room, body.get("player_id", ""))
    if p["id"] != room["host"]:
        raise ApiError("只有房主可以开始游戏")
    if room_phase(room) != "lobby":
        raise ApiError("游戏已开始")
    script = SCRIPTS[room["script_id"]]
    need = len(script["characters"])
    if len(room["players"]) != need:
        raise ApiError("需要 %d 名玩家（当前 %d 名）" % (need, len(room["players"])))
    for pl in room["players"].values():
        if pl["char"] is None and not pl["want_random"]:
            raise ApiError("还有玩家未选角色：%s" % pl["name"])
    # 随机分配剩余角色
    taken = {pl["char"] for pl in room["players"].values() if pl["char"]}
    free = [c["id"] for c in script["characters"] if c["id"] not in taken]
    random.shuffle(free)
    for pl in room["players"].values():
        if pl["char"] is None:
            pl["char"] = free.pop()
    room["phase_idx"] = 1  # reading
    sys_msg(room, "游戏开始！请各自阅读剧本，读完后由房主进入第一轮搜证。")
    return {}

def api_next_phase(body, qs):
    room = get_room(body.get("room", ""))
    p = get_player(room, body.get("player_id", ""))
    if p["id"] != room["host"]:
        raise ApiError("只有房主可以推进阶段")
    if room["phase_idx"] >= len(room["phases"]) - 1:
        raise ApiError("已经是最后阶段")
    room["phase_idx"] += 1
    ph = room_phase(room)
    script = SCRIPTS[room["script_id"]]
    if ph.startswith("round"):
        pts = script.get("search_points", 2)
        for pl in room["players"].values():
            pl["search_left"] = pts
        sys_msg(room, "进入【%s】：每人有 %d 次搜证机会，去各个地点找线索吧！" % (phase_label(room), pts))
    elif ph == "vote":
        sys_msg(room, "进入投票阶段：请指认你心中的凶手！全员投票后房主可揭晓真相。")
    elif ph == "reveal":
        tally = {}
        for cid in room["votes"].values():
            tally[cid] = tally.get(cid, 0) + 1
        lines = []
        for cid, n in sorted(tally.items(), key=lambda x: -x[1]):
            ch = char_by_id(script, cid)
            lines.append("%s %d票" % (ch["name"] if ch else cid, n))
        sys_msg(room, "投票结果：" + ("，".join(lines) if lines else "无人投票"))
        murderer = char_by_id(script, script["murderer"])
        sys_msg(room, "真相揭晓：凶手是「%s」！详见【真相】页。" % murderer["name"])
    return {}

def api_search(body, qs):
    room = get_room(body.get("room", ""))
    p = get_player(room, body.get("player_id", ""))
    ri = current_round(room)
    if ri < 0:
        raise ApiError("当前不是搜证阶段")
    if p["search_left"] <= 0:
        raise ApiError("本轮搜证次数已用完")
    script = SCRIPTS[room["script_id"]]
    loc = body.get("location")
    # 可搜范围：当前轮及之前所有轮的地点
    pool = []
    for r in range(ri + 1):
        clues = script["rounds"][r]["locations"].get(loc)
        if clues:
            pool.extend(clues)
    if not pool:
        raise ApiError("没有这个地点")
    remaining = [c for c in pool if c["id"] not in room["found"]]
    if not remaining:
        raise ApiError("「%s」已经搜不到新线索了（不消耗次数）" % loc)
    clue = random.choice(remaining)
    room["found"][clue["id"]] = {"finder": p["id"], "public": False}
    p["search_left"] -= 1
    ch = char_by_id(script, p["char"])
    sys_msg(room, "%s（%s）在「%s」搜到了一条线索：%s（尚未公开）" % (
        p["name"], ch["name"] if ch else "?", loc, clue["title"]))
    return {"clue": clue, "location": loc}

def api_publish(body, qs):
    room = get_room(body.get("room", ""))
    p = get_player(room, body.get("player_id", ""))
    clue_id = body.get("clue_id")
    info = room["found"].get(clue_id)
    if not info or info["finder"] != p["id"]:
        raise ApiError("这不是你持有的线索")
    if info["public"]:
        raise ApiError("该线索已公开")
    info["public"] = True
    script = SCRIPTS[room["script_id"]]
    clue, loc = clue_by_id(script, clue_id)
    sys_msg(room, "%s 公开了线索【%s · %s】：%s" % (p["name"], loc, clue["title"], clue["text"]))
    return {}

def api_chat(body, qs):
    room = get_room(body.get("room", ""))
    p = get_player(room, body.get("player_id", ""))
    text = (body.get("text") or "").strip()[:500]
    if not text:
        raise ApiError("消息不能为空")
    script = SCRIPTS[room["script_id"]]
    ch = char_by_id(script, p["char"]) if p["char"] else None
    room["chat"].append({"name": p["name"], "char_name": ch["name"] if ch else "",
                         "text": text, "ts": time.time(), "system": False})
    if len(room["chat"]) > 500:
        del room["chat"][:len(room["chat"]) - 500]
    bump(room)
    return {}

def api_vote(body, qs):
    room = get_room(body.get("room", ""))
    p = get_player(room, body.get("player_id", ""))
    if room_phase(room) != "vote":
        raise ApiError("当前不是投票阶段")
    script = SCRIPTS[room["script_id"]]
    char_id = body.get("char_id")
    if not char_by_id(script, char_id):
        raise ApiError("角色不存在")
    first = p["id"] not in room["votes"]
    room["votes"][p["id"]] = char_id
    if first:
        sys_msg(room, "%s 已投票（%d/%d）" % (p["name"], len(room["votes"]), len(room["players"])))
    else:
        bump(room)
    return {}

def api_restart(body, qs):
    room = get_room(body.get("room", ""))
    p = get_player(room, body.get("player_id", ""))
    if p["id"] != room["host"]:
        raise ApiError("只有房主可以重开")
    room["phase_idx"] = 0
    room["found"] = {}
    room["votes"] = {}
    for pl in room["players"].values():
        pl["char"] = None
        pl["want_random"] = False
        pl["search_left"] = 0
    sys_msg(room, "房主重开了房间，回到大厅。可重新选角色（换个剧本请新建房间）。")
    return {}

def api_state(body, qs):
    room = get_room(qs.get("room", [""])[0])
    pid = qs.get("player", [""])[0]
    p = get_player(room, pid)
    p["last_seen"] = time.time()
    # 增量同步：客户端带上一次的版本号，状态没变就只回一个"没变"，大幅省流量
    try:
        client_ver = int(qs.get("ver", ["-1"])[0])
    except ValueError:
        client_ver = -1
    if client_ver == room["ver"]:
        return {"unchanged": True, "ver": room["ver"]}
    script = SCRIPTS[room["script_id"]]
    ph = room_phase(room)
    ri = current_round(room)
    started = room["phase_idx"] >= 1

    players = []
    for pl in room["players"].values():
        ch = char_by_id(script, pl["char"]) if pl["char"] else None
        players.append({
            "name": pl["name"],
            "is_host": pl["id"] == room["host"],
            "is_me": pl["id"] == pid,
            "char_id": pl["char"] if (started or pl["id"] == pid or True) else None,
            "char_name": ch["name"] if ch else None,
            "want_random": pl["want_random"],
            "search_left": pl["search_left"],
            "voted": pl["id"] in room["votes"],
            "online": time.time() - pl["last_seen"] < 10,
        })

    # 线索：公开的所有人可见；私藏的只有发现者可见
    public_clues, my_clues = [], []
    for cid, info in room["found"].items():
        clue, loc = clue_by_id(script, cid)
        finder = room["players"].get(info["finder"])
        item = {"id": cid, "title": clue["title"], "text": clue["text"],
                "location": loc, "finder": finder["name"] if finder else "?"}
        if info["public"]:
            public_clues.append(item)
        elif info["finder"] == pid:
            my_clues.append(item)

    # 当前可搜地点（含之前轮）
    locations = []
    if ri >= 0:
        seen = set()
        for r in range(ri + 1):
            for loc, clues in script["rounds"][r]["locations"].items():
                if loc in seen:
                    continue
                seen.add(loc)
                remaining = sum(1 for c in clues if c["id"] not in room["found"])
                # 之前轮同名地点合并统计
                for r2 in range(ri + 1):
                    if r2 == r:
                        continue
                    for c in script["rounds"][r2]["locations"].get(loc, []):
                        if c["id"] not in room["found"]:
                            remaining += 1
                locations.append({"name": loc, "remaining": remaining})

    my_char = None
    me = room["players"][pid]
    if me["char"] and started:
        ch = char_by_id(script, me["char"])
        my_char = {"id": ch["id"], "name": ch["name"], "brief": ch["brief"],
                   "story": ch["story"], "secrets": ch["secrets"], "goals": ch["goals"]}

    state = {
        "room": room["code"],
        "ver": room["ver"],
        "phase": ph,
        "phase_label": phase_label(room),
        "phase_idx": room["phase_idx"],
        "phase_count": len(room["phases"]),
        "is_host": pid == room["host"],
        "script": {
            "id": script["id"], "title": script["title"], "tagline": script["tagline"],
            "background": script["background"], "victim": script.get("victim", ""),
            "vote_question": script.get("vote_question", "你认为谁是凶手？"),
            "characters": [{"id": c["id"], "name": c["name"], "brief": c["brief"],
                            "public": c["public"]} for c in script["characters"]],
        },
        "players": players,
        "my_char": my_char,
        "my_search_left": me["search_left"],
        "locations": locations,
        "public_clues": public_clues,
        "my_clues": my_clues,
        "chat": room["chat"][-200:],
        "my_vote": room["votes"].get(pid),
        "votes_done": len(room["votes"]),
    }
    if ph == "reveal":
        tally = {}
        for cid in room["votes"].values():
            tally[cid] = tally.get(cid, 0) + 1
        state["reveal"] = {
            "murderer_id": script["murderer"],
            "murderer_name": char_by_id(script, script["murderer"])["name"],
            "truth": script["truth"],
            "tally": [{"char_id": cid, "char_name": char_by_id(script, cid)["name"],
                       "votes": n} for cid, n in sorted(tally.items(), key=lambda x: -x[1])],
            "characters": [{"name": c["name"], "story": c["story"],
                            "secrets": c["secrets"]} for c in script["characters"]],
        }
    return state

API = {
    "scripts": api_scripts, "create": api_create, "join": api_join,
    "pick": api_pick, "start": api_start, "next_phase": api_next_phase,
    "search": api_search, "publish": api_publish, "chat": api_chat,
    "vote": api_vote, "restart": api_restart, "state": api_state,
}

# ---------------- HTTP ----------------

MIME = {".html": "text/html", ".js": "application/javascript",
        ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml",
        ".ico": "image/x-icon"}

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # 安静模式

    def _json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _api(self, name, body, qs):
        fn = API.get(name)
        if not fn:
            return self._json({"error": "未知接口"}, 404)
        try:
            with LOCK:
                result = fn(body, qs)
            self._json({"ok": True, **(result or {})})
        except ApiError as e:
            self._json({"error": str(e)}, 400)
        except Exception as e:
            self._json({"error": "服务器内部错误: %s" % e}, 500)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/"):
            return self._api(path[5:], {}, parse_qs(parsed.query))
        # 静态文件
        if path == "/":
            path = "/index.html"
        fp = os.path.normpath(os.path.join(STATIC_DIR, path.lstrip("/")))
        if not fp.startswith(STATIC_DIR) or not os.path.isfile(fp):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        with open(fp, "rb") as f:
            data = f.read()
        ext = os.path.splitext(fp)[1]
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream") + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            body = {}
        self._api(parsed.path[5:], body, parse_qs(parsed.query))

def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

def cleanup_loop():
    """清理 6 小时无人访问的房间"""
    while True:
        time.sleep(600)
        now = time.time()
        with LOCK:
            dead = [code for code, r in ROOMS.items()
                    if all(now - p["last_seen"] > 21600 for p in r["players"].values())]
            for code in dead:
                del ROOMS[code]

class ExclusiveHTTPServer(ThreadingHTTPServer):
    # Windows 下 SO_REUSEADDR 会允许两个进程绑同一端口、请求随机分流；
    # 关闭它让重复启动时直接报错，而不是悄悄跑两个服务器。
    # （不用 SO_EXCLUSIVEADDRUSE：那会连 TIME_WAIT 残留都挡住，导致快速重启失败）
    allow_reuse_address = False

def all_lan_ips():
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                ips.add(ip)
    except Exception:
        pass
    return ips

def main():
    load_scripts()
    try:
        server = ExclusiveHTTPServer(("0.0.0.0", PORT), Handler)
    except OSError:
        print("!" * 46)
        print("  启动失败：端口 %d 已被占用。" % PORT)
        print("  游戏服务器很可能已经在运行了，别重复启动；")
        print("  或先关掉旧的服务器窗口再试。")
        print("!" * 46)
        input("按回车退出...")
        return
    main_ip = lan_ip()
    print("=" * 46)
    print("  剧本杀小馆 已启动！")
    print("  已加载剧本: %s" % "、".join("《%s》" % s["title"] for s in SCRIPTS.values()))
    print("  本机访问:   http://localhost:%d" % PORT)
    print("  局域网访问: http://%s:%d  <-- 手机/其他设备用这个" % (main_ip, PORT))
    for ip in sorted(all_lan_ips() - {main_ip}):
        print("  备用地址:   http://%s:%d" % (ip, PORT))
    print("  (需与本机连同一个 WiFi / 局域网)")
    print("=" * 46)
    threading.Thread(target=cleanup_loop, daemon=True).start()
    server.serve_forever()

if __name__ == "__main__":
    main()
