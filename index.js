// index.js

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5000;

// IMPORTANT: Ensure this key has write access to 'orders' and 'order_items'
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY); 

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*'
}));
app.use(express.json());

const isSandbox = process.env.CASHFREE_ENV !== 'production';
const BASE_URL = isSandbox ? 'https://sandbox.cashfree.com/pg' : 'https://api.cashfree.com/pg';
const API_VERSION = "2023-08-01";

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

function authHeaders() {
  return {
    'x-client-id': process.env.CASHFREE_CLIENT_ID,
    'x-client-secret': process.env.CASHFREE_CLIENT_SECRET,
    'x-api-version': API_VERSION,
  };
}

// Keep computeAmountFromCart as is (not shown)

app.post('/api/create-order', async (req, res) => {
// ... (Your existing create-order code remains unchanged)
  try {
    const { cart, user, amount } = req.body;
    if (!user?.uid) return res.status(400).json({ error: 'Missing user info' });
    if (!Array.isArray(cart) || cart.length === 0) return res.status(400).json({ error: 'Cart is empty' });

    const orderAmount = Number(amount);
  if (isNaN(orderAmount) || orderAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });


    const cashfreeOrderId = 'order_' + Date.now();

    // Extract necessary data from cart and user for later recording
    const metadata = {
      userId: user.uid,
      userEmail: user.email,
      cartData: JSON.stringify(cart), // Store cart data as JSON string
    };
    
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
        // Crucially, we keep the notify_url for webhooks, even if we don't actively use it yet.
        return_url: `${PUBLIC_BASE_URL}/pg/return?order_id={order_id}`,
        notify_url: `${PUBLIC_BASE_URL}/api/cashfree/webhook`,
        // We can include some metadata here, though we rely on client-side context for the full cart
      },
    };

    const response = await axios.post(`${BASE_URL}/orders`, payload, { headers: authHeaders() });
    const { payment_session_id } = response.data;

    console.log('Create order response from Cashfree:', response.data);

    if (!payment_session_id) {
      return res.status(500).json({ error: 'No payment_session_id from Cashfree', raw: response.data });
    }

    return res.json({
      orderId: cashfreeOrderId,
      paymentSessionId: payment_session_id,
      amount: orderAmount,
      currency: 'INR',
      envMode: isSandbox ? 'sandbox' : 'production',
      // IMPORTANT: Pass user/cart data to client, which passes it to finalize-order
      userDetails: user,
      cartData: cart,
    });
  } catch (error) {
    console.error('Create order error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Create order failed', details: error.response?.data || error.message });
  }
});

// REMOVED: app.post('/api/verify-order', ...)

// REMOVED: app.post('/api/record-order', ...)

// NEW COMBINED ENDPOINT: Finalizes the order after client payment
app.post('/api/finalize-order', async (req, res) => {
  try {
    const { orderId, userId, userEmail, cart } = req.body;
    
    if (!orderId || !userId || !Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: 'Missing required fields for finalization' });
    }

    // 1. Check Cashfree Status
    const verificationResponse = await axios.get(`${BASE_URL}/orders/${orderId}`, { headers: authHeaders() });
    const data = verificationResponse.data;
    const status = data.order_status;
    console.log(`Finalizing order ${orderId}. Cashfree Status: ${status}`);

    if (status !== 'PAID' && status !== 'SUCCESS') {
      return res.status(402).json({ 
        error: 'Payment not successful', 
        status: status,
        details: `Order status is ${status}`
      });
    }

    // 2. Check Database Idempotency
    const { data: existingOrder } = await supabase
      .from('orders')
      .select('id')
      .eq('id', orderId)
      .single();

    if (existingOrder) {
      return res.json({ success: true, orderId, message: 'Order already recorded (idempotent success)' });
    }

    // 3. Record Order
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .insert([{
        id: orderId,
        user_id: userId,
        user_email: userEmail,
        status: 'Preparing',
        created_at: new Date().toISOString(),
      }])
      .select('id')
      .single();

    if (orderErr) throw orderErr;

    // 4. Record Items
    const itemsPayload = cart.map(ci => ({
      order_id: order.id,
      item_id: ci.item.id,
      qty: ci.qty,
      price: Number(ci.item.price),
    }));

    const { error: itemErr } = await supabase.from('order_items').insert(itemsPayload);
    if (itemErr) throw itemErr;

    res.json({ success: true, orderId: order.id, status: 'PAID' });
  } catch (error) {
    console.error('Finalize order error:', error.response?.data || error.message);
    // Use 500 status only if the server/DB part failed, not if payment failed (402)
    const status = error.response?.status || 500;
    res.status(status).json({ 
      error: 'Order finalization failed', 
      details: error.response?.data || error.message 
    });
  }
});

app.listen(PORT, () => console.log(`Server running at port ${PORT}`));