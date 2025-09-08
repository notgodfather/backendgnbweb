require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5000;

// Supabase client for admin operations
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Allow your frontend origin, adjust if needed
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*'
}));

app.use(express.json());

const isSandbox = process.env.CASHFREE_ENV !== 'production';
const BASE_URL = isSandbox ? 'https://sandbox.cashfree.com/pg' : 'https://api.cashfree.com/pg';
const API_VERSION = "2023-08-01";  // Use your account's enabled version

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

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
    if (isNaN(p) || isNaN(q) || p < 0 || q < 0) throw new Error("Invalid price or quantity");
    return sum + p * q;
  }, 0).toFixed(2);
}

app.post('/api/create-order', async (req, res) => {
  try {
    const { cart, user, order_id } = req.body;
    if (!user?.uid) return res.status(400).json({ error: 'Missing user info' });
    if (!Array.isArray(cart) || cart.length === 0) return res.status(400).json({ error: 'Cart is empty' });
    if (!order_id) return res.status(400).json({ error: 'order_id is required' });

    const orderAmount = computeAmountFromCart(cart);
    if (orderAmount <= 0) return res.status(400).json({ error: 'Invalid cart amount' });

    const payload = {
      order_id: order_id,
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
        notify_url: `${PUBLIC_BASE_URL}/api/cashfree/webhook`, // optional, no webhook logic here though
      },
    };

    const response = await axios.post(`${BASE_URL}/orders`, payload, { headers: authHeaders() });
    const { payment_session_id, cf_order_id } = response.data;

    if (!payment_session_id) {
      return res.status(500).json({ error: 'No payment_session_id from Cashfree', raw: response.data });
    }

    return res.json({
      orderId: order_id,
      cfOrderId: cf_order_id,
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

app.post('/api/verify-order', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

    const response = await axios.get(`${BASE_URL}/orders/${orderId}`, { headers: authHeaders() });
    const data = response.data;

    const status = data.order_status || 'UNKNOWN'; // PAID, ACTIVE, EXPIRED, etc.

    // Update Supabase order status on successful payment
    if (status === 'PAID' || status === 'SUCCESS') {
      const { error } = await supabase
        .from('orders')
        .update({ status: 'Completed' })
        .eq('id', orderId);
      if (error) {
        console.error('Supabase update error:', error);
        return res.status(500).json({ error: 'Failed to update order status' });
      }
    }

    res.json({ status });
  } catch (error) {
    console.error('Verify order error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Verify failed', details: error.response?.data || error.message });
  }
});

app.listen(PORT, () => console.log(`Server running at port ${PORT}`));
