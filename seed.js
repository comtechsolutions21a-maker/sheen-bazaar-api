require('dotenv').config();
const connectDB = require('./config/db');
const Product = require('./models/Product');
const User = require('./models/User');

const PRODUCTS = [
  { id: 1, name: 'Printed Georgette Saree with Blouse', icon: '🥻', price: 499, old: 1499, rating: 4.2, badge: '67% OFF', cat: 'Fashion',
    desc: 'A lightweight georgette saree with a printed floral pattern and matching unstitched blouse piece. Easy to drape, great for daily wear or festive occasions.' },
  { id: 2, name: 'Wireless Bluetooth Earbuds', icon: '🎧', price: 799, old: 2499, rating: 4.1, badge: '68% OFF', cat: 'Electronics',
    desc: 'True wireless earbuds with 20 hours total battery life, touch controls, and clear calling mic. Comes with a compact charging case.' },
  { id: 3, name: 'Cotton Straight Kurti for Women', icon: '👚', price: 349, old: 999, rating: 4.3, badge: '65% OFF', cat: 'Fashion',
    desc: 'Breathable pure cotton kurti in a relaxed straight-fit cut. Machine washable and available in multiple sizes.' },
  { id: 4, name: 'Analog Watch for Men', icon: '⌚', price: 599, old: 1999, rating: 4.0, badge: '70% OFF', cat: 'Fashion',
    desc: 'Classic analog watch with stainless steel case, leather strap, and water-resistant build. Comes with 1-year warranty.' },
  { id: 5, name: 'Kids Cartoon Print T-Shirt', icon: '👕', price: 199, old: 599, rating: 4.4, badge: '67% OFF', cat: 'Kids',
    desc: 'Soft cotton T-shirt with fun cartoon prints kids love. Pre-shrunk fabric that keeps its shape after washing.' },
  { id: 6, name: 'Non-Stick Cookware Set (3 pcs)', icon: '🍳', price: 899, old: 2199, rating: 4.2, badge: '59% OFF', cat: 'Home',
    desc: '3-piece non-stick cookware set including a tawa, kadai and frying pan. Even heat distribution and easy to clean.' },
  { id: 7, name: 'Artificial Kundan Jewellery Set', icon: '💍', price: 449, old: 1299, rating: 4.5, badge: '65% OFF', cat: 'Jewellery',
    desc: 'Kundan-studded necklace and earring set, perfect for weddings and festive functions. Anti-tarnish plating.' },
  { id: 8, name: 'Running Sports Shoes Unisex', icon: '👟', price: 699, old: 1799, rating: 4.1, badge: '61% OFF', cat: 'Footwear',
    desc: 'Lightweight running shoes with breathable mesh upper and cushioned sole for all-day comfort.' },
  { id: 9, name: 'Matte Lipstick Combo (Set of 3)', icon: '💄', price: 299, old: 899, rating: 4.3, badge: '67% OFF', cat: 'Beauty',
    desc: 'Long-lasting matte finish lipstick combo in 3 everyday shades. Transfer-proof and lightweight on lips.' },
  { id: 10, name: 'Quilted Sling Bag for Women', icon: '👜', price: 399, old: 1099, rating: 4.2, badge: '64% OFF', cat: 'Bags',
    desc: 'Compact quilted sling bag with adjustable strap, perfect for daily essentials. Available in multiple colours.' },
  { id: 11, name: 'LED Table Lamp with USB Port', icon: '💡', price: 449, old: 1199, rating: 4.0, badge: '63% OFF', cat: 'Home',
    desc: 'Adjustable LED desk lamp with 3 brightness modes and a built-in USB charging port.' },
  { id: 12, name: "Men's Casual Sneakers", icon: '👞', price: 849, old: 2199, rating: 4.1, badge: '61% OFF', cat: 'Footwear',
    desc: 'Everyday casual sneakers with cushioned insole and durable rubber outsole.' },
];

async function seed() {
  await connectDB();
  await Product.deleteMany({});
  await Product.insertMany(PRODUCTS);
  console.log(`Seeded ${PRODUCTS.length} products.`);

  // Demo accounts so seller/admin dashboards can be explored immediately.
  // ⚠️ Demo credentials only — change or remove these before deploying anywhere real.
  await User.deleteOne({ email: 'admin@bazaario.demo' });
  await User.create({
    name: 'Sheen Bazaar Admin',
    email: 'admin@bazaario.demo',
    password: 'admin1234',
    role: 'admin',
  });
  console.log('Seeded demo admin: admin@bazaario.demo / admin1234');

  await User.deleteOne({ email: 'seller@bazaario.demo' });
  const seller = await User.create({
    name: 'Aarav Sharma',
    email: 'seller@bazaario.demo',
    password: 'seller1234',
    role: 'seller',
    businessName: 'Sharma Textiles',
    sellerApproved: true,
  });
  console.log('Seeded demo seller (pre-approved): seller@bazaario.demo / seller1234');

  const lastId = await Product.findOne().sort({ id: -1 }).select('id');
  await Product.create({
    id: (lastId?.id || 0) + 1,
    name: 'Handloom Cotton Dupatta',
    icon: '🧣',
    price: 349,
    old: 899,
    rating: 4.4,
    badge: '61% OFF',
    cat: 'Fashion',
    desc: 'Soft handloom cotton dupatta with woven border detail, made by an independent seller on Sheen Bazaar.',
    seller: seller._id,
    active: true,
  });
  console.log('Seeded one demo seller-owned listing.');

  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
