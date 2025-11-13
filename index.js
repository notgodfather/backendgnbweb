// index.js — Cashfree PG webhook-hardened backend
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5000;

// Visibility logs
console.log('Booting GrabNGo backend...');
console.log('CASHFREE_ENV:', process.env.CASHFREE_ENV);
console.log('PUBLIC_BASE_URL (must be backend URL):', process.env.PUBLIC_BASE_URL);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

// Capture raw body for webhook signature verification
app.use(express.json({
  verify: (req, res, buf) => { if (buf?.length) req.rawBody = buf.toString(); }
}));

const isSandbox = process.env.CASHFREE_ENV !== 'production';
const BASE_URL = isSandbox ? 'https://sandbox.cashfree.com/pg' : 'https://api.cashfree.com/pg';
const API_VERSION = "2023-08-01";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// Cashfree API auth headers
function authHeaders() {
  return {
    'x-client-id': process.env.CASHFREE_CLIENT_ID,
    'x-client-secret': process.env.CASHFREE_CLIENT_SECRET,
    'x-api-version': API_VERSION,
  };
}

// HMAC verification using webhook secret (NOT client secret)
function verifyCashfreeWebhook(req) {
  const ts = req.headers['x-webhook-timestamp'];
  const sig = req.headers['x-webhook-signature'];
  const raw = req.rawBody;
  const secret = process.env.CASHFREE_WEBHOOK_SECRET; // set this from Cashfree Dashboard Webhooks

  if (!ts || !sig || !raw || !secret) {
    console.error('Webhook verify missing ts/sig/raw/secret');
    return false;
  }

  const signedPayload = ts + raw;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('base64');
  const ok = expected === sig;
  if (!ok) console.error('Webhook signature mismatch');
  return ok;
}

// Create Cashfree order and (optionally) pre-record local order
app.post('/api/create-order', async (req, res) => {
  try {
    const { cart, user, amount } = req.body;
    if (!user?.uid) return res.status(400).json({ error: 'Missing user info' });
    if (!Array.isArray(cart) || cart.length === 0) return res.status(400).json({ error: 'Cart is empty' });

    const orderAmount = Number(amount);
    if (isNaN(orderAmount) || orderAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const cashfreeOrderId = 'order_' + Date.now();

    // Pre-record as Pending Payment (idempotent-friendly: ignore error if duplicate)
    const { error: preErr } = await supabase.from('orders').insert([{
      id: cashfreeOrderId,
      user_id: user.uid,
      user_email: user.email || null,
      status: 'Pending Payment',
      total_amount: orderAmount,
      raw_cart_data: cart, // jsonb column recommended
      created_at: new Date().toISOString()
    }]);
    if (preErr && preErr.code !== '23505') { // ignore duplicate PK errors
      console.error('Pre-record order error:', preErr);
      // continue; do not block checkout for a pre-insert failure
    }

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
        // Cashfree may redirect; ensure this is acceptable, but modal should keep user in-app
        return_url: `${PUBLIC_BASE_URL}/pg/return?order_id={order_id}`,
        notify_url: `${PUBLIC_BASE_URL}/api/cashfree/webhook`, // MUST be backend URL
      },
    };

    const cfResp = await axios.post(`${BASE_URL}/orders`, payload, { headers: authHeaders() });
    const { payment_session_id } = cfResp.data;
    if (!payment_session_id) return res.status(500).json({ error: 'No payment_session_id from Cashfree' });

    return res.json({
      orderId: cashfreeOrderId,
      paymentSessionId: payment_session_id,
      amount: orderAmount,
      currency: 'INR',
      envMode: isSandbox ? 'sandbox' : 'production',
    });
  } catch (error) {
    console.error('Create order error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Create order failed', details: error.response?.data || error.message });
  }
});

// Webhook handler: updates order status based on Cashfree events
app.post('/api/cashfree/webhook', async (req, res) => {
  try {
    if (!verifyCashfreeWebhook(req)) {
      // Return 200 to avoid retries storm, but log failure
      console.error('Webhook verification failed; ignoring event');
      return res.status(200).json({ ok: false });
    }

    const payload = req.body || {};
    // Defensive extraction across versions
    const orderObj = payload.data?.order || payload.data?.object || payload.order || payload;
    const order_id = orderObj?.order_id || orderObj?.id;
    const rawStatus = orderObj?.order_status || orderObj?.status || '';
    const cf_payment_id = orderObj?.cf_payment_id || orderObj?.payment_id || null;
    const s = String(rawStatus).toUpperCase();

    if (!order_id) {
      console.error('Webhook missing order_id; payload:', JSON.stringify(payload));
      return res.status(200).json({ ok: true });
    }

    const successStatuses = ['PAID','SUCCESS','CHARGED','CAPTURED'];

    // Ensure row exists; if not, create minimal row
    const { data: dbOrder, error: fetchErr } = await supabase
      .from('orders').select('id,status').eq('id', order_id).single();

    if (fetchErr) {
      console.warn('Order fetch on webhook failed; attempting insert:', fetchErr?.message);
      await supabase.from('orders').insert([{ id: order_id, status: successStatuses.includes(s) ? 'Preparing' : s }]);
      return res.status(200).json({ ok: true });
    }

    if (successStatuses.includes(s)) {
      if (dbOrder.status !== 'Preparing' && dbOrder.status !== 'Success') {
        const { error: updErr } = await supabase.from('orders')
          .update({ status: 'Preparing', payment_id: cf_payment_id ? String(cf_payment_id) : null })
          .eq('id', order_id);
        if (updErr) console.error('DB update to Preparing failed:', updErr);
      }
    } else {
      const { error: updErr } = await supabase.from('orders')
        .update({ status: s })
        .eq('id', order_id);
      if (updErr) console.error('DB update to non-success status failed:', updErr);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Webhook handler crash:', err.message);
    // Still return 200 to prevent endless retries; log for investigation
    return res.status(200).json({ ok: false });
  }
});

// Verify endpoint: prefer DB, fallback to Cashfree
app.post('/api/verify-order', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

    const { data: order, error: dbErr } = await supabase
      .from('orders').select('status').eq('id', orderId).single();

    if (!dbErr && order) return res.json({ status: order.status });

    const response = await axios.get(`${BASE_URL}/orders/${orderId}`, { headers: authHeaders() });
    const status = response.data?.order_status || 'UNKNOWN';
    return res.json({ status });
  } catch (error) {
    console.error('Verify order error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Verify failed', details: error.response?.data || error.message });
  }
});

app.listen(PORT, () => console.log(`Server running at port ${PORT}`));
