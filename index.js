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

// ─── Supabase Auth State ────────────────────────────────────────────────────

async function useSupabaseAuthState(clientId) {
  const writeData = async (key, data) => {
    const id = `${clientId}:${key}`;
    await supabase.from("whatsapp_sessions").upsert({
      id,
      client_id: clientId,
      key_name: key,
      data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)),
      updated_at: new Date().toISOString(),
    });
  };

  const readData = async (key) => {
    const id = `${clientId}:${key}`;
    const { data: row } = await supabase
      .from("whatsapp_sessions")
      .select("data")
      .eq("id", id)
      .maybeSingle();
    if (!row?.data) return null;
    return JSON.parse(JSON.stringify(row.data), BufferJSON.reviver);
  };

  const removeData = async (key) => {
    const id = `${clientId}:${key}`;
    await supabase.from("whatsapp_sessions").delete().eq("id", id);
  };

  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
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
    saveCreds: async () => {
      await writeData("creds", creds);
    },
  };
}

async function deleteSession(clientId) {
  await supabase.from("whatsapp_sessions").delete().eq("client_id", clientId);
}

// ─── WhatsApp Client ────────────────────────────────────────────────────────

async function startClient(clientId) {
  const { state, saveCreds } = await useSupabaseAuthState(clientId);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = [2, 3000, 1019291584];
  }

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: silentLogger,
    getMessage: async () => { return { conversation: '' }; },
    syncFullHistory: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
  });

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

      if (loggedOut) {
        await deleteSession(clientId);
        console.log(`[${clientId}] Session deleted from Supabase — fresh QR needed`);
        clients.delete(clientId);
      } else if (client?.shouldReconnect) {
        console.log(`[${clientId}] Reconnecting in 5s...`);
        setTimeout(() => startClient(clientId).catch(console.error), 5000);
      } else {
        clients.delete(clientId);
      }
    }
  });
}

// ─── Auto-restore sessions on server start ──────────────────────────────────

async function restoreSessions() {
  const { data } = await supabase
    .from("whatsapp_sessions")
    .select("client_id")
    .eq("key_name", "creds");
  if (data?.length) {
    const ids = [...new Set(data.map(r => r.client_id))];
    console.log(`Restoring ${ids.length} session(s):`, ids);
    for (const id of ids) {
      startClient(id).catch(console.error);
    }
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

app.get("/qr/:clientId", async (req, res) => {
  const { clientId } = req.params;
  const existing = clients.get(clientId);

  if (existing?.status === "connected") {
    return res.json({ status: "connected" });
  }

  if (!existing || existing.status === "disconnected") {
    startClient(clientId).catch(console.error);
  }

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const c = clients.get(clientId);
    if (c?.status === "connected") return res.json({ status: "connected" });
    if (c?.qrDataUrl) return res.json({ status: "qr", qr: c.qrDataUrl });
  }

  res.json({ status: "pending", message: "QR not ready yet — try again in a moment" });
});

app.post("/request-code", async (req, res) => {
  const { clientId, phoneNumber } = req.body || {};
  if (!clientId || !phoneNumber) {
    return res.status(400).json({ error: "clientId and phoneNumber are required" });
  }

  const digits = phoneNumber.replace(/[^0-9]/g, "");

  let client = clients.get(clientId);
  if (!client || client.status === "disconnected") {
    await startClient(clientId);
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 500));
      client = clients.get(clientId);
      if (client?.sock) break;
    }
  }

  client = clients.get(clientId);
  if (!client?.sock) {
    return res.status(503).json({ error: "Session could not be started" });
  }

  if (client.status === "connected") {
    return res.json({ status: "connected" });
  }

  try {
    const code = await client.sock.requestPairingCode(digits);
    console.log(`[${clientId}] Pairing code for ${digits}: ${code}`);
    res.json({ code });
  } catch (err) {
    console.error(`[${clientId}] requestPairingCode error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

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

app.post("/test-list", async (req, res) => {
  const { clientId, phone } = req.body || {};
  const client = clients.get(clientId);
  if (!client || client.status !== "connected") {
    return res.status(503).json({ error: "Not connected" });
  }
  try {
    const digits = phone.replace(/[^0-9]/g, "");
    const jid = `${digits}@s.whatsapp.net`;
    await client.sock.sendMessage(jid, {
      text: `📦 *Order Confirmation*\n\nAssalam o Alaikum! Aapka order *#DWK1237* receive ho gaya hai.\n\n*Order Details:*\nItems: Islamic Wall Frame\nSubtotal: Rs. 3,299\nAddress: Lahore\n\nPlease apna order confirm karein:\n\n✅ Confirm karne ke liye reply karein: *1*\n❌ Cancel karne ke liye reply karein: *2*\n🎁 10% discount ke saath confirm: *3*\n\n_DewareKhas.pk_`
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
    try {
      await client.sock.logout();
    } catch {
      // already disconnected
    }
    clients.delete(clientId);
  }

  await deleteSession(clientId);
  console.log(`[${clientId}] Logged out and session deleted from Supabase`);
  res.json({ success: true, clientId });
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`WhatsApp multi-client server running on port ${PORT}`);
  restoreSessions().catch(console.error);
});