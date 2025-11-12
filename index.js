require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors =require('cors');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5000;

// Supabase (service role)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// CORS and JSON parser for normal routes
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

// Cashfree config
const isSandbox = process.env.CASHFREE_ENV !== 'production';
const BASE_URL = isSandbox ? 'https://sandbox.cashfree.com/pg' : 'https://api.cashfree.com/pg';
const API_VERSION = '2023-08-01';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// --- IMPORTANT: Webhook route using raw body parser MUST be defined before express.json() ---
app.post('/api/cashfree/webhook', bodyParser.raw({ type: '*/*' }), async (req, res) => {
  console.log('--- Webhook Triggered ---');
  try {
    const signature = req.headers['x-webhook-signature'] || '';
    const timestamp = req.headers['x-webhook-timestamp'] || '';
    
    if (!signature) {
      console.warn('Webhook received but signature is MISSING.');
      return res.status(200).send('OK');
    }
    console.log('Signature header received.');

    const valid = verifyCashfreeSignature(req.body, signature, timestamp); 
    
    if (!valid) {
      console.error('!!! Invalid webhook signature. Halting processing. Check your Secret Key and Verification Logic. !!!');
      return res.status(200).send('OK');
    }
    console.log('Signature is VALID. Processing payload.');

    const payload = JSON.parse(req.body.toString('utf8'));
    console.log('Payload:', JSON.stringify(payload, null, 2));

    const data = payload?.data || payload;
    const orderId = data?.order?.order_id || data?.order_id;
    const paymentId = data?.payment?.cf_payment_id || data?.cf_payment_id;
    const status = (data?.payment?.payment_status || data?.order_status || '').toUpperCase();
    const amount = Number(data?.payment?.payment_amount || data?.order_amount || 0);

    console.log(`Extracted - OrderID: ${orderId}, PaymentID: ${paymentId}, Status: ${status}`);

    if (!orderId || !paymentId) {
      console.warn('Missing orderId or paymentId in payload. Ignoring.');
      return res.status(200).send('OK');
    }

    console.log('Attempting to insert into order_payments...');
    const { data: paymentRecord, error: payErr } = await supabase.from('order_payments').insert([{
      cf_payment_id: paymentId,
      order_id: orderId,
      amount,
      status: status || 'UNKNOWN',
      raw: payload
    }]);

    if (payErr) {
      if (`${payErr.message}`.toLowerCase().includes('duplicate')) {
        console.log('Payment attempt already recorded (idempotent). Skipping insert.');
      } else {
        console.error('Error inserting into order_payments:', payErr);
      }
    } else {
      console.log('Successfully inserted into order_payments.');
    }

    if (['SUCCESS', 'PAID', 'AUTHORIZED', 'CAPTURED'].includes(status)) {
      console.log(`Payment is successful. Attempting to update order ${orderId}...`);
      const { data: updatedOrder, error: updateErr } = await supabase
        .from('orders')
        .update({ status: 'Preparing', payment_id: paymentId, paid_at: new Date().toISOString() })
        .eq('id', orderId)
        .is('paid_at', null)
        .select();
      
      if (updateErr) {
        console.error(`Error updating order ${orderId}:`, updateErr);
      } else {
        console.log(`Successfully updated order ${orderId}. Rows affected:`, updatedOrder.length);
      }
    } else {
        console.log(`Payment status is ${status}. Not updating order to Preparing.`);
    }

    return res.status(200).send('OK');
  } catch (e) {
    console.error('!!! UNHANDLED EXCEPTION in webhook handler !!!', e);
    return res.status(200).send('OK');
  }
});
// --- Webhook route definition ends ---


// Normal JSON routes defined after
app.use(express.json());


// Helpers
function authHeaders() {
  return {
    'x-client-id': process.env.CASHFREE_CLIENT_ID,
    'x-client-secret': process.env.CASHFREE_CLIENT_SECRET,
    'x-api-version': API_VERSION,
  };
}


function verifyCashfreeSignature(rawBody, signatureHeader, timestampHeader) {
  // Use the Client Secret Key as the secret (since you confirmed no separate secret is available)
  const secret = process.env.CASHFREE_CLIENT_SECRET || ''; 
  
  if (!secret || !signatureHeader || !timestampHeader) {
      return false;
  }
  
  // Cashfree signs the concatenation of timestamp and raw body
  // Format: timestamp + rawBody (no separator)
  const signStr = timestampHeader + rawBody.toString('utf8');
  
  const computed = crypto.createHmac('sha256', secret)
      .update(signStr)
      .digest('base64');

  // Use try-catch for safe comparison
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signatureHeader));
  } catch (e) {
    // Fallback for timingSafeEqual failure (e.g., length mismatch)
    return computed === signatureHeader;
  }
}


