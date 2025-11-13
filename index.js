// index.js (FINAL, RELIABLE DEPLOYMENT VERSION)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(cors({
    origin: process.env.CORS_ORIGIN || '*'
}));

// ----------------------------------------------------------------------
// ** CRITICAL FIX: Custom Body Parser for Webhook RAW BODY Access **
// This global parser handles ALL bodies, saving the raw body (as a string) 
// into req.rawBody BEFORE parsing it to JSON (req.body). 

app.use(express.json({
    // Store the raw body buffer as a string in req.rawBody
    verify: (req, res, buf) => {
        if (buf && buf.length) {
            req.rawBody = buf.toString(); 
        }
    }
}));
// ----------------------------------------------------------------------

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

// Helper for Cashfree Webhook Signature Verification - Now uses req.rawBody
function verifyCashfreeWebhook(req) {
    const timestamp = req.headers['x-webhook-timestamp'];
    const signature = req.headers['x-webhook-signature'];
    const rawBody = req.rawBody; // Get raw body saved by the custom parser

    if (!timestamp || !signature || !rawBody) {
        console.error("Missing required webhook data (Timestamp, Signature, or Raw Body).");
        return false;
    }

    const secretKey = process.env.CASHFREE_CLIENT_SECRET;
    const signStr = timestamp + rawBody;

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

app.post('/api/create-order', async (req, res) => {
    try {
        const { cart, user, amount } = req.body;
        if (!user?.uid) return res.status(400).json({ error: 'Missing user info' });
        if (!Array.isArray(cart) || cart.length === 0) return res.status(400).json({ error: 'Cart is empty' });

        const orderAmount = Number(amount);
        if (isNaN(orderAmount) || orderAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });

        const cashfreeOrderId = 'order_' + Date.now();

        // Pre-record the order with PENDING status and data
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


app.post('/api/cashfree/webhook', async (req, res) => {
    
    // Check for empty body (often happens with simple test pings)
    if (!req.rawBody || req.rawBody.length === 0) {
        return res.status(200).json({ success: true, message: 'Test ping or empty body acknowledged.' });
    }

    // 1. Verify Signature using the saved raw body
    if (!verifyCashfreeWebhook(req)) {
        // Must return 200 OK to stop Cashfree retries for security failures
        return res.status(200).json({ status: 'Signature verification failed', message: 'Rejected' });
    }

    try {
        // 2. Access the already parsed JSON object
        const event = req.body;
        
        const { order_id, order_status, cf_payment_id, entity } = event.data?.order || event; 

        if (entity !== 'order' || !order_id) {
            // Return 200 OK for irrelevant events
            return res.status(200).json({ error: 'Invalid event structure' });
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
                console.log(`Order ${order_id} already processed.`);
                return res.status(200).json({ success: true, message: 'Order already processed' });
            }

            // ** CRITICAL ROBUSTNESS CHECK AND ITEM MAPPING **
            if (!Array.isArray(preOrder.raw_cart_data) || preOrder.raw_cart_data.length === 0) {
                 console.error(`ERROR: Cannot process order ${order_id}. raw_cart_data is missing or empty.`);
                 // Update status to mark the issue for manual inspection
                 await supabase.from('orders').update({ status: 'Failed: Missing Cart Data' }).eq('id', order_id);
                 return res.status(200).json({ success: false, message: 'Missing cart data' });
            }

            const itemsPayload = preOrder.raw_cart_data
                // Filter out any items that might be malformed to prevent the map from crashing
                .filter(ci => ci && ci.item && ci.item.id) 
                .map(ci => ({
                    order_id: order_id,
                    item_id: ci.item.id,
                    qty: ci.qty,
                    price: Number(ci.item.price),
                }));
            
            if (itemsPayload.length === 0) {
                console.error(`ERROR: Items payload is empty after filtering for order ${order_id}.`);
                await supabase.from('orders').update({ status: 'Failed: Items Missing IDs' }).eq('id', order_id);
                return res.status(200).json({ success: false, message: 'Items failed validation' });
            }

            // A. Finalize the main order
            const { error: updateErr } = await supabase
                .from('orders')
                .update({ 
                    status: 'Preparing', 
                    payment_id: cf_payment_id || 'N/A', 
                })
                .eq('id', order_id);

            if (updateErr) throw updateErr; // Throw here, as the critical update failed
            
            // B. Insert order items
            const { error: itemErr } = await supabase.from('order_items').insert(itemsPayload);
            if (itemErr) throw itemErr; // Throw here, as item insertion failed

            console.log(`Successfully recorded and finalized order ${order_id}`);
            
        } else {
            // Update status for FAILED, CANCELLED, etc.
            const { error: updateErr } = await supabase
                .from('orders')
                .update({ status: order_status }) 
                .eq('id', order_id);
            
            if (updateErr) console.error(`Failed to update status for ${order_id} to ${order_status}`);
        }

        return res.status(200).json({ success: true, message: 'Webhook processed' });

    } catch (error) {
        // If an exception occurs here (e.g., Supabase update fails), log it and return 200 to Cashfree.
        console.error('Cashfree Webhook processing FAILED with internal error:', error.message, 'Order ID:', req.body?.data?.order?.order_id || 'N/A');
        res.status(200).json({ success: false, error: 'Internal server error processing webhook' });
    }
});


app.post('/api/verify-order', async (req, res) => {
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
             // Fallback to Cashfree API
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