// server.js
const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Ayarlar
const PORT = process.env.PORT || 3000;
const dataFile = path.join(__dirname, "gamedata.json");
const rooms = new Map();
const globalRoomCode = "global";

// Admin & Ban
const adminCredentials = new Map([
  ["yekta", "yekta2013"] // Kullanıcı:Şifre
]);
const loggedInAdmins = new Set();
const bannedUsers = new Set();
const bannedIPs = new Set();
const userIPs = new Map();

// Statik dosyalar
app.use(express.static(path.join(__dirname)));

// Ana sayfa
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Veri kaydetme
function saveGameData() {
  try {
    const data = {};
    rooms.forEach((room, code) => {
      data[code] = {
        code: room.code,
        pixels: room.pixels,
        messages: room.messages.slice(-50)
      };
    });
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
    console.log("Oyun verisi kaydedildi.");
  } catch (error) {
    console.error("Veri kaydedilemedi:", error);
  }
}

// Veri yükleme
function loadGameData() {
  try {
    if (fs.existsSync(dataFile)) {
      const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
      Object.entries(data).forEach(([code, roomData]) => {
        rooms.set(code, {
          code: roomData.code,
          users: new Set(),
          pixels: roomData.pixels || {},
          messages: roomData.messages || []
        });
      });
      console.log("Oyun verisi yüklendi.");
    }
  } catch (error) {
    console.error("Veri yüklenemedi:", error);
  }
}

// İlk yükleme
loadGameData();

// Global oda yoksa oluştur
if (!rooms.has(globalRoomCode)) {
  rooms.set(globalRoomCode, {
    code: globalRoomCode,
    users: new Set(),
    pixels: {},
    messages: []
  });
}

// Socket bağlantıları
io.on("connection", (socket) => {
  console.log("Kullanıcı bağlandı:", socket.id);

  socket.on("join-room", (data) => {
    const roomCode = data.roomCode || "global";
    const username = data.username;
    const clientIP = socket.handshake.address || socket.conn.remoteAddress;

    if (!username || username.length < 2) {
      socket.emit("error", { message: "Geçersiz kullanıcı adı!" });
      return;
    }

    if (bannedIPs.has(clientIP) || bannedUsers.has(username)) {
      socket.emit("banned", { message: "Banlandınız!" });
      socket.disconnect();
      return;
    }

    userIPs.set(username, clientIP);

    let room = rooms.get(roomCode);
    if (!room) {
      room = { code: roomCode, users: new Set(), pixels: {}, messages: [] };
      rooms.set(roomCode, room);
    }

    if (room.users.has(username)) {
      socket.emit("error", { message: "Bu kullanıcı adı zaten kullanılıyor!" });
      return;
    }

    socket.join(roomCode);
    room.users.add(username);
    socket.username = username;
    socket.roomCode = roomCode;

    socket.emit("roomJoined", { roomCode });
    socket.to(roomCode).emit("user-joined", { username });

    socket.emit("roomState", {
      users: Array.from(room.users),
      pixels: room.pixels,
      messages: room.messages,
      isAdmin: loggedInAdmins.has(username)
    });
  });

  socket.on("place-pixel", (data) => {
    const room = rooms.get(data.roomCode);
    if (!room) return;

    if (data.x < 0 || data.x >= 200 || data.y < 0 || data.y >= 200) return;

    const pixelKey = `${data.x},${data.y}`;
    room.pixels[pixelKey] = data.color;

    saveGameData();

    io.to(data.roomCode).emit("pixel-placed", {
      x: data.x,
      y: data.y,
      color: data.color,
      username: data.username
    });
  });

  socket.on("send-message", (data) => {
    const room = rooms.get(data.roomCode);
    if (!room) return;

    if (!data.message || data.message.trim().length === 0) return;

    // Admin girişi
    if (adminCredentials.has(data.username) && data.message.startsWith("/login")) {
      const password = data.message.split(" ")[1];
      if (adminCredentials.get(data.username) === password) {
        loggedInAdmins.add(data.username);
        socket.emit("chat-message", { username: "SİSTEM", message: "Admin girişi başarılı!" });
        socket.emit("admin-status", { isAdmin: true });
      } else {
        socket.emit("chat-message", { username: "SİSTEM", message: "Hatalı şifre!" });
      }
      return;
    }

    // Admin komutları
    if (loggedInAdmins.has(data.username) && data.message.startsWith("/ban")) {
      const targetUser = data.message.split(" ")[1];
      bannedUsers.add(targetUser);
      const targetIP = userIPs.get(targetUser);
      if (targetIP) bannedIPs.add(targetIP);
      io.to(room.code).emit("chat-message", { username: "ADMIN", message: `${targetUser} banlandı!` });
      return;
    }

    room.messages.push({ username: data.username, message: data.message, timestamp: Date.now() });
    if (room.messages.length > 100) room.messages = room.messages.slice(-100);

    io.to(data.roomCode).emit("chat-message", { username: data.username, message: data.message });

    saveGameData();
  });

  socket.on("disconnect", () => {
    if (socket.username && socket.roomCode) {
      const room = rooms.get(socket.roomCode);
      if (room) {
        room.users.delete(socket.username);
        loggedInAdmins.delete(socket.username);
        socket.to(socket.roomCode).emit("user-left", { username: socket.username });
      }
    }
  });
});

// Otomatik veri kaydı
setInterval(saveGameData, 60000);

// Sunucuyu başlat
server.listen(PORT, () => {
  console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});