// Routes
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
    if (!payment_session_id) return res.status(500).json({ error: 'No payment_session_id from Cashfree', raw: response.data });

    await supabase.from('orders').upsert([{ id: cashfreeOrderId, user_id: user.uid, user_email: user.email || 'noemail@example.com', status: 'Payment Active', created_at: new Date().toISOString() }], { onConflict: 'id' });
    const itemsPayload = (cart || []).map(ci => ({ order_id: cashfreeOrderId, item_id: ci.id || ci.item?.id, qty: ci.quantity || ci.qty, price: Number(ci.price || ci.item?.price) }));
    if (itemsPayload.length) await supabase.from('order_items').upsert(itemsPayload, { onConflict: 'order_id,item_id' });

    return res.json({ orderId: cashfreeOrderId, paymentSessionId: payment_session_id, amount: orderAmount, currency: 'INR', envMode: isSandbox ? 'sandbox' : 'production' });
  } catch (error) {
    console.error('Create order error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Create order failed', details: error.response?.data || error.message });
  }
});


app.post('/api/verify-order', async (req, res) => {
    // This function remains the same as before
    try {
        const { orderId } = req.body;
        if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

        const response = await axios.get(`${BASE_URL}/orders/${orderId}`, { headers: authHeaders() });
        const data = response.data;
        const status = (data.order_status || 'UNKNOWN').toUpperCase();

        if (['SUCCESS','PAID'].includes(status)) {
          await supabase.from('orders').update({ status: 'Preparing', paid_at: new Date().toISOString() }).eq('id', orderId).is('paid_at', null);
        } else if (['FAILED','CANCELLED'].includes(status)) {
          await supabase.from('orders').update({ status: 'Payment Failed' }).eq('id', orderId).is('paid_at', null);
        }

        res.json({ status });
    } catch (error) {
        console.error('Verify order error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Verify failed', details: error.response?.data || error.message });
    }
});


app.post('/api/record-order', async (req, res) => {
    // CHANGED: Removed redundant order_items upsert to fix order history display issue
    try {
        const { userId, userEmail, cart, orderId } = req.body;
        if (!userId || !Array.isArray(cart) || cart.length === 0 || !orderId) {
          return res.status(400).json({ error: 'Missing required fields' });
        }
        const { data: existingOrder, error: existErr } = await supabase.from('orders').select('id').eq('id', orderId).single();
        if (!existingOrder && !existErr) {
          // This part remains to ensure the main order record exists, just in case
          await supabase.from('orders').insert([{ id: orderId, user_id: userId, user_email: userEmail, status: 'Preparing', created_at: new Date().toISOString() }]);
        }
        
        // -------------------------------------------------------------
        // REMOVED: Redundant order_items upsert block is commented out
        // The order items were already inserted in /api/create-order
        // This prevents overwriting with potentially bad data after payment
        // -------------------------------------------------------------
        /*
        const itemsPayload = cart.map(ci => ({ order_id: orderId, item_id: ci.item.id, qty: ci.qty, price: Number(ci.item.price) }));
        if (itemsPayload.length) await supabase.from('order_items').upsert(itemsPayload, { onConflict: 'order_id,item_id' });
        */
        // -------------------------------------------------------------

        res.json({ success: true, orderId });
    } catch (err) {
        console.error('Record order error:', err);
        res.status(500).json({ error: 'Failed to record order' });
    }
});


app.post('/api/reconcile-stuck', async (req, res) => {
    // This function remains the same as before
    try {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data: pending, error } = await supabase.from('orders').select('id, status, paid_at').in('status', ['Pending', 'Payment Active']).gte('created_at', since);
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
          } catch (e) { console.error('reconcile one error', o.id, e?.response?.data || e.message); }
        }
        res.json({ ok: true, checked: pending?.length || 0 });
    } catch (e) {
        console.error('reconcile error', e);
        res.status(500).json({ error: 'reconcile failed' });
    }
});


app.get('/health', (req, res) => res.json({ ok: true }));


app.listen(PORT, () => console.log(`Server running at port ${PORT}`));