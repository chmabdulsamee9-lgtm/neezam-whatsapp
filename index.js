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
  if (error) console.error(`[${clientId}] SESSION DELETE ERROR:`, error.message);
}

// ─── Order confirmation flow state ─────────────────────────────────────────
// phone -> { orderId, orderNo, stage: 'confirm' | 'discount', clientId }
const pendingOrders = new Map();

// ─── Send order confirmation ────────────────────────────────────────────────

async function sendOrderConfirmation(sock, jid, order) {
  const { orderNo, name, items, subtotal, address, city } = order;
  try {
    await sock.sendMessage(jid, {
      listMessage: {
        title: "📦 Order Confirmation",
        text: `Thank you for your order from Dewarekhas.pk. This is a confirmation message.\n\nOrder Details:\n\nOrder Number: #${orderNo}\nItems: ${items}\nSubtotal: ${subtotal}\n\nAddress: ${address}\nCity: ${city}\n\nPlease confirm your order.`,
        footerText: "DewareKhas.pk",
        buttonText: "Select one",
        sections: [{
          rows: [
            { title: "✅ Yes, Confirm ✅", rowId: "confirm" },
            { title: "❌ No, Cancel ❌", rowId: "cancel" },
          ]
        }]
      }
    });
  } catch (e) {
    // listMessage failed — fallback to text + poll
    console.log(`[listMessage failed] Falling back to poll`);
    await sock.sendMessage(jid, {
      text: `📦 *Order Confirmation*\n\nThank you for your order from *Dewarekhas.pk*.\n\nOrder Number: *#${orderNo}*\nItems: ${items}\nSubtotal: ${subtotal}\nAddress: ${address}, ${city}\n\nPlease confirm your order.`
    });
    await new Promise(r => setTimeout(r, 800));
    await sock.sendMessage(jid, {
      poll: {
        name: "Please confirm your order:",
        values: ["✅ Yes, Confirm ✅", "❌ No, Cancel ❌"],
        selectableCount: 1,
      }
    });
  }
}

async function sendDiscountOffer(sock, jid, order) {
  const { orderNo, subtotal } = order;
  const discountedPrice = Math.round(Number(subtotal) * 0.9);
  try {
    await sock.sendMessage(jid, {
      listMessage: {
        title: "🎁 Special Discount Offer!",
        text: `Aapka order cancel karne se pehle — hum aapko *10% discount* offer karte hain!\n\nOrder: #${orderNo}\nOriginal Price: Rs. ${subtotal}\nDiscounted Price: *Rs. ${discountedPrice}*\n\nKya aap discount ke saath confirm karna chahte hain?`,
        footerText: "DewareKhas.pk",
        buttonText: "Select one",
        sections: [{
          rows: [
            { title: "✅ Yes, 10% Discount Ke Saath Confirm", rowId: "discount_confirm" },
            { title: "❌ No, Cancel Karo", rowId: "discount_cancel" },
          ]
        }]
      }
    });
  } catch (e) {
    await sock.sendMessage(jid, {
      text: `🎁 *Special Discount Offer!*\n\nAapka order cancel karne se pehle — hum aapko *10% discount* offer karte hain!\n\nOrder: *#${orderNo}*\nOriginal Price: Rs. ${subtotal}\nDiscounted Price: *Rs. ${discountedPrice}*`
    });
    await new Promise(r => setTimeout(r, 800));
    await sock.sendMessage(jid, {
      poll: {
        name: "Discount ke saath confirm karein?",
        values: ["✅ Yes, 10% Discount Ke Saath Confirm", "❌ No, Cancel Karo"],
        selectableCount: 1,
      }
    });
  }
}

