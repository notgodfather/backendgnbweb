require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use('/api/cashfree/webhook', bodyParser.raw({ type: '*/*' }));
app.use(express.json());

const isSandbox = process.env.CASHFREE_ENV !== 'production';
const BASE_URL = isSandbox ? 'https://sandbox.cashfree.com/pg' : 'https://api.cashfree.com/pg';
const API_VERSION = '2023-08-01';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const FLAT_ITEM_DISCOUNT = 5.0;

function authHeaders() {
  return {
    'x-client-id': process.env.CASHFREE_CLIENT_ID,
    'x-client-secret': process.env.CASHFREE_CLIENT_SECRET,
    'x-api-version': API_VERSION,
  };
}

app.get('/health', (_req, res) =>
  res.json({ ok: true, env: isSandbox ? 'sandbox' : 'production' })
);

app.post('/api/create-order', async (req, res) => {
  try {
    const { cart, user, amount } = req.body;
    if (!user?.uid) return res.status(400).json({ error: 'Missing user info' });
    if (!Array.isArray(cart) || cart.length === 0) return res.status(400).json({ error: 'Cart is empty' });

    const orderAmount = Number(amount);
    if (isNaN(orderAmount) || orderAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });

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

    const cfResp = await axios.post(`${BASE_URL}/orders`, payload, { headers: authHeaders() });
    const { payment_session_id } = cfResp.data;
    if (!payment_session_id) {
      return res.status(500).json({ error: 'No payment_session_id from Cashfree', raw: cfResp.data });
    }

    const snapshot = {
      id: cashfreeOrderId,
      user_id: user.uid,
      user_email: user.email || 'noemail@example.com',
      amount: orderAmount,
      cart: cart,
      created_at: new Date().toISOString(),
    };
    const { error: pendErr } = await supabase.from('pending_orders').upsert([snapshot]);
    if (pendErr) console.error('pending_orders upsert error:', pendErr);

    return res.json({
      orderId: cashfreeOrderId,
      paymentSessionId: payment_session_id,
      amount: orderAmount,
      currency: 'INR',
      envMode: isSandbox ? 'sandbox' : 'production',
    });
  } catch (error) {
    console.error('Create order error:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Create order failed', details: error.response?.data || error.message });
  }
});

// THE MAIN WEBHOOK LOGIC
app.post('/api/cashfree/webhook', async (req, res) => {
  try {
    const timestamp = req.header('x-webhook-timestamp');
    const signature = req.header('x-webhook-signature');
    const payloadStr = req.body.toString('utf8');
    const expected = crypto.createHmac('sha256', process.env.CASHFREE_CLIENT_SECRET)
      .update(timestamp + payloadStr).digest('base64');
    if (!signature || expected !== signature) {
      return res.status(400).send('Invalid signature');
    }

    const event = JSON.parse(payloadStr);
    const data = event.data || {};
    const order = data.order || {};
    const payment = data.payment || {};
    const orderId = order.order_id;
    const paymentId = String(payment.cf_payment_id || '');
    const payStatus = payment.payment_status;

    if (payStatus !== 'SUCCESS') return res.status(200).send('Ignored non-success');

    // 1) Payments upsert (idempotent)
    const payRow = {
      cf_payment_id: paymentId,
      order_id: orderId,
      amount: Number(payment.payment_amount || order.order_amount || 0),
      status: 'SUCCESS',
      payload: event,
    };
    const { error: payErr } = await supabase
      .from('payments')
      .upsert([payRow], { onConflict: 'cf_payment_id', ignoreDuplicates: true });
    if (payErr) return res.status(500).send('Payments upsert failed');

    // 2) If order header exists, reconcile items if missing
    const { data: existingOrder } = await supabase
      .from('orders')
      .select('id')
      .eq('id', orderId)
      .maybeSingle();

    if (existingOrder) {
      const { count, error: itemsCountErr } = await supabase
        .from('order_items')
        .select('id', { count: 'exact', head: true })
        .eq('order_id', orderId);
      if (itemsCountErr) return res.status(500).send('Order items count failed');

      if ((count || 0) === 0) {
        const { data: pending, error: pendGetErr } = await supabase
          .from('pending_orders').select('*').eq('id', orderId).maybeSingle();
        if (pendGetErr) return res.status(500).send('Pending fetch failed');
        if (!pending) return res.status(500).send('No pending for reconciliation');

        const cart = Array.isArray(pending.cart) ? pending.cart : pending.cart || [];
        if (!cart || cart.length === 0) return res.status(500).send('No cart to reconcile');

        const itemsPayload = cart.map(ci => ({
          order_id: orderId,
          item_id: ci.item.id,
          qty: ci.qty,
          price: Math.max(0, Number(ci.item.price) - FLAT_ITEM_DISCOUNT),
        }));
        const { error: itemsErr } = await supabase.from('order_items').insert(itemsPayload);
        if (itemsErr) return res.status(500).send('Order items reconcile failed');

        await supabase.from('pending_orders').delete().eq('id', orderId);
      }
      return res.status(200).send('Order already exists');
    }

    // 3) Write order and items from pending
    const { data: pending, error: pendGetErr } = await supabase
      .from('pending_orders').select('*').eq('id', orderId).maybeSingle();
    if (pendGetErr) return res.status(500).send('Pending fetch failed');
    if (!pending) return res.status(500).send('No pending snapshot');

    const { error: orderErr } = await supabase.from('orders').insert([{
      id: pending.id,
      user_id: pending.user_id,
      user_email: pending.user_email,
      status: 'Preparing',
      created_at: new Date().toISOString(),
    }]);
    if (orderErr) return res.status(500).send('Order insert failed');

    const cart = Array.isArray(pending.cart) ? pending.cart : pending.cart || [];
    if (!cart || cart.length === 0) return res.status(500).send('No cart found in pending');

    const itemsPayload = cart.map(ci => ({
      order_id: pending.id,
      item_id: ci.item.id,
      qty: ci.qty,
      price: Math.max(0, Number(ci.item.price) - FLAT_ITEM_DISCOUNT),
    }));
    const { error: itemsErr } = await supabase.from('order_items').insert(itemsPayload);
    if (itemsErr) return res.status(500).send('Order items insert failed');

    await supabase.from('pending_orders').delete().eq('id', pending.id);
    return res.status(200).send('OK');
  } catch (e) {
    console.error('Webhook error:', e);
    return res.status(500).send('Failed');
  }
});

app.get('/api/orders/:id', async (req, res) => {
  const id = req.params.id;
  const { data, error } = await supabase
    .from('orders').select('id,status').eq('id', id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ exists: !!data, status: data?.status || null });
});

app.listen(PORT, () => console.log(`Server running at port ${PORT}`));
