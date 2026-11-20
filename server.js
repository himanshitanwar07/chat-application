// ChatApp backend — Express + Socket.IO
// Run:  npm install && npm start   →  http://localhost:8080
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 8080;
const DEFAULT_ROOMS = ["general", "tech", "random"];
const HISTORY_LIMIT = 50; // messages remembered per room
const MAX_MESSAGE_LEN = 1000;
const MAX_IMAGE_CHARS = 600000; // ~450 KB image (base64 data URL)
const MAX_ROOMS = 50;
const RATE_LIMIT = { max: 6, windowMs: 5000 }; // 6 messages / 5 sec / user
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "messages.json");
const IMAGE_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: process.env.CORS_ORIGIN || "*" },
  maxHttpBufferSize: 1e6, // 1 MB (images are resized on the client)
});

// ---------- HTTP ----------
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) =>
  res.json({ status: "ok", users: users.size, rooms: rooms.size, uptime: process.uptime() })
);

// ---------- State ----------
const users = new Map(); // socket.id -> { username, room, sentAt: [] }
const rooms = new Map(); // roomName -> { messages: [], typing: Set<username> }
let msgId = 0;

function createRoom(name) {
  if (!rooms.has(name)) rooms.set(name, { messages: [], typing: new Set() });
  return rooms.get(name);
}

// ---------- Persistence (JSON file, room messages only) ----------
function loadData() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    msgId = Number(raw.msgId) || 0;
    for (const [name, msgs] of Object.entries(raw.rooms || {})) {
      const room = cleanRoom(name);
      if (room && Array.isArray(msgs)) createRoom(room).messages = msgs.slice(-HISTORY_LIMIT);
    }
    console.log(`Loaded saved messages for ${rooms.size} rooms`);
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Could not load saved data:", err.message);
  }
}

function saveNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = { msgId, rooms: {} };
    for (const [name, r] of rooms) out.rooms[name] = r.messages.filter((m) => m.type !== "system");
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error("Save failed:", err.message);
  }
}

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 800);
}

// ---------- Helpers ----------
const cleanName = (s) =>
  String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().replace(/\s+/g, " ").slice(0, 20);

const cleanRoom = (s) =>
  String(s ?? "").toLowerCase().trim().replace(/[^a-z0-9_-]/g, "").slice(0, 20);

const cleanText = (s) =>
  String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, MAX_MESSAGE_LEN);

// Accepts "text" or { text, image } → { text, image } or { error }
function parsePayload(input) {
  const o = typeof input === "string" ? { text: input } : input || {};
  const text = cleanText(o.text);
  let image = null;
  if (o.image != null && o.image !== "") {
    if (typeof o.image !== "string" || o.image.length > MAX_IMAGE_CHARS || !IMAGE_RE.test(o.image)) {
      return { error: "Invalid or too large image" };
    }
    image = o.image;
  }
  if (!text && !image) return { error: "Empty message" };
  return { text, image };
}

const findUser = (name) =>
  [...users.entries()].find(([, u]) => u.username.toLowerCase() === name.toLowerCase());

const usersIn = (room) =>
  [...users.values()].filter((u) => u.room === room).map((u) => u.username).sort();

const roomList = () =>
  [...rooms.keys()].map((name) => ({ name, count: usersIn(name).length }));

function makeMessage(room, username, text, type = "chat", image = null) {
  const msg = { id: ++msgId, room, username, text, type, time: Date.now() };
  if (image) msg.image = image;
  return msg;
}

function pushMessage(room, msg) {
  const r = rooms.get(room);
  r.messages.push(msg);
  if (r.messages.length > HISTORY_LIMIT) r.messages.shift();
  io.to(room).emit("message", msg);
  if (msg.type !== "system") saveSoon();
}

const systemMessage = (room, text) => pushMessage(room, makeMessage(room, "System", text, "system"));

function broadcastRoomState(room) {
  io.to(room).emit("users", { room, users: usersIn(room) });
  io.emit("rooms", roomList());
}

function setTyping(room, username, isTyping) {
  const r = rooms.get(room);
  if (!r) return;
  const changed = isTyping ? !r.typing.has(username) && r.typing.add(username) : r.typing.delete(username);
  if (changed) io.to(room).emit("typing", { room, users: [...r.typing] });
}

function allowed(user) {
  const now = Date.now();
  user.sentAt = user.sentAt.filter((t) => now - t < RATE_LIMIT.windowMs);
  if (user.sentAt.length >= RATE_LIMIT.max) return false;
  user.sentAt.push(now);
  return true;
}

