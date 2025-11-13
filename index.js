require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
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

// 🐛 FIX: Add a GET route for /pg/return to prevent the "Cannot GET" error 
// when Cashfree redirects the user's browser after payment completion.
app.get('/pg/return', (req, res) => {
    // Since the actual verification is handled by the front-end (Home.jsx) 
    // after the Cashfree SDK signals success, this route just needs to return a valid page.
    res.status(200).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Payment Processing</title>
            <style>
                body { font-family: sans-serif; text-align: center; padding: 50px; background-color: #f8fafc; color: #1e293b; }
                h1 { color: #22c55e; }
                .spinner { border: 4px solid rgba(0, 0, 0, 0.1); border-top: 4px solid #22c55e; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 20px auto; }
                @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            </style>
        </head>
        <body>
            <div class="spinner"></div>
            <h1>Verifying Payment...</h1>
            <p>Please wait a moment while we confirm your order. You can safely close this window if the main application window has updated.</p>
        </body>
        </html>
    `);
});


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
                // Ensure this path is available (now it is, via the new app.get('/pg/return') above)
                return_url: `${PUBLIC_BASE_URL}/pg/return?order_id={order_id}`, 
                notify_url: `${PUBLIC_BASE_URL}/api/cashfree/webhook`, 
            },
        };

        const response = await axios.post(`${BASE_URL}/orders`, payload, { headers: authHeaders() });
        const { payment_session_id } = response.data;

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

app.post('/api/verify-order', async (req, res) => {
    try {
        const { orderId } = req.body;
        if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

        const response = await axios.get(`${BASE_URL}/orders/${orderId}`, { headers: authHeaders() });
        const data = response.data;

        const status = data.order_status || 'UNKNOWN';

        res.json({ status });
    } catch (error) {
        console.error('Verify order error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Verify failed', details: error.response?.data || error.message });
    }
});

app.post('/api/record-order', async (req, res) => {
    try {
        const { userId, userEmail, cart, orderId } = req.body;
        if (!userId || !Array.isArray(cart) || cart.length === 0 || !orderId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Check if order already recorded
        const { data: existingOrder } = await supabase
            .from('orders')
            .select('id, status')
            .eq('id', orderId)
            .single();

        if (existingOrder) {
            // Update status if necessary
            if (existingOrder.status !== 'Success') {
                await supabase
                    .from('orders')
                    .update({ status: 'Success' })
                    .eq('id', orderId);
            }
            return res.status(200).json({ success: true, message: 'Order already recorded', orderId: existingOrder.id });
        }

        // Insert order
        const { data: order, error: orderErr } = await supabase
            .from('orders')
            .insert([{
                id: orderId,
                user_id: userId,
                user_email: userEmail,
                status: 'Success',
                created_at: new Date().toISOString(),
            }])
            .select('id')
            .single();

        if (orderErr) throw orderErr;

        // Prepare items payload
        const itemsPayload = cart.map(ci => ({
            order_id: order.id,
            item_id: ci.item.id,
            qty: ci.qty,
            price: Number(ci.item.price),
        }));

        const { error: itemErr } = await supabase.from('order_items').insert(itemsPayload);
        if (itemErr) throw itemErr;

        res.json({ success: true, orderId: order.id });
    } catch (err) {
        console.error('Record order error:', err);
        res.status(500).json({ error: 'Failed to record order' });
    }
});

app.listen(PORT, () => console.log(`Server running at port ${PORT}`));