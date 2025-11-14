// index.js

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*'
}));
app.use(express.json());

const isSandbox = process.env.CASHFREE_ENV !== 'production';
const BASE_URL = isSandbox ? 'https://sandbox.cashfree.com/pg' : 'https://api.cashfree.com/pg';
const API_VERSION = "2023-08-01";

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// 💰 FLAT DISCOUNT CONSTANT (Must match client)
const FLAT_ITEM_DISCOUNT = 5.00;

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
    
    // Apply discount per item
    const discountedPrice = Math.max(0, p - FLAT_ITEM_DISCOUNT); 
    
    return sum + discountedPrice * q;
  }, 0).toFixed(2);
}

// --- API: Create Cashfree Order ---
app.post('/api/create-order', async (req, res) => {
  try {
    const { cart, user, amount } = req.body;
    if (!user?.uid) return res.status(400).json({ error: 'Missing user info' });
    if (!Array.isArray(cart) || cart.length === 0) return res.status(400).json({ error: 'Cart is empty' });

    // The client sends the final discounted amount.
    const orderAmount = Number(amount);
    if (isNaN(orderAmount) || orderAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const cashfreeOrderId = 'order_' + Date.now();

    const payload = {
      order_id: cashfreeOrderId,
      order_amount: orderAmount, // Discounted amount sent to Cashfree
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
    });
  } catch (error) {
    console.error('Create order error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Create order failed', details: error.response?.data || error.message });
  }
});

// --- API: Finalize Order (Verify + Record) ---
app.post('/api/finalize-order', async (req, res) => {
  try {
    const { orderId, userId, userEmail, cart } = req.body;
    
    if (!orderId || !userId || !Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: 'Missing required fields for finalization' });
    }

    // A. Check Cashfree Status (Verification)
    const verificationResponse = await axios.get(`${BASE_URL}/orders/${orderId}`, { headers: authHeaders() });
    const data = verificationResponse.data;
    const status = data.order_status;
    console.log(`Finalizing order ${orderId}. Cashfree Status: ${status}`);

    if (status !== 'PAID' && status !== 'SUCCESS') {
      // If payment failed, return 402 Payment Required
      return res.status(402).json({ 
        error: 'Payment not successful', 
        status: status,
        details: `Order status is ${status}`
      });
    }

    // B. Check Database Idempotency
    const { data: existingOrder } = await supabase
      .from('orders')
      .select('id')
      .eq('id', orderId)
      .single();

    if (existingOrder) {
      // Return success if already recorded (idempotent success)
      return res.json({ success: true, orderId, message: 'Order already recorded (idempotent success)' });
    }

    // C. Record Order in Supabase
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

    // D. Record Items
    const itemsPayload = cart.map(ci => ({
      order_id: order.id,
      item_id: ci.item.id,
      qty: ci.qty,
      // Record original price in DB, or use the discounted price depending on your reporting needs.
      // We'll record the discounted price here, as it matches the order total.
      price: Math.max(0, Number(ci.item.price) - FLAT_ITEM_DISCOUNT), 
    }));

    const { error: itemErr } = await supabase.from('order_items').insert(itemsPayload);
    if (itemErr) throw itemErr;

    // Final Success
    res.json({ success: true, orderId: order.id, status: 'PAID' });
  } catch (error) {
    console.error('Finalize order error:', error.response?.data || error.message);
    // Use 500 status for database/server issues to distinguish from 402 (payment failure)
    const status = error.response?.status === 402 ? 402 : 500;
    res.status(status).json({ 
      error: 'Order finalization failed', 
      details: error.response?.data || error.message 
    });
  }
});

app.listen(PORT, () => console.log(`Server running at port ${PORT}`));