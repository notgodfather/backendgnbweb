require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.post('/api/create-payment-order', async (req, res) => {
  const { orderId, orderAmount, customerDetails } = req.body;

  const clientId = process.env.CASHFREE_CLIENT_ID;
  const clientSecret = process.env.CASHFREE_CLIENT_SECRET;
  const cashfreeURL = 'https://sandbox.cashfree.com/pg/orders';

  const data = {
    order_id: orderId,
    order_amount: orderAmount,
    order_currency: 'INR',
    customer_details: customerDetails,
  };

  const headers = {
    'Content-Type': 'application/json',
    'x-client-id': clientId,
    'x-client-secret': clientSecret,
    'x-api-version': '2022-09-01',
  };

  try {
    const response = await axios.post(cashfreeURL, data, { headers });
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
