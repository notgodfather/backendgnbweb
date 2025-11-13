// index.js — simplified, working server (drop-in)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; } // keep raw for signature verification
}));

const isSandbox = process.env.CASHFREE_ENV !== 'production';
const BASE_URL = isSandbox ? 'https://sandbox.cashfree.com/pg' : 'https://api.cashfree.com/pg';
const API_VERSION = '2023-08-01';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const CASHFREE_WEBHOOK_SECRET = process.env.CASHFREE_WEBHOOK_SECRET || null;

function authHeaders() {
  return {
    'x-client-id': process.env.CASHFREE_CLIENT_ID,
    'x-client-secret': process.env.CASHFREE_CLIENT_SECRET,
    'x-api-version': API_VERSION,
  };
}

function computeAmountFromCart(cart) {
  if (!Array.isArray(cart)) return 0;
  return cart.reduce((sum, { price, quantity }) => {
    const p = Number(price);
    const q = Number(quantity);
    if (isNaN(p) || isNaN(q) || p < 0 || q < 0) throw new Error('Invalid price or quantity in cart');
    return sum + p * q;
  }, 0);
}

/**
 * create-order
 * - validates cart/user
 * - computes server-side amount
 * - inserts pending order with cart_json
 * - creates Cashfree payment session
 */
app.post('/api/create-order', async (req, res) => {
  try {
    const { cart, user, amount } = req.body;
    if (!user?.uid) return res.status(400).json({ error: 'Missing user info' });
    if (!Array.isArray(cart) || cart.length === 0) return res.status(400).json({ error: 'Cart is empty' });

    let serverAmount;
    try {
      serverAmount = Number(computeAmountFromCart(cart));
    } catch (err) {
      return res.status(400).json({ error: 'Invalid cart data', details: err.message });
    }

    if (isNaN(serverAmount) || serverAmount <= 0) return res.status(400).json({ error: 'Invalid computed amount' });

    if (typeof amount !== 'undefined') {
      const clientAmount = Number(amount);
      if (isNaN(clientAmount) || Math.abs(clientAmount - serverAmount) > 0.01) {
        return res.status(400).json({ error: 'Amount mismatch', clientAmount: amount, serverAmount });
      }
    }

    const cashfreeOrderId = 'order_' + Date.now();

    // Insert pending order with cart JSON so webhook can insert items later
    try {
      const { error: insertErr } = await supabase.from('orders').insert([{
        id: cashfreeOrderId,
        user_id: user.uid,
        user_email: user.email || null,
        status: 'Pending',
        created_at: new Date().toISOString(),
        total_amount: serverAmount,
        cart_json: cart, // JSONB column required
      }]);
      if (insertErr) {
        console.error('[create-order] insert pending order failed (non-blocking):', insertErr);
      }
    } catch (e) {
      console.error('[create-order] insert error (ignored):', e);
    }

    const payload = {
      order_id: cashfreeOrderId,
      order_amount: serverAmount,
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
    const responseData = response.data || {};
    const payment_session_id = responseData.payment_session_id || responseData.paymentSessionId || responseData.payment_session;

    console.log('[create-order] cashfree response:', responseData);

    if (!payment_session_id) {
      return res.status(500).json({ error: 'No payment_session_id from Cashfree', raw: responseData });
    }

    return res.json({
      orderId: cashfreeOrderId,
      paymentSessionId: payment_session_id,
      amount: serverAmount,
      currency: 'INR',
      envMode: isSandbox ? 'sandbox' : 'production',
    });
  } catch (error) {
    console.error('[create-order] error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Create order failed', details: error.response?.data || error.message });
  }
});

/**
 * verify-order (keeps your original behavior but resilient)
 */
app.post('/api/verify-order', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

    console.log('[verify-order] checking orderId:', orderId);
    const response = await axios.get(`${BASE_URL}/orders/${orderId}`, { headers: authHeaders() });
    const data = response.data || {};
    console.log('[verify-order] cashfree response:', data);
    const status = (data.order_status || data.status || data.orderStatus || '').toString().toUpperCase() || 'UNKNOWN';
    res.json({ status, raw: data });
  } catch (error) {
    console.error('[verify-order] error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Verify failed', details: error.response?.data || error.message });
  }
});

/**
 * record-order (fallback if client calls it)
 * - idempotent
 */
