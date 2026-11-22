// Automatic offer alerts. Call after a product is saved:
//   • price went down (or a flash sale started) → notify everyone who wishlisted it
//   • price reached someone's target ("tell me below ₹X") → notify them, remove the alert
const User = require('../models/User');
const { effectivePrice, isFlashActive } = require('./pricing');
const { notifyMany, notifyUser } = require('./notify');

// Push payloads are limited to ~4 KB, so only web image links (not uploaded base64 photos) go along
const pushImage = (p) => {
  const img = p.images?.[0] || p.image || '';
  return /^https?:\/\//.test(img) ? img : '';
};

async function onProductPriceChange(before, product) {
  try {
    if (!product?.active) return;
    const oldPrice = before.price;
    const newPrice = effectivePrice(product);
    const flashStarted = !before.flash && isFlashActive(product);
    const url = `/products/${product.id}`;
    const image = pushImage(product);

    if (newPrice < oldPrice || flashStarted) {
      const fans = await User.find({ wishlist: product.id }).select('_id');
      if (fans.length) {
        const off = Math.round((1 - newPrice / oldPrice) * 100);
        await notifyMany(fans.map((u) => u._id), flashStarted ? {
          title: `⚡ Flash sale on your wishlist!`,
          body: `${product.name} is now ₹${newPrice}${off > 0 ? ` (${off}% off)` : ''} — for a limited time only.`,
          url, image, type: 'price', tag: `price-${product.id}`,
        } : {
          title: `💸 Price drop on your wishlist`,
          body: `${product.name} is now ₹${newPrice} (was ₹${oldPrice}).`,
          url, image, type: 'price', tag: `price-${product.id}`,
        });
      }
    }

    // Target-price alerts
    const watchers = await User.find({ priceAlerts: { $elemMatch: { productId: product.id, targetPrice: { $gte: newPrice } } } }).select('_id priceAlerts');
    for (const u of watchers) {
      const alert = u.priceAlerts.find((a) => a.productId === product.id);
      await notifyUser(u._id, {
        title: '🎯 Your price alert hit!',
        body: `${product.name} is now ₹${newPrice} — below your ₹${alert?.targetPrice} target. Grab it!`,
        url, image, type: 'price', tag: `alert-${product.id}`,
      });
      await User.updateOne({ _id: u._id }, { $pull: { priceAlerts: { productId: product.id } } });
    }
  } catch (err) {
    console.error('Price watch failed:', err.message);
  }
}

// Snapshot to take BEFORE changing a product
const snapshot = (p) => ({ price: effectivePrice(p), flash: isFlashActive(p) });

module.exports = { onProductPriceChange, snapshot };
