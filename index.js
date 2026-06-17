"use strict";

const express = require("express");
const baileys = require("@whiskeysockets/baileys");
const makeWASocket = baileys.default;
const { DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON, proto } = baileys;
const qrcode = require("qrcode");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = "https://zrdmzmhogykhtrvjdqko.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpyZG16bWhvZ3lraHRydmpkcWtvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3MzY0MDksImV4cCI6MjA5NjMxMjQwOX0.gXBNEkD4q40fpc8zjQdh9GCgqJD4S8bpI2xUx2rcPEQ";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

const PORT = process.env.PORT || 3001;

const silentLogger = {
  level: "silent",
  trace: () => {}, debug: () => {}, info: () => {},
  warn: () => {}, error: console.error,
  child: function () { return this; },
};

const clients = new Map();

async function useSupabaseAuthState(clientId) {
  const writeData = async (key, data) => {
    const id = `${clientId}:${key}`;
    const { error } = await supabase.from("whatsapp_sessions").upsert({
      id, client_id: clientId, key_name: key,
      data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)),
      updated_at: new Date().toISOString(),
    });
    if (error) console.error(`[${clientId}] Supabase WRITE ERROR (${key}):`, error.message);
  };

  const readData = async (key) => {
    const id = `${clientId}:${key}`;
    const { data: row, error } = await supabase.from("whatsapp_sessions").select("data").eq("id", id).maybeSingle();
    if (error) console.error(`[${clientId}] Supabase READ ERROR (${key}):`, error.message);
    if (!row?.data) return null;
    return JSON.parse(JSON.stringify(row.data), BufferJSON.reviver);
  };

  const removeData = async (key) => {
    const id = `${clientId}:${key}`;
    const { error } = await supabase.from("whatsapp_sessions").delete().eq("id", id);
    if (error) console.error(`[${clientId}] Supabase DELETE ERROR (${key}):`, error.message);
  };

  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}`);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => { await writeData("creds", creds); },
  };
}

async function deleteSession(clientId) {
  const { error } = await supabase.from("whatsapp_sessions").delete().eq("client_id", clientId);
  if (error) console.error(`[${clientId}] Supabase SESSION DELETE ERROR:`, error.message);
}

async function startClient(clientId) {
  const existing = clients.get(clientId);
  if (existing?.starting) { console.log(`[${clientId}] Already starting — skip`); return; }
  if (existing?.status === "connected") { console.log(`[${clientId}] Already connected — skip`); return; }
  if (existing?.sock) { try { existing.sock.end(); } catch {} }
  if (existing?.reconnectTimer) { clearTimeout(existing.reconnectTimer); }

  const entry = existing || {};
  entry.starting = true;
  entry.status = "connecting";
  entry.qrDataUrl = null;
  entry.shouldReconnect = true;
  entry.reconnectTimer = null;
  clients.set(clientId, entry);

  try {
    const { state, saveCreds } = await useSupabaseAuthState(clientId);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { version = [2, 3000, 1019291584]; }

    const sock = makeWASocket({
      version, auth: state, printQRInTerminal: false, logger: silentLogger,
      getMessage: async () => { return { conversation: '' }; },
      syncFullHistory: false, markOnlineOnConnect: false,
      connectTimeoutMs: 60000, keepAliveIntervalMs: 30000,
    });

    entry.sock = sock;
    entry.starting = false;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      const client = clients.get(clientId);
      if (client?.sock !== sock) return;

      if (qr) {
        try {
          const dataUrl = await qrcode.toDataURL(qr);
          if (client) { client.qrDataUrl = dataUrl; client.status = "qr"; }
          console.log(`[${clientId}] QR ready`);
        } catch (e) { console.error(`[${clientId}] QR error:`, e.message); }
      }

      if (connection === "open") {
        if (client) { client.status = "connected"; client.qrDataUrl = null; }
        console.log(`[${clientId}] Connected ✅`);
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        console.log(`[${clientId}] Disconnected — code=${code} loggedOut=${loggedOut}`);
        if (client) client.status = "disconnected";

        if (loggedOut) {
          await deleteSession(clientId);
          clients.delete(clientId);
          console.log(`[${clientId}] Session deleted — fresh QR needed`);
        } else if (client?.shouldReconnect && !client.reconnectTimer) {
          client.reconnectTimer = setTimeout(() => {
            const c = clients.get(clientId);
            if (c) c.reconnectTimer = null;
            startClient(clientId).catch(console.error);
          }, 5000);
        }
      }
    });

    // Listen for incoming messages (replies)
    sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
        const from = msg.key.remoteJid;
        console.log(`[${clientId}] Message from ${from}: ${text}`);
        // Store reply in Supabase for ERP to read
        if (text === "1" || text === "2" || text === "3") {
          await supabase.from("whatsapp_replies").upsert({
            client_id: clientId,
            phone: from.replace("@s.whatsapp.net", ""),
            reply: text,
            received_at: new Date().toISOString(),
          }, { onConflict: "client_id,phone" });
        }
      }
    });

  } catch (err) {
    entry.starting = false;
    entry.status = "disconnected";
    console.error(`[${clientId}] startClient error:`, err.message);
    throw err;
  }
}

async function restoreSessions() {
  const { data, error } = await supabase.from("whatsapp_sessions").select("client_id").eq("key_name", "creds");
  if (error) { console.error("Restore sessions error:", error.message); return; }
  if (data?.length) {
    const ids = [...new Set(data.map(r => r.client_id))];
    console.log(`Restoring ${ids.length} session(s):`, ids);
    for (const id of ids) startClient(id).catch(console.error);
  } else {
    console.log("No saved sessions found");
  }
}

app.get("/qr/:clientId", async (req, res) => {
  const { clientId } = req.params;
  const existing = clients.get(clientId);
  if (existing?.status === "connected") return res.json({ status: "connected" });
  if (!existing || (existing.status === "disconnected" && !existing.starting && !existing.reconnectTimer)) {
    startClient(clientId).catch(console.error);
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const c = clients.get(clientId);
    if (c?.status === "connected") return res.json({ status: "connected" });
    if (c?.qrDataUrl) return res.json({ status: "qr", qr: c.qrDataUrl });
  }
  res.json({ status: "pending", message: "QR not ready yet — try again" });
});

app.post("/request-code", async (req, res) => {
  const { clientId, phoneNumber } = req.body || {};
  if (!clientId || !phoneNumber) return res.status(400).json({ error: "clientId and phoneNumber are required" });
  const digits = phoneNumber.replace(/[^0-9]/g, "");
  let client = clients.get(clientId);
  if (!client || (client.status === "disconnected" && !client.starting)) {
    await startClient(clientId);
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 500));
      client = clients.get(clientId);
      if (client?.sock) break;
    }
  }
  client = clients.get(clientId);
  if (!client?.sock) return res.status(503).json({ error: "Session could not be started" });
  if (client.status === "connected") return res.json({ status: "connected" });
  try {
    const code = await client.sock.requestPairingCode(digits);
    res.json({ code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/send", async (req, res) => {
  const { clientId, phone, message } = req.body || {};
  if (!clientId || !phone || !message) return res.status(400).json({ error: "clientId, phone, and message are required" });
  const client = clients.get(clientId);
  if (!client || client.status !== "connected") return res.status(503).json({ error: "Client not connected", status: client?.status || "not_found" });
  try {
    const digits = phone.replace(/[^0-9]/g, "");
    const jid = `${digits}@s.whatsapp.net`;
    await client.sock.sendMessage(jid, { text: message });
    res.json({ success: true, to: jid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/test-list", async (req, res) => {
  const { clientId, phone } = req.body || {};
  const client = clients.get(clientId);
  if (!client || client.status !== "connected") return res.status(503).json({ error: "Not connected", status: client?.status || "not_found" });
  try {
    const digits = phone.replace(/[^0-9]/g, "");
    const jid = `${digits}@s.whatsapp.net`;
    await client.sock.sendMessage(jid, {
      poll: {
        name: "📦 Order #DWK1237 Confirm karein",
        values: ["✅ Yes, Confirm", "❌ No, Cancel", "🎁 10% Discount Le Aur Confirm"],
        selectableCount: 1,
      }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/status/:clientId", (req, res) => {
  const { clientId } = req.params;
  const client = clients.get(clientId);
  if (!client) return res.json({ status: "not_found", clientId });
  res.json({ status: client.status, clientId });
});

app.post("/disconnect/:clientId", async (req, res) => {
  const { clientId } = req.params;
  const client = clients.get(clientId);
  if (client) {
    client.shouldReconnect = false;
    if (client.reconnectTimer) clearTimeout(client.reconnectTimer);
    try { await client.sock.logout(); } catch {}
    clients.delete(clientId);
  }
  await deleteSession(clientId);
  res.json({ success: true, clientId });
});

app.listen(PORT, () => {
  console.log(`WhatsApp multi-client server running on port ${PORT}`);
  restoreSessions().catch(console.error);
});