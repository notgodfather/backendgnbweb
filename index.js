require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5000;

// Supabase client for admin operations
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Allow your frontend origin
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*'
}));

// Use express.json() for all routes EXCEPT the webhook
app.use((req, res, next) => {
  if (req.originalUrl === '/api/cashfree/webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

const isSandbox = process.env.CASHFREE_ENV !== 'production';
const BASE_URL = isSandbox ? 'https://sandbox.cashfree.com/pg' : 'https://api.cashfree.com/pg';
const API_VERSION = "2023-08-01";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// Helper for Cashfree API headers
function authHeaders() {
  return {
    'x-client-id': process.env.CASHFREE_CLIENT_ID,
    'x-client-secret': process.env.CASHFREE_CLIENT_SECRET,
    'x-api-version': API_VERSION,
  };
}

// Helper to compute order amount
function computeAmountFromCart(cart) {
  if (!Array.isArray(cart)) return 0;
  return cart.reduce((sum, { price, quantity }) => {
    const p = Number(price);
    const q = Number(quantity);
    if (isNaN(p) || isNaN(q) || p < 0 || q < 0) throw new Error("Invalid price or quantity");
    return sum + p * q;
  }, 0).toFixed(2);
}

// 1. Create Order Endpoint
app.post('/api/create-order', async (req, res) => {
  try {
    const { cart, user } = req.body;
    if (!user?.uid) return res.status(400).json({ error: 'Missing user info' });
    if (!Array.isArray(cart) || cart.length === 0) return res.status(400).json({ error: 'Cart is empty' });

    const orderAmount = computeAmountFromCart(cart);
    if (orderAmount <= 0) return res.status(400).json({ error: 'Invalid cart amount' });

    // Step 1: Create a 'Pending Payment' order in Supabase to get a unique UUID.
    const { data: newOrder, error: orderErr } = await supabase
      .from('orders')
      .insert([{
        user_id: user.uid,
        user_email: user.email,
        status: 'Pending Payment',
      }])
      .select('id')
      .single();

    if (orderErr) throw orderErr;
    const newOrderId = newOrder.id;

    // Step 2: Insert the items into the 'order_items' table.
    const itemsPayload = cart.map(item => ({
        order_id: newOrderId,
        item_id: item.id,
        qty: item.quantity, // FIX: Changed 'quantity' to 'qty' to match your schema
        price: Number(item.price),
    }));

    const { error: itemErr } = await supabase.from('order_items').insert(itemsPayload);
    if (itemErr) throw itemErr;

    // Step 3: Create the Cashfree order using the real UUID
    const payload = {
      order_id: newOrderId,
      order_amount: orderAmount,
      order_currency: 'INR',
      customer_details: {
        customer_id: user.uid,
        customer_name: user.displayName || 'Guest',
        customer_email: user.email,
        customer_phone: user.phoneNumber || '9999999999',
      },
      order_note: 'GrabNGo Canteen Order',
      order_meta: {
        return_url: `${PUBLIC_BASE_URL}/orders/${newOrderId}`,
        notify_url: `${PUBLIC_BASE_URL}/api/cashfree/webhook`,
      },
    };

    const response = await axios.post(`${BASE_URL}/orders`, payload, { headers: authHeaders() });
    const { payment_session_id } = response.data;

    if (!payment_session_id) {
      return res.status(500).json({ error: 'Failed to create payment session', raw: response.data });
    }

    return res.json({
      orderId: newOrderId,
      paymentSessionId: payment_session_id,
      amount: orderAmount,
      currency: 'INR',
      envMode: isSandbox ? 'sandbox' : 'production',
    });
  } catch (error) {
    console.error('Create order error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to create order', details: error.response?.data?.message || error.message });
  }
});

// 2. Cashfree Webhook Endpoint
app.post('/api/cashfree/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    const payload = req.body;
    const secret = process.env.CASHFREE_WEBHOOK_SECRET;

    if (!signature || !timestamp || !secret) {
        return res.status(400).send('Webhook headers missing');
    }

    const verifier = crypto.createHmac('sha256', secret);
    verifier.update(`${timestamp}${payload.toString()}`);
    const generatedSignature = verifier.digest('base64');

    if (generatedSignature !== signature) {
        return res.status(400).send('Invalid webhook signature');
    }

    const data = JSON.parse(payload.toString());
    const eventType = data.type;
    const orderData = data.data.order;

    if (eventType === 'PAYMENT_SUCCESS_WEBHOOK' && orderData.order_status === 'PAID') {
        const orderId = orderData.order_id;

        const { error: updateError } = await supabase
            .from('orders')
            .update({ status: 'Preparing' })
            .eq('id', orderId)
            .eq('status', 'Pending Payment'); 

        if (updateError) {
            console.error('Webhook Error: Failed to update order status:', orderId, updateError);
        }
    }

    res.status(200).send('Webhook received successfully');
  } catch (err) {
    console.error('Webhook processing error:', err.message);
    res.status(500).send('Internal Server Error');
  }
});

// 3. Verify Order Endpoint
app.post('/api/verify-order', async (req, res) => {
    try {
      const { orderId } = req.body;
      if (!orderId) return res.status(400).json({ error: 'Missing orderId' });
  
      const response = await axios.get(`${BASE_URL}/orders/${orderId}`, { headers: authHeaders() });
      res.json({ status: response.data.order_status || 'UNKNOWN' });
    } catch (error) {
      console.error('Verify order error:', error.response?.data || error.message);
      res.status(500).json({ error: 'Verification failed', details: error.response?.data || error.message });
    }
  });

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
