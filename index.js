// index.js (FINAL, MINIMAL WEBHOOK FIX DEPLOYMENT)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5000;

// *** DEPLOYMENT VERIFICATION LOG ***
console.log('--- DEPLOYMENT VERIFICATION: WEBHOOK CATCH FIX v1.2 ACTIVE ---');
// **********************************

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(cors({
    origin: process.env.CORS_ORIGIN || '*'
}));

// ----------------------------------------------------------------------
// Custom Body Parser for Webhook RAW BODY Access 
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

// Helper for Cashfree Webhook Signature Verification
function verifyCashfreeWebhook(req) {
    const timestamp = req.headers['x-webhook-timestamp'];
    const signature = req.headers['x-webhook-signature'];
    const rawBody = req.rawBody; 

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


// index.js (Simplified /api/cashfree/webhook function)

app.post('/api/cashfree/webhook', async (req, res) => {
    
    let preOrder = null; 

    // Check for empty body (often happens with simple test pings)
    if (!req.rawBody || req.rawBody.length === 0) {
        return res.status(200).json({ success: true, message: 'Test ping or empty body acknowledged.' });
    }

    // 1. Verify Signature using the saved raw body
    if (!verifyCashfreeWebhook(req)) {
        return res.status(200).json({ status: 'Signature verification failed', message: 'Rejected' });
    }

    try {
        // 2. Access the already parsed JSON object
        const event = req.body;
        
        const { order_id, order_status, cf_payment_id, entity } = event.data?.order || event; 

        if (entity !== 'order' || !order_id) {
            return res.status(200).json({ error: 'Invalid event structure' });
        }

        console.log(`Webhook received for Order ID: ${order_id}, Status: ${order_status}`);

        // 3. Fetch only the current status for idempotency check (CRITICAL SIMPLIFICATION)
        const { data: fetchedOrder, error: fetchErr } = await supabase
            .from('orders')
            .select('status')
            .eq('id', order_id)
            .single();
        
        preOrder = fetchedOrder;

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

            // A. Finalize the main order (MINIMAL UPDATE)
            // We use .toString() on payment_id just in case it's numeric/null
            const { error: updateErr } = await supabase
                .from('orders')
                .update({ 
                    status: 'Preparing', 
                    payment_id: (cf_payment_id || 'N/A').toString(), 
                })
                .eq('id', order_id);

            if (updateErr) throw updateErr; 
            
            console.log(`STATUS UPDATE SUCCESS: Order ${order_id} marked as Preparing (Items not recorded).`);
            
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
        // Log the specific crash message.
        console.error('--- CASHFREE WEBHOOK CRASH LOG START ---');
        console.error('Internal processing FAILED:', error.message);
        
        const orderIdInCatch = req.body?.data?.order?.order_id || 'N/A';
        console.error('Order ID:', orderIdInCatch);
        console.error('--- CASHFREE WEBHOOK CRASH LOG END ---');
        
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