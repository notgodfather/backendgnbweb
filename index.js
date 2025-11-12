require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5000;

// Supabase (service role)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// CORS and JSON parser for normal routes
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

// Cashfree config
const isSandbox = process.env.CASHFREE_ENV !== 'production';
const BASE_URL = isSandbox ? 'https://sandbox.cashfree.com/pg' : 'https://api.cashfree.com/pg';
const API_VERSION = '2023-08-01';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// Helpers
function authHeaders() {
  return {
    'x-client-id': process.env.CASHFREE_CLIENT_ID,
    'x-client-secret': process.env.CASHFREE_CLIENT_SECRET,
    'x-api-version': API_VERSION,
  };
}

function verifyCashfreeSignature(rawBody, signatureHeader) {
  const secret = process.env.CASHFREE_WEBHOOK_SECRET || '';
  if (!secret || !signatureHeader) return false;
  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

function computeAmountFromCart(cart) {
  if (!Array.isArray(cart)) return 0;
  const sum = cart.reduce((acc, { price, quantity }) => {
    const p = Number(price);
    const q = Number(quantity);
    if (Number.isNaN(p) || Number.isNaN(q) || p < 0 || q < 0) throw new Error('Invalid price/qty');
    return acc + p * q;
  }, 0);
  return Number(sum.toFixed(2));
}

// Routes

// Create Order: also persist a pending order + items so there’s always a row to update later
app.post('/api/create-order', async (req, res) => {
  try {
    const { cart, user, amount } = req.body;
    if (!user?.uid) return res.status(400).json({ error: 'Missing user info' });
    if (!Array.isArray(cart) || cart.length === 0) return res.status(400).json({ error: 'Cart is empty' });

    const orderAmount = Number(amount);
    if (Number.isNaN(orderAmount) || orderAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const cashfreeOrderId = 'order_' + Date.now();

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
    };

    const response = await axios.post(`${BASE_URL}/orders`, payload, { headers: authHeaders() });
    const { payment_session_id } = response.data;

    if (!payment_session_id) {
      return res.status(500).json({ error: 'No payment_session_id from Cashfree', raw: response.data });
    }

    // Upsert a pending order so it exists even if the user closes the tab after paying
    await supabase.from('orders').upsert([{
      id: cashfreeOrderId,
      user_id: user.uid,
      user_email: user.email || 'noemail@example.com',
      status: 'Payment Active',
      created_at: new Date().toISOString()
    }], { onConflict: 'id' });

    // Upsert items for the order (unique on order_id + item_id recommended in your schema)
    const itemsPayload = (cart || []).map(ci => ({
      order_id: cashfreeOrderId,
      item_id: ci.id || ci.item?.id,
      qty: ci.quantity || ci.qty,
      price: Number(ci.price || ci.item?.price)
    }));
    if (itemsPayload.length) {
      await supabase.from('order_items').upsert(itemsPayload, { onConflict: 'order_id,item_id' });
    }

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

// Verify Order: idempotently finalize state (server is source of truth)
app.post('/api/verify-order', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

    const response = await axios.get(`${BASE_URL}/orders/${orderId}`, { headers: authHeaders() });
    const data = response.data;
    const status = (data.order_status || 'UNKNOWN').toUpperCase();

    if (['SUCCESS','PAID'].includes(status)) {
      await supabase
        .from('orders')
        .update({ status: 'Preparing', paid_at: new Date().toISOString() })
        .eq('id', orderId)
        .is('paid_at', null);
    } else if (['FAILED','CANCELLED'].includes(status)) {
      await supabase
        .from('orders')
        .update({ status: 'Payment Failed' })
        .eq('id', orderId)
        .is('paid_at', null);
    }

    res.json({ status });
  } catch (error) {
    console.error('Verify order error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Verify failed', details: error.response?.data || error.message });
  }
});

// Record Order: keep idempotent; fill missing items; do not 409
app.post('/api/record-order', async (req, res) => {
  try {
    const { userId, userEmail, cart, orderId } = req.body;
    if (!userId || !Array.isArray(cart) || cart.length === 0 || !orderId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { data: existingOrder, error: existErr } = await supabase
      .from('orders')
      .select('id')
      .eq('id', orderId)
      .single();

    if (!existingOrder && !existErr) {
      await supabase.from('orders').insert([{
        id: orderId,
        user_id: userId,
        user_email: userEmail,
        status: 'Preparing',
        created_at: new Date().toISOString(),
      }]);
    }

    const itemsPayload = cart.map(ci => ({
      order_id: orderId,
      item_id: ci.item.id,
      qty: ci.qty,
      price: Number(ci.item.price),
    }));
    if (itemsPayload.length) {
      await supabase.from('order_items').upsert(itemsPayload, { onConflict: 'order_id,item_id' });
    }

    res.json({ success: true, orderId });
  } catch (err) {
    console.error('Record order error:', err);
    res.status(500).json({ error: 'Failed to record order' });
  }
});

// Cashfree Webhook: raw body for signature verification
app.post('/api/cashfree/webhook', bodyParser.raw({ type: '*/*' }), async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'] || req.headers['x-signature'] || '';
    const raw = req.body; // Buffer
    const valid = verifyCashfreeSignature(raw, signature);
    if (!valid) {
      console.warn('Invalid webhook signature');
      return res.status(200).send('ok'); // acknowledge to avoid retries; log for analysis
    }

    const payload = JSON.parse(raw.toString('utf8'));
    const data = payload?.data || payload;

    const orderId = data?.order?.order_id || data?.order_id;
    const paymentId = data?.payment?.payment_id || data?.cf_payment_id;
    const status = (data?.payment?.payment_status || data?.order_status || '').toUpperCase();
    const amount = Number(data?.payment?.payment_amount || data?.order_amount || 0);

    if (!orderId || !paymentId) return res.status(200).send('ok');

    // Idempotent payment attempt record
    const { error: payErr } = await supabase.from('order_payments').insert([{
      cf_payment_id: paymentId,
      order_id: orderId,
      amount,
      status: status || 'UNKNOWN',
      raw: payload
    }]);
    if (payErr && !`${payErr.message}`.toLowerCase().includes('duplicate')) {
      console.error('order_payments insert error', payErr);
    }

    if (['SUCCESS','PAID','AUTHORIZED','CAPTURED'].includes(status)) {
      await supabase
        .from('orders')
        .update({ status: 'Preparing', payment_id: paymentId, paid_at: new Date().toISOString() })
        .eq('id', orderId)
        .is('paid_at', null);
    } else if (['FAILED','CANCELLED'].includes(status)) {
      await supabase
        .from('orders')
        .update({ status: 'Payment Failed' })
        .eq('id', orderId)
        .is('paid_at', null);
    }

    return res.status(200).send('ok');
  } catch (e) {
    console.error('webhook error', e);
    return res.status(200).send('ok');
  }
});

// Optional: reconcile stuck payments (run via cron)
app.post('/api/reconcile-stuck', async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: pending, error } = await supabase
      .from('orders')
      .select('id, status, paid_at')
      .in('status', ['Pending', 'Payment Active'])
      .gte('created_at', since);

    if (error) throw error;

    for (const o of pending || []) {
      try {
        const r = await axios.get(`${BASE_URL}/orders/${o.id}`, { headers: authHeaders() });
        const s = (r.data?.order_status || 'UNKNOWN').toUpperCase();
        if (['SUCCESS', 'PAID'].includes(s)) {
          await supabase.from('orders').update({ status: 'Preparing', paid_at: new Date().toISOString() }).eq('id', o.id);
        } else if (['FAILED', 'CANCELLED'].includes(s)) {
          await supabase.from('orders').update({ status: 'Payment Failed' }).eq('id', o.id).is('paid_at', null);
        }
      } catch (e) {
        console.error('reconcile one error', o.id, e?.response?.data || e.message);
      }
    }

    res.json({ ok: true, checked: pending?.length || 0 });
  } catch (e) {
    console.error('reconcile error', e);
    res.status(500).json({ error: 'reconcile failed' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Server running at port ${PORT}`));
