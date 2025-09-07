require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.post('/api/create-payment-order', async (req, res) => {
  console.log('Received order:', req.body);

  const { orderId, orderAmount, customerDetails } = req.body;

  const clientId = process.env.CASHFREE_CLIENT_ID;
  const clientSecret = process.env.CASHFREE_CLIENT_SECRET;
  const cashfreeURL = 'https://sandbox.cashfree.com/pg/orders';

  const data = {
    order_id: orderId,
    order_amount: orderAmount,
    order_currency: 'INR',
    customer_details: {
      customer_id: customerDetails.customer_id,
      customer_email: customerDetails.customer_email,
      customer_phone: customerDetails.customer_phone || '9999999999',  // fallback phone number
    },
  };

  const headers = {
    'Content-Type': 'application/json',
    'x-client-id': clientId,
    'x-client-secret': clientSecret,
    'x-api-version': '2025-01-01',
  };

  try {
    const response = await axios.post(cashfreeURL, data, { headers });

    // Logging the full response from Cashfree for easier debugging
    console.log('Cashfree response:', response.data);

    if (response.data.status === 'OK') {
      res.json({ paymentSessionId: response.data.payment_session_id });
    } else {
      res.status(400).json({ error: 'Failed to create payment order' });
    }
  } catch (error) {
    console.error('Cashfree API Error:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
