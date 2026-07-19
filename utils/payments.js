// Stands in for a real payment gateway (Razorpay, Stripe, etc.). Online
// payments (UPI/Card) are "captured" immediately so the money is marked as
// received into the platform's business account right away; a real
// integration would replace this with an API call plus a webhook to confirm
// the capture asynchronously.
function chargeOnline(method, amount) {
  const transactionId = `TXN${Date.now()}${Math.floor(1000 + Math.random() * 9000)}`;
  return { success: true, transactionId };
}

// Records cash collected by the courier/supplier at the doorstep for COD orders.
function recordCodCollection(orderId) {
  return { success: true, transactionId: `COD${String(orderId).slice(-8).toUpperCase()}` };
}

module.exports = { chargeOnline, recordCodCollection };
