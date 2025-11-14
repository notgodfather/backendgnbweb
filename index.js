// index.js

require('dotenv').config(); // Load env vars (CASHFREE_CLIENT_ID, CASHFREE_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CASHFREE_ENV, PUBLIC_BASE_URL, CORS_ORIGIN) [web:30]
const express = require('express'); // Express server [web:30]
const axios = require('axios'); // For Cashfree API calls (optional in webhook cross-verify) [web:23]
const cors = require('cors'); // CORS for frontend [web:30]
const crypto = require('crypto'); // HMAC for webhook signature verification [web:21]
const bodyParser = require('body-parser'); // raw body for webhook verification [web:21]
const { createClient } = require('@supabase/supabase-js'); // Supabase server SDK with service role [web:12]

const app = express(); // Create app [web:30]
const PORT = process.env.PORT || 5000; // Default port [web:30]

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
); // Service role; keep on server only as it bypasses RLS [web:12]

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' })); // Allow frontend origin [web:30]

// IMPORTANT: Use raw body ONLY for the webhook route to verify signature reliably [web:21]
app.use('/api/cashfree/webhook', bodyParser.raw({ type: '*/*' })); // Raw bytes required [web:21]

// Other routes parse JSON normally [web:30]
app.use(express.json()); // Standard JSON body parsing [web:30]

