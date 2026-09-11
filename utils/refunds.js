const SiteContent = require('../models/SiteContent');

// Attempts to refund an order's payment back to the card/UPI/bank account it
// was originally paid with, via the gateway that captured it. Returns
// { success: true } on success, or { success: false, message } explaining
// why it couldn't be done automatically (e.g. a COD order with nothing to
// refund, or the gateway isn't configured) — callers should surface that
// message and let the order be handled manually if needed.
async function refundOrderPayment(order) {
  if (!order.transactionId) {
    return { success: false, message: 'No transaction ID on this order — likely Cash on Delivery, so there is nothing to refund automatically.' };
  }

  const content = await SiteContent.get();

  try {
    if (order.paymentMethod === 'RAZORPAY') {
      if (!content.razorpayKeyId || !content.razorpayKeySecret) {
        return { success: false, message: 'Razorpay is not configured — cannot process this refund automatically.' };
      }
      const authHeader = 'Basic ' + Buffer.from(`${content.razorpayKeyId}:${content.razorpayKeySecret}`).toString('base64');
      const rzpRes = await fetch(`https://api.razorpay.com/v1/payments/${order.transactionId}/refund`, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: Math.round(order.total * 100) }),
      });
      const rzpData = await rzpRes.json();
      if (!rzpRes.ok) return { success: false, message: rzpData?.error?.description || 'Razorpay refund failed.' };
      return { success: true };
    }

    if (order.paymentMethod === 'CASHFREE') {
      if (!content.cashfreeAppId || !content.cashfreeSecretKey) {
        return { success: false, message: 'Cashfree is not configured — cannot process this refund automatically.' };
      }
      const base = content.cashfreeLiveMode ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
      const cfRes = await fetch(`${base}/orders/${order.transactionId}/refunds`, {
        method: 'POST',
        headers: {
          'x-api-version': '2023-08-01',
          'x-client-id': content.cashfreeAppId,
          'x-client-secret': content.cashfreeSecretKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refund_amount: order.total, refund_id: `refund_${order._id}_${Date.now()}` }),
      });
      const cfData = await cfRes.json();
      if (!cfRes.ok) return { success: false, message: cfData?.message || 'Cashfree refund failed.' };
      return { success: true };
    }

    return { success: false, message: `Refunding a "${order.paymentMethod}" order automatically isn't supported — please process it manually.` };
  } catch (err) {
    return { success: false, message: `Refund request failed: ${err.message}` };
  }
}

module.exports = { refundOrderPayment };
