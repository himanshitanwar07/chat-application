# ChatApp 💬

Real-time chat app built with **Express + Socket.IO**.

## Run
```bash
npm install
npm start          # or: npm run dev  (auto-restart)
```
Open http://localhost:8080 in two browser tabs and chat.

## Features
- Username login (unique, validated)
- Multiple rooms (#general, #tech, #random) + create your own room
- Online users list and live room counts
- Typing indicators
- Last 50 messages per room saved to `data/messages.json` (survives restarts)
- Private messages: tap a name in the online list (not saved)
- Image sharing: 📎 button or paste an image (auto-resized)
- Join/leave system messages
- Rate limiting (6 msgs / 5 sec), 1000 char limit
- XSS-safe rendering, auto-reconnect + rejoin
- Dark/light theme, emoji picker, mobile responsive
- `/health` endpoint, `PORT` env variable, graceful shutdown

## Structure
```
server.js        backend (Socket.IO events)
data/            saved messages (created automatically)
public/          frontend (index.html, style.css, app.js)
```