// Env and API base config for Cashfree PG v2023-08-01 [web:23]
const isSandbox = process.env.CASHFREE_ENV !== 'production'; // Non-production uses sandbox base URL [web:23]
const BASE_URL = isSandbox ? 'https://sandbox.cashfree.com/pg' : 'https://api.cashfree.com/pg'; // PG base URL [web:23]
const API_VERSION = '2023-08-01'; // Cashfree PG API version [web:23]

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`; // Used for return_url and notify_url [web:23]

// Match client discount logic so stored line-item prices are consistent [web:23]
const FLAT_ITEM_DISCOUNT = 5.0; // Per-item flat discount applied across client/server [web:23]

// Headers for Cashfree PG API calls (client id/secret + version) [web:23]
function authHeaders() {
  return {
    'x-client-id': process.env.CASHFREE_CLIENT_ID,
    'x-client-secret': process.env.CASHFREE_CLIENT_SECRET,
    'x-api-version': API_VERSION,
  }; // Required headers for Cashfree PG REST calls [web:23]
}

// Health check [web:30]
app.get('/health', (_req, res) => res.json({ ok: true, env: isSandbox ? 'sandbox' : 'production' })); // Simple status [web:30]

/**
 * POST /api/create-order
 * Creates a Cashfree order to obtain payment_session_id, then caches a pending snapshot keyed by order_id.
 * The snapshot is used by the webhook to create the order and items idempotently upon SUCCESS. [web:30]
 */
app.post('/api/create-order', async (req, res) => {
  try {
    const { cart, user, amount } = req.body; // Client sends final discounted amount (incl. service charge) and cart lines [web:23]
    if (!user?.uid) return res.status(400).json({ error: 'Missing user info' }); // Validate user context [web:30]
    if (!Array.isArray(cart) || cart.length === 0) return res.status(400).json({ error: 'Cart is empty' }); // Validate cart [web:30]

    const orderAmount = Number(amount); // Final amount as charged at Cashfree [web:23]
    if (isNaN(orderAmount) || orderAmount <= 0) return res.status(400).json({ error: 'Invalid amount' }); // Basic guard [web:30]

    const cashfreeOrderId = 'order_' + Date.now(); // Unique order id to map client/cart to webhook [web:30]

    // Create order in Cashfree to get payment_session_id for checkout [web:23]
    const payload = {
      order_id: cashfreeOrderId,
      order_amount: orderAmount,
      order_currency: 'INR',
      customer_details: {
        customer_id: user.uid,
        customer_name: user.displayName || 'Guest',
        customer_email: user.email || 'noemail@example.com',
        customer_phone: user.phoneNumber || '9999999999',
      },
      order_note: 'College canteen order',
      order_meta: {
        return_url: `${PUBLIC_BASE_URL}/pg/return?order_id={order_id}`,
        notify_url: `${PUBLIC_BASE_URL}/api/cashfree/webhook`,
      },
    }; // order_meta includes notify_url for payment webhooks [web:23]

    const cfResp = await axios.post(`${BASE_URL}/orders`, payload, { headers: authHeaders() }); // POST /pg/orders [web:23]
    const { payment_session_id } = cfResp.data; // Token needed by cashfree.js checkout [web:23]
    if (!payment_session_id) return res.status(500).json({ error: 'No payment_session_id from Cashfree', raw: cfResp.data }); // Defensive check [web:23]

    // Cache a pending snapshot so the webhook can persist items accurately and idempotently [web:30]
    const snapshot = {
      id: cashfreeOrderId,
      user_id: user.uid,
      user_email: user.email || 'noemail@example.com',
      amount: orderAmount,
      cart: cart, // JSONB column holds original line items with catalog ids and prices [web:30]
      created_at: new Date().toISOString(),
    }; // Snapshot links order_id -> user+cart snapshot for webhook consumption [web:30]

    const { error: pendErr } = await supabase.from('pending_orders').upsert([snapshot]); // Upsert by primary key id [web:30]
    if (pendErr) console.error('pending_orders upsert error:', pendErr); // Log but continue; webhook will retry on 500 if needed [web:30]

    // Return to client for cashfree.js checkout [web:23]
    return res.json({
      orderId: cashfreeOrderId,
      paymentSessionId: payment_session_id,
      amount: orderAmount,
      currency: 'INR',
      envMode: isSandbox ? 'sandbox' : 'production',
    }); // Client proceeds to open modal and pay [web:23]
  } catch (error) {
    console.error('Create order error:', error.response?.data || error.message); // Log Cashfree error details [web:23]
    return res.status(500).json({ error: 'Create order failed', details: error.response?.data || error.message }); // 500 on failures [web:30]
  }
});

/**
 * POST /api/cashfree/webhook
 * Cashfree sends payment events here; verify signature, process only SUCCESS, and write orders idempotently. [web:21]
 * Signature: Base64(HMAC_SHA256(timestamp + rawBody, client_secret)) equals x-webhook-signature header. [web:21]
 */
app.post('/api/cashfree/webhook', async (req, res) => {
  try {
    const timestamp = req.header('x-webhook-timestamp'); // Provided by Cashfree [web:21]
    const signature = req.header('x-webhook-signature'); // HMAC signature header [web:21]
    const raw = req.body; // Buffer, not parsed JSON [web:21]
    const payloadStr = raw.toString('utf8'); // Use exact string for HMAC input [web:21]

    // Verify signature per Cashfree docs [web:21]
    const expected = crypto
      .createHmac('sha256', process.env.CASHFREE_CLIENT_SECRET)
      .update(timestamp + payloadStr)
      .digest('base64'); // Generate expected signature [web:21]

    if (!signature || expected !== signature) {
      console.warn('Invalid webhook signature'); // Signature mismatch indicates spoof or wrong secret [web:21]
      return res.status(400).send('Invalid signature'); // Reject without processing [web:21]
    }

    const event = JSON.parse(payloadStr); // Now safe to parse [web:21]
    const data = event.data || {}; // Envelope contains data [web:30]
    const order = data.order || {}; // Order info (order_id, order_amount) [web:30]
    const payment = data.payment || {}; // Payment info (cf_payment_id, payment_status) [web:30]

    const orderId = order.order_id; // Server-chosen id from create-order [web:30]
    const paymentId = String(payment.cf_payment_id || ''); // Unique idempotency key per payment [web:30]
    const payStatus = payment.payment_status; // SUCCESS, PENDING, FAILED, etc. [web:30]

    // Process only terminal success; ignore non-success and still return 200 to stop retries for non-relevant states [web:30]
    if (payStatus !== 'SUCCESS') {
      return res.status(200).send('Ignored non-success'); // No DB write for PENDING/FAILED [web:30]
    }

    // Idempotency: if payment already recorded, exit [web:27]
    const { data: existingPayment } = await supabase
      .from('payments')
      .select('cf_payment_id')
      .eq('cf_payment_id', paymentId)
      .maybeSingle(); // Check for duplicate webhook deliveries [web:27]

    if (existingPayment) {
      return res.status(200).send('Duplicate payment ignored'); // Safe to ack duplicate without rewrites [web:27]
    }

    // Persist payment ledger first to prevent double work on retries [web:27]
    const payRow = {
      cf_payment_id: paymentId,
      order_id: orderId,
      amount: Number(payment.payment_amount || order.order_amount || 0),
      status: 'SUCCESS',
      payload: event,
    }; // Store full payload for audit/reconciliation [web:27]

    const { error: payErr } = await supabase.from('payments').insert([payRow]); // Insert unique cf_payment_id [web:27]
    if (payErr) {
      console.error('payments insert error:', payErr); // Insert failed; request retry from Cashfree [web:27]
      return res.status(500).send('Payments insert failed'); // Trigger webhook retry [web:27]
    }

    // If order already exists, stop (idempotent success) [web:27]
    const { data: existingOrder } = await supabase
      .from('orders')
      .select('id')
      .eq('id', orderId)
      .maybeSingle(); // Primary key guard [web:27]

    if (existingOrder) {
      return res.status(200).send('Order already exists'); // Ack without duplicating items [web:27]
    }

    // Load pending snapshot to reconstruct order lines [web:30]
    const { data: pending, error: pendGetErr } = await supabase
      .from('pending_orders')
      .select('*')
      .eq('id', orderId)
      .maybeSingle(); // Snapshot created at /api/create-order [web:30]

    if (pendGetErr) {
      console.error('pending_orders fetch error:', pendGetErr); // Transient DB issue; retry webhook later [web:30]
      return res.status(500).send('Pending fetch failed'); // Keep Cashfree retrying [web:30]
    }
    if (!pending) {
      console.error('No pending snapshot for', orderId); // Missing cache; choose to retry to allow eventual consistency [web:30]
      return res.status(500).send('No pending snapshot'); // 500 so Cashfree retries [web:30]
    }

    // Insert order header [web:30]
    const { error: orderErr } = await supabase.from('orders').insert([{
      id: pending.id,
      user_id: pending.user_id,
      user_email: pending.user_email,
      status: 'Preparing',
      created_at: new Date().toISOString(),
    }]); // Store initial status; kitchen can update later [web:30]

    if (orderErr) {
      console.error('orders insert error:', orderErr); // Failure writing order header [web:30]
      return res.status(500).send('Order insert failed'); // Retry webhook [web:30]
    }

    // Insert order items with consistent discount logic [web:23]
    const cart = pending.cart || []; // Each has ci.item.id, ci.item.price, ci.qty [web:30]
    const itemsPayload = cart.map((ci) => ({
      order_id: pending.id,
      item_id: ci.item.id,
      qty: ci.qty,
      price: Math.max(0, Number(ci.item.price) - FLAT_ITEM_DISCOUNT),
    })); // Persist per-line final unit price after discount [web:23]

    const { error: itemsErr } = await supabase.from('order_items').insert(itemsPayload); // Bulk insert items [web:30]
    if (itemsErr) {
      console.error('order_items insert error:', itemsErr); // Failure writing items [web:30]
      return res.status(500).send('Order items insert failed'); // Retry webhook [web:30]
    }

    // Cleanup pending snapshot once order is recorded [web:30]
    await supabase.from('pending_orders').delete().eq('id', pending.id); // Remove cache row [web:30]

    return res.status(200).send('OK'); // Success; Cashfree stops retrying [web:30]
  } catch (e) {
    console.error('Webhook error:', e); // Unexpected error path [web:30]
    return res.status(500).send('Failed'); // Ask Cashfree to retry [web:30]
  }
});

/**
 * Optional: lightweight order existence check for client polling after checkout.
 * The client can poll this or query Supabase directly to clear the cart after the webhook writes the order. [web:12]
 */
app.get('/api/orders/:id', async (req, res) => {
  const id = req.params.id; // order_id from create-order [web:30]
  const { data, error } = await supabase
    .from('orders')
    .select('id,status')
    .eq('id', id)
    .maybeSingle(); // Return minimal info [web:12]

  if (error) return res.status(500).json({ error: error.message }); // Propagate server error [web:12]
  return res.json({ exists: !!data, status: data?.status || null }); // For client polling UI [web:12]
});

// Start server [web:30]
app.listen(PORT, () => console.log(`Server running at port ${PORT}`)); // Listen on PORT [web:30]
