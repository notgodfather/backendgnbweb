// index.js (FINAL FIX: Ensuring correct body parsing for Webhook)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5000;

// Supabase client setup
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(cors({
    origin: process.env.CORS_ORIGIN || '*'
}));

// --- PARSERS SETUP ---
// Define the standard JSON parser for *most* API routes
const jsonParser = express.json();

// Define a RAW BODY parser specifically for the Webhook to get the body string for signature verification
// We must get the raw body as a Buffer, convert it to a string, and then parse it manually.
const rawBodyParser = express.text({ type: '*/*' }); 
// ----------------------

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

// Helper for Cashfree Webhook Signature Verification
function verifyCashfreeWebhook(req, rawBody) { // Accepts rawBody as argument
    const timestamp = req.headers['x-webhook-timestamp'];
    const signature = req.headers['x-webhook-signature'];

    if (!timestamp || !signature) {
        console.error("Missing webhook headers.");
        return false;
    }

    const secretKey = process.env.CASHFREE_CLIENT_SECRET;
    const signStr = timestamp + rawBody; // Use the raw body string

    try {
        const generatedSignature = crypto.createHmac('sha256', secretKey)
            .update(signStr)
            .digest('base64');
        
        if (generatedSignature !== signature) {
            console.error("Webhook signature mismatch!");
            return false;
        }
        return true;
    } catch (e) {
        console.error("Error during signature verification:", e.message);
        return false;
    }
}

// --- API Endpoints ---

app.post('/api/create-order', jsonParser, async (req, res) => {
    try {
        const { cart, user, amount } = req.body;
        if (!user?.uid) return res.status(400).json({ error: 'Missing user info' });
        if (!Array.isArray(cart) || cart.length === 0) return res.status(400).json({ error: 'Cart is empty' });

        const orderAmount = Number(amount);
        if (isNaN(orderAmount) || orderAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });

        const cashfreeOrderId = 'order_' + Date.now();

        // ** CRITICAL CHANGE: Pre-record the order with PENDING status and data **
        const { error: preRecordErr } = await supabase
            .from('orders')
            .insert([{
                id: cashfreeOrderId,
                user_id: user.uid,
                user_email: user.email,
                status: 'Pending Payment', 
                total_amount: orderAmount,
                raw_cart_data: cart,
            }])
            .select('id');

        if (preRecordErr) {
            console.error('Supabase pre-record error:', preRecordErr);
            return res.status(500).json({ error: 'Failed to pre-record order' });
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


app.post('/api/cashfree/webhook', rawBodyParser, async (req, res) => {
    
    // ** CRITICAL FIX **: Get the raw body string from the request.
    const rawBodyString = req.body;
    
    // 1. Verify Signature
    if (!verifyCashfreeWebhook(req, rawBodyString)) {
        // Log the failure, but return 200 OK to stop retries if the body was invalid
        return res.status(200).json({ status: 'Signature verification failed', message: 'Rejected' });
    }

    try {
        // 2. Parse the verified raw body string into a JSON event object
        const event = JSON.parse(rawBodyString);
        
        // Structure check (adjust based on actual Cashfree event structure)
        const { order_id, order_status, cf_payment_id, entity } = event.data?.order || event; 

        if (entity !== 'order' || !order_id) {
            return res.status(400).json({ error: 'Invalid event structure' });
        }

        console.log(`Webhook received for Order ID: ${order_id}, Status: ${order_status}`);

        // 3. Fetch the pre-recorded order details
        const { data: preOrder, error: fetchErr } = await supabase
            .from('orders')
            .select('status, raw_cart_data')
            .eq('id', order_id)
            .single();

        if (fetchErr || !preOrder) {
            console.error(`Order ${order_id} not found in DB or fetch error: ${fetchErr?.message}`);
            return res.status(200).json({ success: true, message: 'Order not found in DB' });
        }
        
        // 4. Process the PAID status
        if (order_status === 'PAID' || order_status === 'SUCCESS') {
            
            if (preOrder.status !== 'Pending Payment') {
                console.log(`Order ${order_id} already processed. Current status: ${preOrder.status}`);
                return res.status(200).json({ success: true, message: 'Order already processed' });
            }

            // A. Finalize the main order
            const { error: updateErr } = await supabase
                .from('orders')
                .update({ 
                    status: 'Preparing', 
                    payment_id: cf_payment_id || 'N/A', 
                })
                .eq('id', order_id);

            if (updateErr) throw updateErr;
            
            // B. Insert order items using the stored raw_cart_data
            const itemsPayload = preOrder.raw_cart_data.map(ci => ({
                order_id: order_id,
                item_id: ci.item.id,
                qty: ci.qty,
                price: Number(ci.item.price),
            }));

            const { error: itemErr } = await supabase.from('order_items').insert(itemsPayload);
            if (itemErr) throw itemErr;

            console.log(`Successfully recorded and finalized order ${order_id}`);
            
        } else {
            // Update order status for FAILED, CANCELLED, etc.
            const { error: updateErr } = await supabase
                .from('orders')
                .update({ status: order_status }) 
                .eq('id', order_id);
            
            if (updateErr) console.error(`Failed to update status for ${order_id} to ${order_status}`);
        }

        // Return 200 OK
        return res.status(200).json({ success: true, message: 'Webhook processed' });

    } catch (error) {
        console.error('Cashfree Webhook processing failed:', error.message);
        // Ensure to return 200 OK even if internal processing failed
        res.status(200).json({ success: false, error: 'Internal server error processing webhook' });
    }
});


app.post('/api/verify-order', jsonParser, async (req, res) => {
    try {
        const { orderId } = req.body;
        if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

        // Prefer checking our DB first
        const { data: order, error: dbErr } = await supabase
            .from('orders')
            .select('status')
            .eq('id', orderId)
            .single();

        if (dbErr || !order) {
             // Fallback to Cashfree API if our DB is slow or data is missing
             const response = await axios.get(`${BASE_URL}/orders/${orderId}`, { headers: authHeaders() });
             const status = response.data.order_status || 'UNKNOWN';
             return res.json({ status });
        }

        res.json({ status: order.status });
    } catch (error) {
        console.error('Verify order error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Verify failed', details: error.response?.data || error.message });
    }
});

app.listen(PORT, () => console.log(`Server running at port ${PORT}`));