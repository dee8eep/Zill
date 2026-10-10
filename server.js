const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const express = require("express");
const helmet = require("helmet");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

const app = express();
fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
const server = http.createServer(app);

const isProduction = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT) || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (isProduction && (!SESSION_SECRET || SESSION_SECRET.length < 32)) {
  throw new Error("في بيئة الإنتاج يجب ضبط SESSION_SECRET عشوائي بطول 32 حرفاً على الأقل.");
}
const sessionSecret = SESSION_SECRET || crypto.randomBytes(48).toString("hex");
if (isProduction) app.set("trust proxy", 1);

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.socket.io"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "ws:", "wss:"],
      imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: isProduction ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: "10kb" }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));
let sessionStore; // undefined => express-session MemoryStore (fallback)
try {
  const SQLiteStoreFactory = require("connect-sqlite3")(session);
  sessionStore = new SQLiteStoreFactory({ db: "sessions.sqlite", dir: path.join(__dirname, "data") });
} catch (e) {
  console.warn("تعذر تحميل connect-sqlite3؛ سيتم استخدام مخزن جلسات مؤقت في الذاكرة.", e.message);
}
const sessionMiddleware = session({
  name: "dardasha.sid",
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: isProduction,
    maxAge: 12 * 60 * 60 * 1000
  }
});
app.use(sessionMiddleware);

const io = new Server(server, {
  maxHttpBufferSize: 64 * 1024,
  pingTimeout: 20000,
  pingInterval: 25000,
  cors: { origin: false }
});
io.engine.use(sessionMiddleware);

const limiter = new Map();
function allowEvent(socket, key, limit, intervalMs) {
  const now = Date.now();
  const k = `${socket.id}:${key}`;
  const old = limiter.get(k) || { count: 0, resetAt: now + intervalMs };
  if (now > old.resetAt) { old.count = 0; old.resetAt = now + intervalMs; }
  old.count++;
  limiter.set(k, old);
  if (limiter.size > 5000) {
    for (const [id, val] of limiter) if (val.resetAt < now) limiter.delete(id);
  }
  return old.count <= limit;
}
const roomMembers = new Map();
const socketRooms = new Map();
const roomSecrets = new Map(); // in-memory room records; restart invalidates rooms
const MAX_MESSAGE_LENGTH = 1000;
const MAX_NAME_LENGTH = 30;
const ROOM_CODE_BYTES = 18; // 144 bits entropy
const MAX_MEMBERS = Number(process.env.MAX_ROOM_MEMBERS) || 10;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 1000;
const createLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: "طلبات إنشاء غرف كثيرة. حاول لاحقاً." } });
const joinLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { error: "محاولات انضمام كثيرة. حاول لاحقاً." } });

function cleanText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function newRoomCode() {
  return crypto.randomBytes(ROOM_CODE_BYTES).toString("base64url");
}
function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}
function validCode(code) {
  return typeof code === "string" && /^[A-Za-z0-9_-]{20,40}$/.test(code);
}
function getSession(socket) {
  return socket.request.session;
}
function asyncSessionSave(sess) {
  return new Promise((resolve, reject) => sess.save(err => err ? reject(err) : resolve()));
}
function broadcastCount(room) {
  const members = roomMembers.get(room);
  io.to(room).emit("count", { members: members ? members.size : 0 });
}
function removeFromRoom(socket, announce = true) {
  const room = socketRooms.get(socket.id);
  if (!room) return;
  socket.leave(room);
  socketRooms.delete(socket.id);
  const members = roomMembers.get(room);
  if (members) {
    members.delete(socket.id);
    if (members.size === 0) roomMembers.delete(room);
  }
  const who = socket.data.displayName;
  if (announce) {
    socket.to(room).emit("typing", { name: who || "مستخدم", typing: false });
    socket.to(room).emit("system", { text: who ? `${who} غادر الغرفة.` : "غادر أحد المشاركين الغرفة." });
  }
  broadcastCount(room);
  socket.emit("room:left");
}

app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));
app.get("/health", (_req, res) => res.json({ ok: true }));

// Create a room: the code is a strong random invitation secret; only its SHA-256 hash is stored server-side.
app.post("/api/rooms", createLimiter, async (req, res) => {
  const name = cleanText(req.body?.name, MAX_NAME_LENGTH);
  if (!name) return res.status(400).json({ error: "اكتب اسمك أولاً." });
  if (roomSecrets.size >= MAX_ROOMS) return res.status(503).json({ error: "الخادم مشغول حالياً. حاول لاحقاً." });
  const code = newRoomCode();
  const id = hashCode(code);
  const sessionData = getSession({ request: req });
  sessionData.roomCodes = [...(sessionData.roomCodes || []), id].slice(-10);
  sessionData.displayName = name;
  try {
    await asyncSessionSave(sessionData);
    roomSecrets.set(id, { createdAt: Date.now() });
    return res.status(201).json({ code, name });
  } catch {
    return res.status(500).json({ error: "تعذر إنشاء الغرفة." });
  }
});

