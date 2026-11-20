(() => {
  const $ = (id) => document.getElementById(id);
  const socket = io({ transports: ["websocket", "polling"] });

  const state = {
    username: null,
    room: null,
    roomMsgs: [],            // messages of the current room
    rooms: [],               // [{name, count}]
    onlineUsers: [],
    dms: new Map(),          // username -> { messages: [], unread: 0 }
    view: { type: "room" },  // or { type: "dm", with: "name" }
    lastUser: null,
    typingTimer: null,
    isTyping: false,
    pendingImage: null,
  };
  const DEFAULT_ROOMS = ["general", "tech", "random"];
  const EMOJIS = ["😀","😂","😍","😎","🤔","😢","😡","👍","👎","🙏","🎉","🔥","❤️","💯","👀","✅"];

  // ---------- helpers ----------
  const colorFor = (name) => {
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `hsl(${h} 55% 48%)`;
  };
  const avatar = (name) => {
    const el = document.createElement("span");
    el.className = "avatar";
    el.style.background = colorFor(name);
    el.textContent = name[0].toUpperCase();
    return el;
  };
  const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const toast = (text) => {
    const t = $("toast");
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove("show"), 2200);
  };
  const scrollDown = () => { const m = $("messages"); m.scrollTop = m.scrollHeight; };
  const isDm = () => state.view.type === "dm";
  const dmThread = (name) => {
    if (!state.dms.has(name)) state.dms.set(name, { messages: [], unread: 0 });
    return state.dms.get(name);
  };

  // ---------- theme ----------
  const savedTheme = localStorage.getItem("theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = savedTheme;
  $("themeBtn").onclick = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
  };

  // ---------- login ----------
  $("roomSelect").innerHTML = DEFAULT_ROOMS.map((r) => `<option value="${r}">#${r}</option>`).join("");
  $("usernameInput").value = localStorage.getItem("username") || "";

  $("loginForm").addEventListener("submit", (e) => {
    e.preventDefault();
    join($("usernameInput").value, $("roomSelect").value);
  });

  function join(username, room) {
    $("loginError").textContent = "";
    socket.emit("join", { username, room }, (res) => {
      if (!res.ok) { $("loginError").textContent = res.error; return; }
      localStorage.setItem("username", res.username);
      state.username = res.username;
      $("login").classList.add("hidden");
      $("app").classList.remove("hidden");
      $("meName").textContent = res.username;
      $("meAvatar").replaceWith(Object.assign(avatar(res.username), { id: "meAvatar" }));
      enterRoom(res);
      input.focus();
    });
  }

  function enterRoom({ room, history, users, rooms }) {
    state.room = room;
    state.roomMsgs = history.slice();
    state.rooms = rooms;
    state.onlineUsers = users;
    state.view = { type: "room" };
    $("usersRoom").textContent = "#" + room;
    $("typing").textContent = "";
    refresh();
    $("sidebar").classList.remove("open");
  }

  // ---------- rendering ----------
  function refresh() {
    renderView();
    renderRooms();
    renderDms();
    renderUsers();
  }

  function renderView() {
    const box = $("messages");
    box.innerHTML = "";
    state.lastUser = null;
    const list = isDm() ? dmThread(state.view.with).messages : state.roomMsgs;
    list.forEach(renderMessage);
    $("chatTitle").textContent = isDm() ? "@ " + state.view.with : "# " + state.room;
    input.placeholder = isDm() ? `Message ${state.view.with} privately…` : "Type a message…";
    $("typing").textContent = "";
    scrollDown();
  }

  function renderMessage(msg) {
    const box = $("messages");
    if (msg.type === "system") {
      const s = document.createElement("div");
      s.className = "system";
      s.textContent = msg.text;
      box.appendChild(s);
      state.lastUser = null;
      return;
    }
    const mine = msg.username === state.username;
    const first = state.lastUser !== msg.username;
    state.lastUser = msg.username;

    const row = document.createElement("div");
    row.className = "msg" + (mine ? " mine" : "") + (first ? " first" : "");

    if (!mine) {
      if (first) row.appendChild(avatar(msg.username));
      else { const sp = document.createElement("span"); sp.className = "spacer"; row.appendChild(sp); }
    }

    const body = document.createElement("div");
    if (first) {
      const meta = document.createElement("div");
      meta.className = "meta";
      const b = document.createElement("b");
      b.textContent = mine ? "You" : msg.username;
      meta.append(b, " · " + fmtTime(msg.time));
      body.appendChild(meta);
    }
    const bubble = document.createElement("div");
    bubble.className = "bubble" + (msg.image ? " has-img" : "");
    if (msg.image) {
      const img = document.createElement("img");
      img.className = "chat-img";
      img.alt = "Shared image";
      img.src = msg.image; // server only accepts data:image/png|jpeg|webp|gif
      img.onload = () => { if (nearBottom()) scrollDown(); };
      img.onclick = () => { $("lightboxImg").src = msg.image; $("lightbox").classList.remove("hidden"); };
      bubble.appendChild(img);
    }
    if (msg.text) {
      const t = document.createElement("div");
      t.className = msg.image ? "caption" : "";
      t.textContent = msg.text; // textContent → safe from XSS
      bubble.appendChild(t);
    }
    bubble.title = fmtTime(msg.time);
    body.appendChild(bubble);
    row.appendChild(body);
    box.appendChild(row);
  }

  const nearBottom = () => {
    const m = $("messages");
    return m.scrollHeight - m.scrollTop - m.clientHeight < 160;
  };

  function renderUsers() {
    const users = state.onlineUsers;
    $("userCount").textContent = users.length;
    const ul = $("userList");
    ul.innerHTML = "";
    users.forEach((u) => {
      const li = document.createElement("li");
      const self = u === state.username;
      if (self) li.className = "self";
      else { li.title = "Message privately"; li.onclick = () => openDm(u); }
      li.append(avatar(u), u + (self ? " (you)" : ""));
      ul.appendChild(li);
    });
  }

  function renderRooms() {
    const ul = $("roomList");
    ul.innerHTML = "";
    state.rooms.forEach(({ name, count }) => {
      const li = document.createElement("li");
      li.className = !isDm() && name === state.room ? "active" : "";
      li.append("# " + name);
      const c = document.createElement("span");
      c.className = "count";
      c.textContent = count;
      li.appendChild(c);
      li.onclick = () => switchRoom(name);
      ul.appendChild(li);
    });
  }

  function renderDms() {
    const ul = $("dmList");
    ul.innerHTML = "";
    $("dmHeader").classList.toggle("hidden", state.dms.size === 0);
    state.dms.forEach((thread, name) => {
      const li = document.createElement("li");
      li.className = isDm() && state.view.with === name ? "active" : "";
      li.append(avatar(name), name);
      if (thread.unread > 0) {
        const b = document.createElement("span");
        b.className = "badge";
        b.textContent = thread.unread;
        li.appendChild(b);
      }
      li.onclick = () => openDm(name);
      ul.appendChild(li);
    });
  }

  // ---------- navigation ----------
  function openDm(name) {
    if (name === state.username) return;
    dmThread(name).unread = 0;
    state.view = { type: "dm", with: name };
    stopTyping();
    refresh();
    $("sidebar").classList.remove("open");
    input.focus();
  }

  function switchRoom(name) {
    if (name === state.room) {
      if (isDm()) { state.view = { type: "room" }; refresh(); }
      $("sidebar").classList.remove("open");
      return;
    }
    socket.emit("switch_room", name, (res) => {
      if (!res.ok) return toast(res.error);
      enterRoom(res);
    });
  }

  // ---------- sending ----------
  const input = $("messageInput");

  function send() {
    const text = input.value.trim();
    const image = state.pendingImage;
    if (!text && !image) return;

    const done = (res) => {
      if (res.ok) return;
      toast(res.error);
      if (!input.value) input.value = text; // give the text back so nothing is lost
      if (!state.pendingImage) { state.pendingImage = image; renderPreview(); }
      autoGrow();
    };
    if (isDm()) socket.emit("private", { to: state.view.with, text, image }, done);
    else socket.emit("message", { text, image }, done);

    input.value = "";
    state.pendingImage = null;
    renderPreview();
    autoGrow();
    stopTyping();
  }
  $("messageForm").addEventListener("submit", (e) => { e.preventDefault(); send(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  const autoGrow = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 130) + "px"; };
  input.addEventListener("input", () => {
    autoGrow();
    if (isDm()) return; // no typing indicator in private chats
    if (!state.isTyping) { state.isTyping = true; socket.emit("typing", true); }
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(stopTyping, 1500);
  });
  function stopTyping() {
    clearTimeout(state.typingTimer);
    if (state.isTyping) { state.isTyping = false; socket.emit("typing", false); }
  }

  // ---------- images ----------
  $("attachBtn").onclick = () => $("fileInput").click();
  $("fileInput").onchange = (e) => { loadImageFile(e.target.files[0]); e.target.value = ""; };
  input.addEventListener("paste", (e) => {
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
    if (file) { e.preventDefault(); loadImageFile(file); }
  });
  $("previewRemove").onclick = () => { state.pendingImage = null; renderPreview(); };

  function renderPreview() {
    $("preview").classList.toggle("hidden", !state.pendingImage);
    if (state.pendingImage) $("previewImg").src = state.pendingImage;
  }

  // Resize + compress in the browser so uploads stay small (max ~450 KB)
  function loadImageFile(file) {
    if (!file || !file.type.startsWith("image/")) return toast("Please choose an image");
    if (file.size > 20e6) return toast("Image is too large");
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let scale = Math.min(1, 1280 / Math.max(img.width, img.height));
      let quality = 0.82, data = "";
      for (let i = 0; i < 6; i++) {
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        data = c.toDataURL("image/jpeg", quality);
        if (data.length <= 550000) break;
        scale *= 0.75;
        quality = Math.max(0.6, quality - 0.05);
      }
      if (data.length > 600000) return toast("Image is too large");
      state.pendingImage = data;
      renderPreview();
      input.focus();
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast("Could not read that image"); };
    img.src = url;
  }

  $("lightbox").onclick = () => $("lightbox").classList.add("hidden");
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("lightbox").classList.add("hidden"); });

  // ---------- new room / menu / emoji ----------
  $("newRoomForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("newRoomInput").value.trim();
    if (name) switchRoom(name);
    $("newRoomInput").value = "";
  });
  $("menuBtn").onclick = () => $("sidebar").classList.toggle("open");
  $("messages").onclick = () => { $("sidebar").classList.remove("open"); $("emojiPanel").classList.add("hidden"); };

  $("emojiPanel").innerHTML = EMOJIS.map((e) => `<button type="button">${e}</button>`).join("");
  $("emojiBtn").onclick = () => $("emojiPanel").classList.toggle("hidden");
  $("emojiPanel").onclick = (e) => {
    if (e.target.tagName !== "BUTTON") return;
    input.value += e.target.textContent;
    input.focus();
  };

  // ---------- socket events ----------
  socket.on("message", (msg) => {
    if (msg.room !== state.room) return;
    state.roomMsgs.push(msg);
    if (state.roomMsgs.length > 200) state.roomMsgs.shift();
    if (isDm()) return; // shown when the user returns to the room
    const stick = nearBottom() || msg.username === state.username;
    renderMessage(msg);
    if (stick) scrollDown();
  });

  socket.on("private", (m) => {
    const other = m.from === state.username ? m.to : m.from;
    const thread = dmThread(other);
    const msg = { type: "chat", username: m.from, text: m.text, image: m.image, time: m.time };
    thread.messages.push(msg);
    if (isDm() && state.view.with === other) {
      const stick = nearBottom() || m.from === state.username;
      renderMessage(msg);
      if (stick) scrollDown();
    } else if (m.from !== state.username) {
      thread.unread++;
      toast(`New message from ${m.from}`);
    }
    renderDms();
  });

  socket.on("users", ({ room, users }) => {
    if (room !== state.room) return;
    state.onlineUsers = users;
    renderUsers();
  });
  socket.on("rooms", (rooms) => { state.rooms = rooms; renderRooms(); });
  socket.on("typing", ({ room, users }) => {
    if (room !== state.room || isDm()) return;
    const others = users.filter((u) => u !== state.username);
    $("typing").textContent =
      others.length === 0 ? "" :
      others.length === 1 ? `${others[0]} is typing…` :
      others.length === 2 ? `${others[0]} and ${others[1]} are typing…` : "Several people are typing…";
  });

  // ---------- connection status / auto-rejoin ----------
  socket.on("connect", () => {
    $("status").classList.remove("offline");
    // After a reconnect the server has forgotten us → rejoin same room
    if (state.username) join(state.username, state.room);
  });
  socket.on("disconnect", () => { $("status").classList.add("offline"); toast("Disconnected — reconnecting…"); });
})();
