// Generates an instant AI answer to a customer's product question, grounded
// strictly in that product's own listed details (name, description, brand,
// highlights, specifications, category, price, stock, delivery/return policy).
// Requires ANTHROPIC_API_KEY to be set in Render's environment variables.
// If the key is missing or the call fails, this returns null so the caller
// can gracefully fall back to "pending seller reply" instead of crashing.

async function generateAiAnswer(product, question) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const specsText = (product.specifications || [])
    .map(s => `${s.key}: ${s.value}`)
    .join('\n') || 'None listed';
  const highlightsText = (product.highlights || []).join('\n') || 'None listed';

  const context = `
Product name: ${product.name}
Brand: ${product.brand || 'Not specified'}
Category: ${product.cat}
Price: ₹${product.price} (MRP ₹${product.old})
Stock: ${product.stock > 0 ? `${product.stock} units in stock` : 'Out of stock'}
Description: ${product.desc || 'No description provided'}
Highlights:
${highlightsText}
Specifications:
${specsText}
Delivery: ${product.deliveryDays || 5} days
Return policy: ${product.returnPolicy || `${product.returnDays || 7} days easy return`}
Warranty: ${product.warrantyMonths > 0 ? `${product.warrantyMonths} months` : 'No warranty listed'}
  `.trim();

  const systemPrompt = `You are a helpful shopping assistant answering a customer's question about a specific product on Sheen Bazaar, an Indian e-commerce marketplace. Answer ONLY using the product details provided below — never invent specs, prices, or policies that aren't listed. If the answer truly isn't in the details provided, say so plainly and suggest the seller will follow up, rather than guessing. Keep the answer short (1-3 sentences), friendly, and in plain English.

PRODUCT DETAILS:
${context}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: question }],
      }),
    });

    if (!response.ok) {
      console.error('AI answer request failed:', response.status, await response.text());
      return null;
    }

    const data = await response.json();
    const textBlock = data.content?.find(b => b.type === 'text');
    return textBlock?.text?.trim() || null;
  } catch (err) {
    console.error('AI answer generation error:', err.message);
    return null;
  }
}

module.exports = { generateAiAnswer };