// Join a room by secret invitation code. In-memory room registry means rooms are ephemeral.
app.post("/api/rooms/join", joinLimiter, async (req, res) => {
  const name = cleanText(req.body?.name, MAX_NAME_LENGTH);
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (!name || !validCode(code) || !roomSecrets.has(hashCode(code))) {
    return res.status(400).json({ error: "رمز الدعوة غير صحيح أو انتهت صلاحية الغرفة." });
  }
  const sessionData = getSession({ request: req });
  sessionData.displayName = name;
  sessionData.roomCodes = [...(sessionData.roomCodes || []), hashCode(code)].slice(-10);
  try {
    await asyncSessionSave(sessionData);
    return res.json({ ok: true, name, code });
  } catch {
    return res.status(500).json({ error: "تعذر الانضمام إلى الغرفة." });
  }
});

io.use((socket, next) => {
  const sess = socket.request.session;
  if (!sess) return next(new Error("الجلسة غير متاحة."));
  next();
});

io.on("connection", socket => {
  socket.data.lastMessageAt = 0;

  socket.on("join", async (payload, callback) => {
    const reply = typeof callback === "function" ? callback : () => {};
    if (!allowEvent(socket, "join", 5, 60_000)) return reply({ ok: false, error: "محاولات كثيرة. انتظر دقيقة." });
    // The socket holds a snapshot of the session from its handshake; reload it so rooms
    // authorized after the socket connected (e.g. a second room) are visible.
    try {
      await new Promise((resolve, reject) => socket.request.session.reload(e => e ? reject(e) : resolve()));
    } catch {
      return reply({ ok: false, error: "انتهت الجلسة. أعد تحميل الصفحة." });
    }
    const sess = getSession(socket);
    const name = cleanText(payload?.name || sess?.displayName, MAX_NAME_LENGTH);
    const code = typeof payload?.code === "string" ? payload.code.trim() : "";
    const roomId = validCode(code) ? hashCode(code) : "";
    const authorized = (sess?.roomCodes || []).includes(roomId);
    if (!name || !validCode(code) || !roomSecrets.has(roomId) || !authorized) {
      return reply({ ok: false, error: "رمز الدعوة غير صحيح أو ليس لديك صلاحية لهذه الغرفة." });
    }
    if (socketRooms.get(socket.id) === roomId) { socket.data.displayName = name; return reply({ ok: true }); }
    const existing = roomMembers.get(roomId);
    if (existing && existing.size >= MAX_MEMBERS) return reply({ ok: false, error: "الغرفة ممتلئة." });
    removeFromRoom(socket);
    socket.join(roomId);
    socketRooms.set(socket.id, roomId);
    if (!roomMembers.has(roomId)) roomMembers.set(roomId, new Map());
    roomMembers.get(roomId).set(socket.id, { name });
    socket.data.displayName = name;
    socket.emit("room:joined", { name, members: roomMembers.get(roomId).size });
    socket.to(roomId).emit("system", { text: `${name} انضم إلى الغرفة.` });
    broadcastCount(roomId);
    reply({ ok: true });
  });

  socket.on("message", (payload, callback) => {
    const reply = typeof callback === "function" ? callback : () => {};
    if (!allowEvent(socket, "message", 8, 2_000)) return reply({ ok: false, error: "أرسلت رسائل بسرعة كبيرة. حاول بعد قليل." });
    const room = socketRooms.get(socket.id);
    // Never trust a room code supplied in each message. Verify server-side membership.
    if (!room || !socket.rooms.has(room)) {
      return reply({ ok: false, error: "لست عضواً في هذه الغرفة." });
    }
    if (typeof payload?.text !== "string" || payload.text.length > MAX_MESSAGE_LENGTH) {
      return reply({ ok: false, error: "الرسالة طويلة جداً (الحد 1000 حرف)." });
    }
    const text = cleanText(payload.text, MAX_MESSAGE_LENGTH);
    if (!text) return reply({ ok: false, error: "الرسالة فارغة." });
    const name = socket.data.displayName || "مستخدم";
    const message = { name, text, time: new Date().toISOString() };
    socket.to(room).emit("message", message);
    reply({ ok: true, message });
  });

  socket.on("typing", isTyping => {
    if (!allowEvent(socket, "typing", 4, 2_000)) return;
    const room = socketRooms.get(socket.id);
    if (room && socket.rooms.has(room)) socket.to(room).emit("typing", {
      name: socket.data.displayName || "مستخدم", typing: Boolean(isTyping)
    });
  });

  socket.on("leave", () => removeFromRoom(socket));
  socket.on("disconnect", () => {
    removeFromRoom(socket, true);
    for (const key of limiter.keys()) if (key.startsWith(socket.id + ":")) limiter.delete(key);
  });
});

// Sweep empty ephemeral rooms after 30 minutes. This is not durable storage.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of roomSecrets) {
    if (!roomMembers.has(code) && now - room.createdAt > 30 * 60 * 1000) roomSecrets.delete(code);
  }
}, 60_000).unref();

server.listen(PORT, "0.0.0.0", () => console.log(`Dardasha server listening on port ${PORT}`));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    io.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