app.post('/api/record-order', async (req, res) => {
  try {
    const { userId, userEmail, cart, orderId } = req.body;
    if (!userId || !Array.isArray(cart) || cart.length === 0 || !orderId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // If order already recorded as Preparing/Paid, return success
    const { data: existingOrder, error: existingErr } = await supabase
      .from('orders')
      .select('id, status, cart_json')
      .eq('id', orderId)
      .maybeSingle();

    if (existingErr) {
      console.error('[record-order] DB check error:', existingErr);
      return res.status(500).json({ error: 'DB check failed' });
    }

    if (existingOrder && (existingOrder.status === 'Preparing' || existingOrder.status === 'Paid' || existingOrder.status === 'Completed')) {
      return res.json({ success: true, message: 'Order already recorded', orderId: existingOrder.id });
    }

    if (!existingOrder) {
      // Create order record (status Preparing)
      const { data: createdOrder, error: orderErr } = await supabase
        .from('orders')
        .insert([{
          id: orderId,
          user_id: userId,
          user_email: userEmail || null,
          status: 'Preparing',
          created_at: new Date().toISOString(),
          cart_json: cart,
        }])
        .select('id')
        .maybeSingle();

      if (orderErr || !createdOrder) {
        console.error('[record-order] failed to create order:', orderErr);
        return res.status(500).json({ error: 'Failed to create order' });
      }
    } else {
      // update status (was pending)
      if (existingOrder.status === 'Pending') {
        const { error: updErr } = await supabase.from('orders').update({ status: 'Preparing' }).eq('id', orderId);
        if (updErr) console.error('[record-order] failed to update status:', updErr);
      }
    }

    // Insert items (attempt; if unique constraint exists, treat duplicate as ok)
    const itemsPayload = cart.map(ci => ({
      order_id: orderId,
      item_id: ci.item.id,
      qty: ci.qty,
      price: Number(ci.item.price),
    }));

    const { error: itemErr } = await supabase.from('order_items').insert(itemsPayload);
    if (itemErr) {
      console.error('[record-order] order_items insert error (may be dupes):', itemErr);
      if (itemErr.code && itemErr.code === '23505') { // unique_violation
        return res.json({ success: true, message: 'Order items already recorded (unique violation)' });
      }
      return res.status(500).json({ error: 'Failed to insert order items', details: itemErr });
    }

    return res.json({ success: true, orderId });
  } catch (err) {
    console.error('[record-order] error:', err);
    res.status(500).json({ error: 'Failed to record order' });
  }
});

/**
 * cashfree webhook
 * - verifies signature if secret provided
 * - marks order as Preparing when paid and inserts items from orders.cart_json
 * - idempotent
 */
app.post('/api/cashfree/webhook', async (req, res) => {
  try {
    const payload = req.body || {};
    const rawBody = req.rawBody;

    // optional signature verification — adjust header name to match Cashfree docs
    if (CASHFREE_WEBHOOK_SECRET) {
      const signatureHeader = req.headers['x-cf-signature'] || req.headers['x-cashfree-signature'] || req.headers['x-webhook-signature'];
      if (!signatureHeader) {
        console.warn('[webhook] missing signature header');
        return res.status(400).send('missing signature');
      }
      const computed = crypto.createHmac('sha256', CASHFREE_WEBHOOK_SECRET).update(rawBody).digest('hex');
      if (computed !== signatureHeader) {
        console.warn('[webhook] invalid signature', { computed, signatureHeader });
        return res.status(401).send('invalid signature');
      }
    }

    // Normalize fields
    const orderId = payload.order_id || payload.reference_id || payload.orderReference || payload.orderId;
    const statusRaw = (payload.order_status || payload.status || payload.txStatus || '').toString().toUpperCase();

    if (!orderId) {
      console.warn('[webhook] missing order id', payload);
      return res.status(400).send('missing order id');
    }

    console.log('[webhook] event for order:', orderId, 'status:', statusRaw);

    const paidStatuses = ['PAID', 'SUCCESS', 'COMPLETED', 'CAPTURED'];

    // fetch existing order
    const { data: existingOrder, error: existingErr } = await supabase
      .from('orders')
      .select('id, status, cart_json')
      .eq('id', orderId)
      .maybeSingle();

    if (existingErr) {
      console.error('[webhook] DB fetch error:', existingErr);
      return res.status(500).send('db error');
    }

    if (!existingOrder) {
      // create order row if missing (store payload as meta maybe)
      const { error: createErr } = await supabase.from('orders').insert([{
        id: orderId,
        user_id: payload.customer_id || null,
        user_email: payload.customer_email || null,
        status: paidStatuses.includes(statusRaw) ? 'Preparing' : 'Pending',
        created_at: new Date().toISOString(),
        cart_json: payload.cart || null,
      }]);
      if (createErr) {
        console.error('[webhook] create order failed:', createErr);
        return res.status(500).send('db create failed');
      }
      // If created and status is paid we try to insert items below (but cart_json may be missing)
    }

    // If status is paid => mark Preparing and ensure items are present
    if (paidStatuses.includes(statusRaw)) {
      // Update status to Preparing (idempotent)
      const { error: updErr } = await supabase.from('orders').update({ status: 'Preparing' }).eq('id', orderId);
      if (updErr) console.error('[webhook] failed to update order status:', updErr);

      // Fetch cart_json (again for the case existingOrder was null earlier)
      const { data: orderRow, error: orderFetchErr } = await supabase
        .from('orders')
        .select('id, cart_json')
        .eq('id', orderId)
        .maybeSingle();

      if (orderFetchErr) {
        console.error('[webhook] error fetching order for items insertion:', orderFetchErr);
        return res.status(500).send('db error');
      }

      const cart = orderRow?.cart_json;
      if (Array.isArray(cart) && cart.length > 0) {
        const itemsPayload = cart.map(ci => ({
          order_id: orderId,
          item_id: ci.item.id,
          qty: ci.qty,
          price: Number(ci.item.price),
        }));

        const { error: itemErr } = await supabase.from('order_items').insert(itemsPayload);
        if (itemErr) {
          console.error('[webhook] insert order_items error (may be dupes):', itemErr);
          if (itemErr.code && itemErr.code === '23505') {
            // unique violation -> items already present -> ok
            return res.status(200).send('ok');
          }
          return res.status(500).send('insert items failed');
        }
      } else {
        console.warn('[webhook] no cart_json available to insert items for order:', orderId);
      }

      return res.status(200).send('ok');
    }

    // handle non-paid statuses
    if (['FAILED', 'CANCELLED', 'DECLINED'].includes(statusRaw)) {
      const { error: updErr } = await supabase.from('orders').update({ status: 'Failed' }).eq('id', orderId);
      if (updErr) console.error('[webhook] failed to mark Failed:', updErr);
      return res.status(200).send('ok');
    }

    // default
    return res.status(200).send('ignored');
  } catch (err) {
    console.error('[webhook] processing error:', err);
    return res.status(500).send('server error');
  }
});

app.listen(PORT, () => console.log(`Server running at port ${PORT}`));