function enterRoom(socket, user, room) {
  createRoom(room);
  socket.join(room);
  user.room = room;
  systemMessage(room, `${user.username} joined #${room}`);
  broadcastRoomState(room);
}

function exitRoom(socket, user) {
  const room = user.room;
  setTyping(room, user.username, false);
  socket.leave(room);
  user.room = null;
  systemMessage(room, `${user.username} left #${room}`);
  broadcastRoomState(room);
}

const reply = (ack, payload) => typeof ack === "function" && ack(payload);

loadData();
DEFAULT_ROOMS.forEach(createRoom);

// ---------- Socket events ----------
io.on("connection", (socket) => {
  // 1) Join chat with a username + room
  socket.on("join", (data, ack) => {
    if (users.has(socket.id)) return reply(ack, { ok: false, error: "Already joined" });

    const username = cleanName(data?.username);
    const room = cleanRoom(data?.room) || "general";

    if (username.length < 2) return reply(ack, { ok: false, error: "Name must be at least 2 characters" });
    if (username.toLowerCase() === "system") return reply(ack, { ok: false, error: "That name is reserved" });
    if (findUser(username)) return reply(ack, { ok: false, error: "Name already in use" });
    if (!rooms.has(room) && rooms.size >= MAX_ROOMS) return reply(ack, { ok: false, error: "Room limit reached" });

    const user = { username, room: null, sentAt: [] };
    users.set(socket.id, user);

    const history = createRoom(room).messages.slice(); // before the join message
    enterRoom(socket, user, room);

    reply(ack, { ok: true, username, room, history, users: usersIn(room), rooms: roomList() });
  });

  // 2) Send a message (text and/or image) to current room
  socket.on("message", (input, ack) => {
    const user = users.get(socket.id);
    if (!user) return reply(ack, { ok: false, error: "Join first" });

    const p = parsePayload(input);
    if (p.error) return reply(ack, { ok: false, error: p.error });
    if (!allowed(user)) return reply(ack, { ok: false, error: "Slow down a little" });

    setTyping(user.room, user.username, false);
    pushMessage(user.room, makeMessage(user.room, user.username, p.text, "chat", p.image));
    reply(ack, { ok: true });
  });

  // 3) Private message (text and/or image) to one online user — not saved
  socket.on("private", (data, ack) => {
    const user = users.get(socket.id);
    if (!user) return reply(ack, { ok: false, error: "Join first" });

    const target = findUser(cleanName(data?.to));
    if (!target) return reply(ack, { ok: false, error: "That user is offline" });
    if (target[0] === socket.id) return reply(ack, { ok: false, error: "You can't message yourself" });

    const p = parsePayload(data);
    if (p.error) return reply(ack, { ok: false, error: p.error });
    if (!allowed(user)) return reply(ack, { ok: false, error: "Slow down a little" });

    const msg = { id: ++msgId, from: user.username, to: target[1].username, text: p.text, image: p.image, time: Date.now() };
    io.to(target[0]).emit("private", msg);
    socket.emit("private", msg);
    reply(ack, { ok: true });
  });

  // 4) Switch (or create) a room
  socket.on("switch_room", (name, ack) => {
    const user = users.get(socket.id);
    if (!user) return reply(ack, { ok: false, error: "Join first" });

    const room = cleanRoom(name);
    if (!room) return reply(ack, { ok: false, error: "Invalid room name" });
    if (room === user.room) return reply(ack, { ok: false, error: "Already in this room" });
    if (!rooms.has(room) && rooms.size >= MAX_ROOMS) return reply(ack, { ok: false, error: "Room limit reached" });

    exitRoom(socket, user);
    const history = createRoom(room).messages.slice();
    enterRoom(socket, user, room);
    reply(ack, { ok: true, room, history, users: usersIn(room), rooms: roomList() });
  });

  // 5) Typing indicator
  socket.on("typing", (isTyping) => {
    const user = users.get(socket.id);
    if (user) setTyping(user.room, user.username, Boolean(isTyping));
  });

  // 6) Disconnect
  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (!user) return;
    exitRoom(socket, user);
    users.delete(socket.id);
    io.emit("rooms", roomList());
    console.log(`- ${user.username} disconnected (online: ${users.size})`);
  });
});

// ---------- Start / shutdown ----------
httpServer.listen(PORT, () => console.log(`Chat server running → http://localhost:${PORT}`));

function shutdown() {
  console.log("Shutting down...");
  saveNow();
  io.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
