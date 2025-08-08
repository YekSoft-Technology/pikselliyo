const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const path = require("path");

app.use(express.static(path.join(__dirname)));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

io.on("connection", (socket) => {
  console.log("Bir kullanıcı bağlandı");
  socket.on("disconnect", () => {
    console.log("Bir kullanıcı ayrıldı");
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor`);
});

// İstemci dosyalarını ana dizinden sun
app.use(express.static(path.join(__dirname)));

const rooms = new Map();
const globalRoomCode = "global";
const dataFile = path.join(__dirname, "gamedata.json");

// Admin ve ban sistemi
const adminCredentials = new Map([
  ["yekta", "yekta2013"]
]); // Admin kullanıcı adları ve şifreleri (şifreli)
const loggedInAdmins = new Set(); // Giriş yapmış adminler
const bannedUsers = new Set(); // Banlanmış kullanıcılar
const bannedIPs = new Set(); // Banlanmış IP adresleri - Admin IP banı temizlendi
const userIPs = new Map(); // Kullanıcı adı -> IP eşleştirmesi

// Veri kaydetme fonksiyonu
function saveGameData() {
  try {
    const data = {};
    rooms.forEach((room, code) => {
      data[code] = {
        code: room.code,
        pixels: room.pixels,
        messages: room.messages.slice(-50) // Son 50 mesajı sakla
      };
    });
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
    console.log("Oyun verisi kaydedildi.");
  } catch (error) {
    console.error("Veri kaydedilemedi:", error);
  }
}

// Veri yükleme fonksiyonu
function loadGameData() {
  try {
    if (fs.existsSync(dataFile)) {
      const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
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

// Oyun verisini yükle
loadGameData();

// Herkese açık (global) odayı oluştur (eğer yoksa)
if (!rooms.has(globalRoomCode)) {
  rooms.set(globalRoomCode, {
    code: globalRoomCode,
    users: new Set(),
    pixels: {},
    messages: [],
  });
}

// Ana sayfayı sun
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

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

    // IP ban kontrolü
    if (bannedIPs.has(clientIP)) {
      socket.emit("banned", { 
        message: "Bu IP adresi banlanmıştır!", 
        reason: "IP Ban",
        bannedAt: new Date().toLocaleString('tr-TR')
      });
      socket.disconnect();
      return;
    }

    // Kullanıcı ban kontrolü
    if (bannedUsers.has(username)) {
      socket.emit("banned", { 
        message: "Bu hesap banlanmıştır!", 
        reason: "Kullanıcı Ban", 
        bannedAt: new Date().toLocaleString('tr-TR')
      });
      socket.disconnect();
      return;
    }

    console.log(`${username} bağlandı. IP: ${clientIP}, Ban durumu: IP=${bannedIPs.has(clientIP)}, User=${bannedUsers.has(username)}`);

    // IP'yi kaydet
    userIPs.set(username, clientIP);

    let room = rooms.get(roomCode);
    if (!room) {
      // Oda yoksa oluştur
      room = {
        code: roomCode,
        users: new Set(),
        pixels: {},
        messages: [],
      };
      rooms.set(roomCode, room);
    }

    // Aynı kullanıcı adıyla giriş engelleme - tamamen reddet
    if (room.users.has(username)) {
      socket.emit("error", { message: "Bu kullanıcı adı zaten kullanılıyor! Farklı bir isim seçin." });
      return;
    }

    socket.join(roomCode);
    room.users.add(username);
    socket.username = username;
    socket.roomCode = roomCode;

    console.log(`${username} ${roomCode} odasına katıldı`);

    socket.emit("roomJoined", { roomCode });

    // Odadaki diğer kullanıcılara bildir
    socket.to(roomCode).emit("user-joined", { username });

    // Mevcut oda durumunu gönder
    socket.emit("roomState", {
      users: Array.from(room.users),
      pixels: room.pixels,
      message: `${username} odaya katıldı.`,
      isAdmin: loggedInAdmins.has(username)
    });
  });

  socket.on("place-pixel", (data) => {
    const room = rooms.get(data.roomCode);
    if (!room || !room.users.has(data.username)) {
      socket.emit("error", { message: "Oda bulunamadı veya yetkiniz yok!" });
      return;
    }

    // Koordinat kontrolü
    if (data.x < 0 || data.x >= 200 || data.y < 0 || data.y >= 200) {
      socket.emit("error", { message: "Geçersiz koordinat!" });
      return;
    }

    const pixelKey = `${data.x},${data.y}`;
    room.pixels[pixelKey] = data.color;

    console.log(
      `${data.username} (${data.x}, ${data.y}) koordinatına ${data.color} rengini koydu`,
    );

    // Veriyi kaydet
    saveGameData();

    // Tüm oda üyelerine piksel yerleştirme bilgisini gönder
    io.to(data.roomCode).emit("pixel-placed", {
      x: data.x,
      y: data.y,
      color: data.color,
      username: data.username,
    });
  });

  socket.on("send-message", (data) => {
    const room = rooms.get(data.roomCode);
    if (!room || !room.users.has(data.username)) {
      socket.emit("error", { message: "Oda bulunamadı veya yetkiniz yok!" });
      return;
    }

    if (!data.message || data.message.trim().length === 0) {
      return;
    }

    // Admin giriş kontrolü
    if (adminCredentials.has(data.username) && data.message.includes("/login")) {
      // Emoji ve diğer karakterleri temizle, sadece /login ve şifreyi al
      const cleanMessage = data.message.replace(/[^\w\s\/]/g, '').trim();
      const parts = cleanMessage.split(' ');
      
      if (parts.length >= 2 && parts[0] === '/login') {
        const password = parts[1];
        if (adminCredentials.get(data.username) === password) {
          loggedInAdmins.add(data.username);
          socket.emit("chat-message", {
            username: "SİSTEM",
            message: "Admin girişi başarılı! ✅"
          });
          socket.emit("admin-status", { isAdmin: true });
          console.log(`${data.username} admin olarak giriş yaptı`);
          return;
        } else {
          socket.emit("chat-message", {
            username: "SİSTEM", 
            message: "Hatalı şifre! ❌"
          });
          return;
        }
      }
    }

    // Admin komutları kontrolü
    if (loggedInAdmins.has(data.username) && data.message.startsWith("/")) {
      handleAdminCommand(socket, data.message, data.username, data.roomCode);
      return;
    }

    console.log(`${data.username} mesaj gönderdi: ${data.message}`);

    // Mesajı odadaki herkese gönder
    io.to(data.roomCode).emit("chat-message", {
      username: data.username,
      message: data.message,
    });

    // Mesajı oda geçmişine ekle
    room.messages.push({
      username: data.username,
      message: data.message,
      timestamp: Date.now(),
    });

    // Mesaj geçmişini 100 ile sınırla
    if (room.messages.length > 100) {
      room.messages = room.messages.slice(-100);
    }

    // Veriyi kaydet
    saveGameData();
  });

  // Sesli sohbet için WebRTC sinyalleme
  socket.on("voice-offer", (data) => {
    const room = rooms.get(data.roomCode);
    if (!room || !room.users.has(data.fromUser)) {
      return;
    }

    // Hedef kullanıcıya offer'ı ilet
    const targetSocket = findSocketByUsername(data.targetUser, data.roomCode);
    if (targetSocket) {
      targetSocket.emit("voice-offer", {
        offer: data.offer,
        fromUser: data.fromUser,
      });
    }
  });

  socket.on("voice-answer", (data) => {
    const room = rooms.get(data.roomCode);
    if (!room || !room.users.has(data.fromUser)) {
      return;
    }

    // Hedef kullanıcıya answer'ı ilet
    const targetSocket = findSocketByUsername(data.targetUser, data.roomCode);
    if (targetSocket) {
      targetSocket.emit("voice-answer", {
        answer: data.answer,
        fromUser: data.fromUser,
      });
    }
  });

  socket.on("voice-ice-candidate", (data) => {
    const room = rooms.get(data.roomCode);
    if (!room || !room.users.has(data.fromUser)) {
      return;
    }

    // Hedef kullanıcıya ICE candidate'i ilet
    const targetSocket = findSocketByUsername(data.targetUser, data.roomCode);
    if (targetSocket) {
      targetSocket.emit("voice-ice-candidate", {
        candidate: data.candidate,
        fromUser: data.fromUser,
      });
    }
  });

  socket.on("leave-room", (data) => {
    handleUserLeave(socket);
  });

  socket.on("disconnect", () => {
    console.log("Kullanıcı bağlantısı kesildi:", socket.id);
    handleUserLeave(socket);
  });

  function handleUserLeave(socket) {
    if (socket.username && socket.roomCode) {
      const room = rooms.get(socket.roomCode);
      if (room) {
        room.users.delete(socket.username);
        // Admin çıkış yapıldığında admin durumunu temizle
        loggedInAdmins.delete(socket.username);

        console.log(`${socket.username} ${socket.roomCode} odasından ayrıldı`);

        // Odadaki diğer kullanıcılara bildir
        socket.to(socket.roomCode).emit("user-left", {
          username: socket.username,
        });

        // Oda boşsa ve global oda değilse sil
        if (room.users.size === 0 && socket.roomCode !== "global") {
          rooms.delete(socket.roomCode);
          console.log(`${socket.roomCode} odası silindi (boş)`);
        }
      }
    }
  }

  function findSocketByUsername(username, roomCode) {
    const room = io.sockets.adapter.rooms.get(roomCode);
    if (!room) return null;

    for (const socketId of room) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket && socket.username === username) {
        return socket;
      }
    }
    return null;
  }

  // Admin komutları
  function handleAdminCommand(socket, message, adminUsername, roomCode) {
    // Emoji ve özel karakterleri temizle
    const cleanMessage = message.replace(/[^\w\s\/<>]/g, '').trim();
    const args = cleanMessage.split(/\s+/);
    const command = args[0].toLowerCase();

    switch (command) {
      case "/ban":
        if (args[1]) {
          let targetUser = args[1];
          // < > işaretlerini temizle
          targetUser = targetUser.replace(/[<>]/g, '');
          
          // Kullanıcıyı ve IP'sini banla
          bannedUsers.add(targetUser);
          const targetIP = userIPs.get(targetUser);
          if (targetIP) {
            bannedIPs.add(targetIP);
            console.log(`IP ${targetIP} banlandı (kullanıcı: ${targetUser})`);
          }
          
          // Tüm odalardaki hedef kullanıcıyı bul ve at
          Array.from(io.sockets.sockets.values()).forEach(targetSocket => {
            if (targetSocket.username === targetUser) {
              targetSocket.emit("banned", { 
                message: `${adminUsername} tarafından banlandınız!`, 
                reason: "Admin Banı",
                admin: adminUsername,
                bannedAt: new Date().toLocaleString('tr-TR')
              });
              setTimeout(() => {
                targetSocket.disconnect();
              }, 1000); // 1 saniye sonra bağlantıyı kes
            }
          });

          // Kullanıcıyı odadan çıkar
          const room = rooms.get(roomCode);
          if (room) {
            room.users.delete(targetUser);
            userIPs.delete(targetUser);
          }

          io.to(roomCode).emit("chat-message", {
            username: "ADMIN",
            message: `${targetUser} banlandı! 🔨 (IP: ${targetIP || 'bilinmiyor'})`
          });

          console.log(`Admin ${adminUsername} banned ${targetUser} (IP: ${targetIP})`);
        } else {
          socket.emit("chat-message", {
            username: "ADMIN",
            message: "Kullanım: /ban <kullanıcı_adı>"
          });
        }
        break;

      

      case "/clear":
        const room = rooms.get(roomCode);
        if (room) {
          room.pixels = {};
          io.to(roomCode).emit("clear-canvas");
          io.to(roomCode).emit("chat-message", {
            username: "ADMIN",
            message: "Tuval temizlendi."
          });
          saveGameData();
          console.log(`Admin ${adminUsername} cleared canvas`);
        }
        break;

      case "/help":
        socket.emit("chat-message", {
          username: "ADMIN",
          message: "Admin komutları: /ban <kullanıcı>, /clear, /help, /logout"
        });
        break;

      case "/logout":
        loggedInAdmins.delete(adminUsername);
        socket.emit("chat-message", {
          username: "SİSTEM",
          message: "Admin çıkışı yapıldı! 👋"
        });
        socket.emit("admin-status", { isAdmin: false });
        break;

      default:
        socket.emit("chat-message", {
          username: "ADMIN",
          message: `Bilinmeyen komut: ${command}. /help yazarak komutları görebilirsiniz.`
        });
    }
  }
});

// Sunucu durumu kontrolü ve otomatik kaydetme
setInterval(() => {
  console.log(`Aktif odalar: ${rooms.size}`);
  let totalUsers = 0;
  rooms.forEach((room, code) => {
    console.log(`  ${code}: ${room.users.size} kullanıcı`);
    totalUsers += room.users.size;
  });
  console.log(`Toplam kullanıcı: ${totalUsers}`);
  
  // Her dakika veriyi kaydet
  saveGameData();
}, 60000); // Her dakika

server.listen(PORT, () => {
  console.log(`Pikselliyo sunucusu ${PORT} portunda çalışıyor.`);
  console.log(`http://localhost:${PORT} adresinden erişebilirsiniz.`);
});