// ─── WhatsApp Client ────────────────────────────────────────────────────────

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
        } else if (client?.shouldReconnect && !client.reconnectTimer) {
          client.reconnectTimer = setTimeout(() => {
            const c = clients.get(clientId);
            if (c) c.reconnectTimer = null;
            startClient(clientId).catch(console.error);
          }, 5000);
        }
      }
    });

    // ─── Incoming message handler ───────────────────────────────────────
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        const phone = jid.replace("@s.whatsapp.net", "");

        // List response
        const listReply = msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId;
        // Poll response
        const pollVote = msg.message?.pollUpdateMessage;

        const response = listReply || (pollVote ? "poll" : null);
        const pending = pendingOrders.get(phone);

        if (!pending || pending.clientId !== clientId) continue;

        if (pending.stage === "confirm") {
          if (listReply === "confirm") {
            // Confirmed
            pendingOrders.delete(phone);
            await sock.sendMessage(jid, {
              text: `✅ *Shukriya!* Aapka order *#${pending.orderNo}* confirm ho gaya hai!\n\nHum jald hi aapka order dispatch karenge. 🚀\n\n_DewareKhas.pk_`
            });
            // Update Supabase
            await supabase.from("order_statuses").upsert(
              { order_id: String(pending.orderId), status: "Approved", updated_at: new Date().toISOString() },
              { onConflict: "order_id" }
            );
            console.log(`[${clientId}] Order ${pending.orderNo} CONFIRMED`);
          } else if (listReply === "cancel") {
            // Offer discount
            pending.stage = "discount";
            pendingOrders.set(phone, pending);
            await sendDiscountOffer(sock, jid, pending);
          }
        } else if (pending.stage === "discount") {
          if (listReply === "discount_confirm") {
            // Confirmed with discount
            pendingOrders.delete(phone);
            const discountedPrice = Math.round(Number(pending.subtotal) * 0.9);
            const discountAmount = Number(pending.subtotal) - discountedPrice;
            await sock.sendMessage(jid, {
              text: `🎉 *Zabardast!* Aapka order *#${pending.orderNo}* 10% discount ke saath confirm ho gaya!\n\nDiscount: Rs. ${discountAmount}\nFinal Price: *Rs. ${discountedPrice}*\n\nHum jald dispatch karenge! 🚀\n\n_DewareKhas.pk_`
            });
            // Update Supabase — Approved + discount
            await supabase.from("order_statuses").upsert(
              {
                order_id: String(pending.orderId),
                status: "Approved",
                discount: String(discountAmount),
                updated_at: new Date().toISOString()
              },
              { onConflict: "order_id" }
            );
            console.log(`[${clientId}] Order ${pending.orderNo} CONFIRMED with 10% discount`);
          } else if (listReply === "discount_cancel") {
            // Cancelled
            pendingOrders.delete(phone);
            await sock.sendMessage(jid, {
              text: `😔 Aapka order *#${pending.orderNo}* cancel ho gaya hai.\n\nAgar kabhi zaroorat ho to dobara order karein.\n\n_DewareKhas.pk_`
            });
            // Update Supabase
            await supabase.from("order_statuses").upsert(
              { order_id: String(pending.orderId), status: "Cancelled", updated_at: new Date().toISOString() },
              { onConflict: "order_id" }
            );
            console.log(`[${clientId}] Order ${pending.orderNo} CANCELLED`);
          }
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

// ─── Auto-restore sessions ───────────────────────────────────────────────────

async function restoreSessions() {
  const { data, error } = await supabase.from("whatsapp_sessions").select("client_id").eq("key_name", "creds");
  if (error) { console.error("Restore error:", error.message); return; }
  if (data?.length) {
    const ids = [...new Set(data.map(r => r.client_id))];
    console.log(`Restoring ${ids.length} session(s):`, ids);
    for (const id of ids) startClient(id).catch(console.error);
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

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
  res.json({ status: "pending", message: "QR not ready yet" });
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
  if (!client || client.status !== "connected") return res.status(503).json({ error: "Not connected" });
  try {
    const digits = phone.replace(/[^0-9]/g, "");
    const jid = `${digits}@s.whatsapp.net`;
    await client.sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send order confirmation — full flow
app.post("/send-confirmation", async (req, res) => {
  const { clientId, phone, orderId, orderNo, name, items, subtotal, address, city } = req.body || {};
  if (!clientId || !phone || !orderId) return res.status(400).json({ error: "clientId, phone, orderId required" });
  const client = clients.get(clientId);
  if (!client || client.status !== "connected") return res.status(503).json({ error: "Not connected" });
  try {
    const digits = phone.replace(/[^0-9]/g, "");
    const jid = `${digits}@s.whatsapp.net`;
    const order = { orderId, orderNo, name, items, subtotal, address, city, clientId };
    pendingOrders.set(digits, { ...order, stage: "confirm" });
    await sendOrderConfirmation(client.sock, jid, order);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test route
app.post("/test-list", async (req, res) => {
  const { clientId, phone } = req.body || {};
  const client = clients.get(clientId);
  if (!client || client.status !== "connected") return res.status(503).json({ error: "Not connected" });
  try {
    const digits = phone.replace(/[^0-9]/g, "");
    const jid = `${digits}@s.whatsapp.net`;
    const order = {
      orderId: "test123",
      orderNo: "DWK1237",
      name: "Test Customer",
      items: "Islamic Wall Frame × 1",
      subtotal: "3299",
      address: "Office no s8 distic council plaza chakwal",
      city: "Chakwal",
      clientId,
    };
    pendingOrders.set(digits, { ...order, stage: "confirm" });
    await sendOrderConfirmation(client.sock, jid, order);
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

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`WhatsApp multi-client server running on port ${PORT}`);
  restoreSessions().catch(console.error);
});