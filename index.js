"use strict";

const express = require("express");
const baileys = require("@whiskeysockets/baileys");
const makeWASocket = baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;
const qrcode = require("qrcode");
const path = require("path");
const fs = require("fs");

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

const PORT = process.env.PORT || 3001;
const SESSIONS_DIR = path.join(__dirname, "sessions");

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Minimal silent logger so Baileys doesn't flood stdout
const silentLogger = {
  level: "silent",
  trace: () => {}, debug: () => {}, info: () => {},
  warn: () => {}, error: console.error,
  child: function () { return this; },
};

// clients: Map<clientId, { sock, status, qrDataUrl, shouldReconnect }>
const clients = new Map();

async function startClient(clientId) {
  const sessionDir = path.join(SESSIONS_DIR, clientId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = [2, 3000, 1019291584]; // fallback version
  }

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: silentLogger,
  });

  // Upsert the client entry
  const existing = clients.get(clientId) || {};
  existing.sock = sock;
  existing.status = "connecting";
  existing.qrDataUrl = null;
  existing.shouldReconnect = true;
  clients.set(clientId, existing);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const client = clients.get(clientId);

    if (qr) {
      try {
        const dataUrl = await qrcode.toDataURL(qr);
        if (client) { client.qrDataUrl = dataUrl; client.status = "qr"; }
        console.log(`[${clientId}] QR ready`);
      } catch (e) {
        console.error(`[${clientId}] QR error:`, e.message);
      }
    }

    if (connection === "open") {
      if (client) { client.status = "connected"; client.qrDataUrl = null; }
      console.log(`[${clientId}] Connected`);
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log(`[${clientId}] Disconnected — code=${code} loggedOut=${loggedOut}`);

      if (client) client.status = "disconnected";

      if (!loggedOut && client?.shouldReconnect) {
        console.log(`[${clientId}] Reconnecting in 3s...`);
        setTimeout(() => startClient(clientId).catch(console.error), 3000);
      } else {
        clients.delete(clientId);
      }
    }
  });
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// GET /qr/:clientId — start session, return QR dataURL or {status:'connected'}
app.get("/qr/:clientId", async (req, res) => {
  const { clientId } = req.params;
  const existing = clients.get(clientId);

  if (existing?.status === "connected") {
    return res.json({ status: "connected" });
  }

  // Start a new session if none is running
  if (!existing || existing.status === "disconnected") {
    startClient(clientId).catch(console.error);
  }

  // Poll up to 10 seconds for QR or connected state
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const c = clients.get(clientId);
    if (c?.status === "connected") return res.json({ status: "connected" });
    if (c?.qrDataUrl) return res.json({ status: "qr", qr: c.qrDataUrl });
  }

  res.json({ status: "pending", message: "QR not ready yet — try again in a moment" });
});

// POST /send — { clientId, phone, message }
app.post("/send", async (req, res) => {
  const { clientId, phone, message } = req.body || {};
  if (!clientId || !phone || !message) {
    return res.status(400).json({ error: "clientId, phone, and message are required" });
  }

  const client = clients.get(clientId);
  if (!client || client.status !== "connected") {
    return res.status(503).json({
      error: "Client not connected",
      status: client?.status || "not_found",
    });
  }

  try {
    const digits = phone.replace(/[^0-9]/g, "");
    const jid = `${digits}@s.whatsapp.net`;
    await client.sock.sendMessage(jid, { text: message });
    res.json({ success: true, to: jid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /status/:clientId
app.get("/status/:clientId", (req, res) => {
  const { clientId } = req.params;
  const client = clients.get(clientId);
  if (!client) return res.json({ status: "not_found", clientId });
  res.json({ status: client.status, clientId });
});

// POST /disconnect/:clientId — logout and delete session
app.post("/disconnect/:clientId", async (req, res) => {
  const { clientId } = req.params;
  const client = clients.get(clientId);

  if (!client) return res.json({ success: true, message: "Session not found" });

  client.shouldReconnect = false;

  try {
    await client.sock.logout();
  } catch {
    // logout may throw if already disconnected; that's fine
  }

  const sessionDir = path.join(SESSIONS_DIR, clientId);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }

  clients.delete(clientId);
  console.log(`[${clientId}] Logged out and session deleted`);
  res.json({ success: true, clientId });
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`WhatsApp multi-client server running on port ${PORT}`);
});
