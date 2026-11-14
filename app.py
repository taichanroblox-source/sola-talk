import os
import secrets
import time
from collections import defaultdict
from flask import Flask, jsonify, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", secrets.token_hex(32))
socketio = SocketIO(app, cors_allowed_origins=None, async_mode="threading")
rooms = {}
socket_rooms = {}
MAX_PEERS = 5

def info(room):
    return {
        "id": room["id"], "name": room["name"], "limit": room["limit"],
        "locked": room["locked"], "count": len(room["members"]),
        "approval": room["approval"]
    }

def member_data(sid, data):
    return {"sid": sid, "name": data["name"]}

@app.get("/")
def home():
    return render_template("index.html")

@app.get("/r/<room_id>")
def call(room_id):
    return render_template("index.html", room_id=room_id)

@app.post("/api/rooms")
def create_room():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "通話ルーム")).strip()[:60] or "通話ルーム"
    try:
        limit = int(data.get("limit", 5))
    except (ValueError, TypeError):
        return jsonify(error="人数が正しくありません"), 400
    if not 2 <= limit <= MAX_PEERS:
        return jsonify(error="人数は2〜5人にしてね"), 400
    room_id = secrets.token_urlsafe(9)
    host_key = secrets.token_urlsafe(32)
    password = str(data.get("password") or "")
    rooms[room_id] = {
        "id": room_id, "name": name, "limit": limit,
        "password": password, "host_key": host_key,
        "approval": bool(data.get("approval", False)),
        "locked": False, "members": {}, "pending": {},
        "created": time.time()
    }
    return jsonify(room=info(rooms[room_id]), host_key=host_key, url=f"/r/{room_id}")

@app.get("/api/rooms/<room_id>")
def get_room(room_id):
    room = rooms.get(room_id)
    if not room:
        return jsonify(error="ルームが見つかりません"), 404
    return jsonify(info(room))

def valid_host(room, key):
    return bool(key) and secrets.compare_digest(room["host_key"], str(key))

def send_roster(room):
    socketio.emit("roster", {"members": [member_data(sid, data) for sid, data in room["members"].items()]}, to=room["id"])

def admit(sid, room, name, is_host=False):
    if len(room["members"]) >= room["limit"]:
        socketio.emit("join_error", {"error": "ルームは満員です"}, to=sid)
        return
    room["members"][sid] = {"name": name, "host": is_host}
    socket_rooms[sid] = room["id"]
    join_room(room["id"], sid=sid)
    socketio.emit("admitted", {"room": info(room), "sid": sid, "host": is_host}, to=sid)
    send_roster(room)
    socketio.emit("peer_joined", {"sid": sid, "name": name}, to=room["id"], skip_sid=sid)

@socketio.on("join_call")
def join_call(data):
    data = data or {}
    room = rooms.get(str(data.get("room_id", "")))
    if not room:
        return emit("join_error", {"error": "ルームが見つかりません"})
    if request.sid in socket_rooms:
        return emit("join_error", {"error": "すでに通話に参加しています"})
    is_host = valid_host(room, data.get("host_key"))
    if room["locked"] and not is_host:
        return emit("join_error", {"error": "ルームはロックされています"})
    if len(room["members"]) >= room["limit"]:
        return emit("join_error", {"error": "ルームは満員です"})
    password = str(data.get("password") or "")
    if room["password"] and not is_host and not secrets.compare_digest(room["password"], password):
        return emit("join_error", {"error": "パスワードが違います"})
    name = str(data.get("name") or "").strip()[:32] or "ゲスト"
    if room["approval"] and not is_host:
        room["pending"][request.sid] = name
        emit("waiting", {"message": "管理者の承認を待っています"})
        socketio.emit("pending_requests", {"requests": [{"sid": sid, "name": n} for sid, n in room["pending"].items()]}, to=room["id"])
        return
    admit(request.sid, room, name, is_host)

@socketio.on("manage")
def manage(data):
    data = data or {}
    room = rooms.get(str(data.get("room_id", "")))
    if not room or not valid_host(room, data.get("host_key")):
        return emit("action_error", {"error": "管理者の権限がありません"})
    action = data.get("action")
    target = str(data.get("target") or "")
    if action == "approve" and target in room["pending"]:
        name = room["pending"].pop(target)
        admit(target, room, name)
    elif action == "reject" and target in room["pending"]:
        room["pending"].pop(target)
        socketio.emit("join_error", {"error": "参加が拒否されました"}, to=target)
    elif action == "kick" and target in room["members"]:
        if room["members"][target]["host"]:
            return emit("action_error", {"error": "管理者は退出させられません"})
        socketio.emit("removed", {"reason": "管理者によって退出しました"}, to=target)
        evict(target, room)
    elif action == "lock":
        room["locked"] = bool(data.get("value"))
        socketio.emit("room_state", info(room), to=room["id"])
    elif action == "end":
        socketio.emit("removed", {"reason": "管理者が通話を終了しました"}, to=room["id"])
        for sid in list(room["members"]):
            socket_rooms.pop(sid, None)
            leave_room(room["id"], sid=sid)
        rooms.pop(room["id"], None)
        return
    else:
        return emit("action_error", {"error": "操作ができません"})
    socketio.emit("pending_requests", {"requests": [{"sid": sid, "name": n} for sid, n in room["pending"].items()]}, to=room["id"])

def evict(sid, room):
    room["members"].pop(sid, None)
    socket_rooms.pop(sid, None)
    room["pending"].pop(sid, None)
    leave_room(room["id"], sid=sid)
    socketio.emit("peer_left", {"sid": sid}, to=room["id"])
    send_roster(room)

@socketio.on("signal")
def signal(data):
    data = data or {}
    room_id = socket_rooms.get(request.sid)
    room = rooms.get(room_id)
    target = str(data.get("to") or "")
    if not room or target not in room["members"] or data.get("kind") not in ("offer", "answer", "candidate"):
        return
    socketio.emit("signal", {"from": request.sid, "kind": data["kind"], "payload": data.get("payload")}, to=target)

@socketio.on("chat")
def chat(data):
    room_id = socket_rooms.get(request.sid)
    room = rooms.get(room_id)
    if not room:
        return
    message = str((data or {}).get("text") or "").strip()[:1000]
    if message:
        socketio.emit("chat", {"name": room["members"][request.sid]["name"], "text": message, "at": int(time.time())}, to=room_id)

@socketio.on("leave_call")
def leave_call():
    disconnect_user(request.sid)

@socketio.on("disconnect")
def disconnected():
    disconnect_user(request.sid)

def disconnect_user(sid):
    room_id = socket_rooms.get(sid)
    if room_id and room_id in rooms:
        evict(sid, rooms[room_id])
    for room in rooms.values():
        if sid in room["pending"]:
            room["pending"].pop(sid, None)
            socketio.emit("pending_requests", {"requests": [{"sid": x, "name": n} for x, n in room["pending"].items()]}, to=room["id"])

if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), allow_unsafe_werkzeug=True)
